const { Router } = require('express');
const { EventEmitter } = require('events');
const { getPool } = require('../db/pool');
const { createMessage, streamMessage, isRetryable, isEnabled, buildSystemPrompt, getCreateParams, resolveModel, defaultModelFor, resolveLocale, estimateMicrocents, isToolChoiceUnsupported, LLM_IDLE_TIMEOUT_MS, LLM_MAX_TURN_MS } = require('../services/llm');
const { validate, getSchemaReminder } = require('../services/recipe-validator');
const { fetchWebpage, MAX_CONTENT_LENGTH } = require('../services/web');
const { webSearch, init: initSearch } = require('../services/search');
const { rateLimitMiddleware } = require('../middleware/rate-limit');
const log = require('../services/logger');

const MAX_VALIDATION_RETRIES = 2;

// Accepted values for pending_replies.edit_decision (see schema.sql).
// 'superseded' is written server-side when a newer reply retires an older
// undecided proposal, and client-side when the user answers a diff by
// sending another message instead of choosing.
const EDIT_DECISIONS = new Set(['accepted', 'rejected', 'superseded']);

// Tighter activity budget for the recipe fix-up call ("Fixing recipe
// format..."): the user is already waiting on a spinner at that point, so give
// up on a stall sooner than a normal turn does.
const RECIPE_FIXUP_IDLE_MS = 45_000;
const RECIPE_FIXUP_MAX_MS = 180_000;

// Whole-reply wall clock. Per-turn budgets alone would allow 5 × LLM_MAX_TURN_MS
// of looping, so the reply itself gets a ceiling; hitting it delivers whatever
// was produced rather than starting another turn (issue #43).
const REPLY_BUDGET_MS = 480_000;

// Bounded retry for transient upstream failures (overload, 5xx, a stall before
// anything streamed). Two attempts past the first, backed off with jitter.
const MAX_LLM_RETRIES = 2;
const RETRY_BACKOFF_MS = [1000, 4000];

// Streamed deltas are coalesced before they become events: every `send` writes
// a JSONB append to pending_replies, and one DB round-trip per token would
// rewrite the whole column hundreds of times per reply. Flushing on either
// bound keeps the write rate close to the pre-streaming behaviour while the UI
// still updates 2–3× per second.
const DELTA_FLUSH_MS = 400;
const DELTA_FLUSH_CHARS = 1500;

// SSE keepalive. A silent turn used to leave the stream idle for minutes,
// which intermediary proxies are entitled to close.
const SSE_HEARTBEAT_MS = 15_000;

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

// Build the per-reply event sender.
//
// Invariant preserved from the pre-streaming design: every event gets exactly
// one monotonic index and is BOTH emitted and persisted, so the `?after=N`
// replay path and the client's dedup() keep working. What's new is
// `sendDelta` — streamed text/thinking is buffered and flushed as a single
// event on a time or size bound, because one DB append per token would rewrite
// the whole `events` JSONB column hundreds of times per reply.
function makeSender(pool, replyId) {
  const emitter = getOrCreateEmitter(replyId);
  let eventIndex = 0;
  let buffered = null; // { event, text }
  let flushTimer = null;

  const emit = (event, data) => {
    const evt = { index: eventIndex++, event, data };
    emitter.emit('event', evt);
    pool.query(
      `UPDATE pending_replies SET events = events || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify([evt]), replyId]
    ).catch((err) => log.warn('chat', 'Failed to persist event', { message: err.message }));
  };

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!buffered) return;
    const { event, text } = buffered;
    buffered = null;
    if (text) emit(event, { text });
  };

  // Any non-delta event flushes first, so ordering on screen matches the
  // order the model produced things (text before the tool status line).
  const send = (event, data) => {
    flush();
    emit(event, data);
  };

  send.delta = (event, text) => {
    if (!text) return;
    if (buffered && buffered.event !== event) flush();
    if (!buffered) buffered = { event, text: '' };
    buffered.text += text;
    if (buffered.text.length >= DELTA_FLUSH_CHARS) {
      flush();
      return;
    }
    if (!flushTimer) flushTimer = setTimeout(flush, DELTA_FLUSH_MS);
  };

  send.flush = flush;

  return send;
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

    // AI output language comes from the platform-level user preference (the
    // JWT locale claim), not from the client body — any client-sent value
    // is replaced. Unresolvable/unset locale → null → no prompt directive.
    const effectivePrefs = {
      ...(preferences || {}),
      language: resolveLocale(req.user.locale),
    };

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
        const convPrefs = effectivePrefs;

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

      // This reply's recipe supersedes any earlier proposal the user never
      // answered, so retire those rows now. Without this, an older undecided
      // reply resurfaces as "the" pending reply once a newer one is decided
      // and re-shows a diff the user already dealt with (issue #24).
      await pool.query(
        `UPDATE pending_replies SET edit_decision = 'superseded', decided_at = NOW(), updated_at = NOW()
         WHERE conversation_id = $1 AND id <> $2 AND edit_decision IS NULL AND status <> 'processing'`,
        [convId, replyId]
      ).catch((err) =>
        log.warn('chat', 'Failed to supersede older replies', { message: err.message }));

      const send = makeSender(pool, replyId);

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
      let userModel = defaultModelFor(config);
      try {
        const { rows: settingsRows } = await pool.query(
          'SELECT preferences FROM user_settings WHERE user_id = $1',
          [req.user.id]
        );
        const savedModel = settingsRows.length ? (settingsRows[0].preferences || {}).model : null;
        if (savedModel) userModel = resolveModel(savedModel, userModel);
      } catch (err) {
        log.warn('chat', 'Failed to load user model preference', { message: err.message });
      }

      runBackgroundStream(
        userToken, config, pool, convId, replyId, req.user.id, userModel,
        effectivePrefs, send, userMsgId
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

    // Listen BEFORE reading the stored events. Listening after the SELECT
    // left a gap: anything emitted while the query ran was in neither the
    // rows read nor the live feed, so a reload mid-reply lost it (issue #52).
    const hadEmitter = replyEmitters.has(replyId);
    const emitter = getOrCreateEmitter(replyId);
    const buffer = [];
    let onEvent = (evt) => { buffer.push(evt); };
    let finished = false;
    let onFinish = () => { finished = true; };
    const eventListener = (evt) => onEvent(evt);
    const finishListener = () => onFinish();
    emitter.on('event', eventListener);
    emitter.once('finish', finishListener);
    const detach = () => {
      emitter.removeListener('event', eventListener);
      emitter.removeListener('finish', finishListener);
    };

    try {
      const { rows } = await pool.query(
        'SELECT id, status, events FROM pending_replies WHERE id = $1 AND user_id = $2',
        [replyId, req.user.id]
      );
      if (!rows.length) {
        detach();
        if (!hadEmitter) cleanupEmitter(replyId);
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

      // Keepalive comment lines: EventSource ignores them and they carry no
      // index, so nothing downstream changes — but they stop an intermediary
      // proxy from closing the stream during a long silent turn.
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
      }, SSE_HEARTBEAT_MS);
      const endStream = () => {
        clearInterval(heartbeat);
        res.end();
      };

      // Stored events and the ones buffered while the query ran overlap;
      // send each index once, in order.
      const pending = new Map();
      for (const evt of [...(reply.events || []), ...buffer]) {
        if (evt.index > after && !pending.has(evt.index)) pending.set(evt.index, evt);
      }
      buffer.length = 0;
      let maxSent = after;
      for (const evt of [...pending.values()].sort((a, b) => a.index - b.index)) {
        writeSse(evt);
        maxSent = evt.index;
      }

      onEvent = (evt) => {
        if (evt.index <= maxSent) return;
        try { writeSse(evt); } catch { detach(); }
      };
      onFinish = () => {
        finished = true;
        detach();
        endStream();
      };

      if (reply.status === 'done' || reply.status === 'error' || finished) {
        detach();
        if (reply.status === 'error') {
          writeSse({ event: 'error', data: { error: 'Response was interrupted' }, index: maxSent + 1 });
        } else if (reply.status === 'done') {
          writeSse({ event: 'done', data: {}, index: maxSent + 1 });
        }
        endStream();
        return;
      }

      req.on('close', () => {
        clearInterval(heartbeat);
        detach();
      });
    } catch (err) {
      detach();
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

  // Record the user's decision on a reply that proposed a recipe edit. Writes
  // `edit_decision` only — `status` stays lifecycle-only, so this can be
  // called while the reply is still streaming without tripping the client's
  // stale checker (that constraint is what made issue #16's fix lossy).
  // Idempotent: repeated calls just rewrite the same decision.
  router.patch('/api/chat/:replyId/acknowledge', async (req, res) => {
    const replyId = parseInt(req.params.replyId);
    const decision = (req.body && req.body.decision) || 'accepted';
    if (!EDIT_DECISIONS.has(decision)) {
      return res.status(400).json({ error: 'Invalid decision' });
    }
    try {
      const { rowCount } = await pool.query(
        `UPDATE pending_replies SET edit_decision = $3, decided_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND ${config.isStaging ? 'user_id IN ($2, 0)' : 'user_id = $2'}`,
        [replyId, req.user.id, decision]
      );
      // 0 rows means the decision was NOT recorded — tell the client so it can
      // retry instead of assuming success (the old fire-and-forget behaviour).
      if (!rowCount) return res.status(404).json({ error: 'Reply not found' });
      res.json({ ok: true, decision });
    } catch (err) {
      log.error('chat', 'Acknowledge error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Re-run a reply that failed, reusing the user message that produced it
  // (issue #43). Deliberately NOT behind rateLimitMiddleware: the failed
  // attempt already spent a message from the daily allowance and returned
  // nothing, so the retry is free.
  router.post('/api/chat/:replyId/retry', async (req, res) => {
    const replyId = parseInt(req.params.replyId);
    if (Number.isNaN(replyId)) return res.status(400).json({ error: 'Invalid reply id' });

    if (!isEnabled(config)) {
      return res.status(503).json({
        error: 'AI features are unavailable in this environment.',
        code: 'llm_unavailable',
      });
    }

    const userToken = req.headers['x-usernode-token'] || req.query.token || '';

    try {
      const { rows } = await pool.query(
        `SELECT id, conversation_id, status FROM pending_replies
         WHERE id = $1 AND ${config.isStaging ? 'user_id IN ($2, 0)' : 'user_id = $2'}`,
        [replyId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Reply not found' });

      const failed = rows[0];
      if (failed.status !== 'error') {
        return res.status(409).json({ error: 'That reply did not fail', status: failed.status });
      }

      const convId = failed.conversation_id;

      // Reuse the existing user message — no new row, so the retry never
      // duplicates what the user typed.
      const { rows: msgRows } = await pool.query(
        `SELECT id FROM messages WHERE conversation_id = $1 AND role = 'user'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [convId]
      );
      if (!msgRows.length) return res.status(409).json({ error: 'Nothing to retry' });
      const userMsgId = msgRows[0].id;

      const { rows: convRows } = await pool.query(
        'SELECT preferences FROM conversations WHERE id = $1',
        [convId]
      );
      const effectivePrefs = {
        ...((convRows[0] && convRows[0].preferences) || {}),
        language: resolveLocale(req.user.locale),
      };

      const { rows: replyRows } = await pool.query(
        'INSERT INTO pending_replies (conversation_id, user_id) VALUES ($1, $2) RETURNING id',
        [convId, req.user.id]
      );
      const newReplyId = replyRows[0].id;

      await pool.query(
        `UPDATE pending_replies SET edit_decision = 'superseded', decided_at = NOW(), updated_at = NOW()
         WHERE conversation_id = $1 AND id <> $2 AND edit_decision IS NULL AND status <> 'processing'`,
        [convId, newReplyId]
      ).catch((err) =>
        log.warn('chat', 'Failed to supersede older replies', { message: err.message }));

      let userModel = defaultModelFor(config);
      try {
        const { rows: settingsRows } = await pool.query(
          'SELECT preferences FROM user_settings WHERE user_id = $1',
          [req.user.id]
        );
        const savedModel = settingsRows.length ? (settingsRows[0].preferences || {}).model : null;
        if (savedModel) userModel = resolveModel(savedModel, userModel);
      } catch (err) {
        log.warn('chat', 'Failed to load user model preference', { message: err.message });
      }

      log.info('chat', 'Retrying failed reply', {
        failedReplyId: replyId, replyId: newReplyId, conversationId: convId,
      });

      const send = makeSender(pool, newReplyId);

      // The new reply writes into the SAME user message's response_log, so a
      // successful retry replaces the failed attempt's log in history.
      runBackgroundStream(
        userToken, config, pool, convId, newReplyId, req.user.id, userModel,
        effectivePrefs, send, userMsgId
      );

      res.status(202).json({ conversationId: convId, replyId: newReplyId });
    } catch (err) {
      log.error('chat', 'Retry error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Keep the user message's response_log in step with what the client has been
// shown, so a reload (or a restart mid-reply) renders the same progress lines
// in the same order (issue #52). Writes run one at a time and each serializes
// the log when it starts, so an older snapshot can never land after a newer
// one. `save.soon()` is the throttled form for streamed deltas.
function makeLogSaver(pool, userMsgId, responseLog) {
  let tail = Promise.resolve();
  let queued = null;
  let timer = null;

  const save = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queued) return queued;
    queued = tail.then(() => {
      queued = null;
      // `open` is the in-memory marker for appending deltas; never persisted.
      const json = JSON.stringify(responseLog, (k, v) => (k === 'open' ? undefined : v));
      return pool.query('UPDATE messages SET response_log = $1::jsonb WHERE id = $2', [json, userMsgId]);
    }).catch((err) => log.warn('chat', 'Failed to save response_log', { message: err.message }));
    tail = queued;
    return queued;
  };

  save.soon = () => {
    if (!timer && !queued) timer = setTimeout(save, DELTA_FLUSH_MS);
  };

  return save;
}

async function runBackgroundStream(
  userToken, config, pool, convId, replyId, userId, userModel, preferences, send, userMsgId
) {
  const responseLog = [];
  const saveLog = makeLogSaver(pool, userMsgId, responseLog);
  const startTime = Date.now();

  // Log entries carry structured fields (kind/query/url/title) alongside the
  // English `text` so the client can render them in the user's language;
  // `text` stays as the fallback for rows persisted before this existed.
  //
  // Streamed thinking arrives as many small deltas, so the log keeps ONE
  // 'thinking' entry per turn and appends into its `detail` rather than
  // pushing an entry per delta.
  const trackingSend = (event, data) => {
    if (event === 'thinking') {
      const last = responseLog[responseLog.length - 1];
      if (last && last.type === 'thinking' && last.open) {
        last.detail = (last.detail || '') + (data.text || '');
      } else {
        responseLog.push({
          type: 'thinking', kind: 'thinking', text: 'Thinking...',
          detail: data.text || '', open: true,
        });
      }
      send.delta('thinking', data.text);
      saveLog.soon();
      return;
    }

    // Prose is logged as it streams, the same way: one {type:'text'} entry
    // per run of text, so text written after a tool call in the same turn, or
    // before a turn failed, is kept in the order it appeared.
    if (event === 'token') {
      if (data.text) {
        const last = responseLog[responseLog.length - 1];
        if (last && last.type === 'text' && last.open) {
          last.content += data.text;
        } else {
          responseLog.push({ type: 'text', content: data.text, open: true });
        }
      }
      send.delta('token', data.text);
      saveLog.soon();
      return;
    }

    // Any other event closes the open thinking/text entries so a later turn
    // starts fresh ones.
    for (const entry of responseLog) {
      if (entry.open) delete entry.open;
    }

    if (event === 'status') {
      const entry = { type: 'status', text: data.text };
      if (data.kind) entry.kind = data.kind;
      if (data.query) entry.query = data.query;
      if (data.url) entry.url = data.url;
      responseLog.push(entry);
    } else if (event === 'recipe') {
      responseLog.push({ type: 'recipe', kind: 'recipe', title: data.title, text: `Created recipe: ${data.title}` });
    } else if (event === 'warning') {
      const entry = { type: 'warning', text: data.text };
      if (data.kind) entry.kind = data.kind;
      responseLog.push(entry);
    } else if (event === 'error') {
      // Persisting the failure is what makes it survive a reload — before
      // this, a timed-out reply reopened as a conversation that just stopped
      // mid-sentence, with no error and no way to retry (issue #43).
      markLastStatusFailed(responseLog);
      const entry = {
        type: 'error',
        kind: data.code || 'llm_failed',
        text: data.error,
        ok: false,
      };
      // Structured debug detail (issue #105): rides along so a reloaded
      // history renders the same "Details" box the live stream showed.
      if (data.detail && typeof data.detail === 'object') entry.detail = data.detail;
      responseLog.push(entry);
    }
    send(event, data);
    saveLog();
  };
  trackingSend.flush = () => send.flush();

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

    // A retry re-runs a conversation whose history now ends on the failed
    // reply's own assistant rows (progress text, the failure sentinel).
    // Current models reject a conversation ending on an assistant turn as a
    // prefill (HTTP 400), which is what made "Try again" fail a second time
    // and stack a generic "The AI request failed." under the first error
    // (issue #105). A short in-memory note reopens the turn; it is never
    // inserted into messages. New sends always end on a user row, so in
    // practice only retries land here.
    if (messages.length && messages[messages.length - 1].role === 'assistant') {
      messages.push({
        role: 'user',
        content: '[System: The previous attempt to answer the message above failed partway through. Answer it again now.]',
      });
      log.info('chat', 'History ended on an assistant row — added retry note', {
        conversationId: convId,
        replyId,
      });
    }

    log.info('chat', 'Starting stream', {
      conversationId: convId,
      replyId,
      userId,
      model: userModel,
      messageCount: messages.length,
    });

    const result = await streamWithToolHandling(
      userToken, config, messages, systemPrompt, trackingSend, convId, replyId, pool, userId, userModel,
      responseLog, userMsgId
    );

    const elapsed = Date.now() - startTime;
    log.info('chat', 'Stream complete', {
      conversationId: convId,
      replyId,
      elapsed_ms: elapsed,
      usage: result.usage,
    });

    sealResponseLog(responseLog);
    await saveLog();

    send('done', {});

    await pool.query(
      `UPDATE pending_replies SET status = 'done', updated_at = NOW() WHERE id = $1 AND status = 'processing'`,
      [replyId]
    );
  } catch (err) {
    // Structured failure detail (issue #105): the specific fields the failing
    // step attached, plus the reply-level ones every failure carries.
    const detail = {
      code: err.code || 'llm_failed',
      replyId,
      conversationId: convId,
      reply_elapsed_ms: Date.now() - startTime,
      ...err.detail,
    };
    if (!err.detail) {
      if (err.status != null) detail.upstream_status = err.status;
      if (err.upstreamMessage) detail.upstream_message = String(err.upstreamMessage).slice(0, 300);
    }
    log.error('chat', 'Background stream error', {
      message: err.message, code: err.code, replyId, conversationId: convId, detail,
    });
    // trackingSend (not the raw sender) so the failure lands in response_log
    // and survives a reload.
    trackingSend('error', { error: err.userMessage || 'Something went wrong', code: err.code, detail });
    sealResponseLog(responseLog);
    if (responseLog.length) await saveLog();

    await pool.query(
      `UPDATE pending_replies SET status = 'error', updated_at = NOW() WHERE id = $1 AND status = 'processing'`,
      [replyId]
    ).catch(() => {});
  } finally {
    if (send.flush) send.flush();
    const emitter = getOrCreateEmitter(replyId);
    emitter.emit('finish');
    setTimeout(() => cleanupEmitter(replyId), 5000);
  }
}

// Drop the transient `open` marker used to append streamed thinking deltas into
// one log entry — it's bookkeeping, not something to persist.
function sealResponseLog(responseLog) {
  for (const entry of responseLog) {
    if (entry && entry.open) delete entry.open;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One turn's LLM call: streaming by default, with a bounded retry for transient
// failures and a non-streaming fallback if the stream can't be opened at all.
//
// Deltas go straight to `send.delta`, which coalesces them into periodic
// events — so the client sees prose appear as it's written instead of waiting
// for the whole reply. That's the core of the timeout fix: nothing has to
// finish inside a single fixed budget any more.
async function callModel(config, params, userToken, budget, send, replyState, turn) {
  for (let attempt = 0; ; attempt++) {
    // Only the FIRST attempt may stream when a previous turn already proved
    // streaming is unavailable in this environment.
    const canStream = !replyState.streamUnavailable;
    let sawDelta = false;

    try {
      if (canStream) {
        const message = await streamMessage(config, params, userToken, {
          idleMs: budget.idleMs,
          maxMs: budget.maxMs,
          onDelta: ({ type, text }) => {
            sawDelta = true;
            // Routed through the tracking sender so thinking still accumulates
            // into the response log; it coalesces these into periodic events.
            send(type === 'thinking' ? 'thinking' : 'token', { text });
          },
        });
        // Tells the caller the text/thinking blocks already reached the client
        // incrementally, so it must not re-send them whole.
        message._streamed = true;
        return message;
      }
      // Fallback transport: no incremental delivery, so give it the same total
      // ceiling the streaming path gets rather than the old flat 120s.
      return await createMessage(config, params, userToken, { timeoutMs: budget.maxMs });
    } catch (err) {
      // The stream never opened (proxy doesn't support SSE, immediate network
      // failure). Retry this same attempt over the non-streaming transport
      // before treating it as a real failure.
      if (canStream && err.streamNeverOpened && !isBudgetCode(err.code)) {
        log.warn('llm', 'Stream could not be opened — falling back to non-streaming', {
          turn, code: err.code, error: err.message,
        });
        replyState.streamUnavailable = true;
        try {
          return await createMessage(config, params, userToken, { timeoutMs: budget.maxMs });
        } catch (fallbackErr) {
          err = fallbackErr;
        }
      }

      // A timeout that already put prose on screen must not be retried —
      // re-running the turn would duplicate what the user can see.
      if (sawDelta) err.streamedContent = true;

      if (attempt < MAX_LLM_RETRIES && isRetryable(err)) {
        const base = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
        const jitter = base * 0.25;
        const delay = Math.round(base - jitter + Math.random() * jitter * 2);
        log.warn('llm', 'Retrying after transient failure', {
          turn, attempt: attempt + 1, max: MAX_LLM_RETRIES,
          code: err.code, status: err.status, delay_ms: delay,
        });
        send('status', { kind: 'retrying', text: 'Retrying…' });
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

function isBudgetCode(code) {
  return code === 'grant_required' || code === 'app_cap_exceeded'
    || code === 'budget_exceeded' || code === 'llm_unavailable';
}

async function streamWithToolHandling(
  userToken, config, messages, systemPrompt, send, convId, replyId, pool, userId, userModel,
  responseLog, userMsgId
) {
  let currentMessages = [...messages];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };

  // Recipe-validation fix-up state, shared across turns: `attempts` counts
  // how many fix-up rounds we've asked the model for (bounded by
  // MAX_VALIDATION_RETRIES), `pending` marks that the NEXT LLM call is a
  // fix-up call — it gets a tighter activity budget, a prompt asking the
  // model to call display_recipe again, and '[recipe]' logging — and `lastErrors` keeps the most recent
  // validation errors for failure reporting.
  const fixState = { attempts: 0, pending: null, lastErrors: null };

  // Set once a VALID recipe reaches the client. After that, a later turn
  // timing out is a partial success — deliver what we have with a warning
  // instead of erroring the whole reply away (issue #43).
  // `toolChoiceUnsupported`: set once the model rejects forced tool_choice
  // (issue #108) — the rest of this reply then never forces it again, so a
  // second fix-up can't hit the same 400. `truncationRetried`: one-time
  // second chance for a turn cut off at max_tokens before display_recipe ran.
  const replyState = {
    recipeDelivered: false,
    streamUnavailable: false,
    toolChoiceUnsupported: false,
    truncationRetried: false,
  };
  const replyStartedAt = Date.now();

  for (let turn = 0; turn < 5; turn++) {
    // Reply-level ceiling: without it, five turns of LLM_MAX_TURN_MS could run
    // for 25 minutes.
    if (Date.now() - replyStartedAt > REPLY_BUDGET_MS) {
      log.warn('chat', 'Reply budget exhausted', {
        conversationId: convId,
        replyId,
        turn, elapsed_ms: Date.now() - replyStartedAt, budget_ms: REPLY_BUDGET_MS,
      });
      if (replyState.recipeDelivered) {
        send('warning', { kind: 'truncated', text: 'Response was cut off' });
        return { usage: totalUsage };
      }
      const err = new Error('Reply budget exhausted');
      err.code = 'turn_too_long';
      err.userMessage = 'The AI is taking much longer than expected. Please try again — asking for a simpler recipe usually helps.';
      throw err;
    }

    const params = getCreateParams(config, currentMessages, systemPrompt, {
      model: userModel,
      // Fix-up turns rely on the fix-up tool result prompt to get
      // display_recipe called again; the turn is failed loudly below if it
      // doesn't.
      fixup: !!fixState.pending,
    });

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
    const budget = fixup
      ? { idleMs: RECIPE_FIXUP_IDLE_MS, maxMs: RECIPE_FIXUP_MAX_MS }
      : { idleMs: LLM_IDLE_TIMEOUT_MS, maxMs: LLM_MAX_TURN_MS };

    if (fixup) {
      log.info('recipe', 'Fix-up call starting', {
        conversationId: convId,
        replyId,
        attempt: fixup.attempt,
        max_attempts: MAX_VALIDATION_RETRIES,
        model: params.model,
        idle_ms: budget.idleMs,
        max_ms: budget.maxMs,
      });
    }

    let response;
    try {
      try {
        response = await callModel(
          config, params, userToken, budget, send, replyState, turn
        );
      } catch (err) {
        // Sonnet 5.5 / Opus 5.5 reject forced tool_choice with a 400 (issue
        // #108). Retry the fix-up once without forcing — the system prompt
        // already instructs the model to always call display_recipe. Only an
        // error from this second call reaches the fix-up catch below.
        if (fixup && !replyState.toolChoiceUnsupported && isToolChoiceUnsupported(err)) {
          log.warn('recipe', 'Forced tool_choice rejected, retrying fix-up without it', {
            conversationId: convId,
            replyId,
            attempt: fixup.attempt,
            upstream_message: (err.upstreamMessage || err.message || '').slice(0, 300),
          });
          replyState.toolChoiceUnsupported = true;
          const unforcedParams = getCreateParams(config, currentMessages, systemPrompt, {
            model: userModel,
            fixup: true,
          });
          response = await callModel(
            config, unforcedParams, userToken, budget, send, replyState, turn
          );
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (fixup) {
        const fixupElapsedMs = Date.now() - fixup.startedAt;
        log.error('recipe', 'Fix-up call failed', {
          conversationId: convId,
          replyId,
          attempt: fixup.attempt,
          max_attempts: MAX_VALIDATION_RETRIES,
          elapsed_ms: fixupElapsedMs,
          status: err.status,
          code: err.code,
          upstream_message: (err.upstreamMessage || err.message || '').slice(0, 300),
          error: err.message,
        });
        err.userMessage = err.code === 'timeout'
          ? 'Fixing the recipe format timed out. Please try again.'
          : err.code === 'turn_too_long'
            ? 'Fixing the recipe format is taking much longer than expected. Please try again.'
            : (err.userMessage || 'Fixing the recipe format failed. Please try again.');
        // Structured failure detail for the error event / response_log (issue
        // #105) — the client parks it behind a closed "Details" toggle.
        err.detail = {
          stage: 'fixup',
          turn,
          attempt: fixup.attempt,
          max_attempts: MAX_VALIDATION_RETRIES,
          step_elapsed_ms: fixupElapsedMs,
          upstream_status: err.status,
          upstream_code: err.code,
          upstream_message: (err.upstreamMessage || err.message || '').slice(0, 300) || undefined,
          validation_errors: (fixState.lastErrors || []).slice(0, 5).map((e) => String(e).slice(0, 200)),
        };
        // When the error is about to be rethrown (not the partial-delivery
        // branch below), persist the sentinel here too so the next turn knows
        // the edit never applied — same as the in-loop failure paths.
        const partialDelivery = replyState.recipeDelivered
          && (err.code === 'timeout' || err.code === 'turn_too_long');
        if (!partialDelivery) {
          const reason = fixState.lastErrors?.length
            ? `Validation errors: ${fixState.lastErrors.slice(0, 3).join('; ')}.`
            : 'The fix-up call failed before a recipe arrived.';
          await persistRecipeFailureSentinel(pool, convId, reason, {
            code: err.code,
            attempt: fixup.attempt,
            max_attempts: MAX_VALIDATION_RETRIES,
            step_elapsed_ms: fixupElapsedMs,
          });
        }
      }
      // A recipe already landed this reply — keep it rather than throwing the
      // whole turn away.
      if (replyState.recipeDelivered
          && (err.code === 'timeout' || err.code === 'turn_too_long')) {
        log.warn('chat', 'Turn failed after a recipe was delivered — partial delivery', {
          turn, code: err.code,
        });
        send('warning', { kind: 'truncated', text: 'Response was cut off' });
        return { usage: totalUsage };
      }
      throw err;
    }

    const calledDisplayRecipe = response.content.some(
      (b) => b.type === 'tool_use' && b.name === 'display_recipe'
    );
    const truncated = response.stop_reason === 'max_tokens';

    if (fixup) {
      fixState.pending = null;
      log.info('recipe', 'Fix-up response received', {
        conversationId: convId,
        replyId,
        attempt: fixup.attempt,
        elapsed_ms: Date.now() - fixup.startedAt,
        stop_reason: response.stop_reason,
        called_display_recipe: calledDisplayRecipe,
      });
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
    // Streamed turns already pushed every text/thinking delta to the client as
    // it arrived; replaying the finished blocks here would duplicate them.
    const alreadyStreamed = !!response._streamed;

    for (const block of response.content) {
      if (block.type === 'thinking') {
        if (!alreadyStreamed) send('thinking', { text: block.thinking });
      } else if (block.type === 'text') {
        assistantText += block.text;
        if (!alreadyStreamed) send('token', { text: block.text });
      } else if (block.type === 'tool_use') {
        const toolResult = await handleToolCall(
          block, config, currentMessages, systemPrompt, send, convId, replyId, pool, userId, responseLog,
          fixState, replyState
        );
        toolResults.push({ toolUseId: block.id, result: toolResult });
      }
    }

    // The text itself is already in responseLog: trackingSend logs every
    // 'token' event, streamed or not.
    if (assistantText) {
      await pool.query(
        'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
        [convId, 'assistant', assistantText]
      );
    }

    // A turn cut off at max_tokens before display_recipe ran: retry once
    // (issue #108) rather than failing the reply straight away. The cut-off
    // assistant text is already on screen and in the log; the replay below
    // keeps only its text blocks so the API accepts the new turn, and a nudge
    // tells the model to get to the recipe. Truncation mid-tool-call produces
    // `input = {}` instead, so calledDisplayRecipe is true there and the
    // normal validation fix-up round handles it.
    if (truncated && !calledDisplayRecipe && !replyState.truncationRetried) {
      replyState.truncationRetried = true;
      log.warn('recipe', 'Turn truncated before display_recipe — retrying once', {
        conversationId: convId,
        replyId,
        turn,
        fixup_attempt: fixup ? fixup.attempt : null,
      });
      send('status', { kind: 'retrying', text: 'Retrying…' });
      const NUDGE = 'Your previous response was cut off by the output length limit before display_recipe was called. Keep any text very brief and call display_recipe now with the full recipe.';
      const textBlocks = response.content
        .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
        .map((b) => ({ type: 'text', text: b.text }));
      if (textBlocks.length) {
        // Thinking blocks are dropped: this starts a fresh user turn, not a
        // tool-use continuation, so no signature is needed.
        currentMessages.push({ role: 'assistant', content: textBlocks });
        currentMessages.push({ role: 'user', content: NUDGE });
      } else {
        // No prose before the cut — the last message is already a user turn
        // (the user's message or a tool_result); append the nudge to it so
        // roles still alternate.
        const last = currentMessages[currentMessages.length - 1];
        if (typeof last.content === 'string') {
          last.content = [{ type: 'text', text: last.content }];
        }
        last.content.push({ type: 'text', text: NUDGE });
      }
      // Keep the fix-up loop semantics for a cut-off fix-up turn: the next
      // call is still a fix-up attempt (tighter budget, '[recipe]' logging).
      if (fixup) {
        fixState.pending = { attempt: fixup.attempt, startedAt: Date.now() };
      }
      continue;
    }

    // A fix-up turn that produced no display_recipe call (tool choice is not
    // forced, so the model can answer with text only), or any turn truncated at
    // max_tokens with its display_recipe block dropped, must fail loudly —
    // ending with 'done' here is exactly the silent "Fixing recipe
    // format..." dead end.
    if (!calledDisplayRecipe && (fixup || truncated)) {
      log.error('recipe', 'Recipe reply failed without a display_recipe call', {
        conversationId: convId,
        replyId,
        fixup_attempt: fixup ? fixup.attempt : null,
        stop_reason: response.stop_reason,
        truncated,
      });
      const reason = truncated
        ? 'The response was cut off by the output length limit.'
        : (fixState.lastErrors?.length
          ? `Validation errors: ${fixState.lastErrors.slice(0, 3).join('; ')}.`
          : 'The display_recipe tool call never arrived.');
      await failRecipeReply(pool, convId, responseLog, reason, {
        turn,
        attempt: fixup ? fixup.attempt : null,
        max_attempts: MAX_VALIDATION_RETRIES,
        step_elapsed_ms: fixup ? Date.now() - fixup.startedAt : null,
        stop_reason: response.stop_reason,
        validation_errors: fixState.lastErrors,
      });
    }

    // Truncation after a completed recipe call: the recipe went through but
    // trailing text was cut — deliver what we have and say so.
    if (truncated && !fixState.pending) {
      log.warn('chat', 'Response truncated at max_tokens', { turn });
      send('warning', { kind: 'truncated', text: 'Response was cut off' });
    }

    // Keep looping while a fix-up is owed even if stop_reason isn't
    // 'tool_use' (e.g. max_tokens hit right after the tool block closed).
    if (toolResults.length === 0 || (response.stop_reason !== 'tool_use' && !fixState.pending)) {
      if (send.flush) send.flush();
      return { usage: totalUsage };
    }

    currentMessages.push({
      role: 'assistant',
      // Reassembled streaming blocks can end up empty (a text block the model
      // opened and never filled), which the API rejects on the replay. Thinking
      // blocks keep their `signature` — without it the next turn 400s.
      content: response.content.filter((b) => {
        if (b.type === 'text') return typeof b.text === 'string' && b.text.length > 0;
        if (b.type === 'thinking') return typeof b.thinking === 'string' && b.thinking.length > 0;
        return true;
      }),
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
      conversationId: convId,
      replyId,
      attempt: fixState.pending.attempt,
    });
    const reason = fixState.lastErrors?.length
      ? `Validation errors: ${fixState.lastErrors.slice(0, 3).join('; ')}.`
      : 'The turn limit was reached before the fix-up completed.';
    await failRecipeReply(pool, convId, responseLog, reason, {
      attempt: fixState.pending.attempt,
      max_attempts: MAX_VALIDATION_RETRIES,
      step_elapsed_ms: Date.now() - fixState.pending.startedAt,
      validation_errors: fixState.lastErrors,
    });
  }

  return { usage: totalUsage };
}

// Terminal recipe failure: mark the in-flight fix-up log entry as failed
// (so reloaded history shows an ✕, not a ✓), record a sentinel row in the
// conversation so the model's next turn knows the edit never applied, then
// throw a coded error that the background-stream catch surfaces to the user.
// Mark the most recent still-in-flight status entry as failed, so reloaded
// history shows an ✕ on the step that actually died (the "Reading: …" line for
// a timeout after a web read) instead of a misleading checkmark.
function markLastStatusFailed(responseLog, kind = null) {
  for (let i = responseLog.length - 1; i >= 0; i--) {
    const entry = responseLog[i];
    if (entry.type !== 'status') continue;
    if (kind && entry.kind !== kind) continue;
    if (entry.ok === undefined) entry.ok = false;
    return;
  }
}

// Debug trailer on the failure sentinel, e.g.
// " (code: recipe_fixup_failed, attempt 2 of 2, after 38s)" — issue #105.
function failureTrailer(info) {
  const parts = [`code: ${info?.code || 'recipe_fixup_failed'}`];
  if (info?.attempt != null) {
    parts.push(`attempt ${info.attempt}${info.max_attempts != null ? ` of ${info.max_attempts}` : ''}`);
  }
  if (info?.step_elapsed_ms != null) parts.push(`after ${Math.round(info.step_elapsed_ms / 1000)}s`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

// Record the assistant-side sentinel row that tells the model's next turn the
// edit never applied. Kept separate from failRecipeReply so the fix-up-catch
// path (an LLM failure mid "Fixing recipe format...") can persist it too.
async function persistRecipeFailureSentinel(pool, convId, reason, info) {
  await pool.query(
    'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
    [convId, 'assistant',
      `[Recipe update FAILED — display_recipe was not called successfully.${failureTrailer(info)} ${reason} ` +
      'The current recipe is unchanged; you must call display_recipe with the full corrected recipe on your next turn.]']
  ).catch((err) => log.warn('chat', 'Failed to persist recipe-failure sentinel', { message: err.message }));
}

async function failRecipeReply(pool, convId, responseLog, reason, info = {}) {
  markLastStatusFailed(responseLog, 'fixup');
  await persistRecipeFailureSentinel(pool, convId, reason, info);

  const err = new Error('Recipe fix-up failed');
  err.code = 'recipe_fixup_failed';
  err.userMessage = "I couldn't apply the changes to the recipe — the update didn't come through correctly. Please try asking again.";
  // Structured detail for the error event / response_log (issue #105).
  err.detail = {
    stage: 'fixup',
    turn: info.turn,
    attempt: info.attempt,
    max_attempts: info.max_attempts,
    step_elapsed_ms: info.step_elapsed_ms,
    stop_reason: info.stop_reason,
    reason,
    validation_errors: (info.validation_errors || []).slice(0, 5).map((e) => String(e).slice(0, 200)),
  };
  throw err;
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

async function handleToolCall(block, config, messages, systemPrompt, send, convId, replyId, pool, userId, responseLog, fixState, replyState) {
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

    // Say explicitly what kind of read this was. Silent truncation is what
    // invited the model to confidently invent the amounts it never saw — and
    // then go fetch more pages looking for them, blowing the time budget.
    const parts = [`Title: ${result.title}`];
    if (result.structured) {
      parts.push('Source: structured recipe data published by the page (exact amounts and steps).');
    }
    if (result.truncated) {
      parts.push(`[Content truncated at ${MAX_CONTENT_LENGTH} characters — the recipe card may be further down the page. Do NOT invent amounts for anything you could not read; say what was missing instead.]`);
    }
    parts.push(`\nContent:\n${result.content}`);
    return parts.join('\n');
  }

  if (block.name === 'display_recipe') {
    return await handleRecipeDisplay(block.input, send, convId, replyId, pool, userId, fixState, replyState);
  }

  return 'Unknown tool';
}

async function handleRecipeDisplay(recipeData, send, convId, replyId, pool, userId, fixState, replyState) {
  const recipe = recipeData;
  const { valid, errors } = validate(recipe);

  if (valid) {
    // Marks the reply as having produced something worth keeping: a later turn
    // that times out now degrades to "cut off" instead of erroring outright.
    if (replyState) replyState.recipeDelivered = true;
    if (fixState.attempts > 0) {
      log.info('recipe', 'Fix-up succeeded — valid recipe after retry', {
        attempt: fixState.attempts,
        title: recipe.title,
      });
      fixState.attempts = 0;
    }
    fixState.lastErrors = null;
    send('recipe', recipe);
    await updateConversationTitle(pool, convId, recipe.title, send);
    await pool.query(
      'INSERT INTO messages (conversation_id, role, content, recipe_data) VALUES ($1, $2, $3, $4)',
      [convId, 'assistant', `[Recipe: ${recipe.title}]`, JSON.stringify(recipe)]
    );
    log.info('recipe', 'Valid recipe displayed', { title: recipe.title });
    return 'Recipe displayed successfully.';
  }

  log.warn('recipe', 'Validation failed', {
    conversationId: convId,
    replyId,
    attempt: fixState.attempts,
    errors,
  });

  if (fixState.attempts < MAX_VALIDATION_RETRIES) {
    fixState.attempts += 1;
    fixState.pending = { attempt: fixState.attempts, startedAt: Date.now() };
    fixState.lastErrors = errors;
    send('status', { text: 'Fixing recipe format...', kind: 'fixup' });
    log.warn('recipe', 'Requesting fix-up from model', {
      conversationId: convId,
      replyId,
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
  fixState.lastErrors = null;
  if (replyState) replyState.recipeDelivered = true;
  send('warning', { text: 'Recipe may have formatting issues', kind: 'formatting' });
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
