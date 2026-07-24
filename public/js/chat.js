const Chat = {
  messages: [],
  streaming: false,
  _eventSource: null,
  _lastEventIndex: -1,
  _activeReplyId: null,
  _spinnerEl: null,
  _streamWrapper: null,
  _activeStatusLine: null,

  // replyId → highest event index whose recipe the user has already decided
  // on. Survives conversation switches on purpose (clear()/loadMessages must
  // NOT reset it): re-entering a recipe replays the reply's event log, and
  // without this the replayed 'recipe' event re-opens a diff the user already
  // accepted. Infinity = the whole log is settled (server-reported decision).
  _decidedReplies: new Map(),
  _maxDecidedReplies: 50,
  // Decisions whose PATCH failed outright; retried on the next load.
  _unsentDecisions: [],

  _statusIconSpinner: `<svg class="status-icon spinning" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-dasharray="28" stroke-dashoffset="8" stroke-linecap="round"/></svg>`,
  _statusIconCheck: `<svg class="status-icon" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  _statusIconError: `<svg class="status-icon status-icon-error" viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  _statusIconWarning: `<svg class="status-icon status-icon-warning" viewBox="0 0 16 16" fill="none"><path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5V9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.9" fill="currentColor"/></svg>`,

  _createSpinner() {
    const el = document.createElement('div');
    el.className = 'streaming-spinner';
    el.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
    return el;
  },

  _removeSpinner() {
    if (this._spinnerEl) {
      this._spinnerEl.remove();
      this._spinnerEl = null;
    }
  },

  _finalizeActiveStatus() {
    if (this._activeStatusLine) {
      const icon = this._activeStatusLine.querySelector('.status-icon');
      if (icon) {
        icon.classList.remove('spinning');
        icon.outerHTML = this._statusIconCheck;
      }
      this._activeStatusLine = null;
    }
  },

  // Like _finalizeActiveStatus, but for failures: an in-flight status line
  // (e.g. "Fixing recipe format...") gets an ✕ instead of a checkmark so the
  // user can see which step died.
  _failActiveStatus() {
    if (this._activeStatusLine) {
      const icon = this._activeStatusLine.querySelector('.status-icon');
      if (icon) {
        icon.outerHTML = this._statusIconError;
      }
      this._activeStatusLine.classList.add('status-line-error');
      this._activeStatusLine = null;
    }
  },

  // Server status/log entries carry a structured `kind` (+ params) alongside
  // the legacy English `text`; render via the dictionary when the kind is
  // known, fall back to the persisted text for old rows.
  _statusText(data) {
    if (data.kind === 'search') return t('chat.searching', { query: data.query });
    if (data.kind === 'fetch') return t('chat.reading', { url: data.url });
    if (data.kind === 'fixup') return t('chat.fixingFormat');
    return data.text;
  },

  // Warning events/log entries: localized by `kind`, falling back to the
  // persisted English text for rows written before kinds existed.
  _warningText(data) {
    if (data.kind === 'truncated') return t('chat.responseTruncated');
    if (data.kind === 'formatting') return t('chat.recipeFormatWarning');
    return data.text || t('chat.recipeFormatWarning');
  },

  _appendWarningLine(target, text) {
    const line = document.createElement('div');
    line.className = 'status-line status-line-warning';
    line.innerHTML = `${this._statusIconWarning}<span>${text}</span>`;
    target.appendChild(line);
    const container = document.getElementById('chat-messages');
    container.scrollTop = container.scrollHeight;
    return line;
  },

  // Server errors carry a machine `code`; map it to a localized message and
  // fall back to the server's English string for unknown codes.
  _errorText(data) {
    if (data.code) {
      const key = 'errors.' + data.code;
      const translated = t(key);
      if (translated !== key) return translated;
    }
    return data.error || t('errors.somethingWrong');
  },

  _appendStatusLine(target, text, active = true) {
    this._finalizeActiveStatus();
    this._activeStatusDetail = null;
    const line = document.createElement('div');
    line.className = 'status-line';
    line.innerHTML = `${active ? this._statusIconSpinner : this._statusIconCheck}<span>${text}</span>`;
    target.appendChild(line);
    if (active) this._activeStatusLine = line;
    const container = document.getElementById('chat-messages');
    container.scrollTop = container.scrollHeight;
    return line;
  },

  _initStreamUI() {
    this.hideWelcome();
    const container = document.getElementById('chat-messages');
    this._streamWrapper = document.createElement('div');
    container.appendChild(this._streamWrapper);
    this._spinnerEl = this._createSpinner();
    container.appendChild(this._spinnerEl);
    container.scrollTop = container.scrollHeight;
  },

  _setStreamingBtn(streaming) {
    const btn = document.getElementById('send-btn');
    const label = btn.querySelector('.send-label');
    const spinner = btn.querySelector('.send-spinner');
    btn.disabled = streaming;
    if (streaming) {
      btn.classList.add('btn-streaming');
      if (label) label.classList.add('hidden');
      if (spinner) spinner.classList.remove('hidden');
    } else {
      btn.classList.remove('btn-streaming');
      if (label) label.classList.remove('hidden');
      if (spinner) spinner.classList.add('hidden');
    }
  },


  renderMarkdown(text) {
    if (!text) return '';
    let html = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code class="px-1 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-sm">$1</code>')
      .replace(/^### (.+)$/gm, '<h4 class="font-semibold mt-3 mb-1">$1</h4>')
      .replace(/^## (.+)$/gm, '<h3 class="font-semibold text-base mt-3 mb-1">$1</h3>')
      .replace(/^# (.+)$/gm, '<h3 class="font-bold text-lg mt-3 mb-1">$1</h3>');

    html = html.replace(/(^(\d+)\.\s+(.*)$\n?)+/gm, (block) => {
      const items = block.trim().split('\n').map(line =>
        line.replace(/^\d+\.\s+(.*)$/, '<li class="ml-4">$1</li>')
      ).join('');
      return `<ol class="list-decimal space-y-1 my-1 pl-2">${items}</ol>`;
    });

    html = html.replace(/(^[-*]\s+(.*)$\n?)+/gm, (block) => {
      const items = block.trim().split('\n').map(line =>
        line.replace(/^[-*]\s+(.*)$/, '<li class="ml-4">$1</li>')
      ).join('');
      return `<ul class="list-disc space-y-1 my-1 pl-2">${items}</ul>`;
    });

    return html
      .replace(/\n\n/g, '</p><p class="mt-2">')
      .replace(/\n/g, '<br>');
  },

  async loadMessages(conversationId) {
    this.clear();
    this.messages = [];
    App.pendingReplyId = null;
    this._retryUnsentDecisions();

    if (!conversationId) return;

    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      if (!res.ok) return;
      const data = await res.json();
      this.messages = data.messages || data;

      const pr = data.pendingReply;
      const isProcessing = pr?.status === 'processing';

      if (isProcessing) {
        const cutoff = new Date(pr.createdAt).getTime();
        const renderMsgs = this.messages.filter(
          m => !(m.role === 'assistant' && new Date(m.created_at).getTime() >= cutoff)
        );
        const saved = this.messages;
        this.messages = renderMsgs;
        this.renderAll(data.preferences);
        this.messages = saved;
      } else {
        this.renderAll(data.preferences);
      }

      const allRecipeMsgs = this.messages.filter(m => m.recipe_data);
      const lastRecipeMsg = allRecipeMsgs[allRecipeMsgs.length - 1];

      if (lastRecipeMsg && typeof Recipe !== 'undefined') {
        const uiState = data.ui_state || {};
        const hp = HashParams.get();
        Recipe.ingredientSummaryOpen = hp.ing === '1' || uiState.ingredientSummaryOpen || false;
        Recipe._showIngMacros = hp.mac === '1' || uiState.showIngMacros || false;
        Recipe.activeSteps = new Set((uiState.activeSteps || []).map(String));
        Recipe.checkedIngredients = new Set(uiState.checkedIngredients || []);

        if (pr && pr.resolved) {
          // Already decided (or errored) — the recipe the reply produced is
          // simply the current one. Remembering the decision locally keeps the
          // replayed 'recipe' event from re-opening the diff when the reply is
          // still streaming.
          this._markDecided(pr.id, Infinity);
          App.currentRecipe = lastRecipeMsg.recipe_data;
          Recipe.currentServings = uiState.servings || lastRecipeMsg.recipe_data.default_servings;
          Recipe.servingScale = uiState.servingScale || 1.0;
          Recipe.display(lastRecipeMsg.recipe_data);

          if (isProcessing) {
            this._resumeStream(pr.id);
          }
        } else if (pr) {
          const cutoff = new Date(pr.createdAt).getTime();
          const oldRecipeMsgs = allRecipeMsgs.filter(m => new Date(m.created_at).getTime() < cutoff);
          const oldRecipeMsg = oldRecipeMsgs[oldRecipeMsgs.length - 1];
          const newRecipeFromReply = new Date(lastRecipeMsg.created_at).getTime() >= cutoff;
          const baseRecipe = (oldRecipeMsg || lastRecipeMsg).recipe_data;

          Recipe.currentServings = uiState.servings || baseRecipe.default_servings;
          Recipe.servingScale = uiState.servingScale || 1.0;

          if (newRecipeFromReply && oldRecipeMsg) {
            App.currentRecipe = oldRecipeMsg.recipe_data;
            Recipe.display(oldRecipeMsg.recipe_data);
            App.pendingReplyId = pr.id;

            if (pr.status === 'done') {
              Recipe.handleRecipeEvent(lastRecipeMsg.recipe_data);
            }
          } else if (newRecipeFromReply && !oldRecipeMsg) {
            // First recipe of the conversation — nothing to diff against, so
            // there was never a decision to make. Settle the row.
            if (pr.status === 'done') {
              App.currentRecipe = lastRecipeMsg.recipe_data;
              Recipe.display(lastRecipeMsg.recipe_data);
              this._recordDecision(pr.id, 'accepted');
            }
          } else {
            App.currentRecipe = lastRecipeMsg.recipe_data;
            Recipe.display(lastRecipeMsg.recipe_data);
            if (pr.status === 'done') {
              this._recordDecision(pr.id, 'accepted');
            }
          }

          if (isProcessing) {
            this._resumeStream(pr.id);
          }
        } else {
          App.currentRecipe = lastRecipeMsg.recipe_data;
          Recipe.currentServings = uiState.servings || lastRecipeMsg.recipe_data.default_servings;
          Recipe.servingScale = uiState.servingScale || 1.0;
          Recipe.display(lastRecipeMsg.recipe_data);
        }
      } else if (isProcessing) {
        this._resumeStream(pr.id);
      }
    } catch { /* retry on next load */ }
  },

  _resumeStream(replyId) {
    this._activeReplyId = replyId;
    this.streaming = true;
    this._setStreamingBtn(true);
    this._initStreamUI();
    this._connectStream(replyId);
  },

  _connectStream(replyId) {
    if (this._eventSource) {
      this._eventSource.close();
    }

    // EventSource can't set headers, so the platform token rides the URL.
    const token = window.UsernodeAuth?.token;
    const url = `/api/chat/${replyId}/stream?after=${this._lastEventIndex}` +
      (token ? `&token=${encodeURIComponent(token)}` : '');
    const es = new EventSource(url);
    this._eventSource = es;
    const wrapper = this._streamWrapper;

    let currentTextEl = null;
    let currentFullText = '';
    let thinkingEl = null;
    let thinkingText = '';
    const seen = new Set();

    const startStaleCheck = () => {
      clearInterval(this._staleTimer);
      this._staleTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/chat/${replyId}/status`);
          const { status } = await res.json();
          if (status === 'processing') return;
          console.warn('[chat] reply no longer processing:', status);
          if (status === 'error' || status === 'not_found') {
            this._failActiveStatus();
          } else {
            this._finalizeActiveStatus();
          }
          this._removeSpinner();
          if (status === 'error' || status === 'not_found') {
            const errEl = document.createElement('div');
            errEl.className = 'msg-assistant px-4 py-2.5';
            errEl.textContent = t('errors.interrupted');
            if (wrapper) wrapper.appendChild(errEl);
          }
          this._cleanupStream();
        } catch { /* network error, will retry next interval */ }
      }, 10000);
    };
    startStaleCheck();

    const dedup = (data) => {
      if (data._idx === undefined) return false;
      if (seen.has(data._idx)) return true;
      seen.add(data._idx);
      this._lastEventIndex = data._idx;
      return false;
    };

    es.addEventListener('thinking', (e) => {
      const data = JSON.parse(e.data);
      if (dedup(data)) return;
      this._removeSpinner();
      if (!thinkingEl) {
        this._finalizeActiveStatus();
        const line = document.createElement('div');
        line.className = 'status-line';
        const icon = document.createElement('span');
        icon.innerHTML = this._statusIconSpinner;
        const label = document.createElement('span');
        label.className = 'status-toggle';
        label.textContent = t('chat.thinking');
        line.appendChild(icon);
        line.appendChild(label);
        thinkingEl = document.createElement('div');
        thinkingEl.className = 'status-detail hidden';
        label.addEventListener('click', () => thinkingEl.classList.toggle('hidden'));
        wrapper.appendChild(line);
        wrapper.appendChild(thinkingEl);
        this._activeStatusLine = line;
      }
      thinkingText += data.text;
      thinkingEl.textContent = thinkingText;
    });

    es.addEventListener('token', (e) => {
      const data = JSON.parse(e.data);
      if (dedup(data)) return;
      this._removeSpinner();
      this._finalizeActiveStatus();
      if (!currentTextEl) {
        currentTextEl = document.createElement('div');
        currentTextEl.className = 'msg-assistant px-4 py-2.5';
        wrapper.appendChild(currentTextEl);
        currentFullText = '';
      }
      currentFullText += data.text;
      currentTextEl.innerHTML = this.renderMarkdown(currentFullText);
      const container = document.getElementById('chat-messages');
      container.scrollTop = container.scrollHeight;
    });

    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      if (dedup(data)) return;
      console.log('[chat] ← status', data);
      this._removeSpinner();
      currentTextEl = null;
      thinkingEl = null; thinkingText = '';
      if (data.url) {
        this._finalizeActiveStatus();
        this._activeStatusDetail = null;
        const line = document.createElement('div');
        line.className = 'status-line';
        line.innerHTML = this._statusIconSpinner;
        const link = document.createElement('a');
        link.href = data.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'status-link';
        link.textContent = this._statusText(data);
        line.appendChild(link);
        wrapper.appendChild(line);
        this._activeStatusLine = line;
      } else if (data.kind === 'search' || data.text?.startsWith('Searching:')) {
        this._finalizeActiveStatus();
        this._activeStatusDetail = null;
        const line = document.createElement('div');
        line.className = 'status-line';
        line.innerHTML = this._statusIconSpinner;
        const label = document.createElement('span');
        label.className = 'status-toggle';
        label.textContent = this._statusText(data);
        line.appendChild(label);
        wrapper.appendChild(line);
        const detail = document.createElement('div');
        detail.className = 'status-detail hidden';
        label.addEventListener('click', () => detail.classList.toggle('hidden'));
        wrapper.appendChild(detail);
        this._activeStatusLine = line;
        this._activeStatusDetail = detail;
      } else {
        this._appendStatusLine(wrapper, this._statusText(data), true);
      }
    });

    es.addEventListener('status_results', (e) => {
      const data = JSON.parse(e.data);
      if (dedup(data)) return;
      if (this._activeStatusDetail && data.results?.length) {
        this._activeStatusDetail.innerHTML = data.results.map(r =>
          `<div class="mb-1"><a href="${r.url}" target="_blank" rel="noopener" class="status-link">${r.title}</a></div>`
        ).join('');
      }
    });

    es.addEventListener('recipe', (e) => {
      const data = JSON.parse(e.data);
      const eventIndex = data._idx;
      if (dedup(data)) return;
      console.log('[chat] ← recipe');
      currentTextEl = null;
      this._appendStatusLine(wrapper, t('chat.createdRecipe', { title: data.title }), false);
      if (typeof Recipe !== 'undefined') {
        // `_idx` is the stream's own bookkeeping — keep it out of the recipe
        // object so the accepted recipe equals the stored recipe_data.
        const recipe = { ...data };
        delete recipe._idx;

        if (this._isDecided(replyId, eventIndex)) {
          // Replay of a recipe the user already accepted/rejected (re-entering
          // a recipe re-reads the whole event log). Adopt it silently instead
          // of asking again.
          App.currentRecipe = recipe;
          Recipe.display(recipe);
          return;
        }

        // A modification renders the Accept/Reject diff — record which reply
        // it belongs to so the decision can be persisted server-side.
        if (App.currentRecipe) App.pendingReplyId = replyId;
        Recipe.handleRecipeEvent(recipe);
      }
    });

    es.addEventListener('conversation', (e) => {
      const data = JSON.parse(e.data);
      if (dedup(data)) return;
      console.log('[chat] ← conversation', data);
      App.currentConversationId = data.id;
      HashParams.set('c', data.id);
      Store.refresh();
    });

    es.addEventListener('title_update', (e) => {
      const data = JSON.parse(e.data);
      if (dedup(data)) return;
      Store.refresh();
    });

    es.addEventListener('rate_limit', (e) => {
      const data = JSON.parse(e.data);
      if (dedup(data)) return;
      const el = document.getElementById('rate-limit-display');
      if (data.used >= 30) {
        el.textContent = t('chat.rateLimitBadge', { used: data.used, limit: data.limit });
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    });

    es.addEventListener('done', (e) => {
      const data = JSON.parse(e.data);
      if (dedup(data)) return;
      this._finalizeActiveStatus();
      this._removeSpinner();
      this._cleanupStream();
    });

    es.addEventListener('error', (e) => {
      if (es.readyState === EventSource.CLOSED) {
        this._cleanupStream();
        return;
      }
      try {
        const data = JSON.parse(e.data);
        if (dedup(data)) return;
        this._removeSpinner();
        this._failActiveStatus();
        const errEl = document.createElement('div');
        errEl.className = 'msg-assistant px-4 py-2.5';
        errEl.textContent = this._errorText(data);
        wrapper.appendChild(errEl);
        this._cleanupStream();
        if (data.code === 'grant_required' && typeof usernode !== 'undefined' && usernode.requestLlmAccess) {
          // Ask the platform shell for AI consent so the next send works.
          usernode.requestLlmAccess().catch(() => {});
        }
      } catch {
        es.close();
        setTimeout(() => {
          if (this._activeReplyId) {
            this._removeSpinner();
            this._activeStatusLine = null;
            currentTextEl = null;
            wrapper.innerHTML = '';

            const container = document.getElementById('chat-messages');
            this._spinnerEl = this._createSpinner();
            container.insertBefore(this._spinnerEl, wrapper.nextSibling);

            this._lastEventIndex = -1;
            this._connectStream(replyId);
          }
        }, 1000);
      }
    });

    es.addEventListener('warning', (e) => {
      const data = JSON.parse(e.data);
      if (dedup(data)) return;
      console.log('[chat] ← warning', data);
      currentTextEl = null;
      this._appendWarningLine(wrapper, this._warningText(data));
    });
  },

  // Remember locally that this reply's diff is settled, so a replayed
  // 'recipe' event (stream resume replays the whole log) can't re-open it.
  _markDecided(replyId, eventIndex) {
    const prev = this._decidedReplies.get(replyId);
    if (prev !== undefined && prev >= eventIndex) return;
    this._decidedReplies.set(replyId, eventIndex);
    while (this._decidedReplies.size > this._maxDecidedReplies) {
      this._decidedReplies.delete(this._decidedReplies.keys().next().value);
    }
  },

  _isDecided(replyId, eventIndex) {
    const decidedAt = this._decidedReplies.get(replyId);
    if (decidedAt === undefined) return false;
    // A genuinely NEW recipe from the same reply (higher index) still deserves
    // its own diff; anything at or below the decided index is a replay.
    return eventIndex === undefined || eventIndex <= decidedAt;
  },

  // Persist a decision immediately — no deferral. The PATCH only touches
  // `edit_decision`, never `status`, so writing it mid-stream can't trip the
  // stale checker (the reason issue #16's fix deferred it, which is exactly
  // how the decision got lost on re-entry).
  async _recordDecision(replyId, decision, attempt = 0) {
    try {
      const res = await fetch(`/api/chat/${replyId}/acknowledge`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (res.ok) return true;
      if (res.status === 404 || res.status === 400) {
        console.warn('[chat] decision not recorded:', res.status, replyId);
        return false;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, attempt === 0 ? 1000 : 3000));
        return this._recordDecision(replyId, decision, attempt + 1);
      }
      console.warn('[chat] failed to record decision, will retry on next load:', err.message);
      if (!this._unsentDecisions.some(d => d.replyId === replyId)) {
        this._unsentDecisions.push({ replyId, decision });
      }
      return false;
    }
  },

  _retryUnsentDecisions() {
    if (!this._unsentDecisions.length) return;
    const queued = this._unsentDecisions;
    this._unsentDecisions = [];
    for (const d of queued) this._recordDecision(d.replyId, d.decision);
  },

  // Persist the Accept/Reject decision for the diff currently on screen.
  resolveDiffReply(decision = 'accepted') {
    const id = App.pendingReplyId;
    App.pendingReplyId = null;
    if (!id) return;
    // Record locally FIRST so an immediate re-entry (before the PATCH lands)
    // doesn't re-show the diff.
    this._markDecided(id, this._activeReplyId === id ? this._lastEventIndex : Infinity);
    this._recordDecision(id, decision);
  },

  _cleanupStream() {
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
    clearInterval(this._staleTimer);
    this._activeReplyId = null;
    this._lastEventIndex = -1;
    this.streaming = false;
    this._removeSpinner();
    this._streamWrapper = null;
    this._activeStatusLine = null;
    this._setStreamingBtn(false);
  },

  hideWelcome() {
    const w = document.getElementById('chat-welcome');
    if (w) w.classList.add('hidden');
  },

  showWelcome() {
    const w = document.getElementById('chat-welcome');
    if (w) w.classList.remove('hidden');
  },

  renderPreferencePills(preferences) {
    if (!preferences) return '';

    const dietOptions = [
      { value: 'vegetarian', label: t('pref.vegetarian') },
      { value: 'vegan', label: t('pref.vegan') },
    ];
    const complexityOptions = [
      { value: 'quick', label: t('pref.quick') },
      { value: 'normal', label: t('pref.normal') },
      { value: 'serious', label: t('pref.advanced') },
      { value: 'foodscience', label: t('pref.foodScience') },
    ];
    const servingOptions = [
      { value: 'snack', label: t('pref.snack') },
      { value: 'normal', label: t('pref.normal') },
      { value: 'large', label: t('pref.large') },
    ];

    const renderRow = (label, options, selected) => {
      const btns = options.map(o => {
        const isActive = o.value === selected;
        return `<span class="pref-btn-locked px-2.5 py-1 text-xs rounded-full border ${
          isActive
            ? 'border-[#E07A3F] bg-[rgba(224,122,63,0.1)] text-[#b85a24] dark:text-[#E8935B]'
            : 'border-zinc-200 dark:border-zinc-800 text-zinc-300 dark:text-zinc-600'
        }">${o.label}</span>`;
      }).join('');
      return `<div class="flex items-center gap-2">
        <span class="text-xs text-zinc-500 w-16 shrink-0">${label}</span>
        <div class="flex gap-1.5">${btns}</div>
      </div>`;
    };

    return `<div class="space-y-2.5 text-left py-2 px-1">
      ${renderRow(t('chat.diet'), dietOptions, preferences.diet)}
      ${renderRow(t('chat.style'), complexityOptions, preferences.complexity || 'normal')}
      ${renderRow(t('chat.servingSize'), servingOptions, preferences.serving || 'normal')}
    </div>`;
  },

  _renderResponseLog(container, responseLog) {
    const wrap = document.createElement('div');
    container.appendChild(wrap);
    for (const entry of responseLog) {
      if (entry.type === 'text') {
        const el = document.createElement('div');
        el.className = 'msg-assistant px-4 py-2.5';
        el.innerHTML = this.renderMarkdown(entry.content);
        wrap.appendChild(el);
        continue;
      }

      const line = document.createElement('div');
      line.className = 'status-line';
      const icon = document.createElement('span');
      // Failed steps (e.g. a fix-up that never produced a recipe) show an ✕,
      // warnings a triangle; everything else keeps the checkmark. Entries
      // persisted before `ok` existed have no field and render as before.
      if (entry.type === 'warning') {
        line.classList.add('status-line-warning');
        icon.innerHTML = this._statusIconWarning;
      } else if (entry.ok === false) {
        line.classList.add('status-line-error');
        icon.innerHTML = this._statusIconError;
      } else {
        icon.innerHTML = this._statusIconCheck;
      }
      line.appendChild(icon);

      // Localized label: kind-mapped when the entry carries structured
      // fields (kind/title/query/url), the stored English text otherwise.
      const entryText = entry.type === 'warning'
        ? this._warningText(entry)
        : entry.kind === 'thinking' || entry.type === 'thinking'
          ? t('chat.thinking')
          : entry.kind === 'recipe' || (entry.type === 'recipe' && entry.title)
            ? t('chat.createdRecipe', { title: entry.title })
            : this._statusText(entry);

      if (entry.type === 'thinking' && entry.detail) {
        const label = document.createElement('span');
        label.className = 'status-toggle';
        label.textContent = entryText;
        line.appendChild(label);
        wrap.appendChild(line);
        const detail = document.createElement('div');
        detail.className = 'status-detail hidden';
        detail.textContent = entry.detail;
        label.addEventListener('click', () => detail.classList.toggle('hidden'));
        wrap.appendChild(detail);
      } else if (entry.type === 'status' && entry.results?.length) {
        const label = document.createElement('span');
        label.className = 'status-toggle';
        label.textContent = entryText;
        line.appendChild(label);
        wrap.appendChild(line);
        const detail = document.createElement('div');
        detail.className = 'status-detail hidden';
        detail.innerHTML = entry.results.map(r =>
          `<div class="mb-1"><a href="${r.url}" target="_blank" rel="noopener" class="status-link">${r.title}</a></div>`
        ).join('');
        label.addEventListener('click', () => detail.classList.toggle('hidden'));
        wrap.appendChild(detail);
      } else if (entry.url) {
        const link = document.createElement('a');
        link.href = entry.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'status-link';
        link.textContent = entryText;
        line.appendChild(link);
        wrap.appendChild(line);
      } else {
        const label = document.createElement('span');
        label.textContent = entryText;
        line.appendChild(label);
        wrap.appendChild(line);
      }
    }
  },

  renderAll(preferences) {
    const container = document.getElementById('chat-messages');
    const welcome = document.getElementById('chat-welcome');
    container.innerHTML = '';
    if (welcome) container.appendChild(welcome);

    if (this.messages.length) {
      this.hideWelcome();
    } else {
      this.showWelcome();
      return;
    }

    const prefHtml = this.renderPreferencePills(preferences);
    if (prefHtml) {
      const prefEl = document.createElement('div');
      prefEl.innerHTML = prefHtml;
      container.appendChild(prefEl);
    }

    let skipAssistant = false;

    for (const msg of this.messages) {
      if (msg.role === 'user') {
        skipAssistant = false;
        this.appendMessage('user', msg.content);
        if (msg.response_log?.length) {
          this._renderResponseLog(container, msg.response_log);
          skipAssistant = true;
        }
      } else if (skipAssistant) {
        // Covered by the response_log — skip
      } else if (msg.role === 'assistant' && /^\[Recipe[ :]/.test(msg.content || '')) {
        // Internal sentinel rows ("[Recipe: <title>]", "[Recipe update
        // FAILED — …]") are prompt-history bookkeeping, not user-facing
        // prose — never render them even without a covering response_log.
      } else {
        this.appendMessage(msg.role, msg.content);
      }
    }

    container.scrollTop = container.scrollHeight;
  },

  appendMessage(role, content) {
    this.hideWelcome();
    const container = document.getElementById('chat-messages');
    const el = document.createElement('div');
    el.className = role === 'user' ? 'msg-user px-4 py-2.5' : 'msg-assistant px-4 py-2.5';
    if (content) {
      el.innerHTML = this.renderMarkdown(content);
    }
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  },

  clear() {
    this._cleanupStream();
    this.messages = [];
    App.pendingReplyId = null;
    // NOTE: _decidedReplies is deliberately NOT cleared here — it's what keeps
    // a decision made moments ago from being forgotten on re-entry (issue #24).
    const container = document.getElementById('chat-messages');
    const welcome = document.getElementById('chat-welcome');
    container.innerHTML = '';
    if (welcome) {
      container.appendChild(welcome);
      this.showWelcome();
    }
  },

  async _ensureLlmGrant() {
    // Platform-proxy mode bills the user's AI budget under an explicit
    // per-app grant — ask the shell for consent before the first send.
    if (App.llm?.mode !== 'proxy') return true;
    if (typeof usernode === 'undefined' || !usernode.getLlmAccess) return true;
    try {
      const state = await usernode.getLlmAccess();
      if (state?.granted) return true;
      const result = await usernode.requestLlmAccess();
      return !!result?.granted;
    } catch {
      // No platform shell (standalone/dev) — let the server decide.
      return true;
    }
  },

  async send(message) {
    if (this.streaming || !message.trim()) return;

    if (App.isAnonymous) {
      App.promptSignIn(t('signin.cookWithAI'));
      return;
    }

    if (App.llm && !App.llm.enabled) {
      this.appendMessage('assistant', t('chat.aiDisabled'));
      return;
    }

    if (!(await this._ensureLlmGrant())) {
      this.appendMessage('assistant', t('chat.needsAccess'));
      return;
    }

    // Answering a diff by asking for something else instead of choosing: the
    // proposal is moot, so settle it server-side. Left undecided (as it was
    // before), it came back as a stale diff on a later re-entry.
    if (App.pendingRecipe) {
      App.pendingRecipe = null;
      this.resolveDiffReply('superseded');
      if (typeof Recipe !== 'undefined' && App.currentRecipe) {
        Recipe.display(App.currentRecipe);
      }
    }

    const isFirst = !document.querySelector('#chat-messages .msg-user');
    if (isFirst) {
      this.hideWelcome();
      const prefHtml = this.renderPreferencePills(App.preferences);
      if (prefHtml) {
        const prefEl = document.createElement('div');
        prefEl.innerHTML = prefHtml;
        document.getElementById('chat-messages').appendChild(prefEl);
      }
    }
    this.appendMessage('user', message);
    this.streaming = true;
    this._setStreamingBtn(true);
    this._initStreamUI();

    const body = {
      conversationId: App.currentConversationId,
      message,
      preferences: App.preferences,
    };

    if (!App.currentConversationId && App.currentRecipe) {
      body.forkRecipe = App.currentRecipe;
      // Remix lineage: record which shared recipe (and version) this fork
      // came from. Own recipes and unattributed imports carry no source.
      const vs = App.viewingShared;
      if (vs && !vs.is_mine && vs.id) {
        body.forkSource = {
          sharedRecipeId: vs.id,
          version: (App.viewingVersion && App.viewingVersion.version) || vs.current_version || 1,
          username: vs.username,
        };
      }
    }

    console.log('[chat] → request', body);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const data = await res.json();
        const errEl = document.createElement('div');
        errEl.className = 'msg-assistant px-4 py-2.5';
        errEl.textContent = t('errors.dailyLimit', { count: data.count, limit: data.limit });
        this._streamWrapper.appendChild(errEl);
        this._cleanupStream();
        return;
      }

      if (!res.ok) {
        let errText = t('errors.tryAgain');
        if (res.status === 503) {
          try {
            const data = await res.json();
            errText = this._errorText(data);
          } catch {}
        }
        const errEl = document.createElement('div');
        errEl.className = 'msg-assistant px-4 py-2.5';
        errEl.textContent = errText;
        this._streamWrapper.appendChild(errEl);
        this._cleanupStream();
        return;
      }

      const { conversationId, replyId } = await res.json();

      if (conversationId && !App.currentConversationId) {
        App.currentConversationId = conversationId;
        HashParams.set('c', conversationId);
        Store.refresh();
      }

      this._activeReplyId = replyId;
      this._lastEventIndex = -1;
      this._connectStream(replyId);
    } catch {
      const errEl = document.createElement('div');
      errEl.className = 'msg-assistant px-4 py-2.5';
      errEl.textContent = t('errors.connection');
      this._streamWrapper.appendChild(errEl);
      this._cleanupStream();
    }
  },
};

document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const message = input.value;
  input.value = '';
  input.style.height = 'auto';
  Chat.send(message);
});
