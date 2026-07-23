const { Router } = require('express');
const { EventEmitter } = require('events');
const { getPool } = require('../db/pool');
const { createMessage, isEnabled, buildSystemPrompt, getCreateParams, isValidModel, estimateMicrocents } = require('../services/llm');
const { validate, getSchemaReminder } = require('../services/recipe-validator');
const { fetchWebpage } = require('../services/web');
const { webSearch, init: initSearch } = require('../services/search');
const { rateLimitMiddleware } = require('../middleware/rate-limit');
const log = require('../services/logger');

const MAX_VALIDATION_RETRIES = 2;

// Tighter timeout for the recipe fix-up call ("Fixing recipe format..."):
// the user is already waiting on a spinner at that point, so fail fast
// rather than sitting on the default LLM timeout.
const RECIPE_FIXUP_TIMEOUT_MS = 60_000;

const replyEmitters = new Map();

function getOrCreateEmitter(replyId) {
  if (!replyEmitters.has(replyId)) {
    replyEmitters.set(replyId, new EventEmitter());
  }
  return replyEmitters.get(replyId);
}

function cleanupEmitter(replyId) {
  const emitter = replyEmitters.get(replyId);
  if (emitter) {
    emitter.removeAllListeners();
    replyEmitters.delete(replyId);
  }
}

function chatRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  initSearch(config);

  router.post('/api/chat', rateLimitMiddleware(config), async (req, res) => {
    const { conversationId, message, preferences, forkRecipe, forkSource } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message required' });
    }

    if (!isEnabled(config)) {
      return res.status(503).json({
        error: 'AI features are unavailable in this environment.',
        code: 'llm_unavailable',
      });
    }

    // The requester's platform JWT — forwarded to the LLM proxy so it can
    // authorize and bill the right user during the background stream.
    const userToken = req.headers['x-usernode-token'] || req.query.token || '';

    try {
      let convId = conversationId;
      let convCreated = null;

      if (convId) {
        const { rows: existing } = await pool.query(
          'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
          [convId, req.user.id]
        );
        if (!existing.length) {
          log.warn('chat', 'Conversation not found, creating new', { conversationId: convId });
          convId = null;
        }
      }

      if (!convId) {
        const title = forkRecipe?.title ? `Fork: ${forkRecipe.title}` : 'New conversation';
        const convPrefs = preferences || {};

        // Remix lineage: when the fork came from a shared recipe, record
        // the source on the conversation. Copied onto the published
        // snapshot at publish time (see recipes.js share endpoint).
        let src = { id: null, version: null, username: null };
        if (forkRecipe && forkSource && parseInt(forkSource.sharedRecipeId)) {
          src = {
            id: parseInt(forkSource.sharedRecipeId),
            version: parseInt(forkSource.version) || null,
            username: typeof forkSource.username === 'string'
              ? forkSource.username.slice(0, 255) : null,
          };
        }

        const { rows } = await pool.query(
          `INSERT INTO conversations
             (user_id, title, preferences, forked_from_shared_id, forked_from_version, forked_from_username)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [req.user.id, title, JSON.stringify(convPrefs), src.id, src.version, src.username]
        );
        convId = rows[0].id;
        convCreated = { id: convId, preferences: convPrefs };

        if (forkRecipe) {
          const context = `[System: The user is modifying an existing recipe. Current recipe JSON:\n${JSON.stringify(forkRecipe)}\n]`;
          await pool.query(
            'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
            [convId, 'user', context]
          );
        }
      }

      const { rows: userMsgRows } = await pool.query(
        'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id',
        [convId, 'user', message]
      );
      const userMsgId = userMsgRows[0].id;

      const { rows: replyRows } = await pool.query(
        'INSERT INTO pending_replies (conversation_id, user_id) VALUES ($1, $2) RETURNING id',
        [convId, req.user.id]
      );
      const replyId = replyRows[0].id;

      const emitter = getOrCreateEmitter(replyId);
      let eventIndex = 0;

      const send = (event, data) => {
        const evt = { index: eventIndex++, event, data };
        emitter.emit('event', evt);
        pool.query(
          `UPDATE pending_replies SET events = events || $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify([evt]), replyId]
        ).catch((err) => log.warn('chat', 'Failed to persist event', { message: err.message }));
      };

      if (convCreated) {
        send('conversation', convCreated);
      }

      const rlLimit = res.getHeader('X-RateLimit-Limit');
      const rlRemaining = res.getHeader('X-RateLimit-Remaining');
      if (rlLimit) {
        const limit = parseInt(rlLimit);
        const remaining = parseInt(rlRemaining);
        send('rate_limit', { used: limit - remaining, limit });
      }

      // Per-user model choice (saved via the settings modal); falls back to
      // the server default for missing rows or stale/unknown saved ids.
      let userModel = config.anthropicModel;
      try {
        const { rows: settingsRows } = await pool.query(
          'SELECT preferences FROM user_settings WHERE user_id = $1',
          [req.user.id]
        );
        const savedModel = settingsRows.length ? (settingsRows[0].preferences || {}).model : null;
        if (isValidModel(savedModel)) userModel = savedModel;
      } catch (err) {
        log.warn('chat', 'Failed to load user model preference', { message: err.message });
      }

      runBackgroundStream(
        userToken, config, pool, convId, replyId, req.user.id, userModel,
        preferences, send, userMsgId
      );

      res.status(202).json({ conversationId: convId, replyId });
    } catch (err) {
      log.error('chat', 'Chat setup error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/chat/:replyId/stream', async (req, res) => {
    const replyId = parseInt(req.params.replyId);
    const after = req.query.after !== undefined ? parseInt(req.query.after) : -1;

    try {
      const { rows } = await pool.query(
        'SELECT id, status, events FROM pending_replies WHERE id = $1 AND user_id = $2',
        [replyId, req.user.id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Reply not found' });
      }

      const reply = rows[0];

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const writeSse = (evt) => {
        res.write(`event: ${evt.event}\ndata: ${JSON.stringify({ ...evt.data, _idx: evt.index })}\n\n`);
      };

      const emitter = getOrCreateEmitter(replyId);
      const buffer = [];
      let flushing = false;

      const onEvent = (evt) => {
        if (!flushing) {
          buffer.push(evt);
        } else {
          try { writeSse(evt); } catch { emitter.removeListener('event', onEvent); }
        }
      };

      let finished = false;
      const onFinish = () => {
        finished = true;
        if (flushing) {
          emitter.removeListener('event', onEvent);
          res.end();
        }
      };

      emitter.on('event', onEvent);
      emitter.once('finish', onFinish);

      const existingEvents = (reply.events || []).slice().sort((a, b) => a.index - b.index);
      let maxSent = after;
      for (const evt of existingEvents) {
        if (evt.index > after) {
          writeSse(evt);
          if (evt.index > maxSent) maxSent = evt.index;
        }
      }

      flushing = true;
      for (const evt of buffer) {
        if (evt.index > maxSent) {
          writeSse(evt);
        }
      }
      buffer.length = 0;

      if (reply.status === 'done' || reply.status === 'error' || finished) {
        emitter.removeListener('event', onEvent);
        emitter.removeListener('finish', onFinish);
        if (reply.status === 'error') {
          writeSse({ event: 'error', data: { error: 'Response was interrupted' }, index: maxSent + 1 });
        } else if (reply.status === 'done') {
          writeSse({ event: 'done', data: {}, index: maxSent + 1 });
        }
        res.end();
        return;
      }

      req.on('close', () => {
        emitter.removeListener('event', onEvent);
        emitter.removeListener('finish', onFinish);
      });
    } catch (err) {
      log.error('chat', 'Stream setup error', { message: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  router.get('/api/chat/:replyId/status', async (req, res) => {
    const replyId = parseInt(req.params.replyId);
    try {
      const { rows } = await pool.query(
        'SELECT status FROM pending_replies WHERE id = $1 AND user_id = $2',
        [replyId, req.user.id]
      );
      if (!rows.length) return res.json({ status: 'not_found' });
      res.json({ status: rows[0].status });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/chat/:replyId/acknowledge', async (req, res) => {
    const replyId = parseInt(req.params.replyId);
    try {
      await pool.query(
        `UPDATE pending_replies SET status = 'acknowledged', updated_at = NOW() WHERE id = $1 AND user_id = $2`,
        [replyId, req.user.id]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('chat', 'Acknowledge error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

async function runBackgroundStream(
  userToken, config, pool, convId, replyId, userId, userModel, preferences, send, userMsgId
) {
  const responseLog = [];

  // Log entries carry structured fields (kind/query/url/title) alongside the
  // English `text` so the client can render them in the user's language;
  // `text` stays as the fallback for rows persisted before this existed.
  const trackingSend = (event, data) => {
    if (event === 'thinking') {
      responseLog.push({ type: 'thinking', kind: 'thinking', text: 'Thinking...', detail: data.text });
    } else if (event === 'status') {
      const entry = { type: 'status', text: data.text };
      if (data.kind) entry.kind = data.kind;
      if (data.query) entry.query = data.query;
      if (data.url) entry.url = data.url;
      responseLog.push(entry);
    } else if (event === 'recipe') {
      responseLog.push({ type: 'recipe', kind: 'recipe', title: data.title, text: `Created recipe: ${data.title}` });
    }
    send(event, data);
  };

  try {
    const { rows: history } = await pool.query(
      'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [convId]
    );

    const { rows: recipeRows } = await pool.query(
      'SELECT recipe_data FROM messages WHERE conversation_id = $1 AND recipe_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      [convId]
    );
    const currentRecipe = recipeRows.length ? recipeRows[0].recipe_data : null;

    const systemPrompt = buildSystemPrompt(preferences || {}, currentRecipe);
    const messages = history.map((m) => ({ role: m.role, content: m.content }));

    const startTime = Date.now();

    log.info('chat', 'Starting stream', {
      conversationId: convId,
      replyId,
      userId,
      model: userModel,
      messageCount: messages.length,
    });

    const result = await streamWithToolHandling(
      userToken, config, messages, systemPrompt, trackingSend, convId, pool, userId, userModel,
      responseLog, userMsgId
    );

    const elapsed = Date.now() - startTime;
    log.info('chat', 'Stream complete', {
      conversationId: convId,
      replyId,
      elapsed_ms: elapsed,
      usage: result.usage,
    });

    await pool.query(
      'UPDATE messages SET response_log = $1::jsonb WHERE id = $2',
      [JSON.stringify(responseLog), userMsgId]
    ).catch((err) => log.warn('chat', 'Failed to save response_log', { message: err.message }));

    send('done', {});

    await pool.query(
      `UPDATE pending_replies SET status = 'done', updated_at = NOW() WHERE id = $1 AND status = 'processing'`,
      [replyId]
    );
  } catch (err) {
    log.error('chat', 'Background stream error', { message: err.message, code: err.code, replyId });
    send('error', { error: err.userMessage || 'Something went wrong', code: err.code });

    if (responseLog.length) {
      await pool.query(
        'UPDATE messages SET response_log = $1::jsonb WHERE id = $2',
        [JSON.stringify(responseLog), userMsgId]
      ).catch(() => {});
    }

    await pool.query(
      `UPDATE pending_replies SET status = 'error', updated_at = NOW() WHERE id = $1 AND status = 'processing'`,
      [replyId]
    ).catch(() => {});
  } finally {
    const emitter = getOrCreateEmitter(replyId);
    emitter.emit('finish');
    setTimeout(() => cleanupEmitter(replyId), 5000);
  }
}

async function streamWithToolHandling(
  userToken, config, messages, systemPrompt, send, convId, pool, userId, userModel,
  responseLog, userMsgId
) {
  let currentMessages = [...messages];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };

  // Recipe-validation fix-up state, shared across turns: `attempts` counts
  // how many fix-up rounds we've asked the model for (bounded by
  // MAX_VALIDATION_RETRIES), and `pending` marks that the NEXT createMessage
  // call is a fix-up call — it gets a tighter timeout and '[recipe]' logging.
  const fixState = { attempts: 0, pending: null };

  for (let turn = 0; turn < 5; turn++) {
    const params = getCreateParams(config, currentMessages, systemPrompt, { model: userModel });

    log.debug('chat', `Turn ${turn} request`, {
      model: params.model,
      system: params.system?.slice(0, 200),
      messageCount: params.messages.length,
      messages: params.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content.slice(0, 300) : m.content,
      })),
    });

    const fixup = fixState.pending;
    if (fixup) {
      log.info('recipe', 'Fix-up call starting', {
        attempt: fixup.attempt,
        max_attempts: MAX_VALIDATION_RETRIES,
        model: params.model,
        timeout_ms: RECIPE_FIXUP_TIMEOUT_MS,
      });
    }

    let response;
    try {
      response = await createMessage(
        config, params, userToken,
        fixup ? { timeoutMs: RECIPE_FIXUP_TIMEOUT_MS } : {}
      );
    } catch (err) {
      if (fixup) {
        log.error('recipe', 'Fix-up call failed', {
          attempt: fixup.attempt,
          elapsed_ms: Date.now() - fixup.startedAt,
          code: err.code,
          error: err.message,
        });
        err.userMessage = err.code === 'timeout'
          ? 'Fixing the recipe format timed out. Please try again.'
          : (err.userMessage || 'Fixing the recipe format failed. Please try again.');
      }
      throw err;
    }

    if (fixup) {
      fixState.pending = null;
      const calledDisplayRecipe = response.content.some(
        (b) => b.type === 'tool_use' && b.name === 'display_recipe'
      );
      log.info('recipe', 'Fix-up response received', {
        attempt: fixup.attempt,
        elapsed_ms: Date.now() - fixup.startedAt,
        stop_reason: response.stop_reason,
        called_display_recipe: calledDisplayRecipe,
      });
      if (!calledDisplayRecipe) {
        log.warn('recipe', 'Fix-up turn made no display_recipe call', {
          attempt: fixup.attempt,
          stop_reason: response.stop_reason,
        });
      }
    }

    log.debug('chat', `Turn ${turn} response`, {
      stop_reason: response.stop_reason,
      usage: response.usage,
      content: response.content.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text.slice(0, 300) };
        if (b.type === 'tool_use') return { type: 'tool_use', name: b.name, input_keys: Object.keys(b.input || {}) };
        if (b.type === 'thinking') return { type: 'thinking', length: b.thinking?.length };
        return { type: b.type };
      }),
    });

    totalUsage.input_tokens += response.usage?.input_tokens || 0;
    totalUsage.output_tokens += response.usage?.output_tokens || 0;

    // Accumulate the user's daily spend estimate (shown in the user menu as
    // "AI usage today"). Per-turn so a reply that errors mid-loop still
    // counts its completed turns — matching what the proxy billed. Keyed on
    // the UTC day to match the platform's midnight-UTC budget reset.
    recordUsage(pool, userId, params.model, response.usage);

    let assistantText = '';
    const toolResults = [];
    let textFlushed = false;

    for (const block of response.content) {
      if (block.type === 'thinking') {
        send('thinking', { text: block.thinking });
      } else if (block.type === 'text') {
        assistantText += block.text;
        send('token', { text: block.text });
      } else if (block.type === 'tool_use') {
        if (!textFlushed && assistantText) {
          responseLog.push({ type: 'text', content: assistantText });
          textFlushed = true;
        }
        const toolResult = await handleToolCall(
          block, config, currentMessages, systemPrompt, send, convId, pool, userId, responseLog, fixState
        );
        toolResults.push({ toolUseId: block.id, result: toolResult });
      }
    }

    if (assistantText) {
      if (!textFlushed) {
        responseLog.push({ type: 'text', content: assistantText });
      }
      await pool.query(
        'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
        [convId, 'assistant', assistantText]
      );
    }

    if (toolResults.length === 0 || response.stop_reason !== 'tool_use') {
      return { usage: totalUsage };
    }

    pool.query(
      'UPDATE messages SET response_log = $1::jsonb WHERE id = $2',
      [JSON.stringify(responseLog), userMsgId]
    ).catch(() => {});

    currentMessages.push({
      role: 'assistant',
      content: response.content,
    });

    for (const tr of toolResults) {
      currentMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: tr.toolUseId,
            content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
          },
        ],
      });
    }
  }

  // The turn cap was reached with a fix-up round still owed to the user —
  // without this, the stream would end with 'done' and the "Fixing recipe
  // format..." spinner would resolve with no recipe and no explanation.
  if (fixState.pending) {
    log.error('recipe', 'Turn limit reached with recipe fix-up still pending', {
      attempt: fixState.pending.attempt,
    });
    const err = new Error('Recipe fix-up incomplete at turn limit');
    err.userMessage = "I couldn't format that recipe correctly. Please try asking again.";
    throw err;
  }

  return { usage: totalUsage };
}

// Fire-and-forget upsert of one API turn's token usage into llm_usage.
function recordUsage(pool, userId, model, usage) {
  if (!usage) return;
  const microcents = estimateMicrocents(model, usage);
  pool.query(
    `INSERT INTO llm_usage (user_id, date, input_tokens, output_tokens, estimated_microcents)
     VALUES ($1, (NOW() AT TIME ZONE 'utc')::date, $2, $3, $4)
     ON CONFLICT (user_id, date) DO UPDATE SET
       input_tokens = llm_usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = llm_usage.output_tokens + EXCLUDED.output_tokens,
       estimated_microcents = llm_usage.estimated_microcents + EXCLUDED.estimated_microcents`,
    [userId, usage.input_tokens || 0, usage.output_tokens || 0, microcents]
  ).catch((err) => log.warn('chat', 'Failed to record llm usage', { message: err.message }));
}

async function handleToolCall(block, config, messages, systemPrompt, send, convId, pool, userId, responseLog, fixState) {
  const lastEntry = () => responseLog[responseLog.length - 1];

  if (block.name === 'web_search') {
    send('status', { text: `Searching: ${block.input.query}`, kind: 'search', query: block.input.query });
    const result = await webSearch(block.input.query);
    if (result.error) return result.error;
    if (!result.results?.length) return 'No search results found.';
    const entry = lastEntry();
    const mapped = result.results.map(r => ({ title: r.title, url: r.url }));
    if (entry) entry.results = mapped;
    send('status_results', { results: mapped });
    return result.results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n');
  }

  if (block.name === 'fetch_webpage') {
    send('status', { text: `Reading: ${block.input.url}`, kind: 'fetch', url: block.input.url });
    const result = await fetchWebpage(block.input.url);
    if (result.error) return result.error;
    return `Title: ${result.title}\n\nContent:\n${result.content}`;
  }

  if (block.name === 'display_recipe') {
    return await handleRecipeDisplay(block.input, send, convId, pool, userId, fixState);
  }

  return 'Unknown tool';
}

async function handleRecipeDisplay(recipeData, send, convId, pool, userId, fixState) {
  const recipe = recipeData;
  const { valid, errors } = validate(recipe);

  if (valid) {
    if (fixState.attempts > 0) {
      log.info('recipe', 'Fix-up succeeded — valid recipe after retry', {
        attempt: fixState.attempts,
        title: recipe.title,
      });
      fixState.attempts = 0;
    }
    send('recipe', recipe);
    await updateConversationTitle(pool, convId, recipe.title, send);
    await pool.query(
      'INSERT INTO messages (conversation_id, role, content, recipe_data) VALUES ($1, $2, $3, $4)',
      [convId, 'assistant', `[Recipe: ${recipe.title}]`, JSON.stringify(recipe)]
    );
    log.info('recipe', 'Valid recipe displayed', { title: recipe.title });
    return 'Recipe displayed successfully.';
  }

  log.warn('recipe', 'Validation failed', { attempt: fixState.attempts, errors });

  if (fixState.attempts < MAX_VALIDATION_RETRIES) {
    fixState.attempts += 1;
    fixState.pending = { attempt: fixState.attempts, startedAt: Date.now() };
    send('status', { text: 'Fixing recipe format...', kind: 'fixup' });
    log.warn('recipe', 'Requesting fix-up from model', {
      attempt: fixState.attempts,
      max_attempts: MAX_VALIDATION_RETRIES,
      errors,
    });
    return `Recipe validation failed with these errors:\n${errors.join('\n')}\n\nPlease fix the issues and call display_recipe again.\n\n${getSchemaReminder()}`;
  }

  log.error('recipe', 'Validation failed after retries, sending best-effort', {
    attempts: fixState.attempts,
    errors,
  });
  fixState.attempts = 0;
  send('warning', { text: 'Recipe may have formatting issues' });
  send('recipe', recipe);
  await updateConversationTitle(pool, convId, recipe.title || 'Untitled', send);
  await pool.query(
    'INSERT INTO messages (conversation_id, role, content, recipe_data) VALUES ($1, $2, $3, $4)',
    [convId, 'assistant', `[Recipe: ${recipe.title || 'Untitled'}]`, JSON.stringify(recipe)]
  );
  return 'Recipe displayed (with formatting issues).';
}

async function updateConversationTitle(pool, convId, title, send) {
  try {
    const { rowCount } = await pool.query(
      "UPDATE conversations SET title = $1 WHERE id = $2 AND title != $1",
      [title, convId]
    );
    if (rowCount > 0 && send) {
      send('title_update', { id: convId, title });
    }
  } catch (err) {
    log.warn('chat', 'Failed to update conversation title', { message: err.message });
  }
}

module.exports = { chatRoutes };
