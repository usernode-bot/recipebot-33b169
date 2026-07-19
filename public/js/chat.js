const Chat = {
  messages: [],
  streaming: false,
  _eventSource: null,
  _lastEventIndex: -1,
  _activeReplyId: null,
  _spinnerEl: null,
  _streamWrapper: null,
  _activeStatusLine: null,

  _statusIconSpinner: `<svg class="status-icon spinning" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-dasharray="28" stroke-dashoffset="8" stroke-linecap="round"/></svg>`,
  _statusIconCheck: `<svg class="status-icon" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

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
    this._ackOnDone = null;

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

        if (pr) {
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
            if (pr.status === 'done') {
              App.currentRecipe = lastRecipeMsg.recipe_data;
              Recipe.display(lastRecipeMsg.recipe_data);
              this._acknowledgeReply(pr.id);
            }
          } else {
            App.currentRecipe = lastRecipeMsg.recipe_data;
            Recipe.display(lastRecipeMsg.recipe_data);
            if (pr.status === 'done') {
              this._acknowledgeReply(pr.id);
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
          this._finalizeActiveStatus();
          this._removeSpinner();
          if (status === 'done') this._flushDeferredAck();
          if (status === 'error' || status === 'not_found') {
            const errEl = document.createElement('div');
            errEl.className = 'msg-assistant px-4 py-2.5';
            errEl.textContent = 'Response was interrupted. Please try again.';
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
        label.textContent = 'Thinking...';
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
        link.textContent = data.text;
        line.appendChild(link);
        wrapper.appendChild(line);
        this._activeStatusLine = line;
      } else if (data.text?.startsWith('Searching:')) {
        this._finalizeActiveStatus();
        this._activeStatusDetail = null;
        const line = document.createElement('div');
        line.className = 'status-line';
        line.innerHTML = this._statusIconSpinner;
        const label = document.createElement('span');
        label.className = 'status-toggle';
        label.textContent = data.text;
        line.appendChild(label);
        wrapper.appendChild(line);
        const detail = document.createElement('div');
        detail.className = 'status-detail hidden';
        label.addEventListener('click', () => detail.classList.toggle('hidden'));
        wrapper.appendChild(detail);
        this._activeStatusLine = line;
        this._activeStatusDetail = detail;
      } else {
        this._appendStatusLine(wrapper, data.text, true);
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
      if (dedup(data)) return;
      console.log('[chat] ← recipe');
      currentTextEl = null;
      this._appendStatusLine(wrapper, `Created recipe: ${data.title}`, false);
      if (typeof Recipe !== 'undefined') {
        // A modification renders the Accept/Reject diff — record which reply
        // it belongs to so the decision can be persisted server-side.
        if (App.currentRecipe) App.pendingReplyId = replyId;
        Recipe.handleRecipeEvent(data);
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
        el.textContent = `${data.used}/${data.limit} today`;
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
      this._flushDeferredAck();
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
        this._finalizeActiveStatus();
        const errEl = document.createElement('div');
        errEl.className = 'msg-assistant px-4 py-2.5';
        errEl.textContent = data.error || 'Something went wrong.';
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
    });
  },

  _acknowledgeReply(replyId) {
    fetch(`/api/chat/${replyId}/acknowledge`, { method: 'PATCH' }).catch(() => {});
  },

  // Persist an Accept/Reject decision for the diff currently on screen.
  // If the reply is still streaming, defer the PATCH until 'done' — an
  // early acknowledge would make the stale checker see a non-'processing'
  // status and kill the live stream.
  resolveDiffReply() {
    const id = App.pendingReplyId;
    App.pendingReplyId = null;
    if (!id) return;
    if (this.streaming && this._activeReplyId === id) {
      this._ackOnDone = id;
    } else {
      this._acknowledgeReply(id);
    }
  },

  _flushDeferredAck() {
    if (this._ackOnDone) {
      this._acknowledgeReply(this._ackOnDone);
      this._ackOnDone = null;
    }
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
      { value: 'vegetarian', label: 'Vegetarian' },
      { value: 'vegan', label: 'Vegan' },
    ];
    const complexityOptions = [
      { value: 'quick', label: '≤10 min' },
      { value: 'normal', label: 'Normal' },
      { value: 'serious', label: 'Advanced' },
      { value: 'foodscience', label: 'Food Science' },
    ];
    const servingOptions = [
      { value: 'snack', label: 'Snack' },
      { value: 'normal', label: 'Normal' },
      { value: 'large', label: 'Large' },
    ];

    const renderRow = (label, options, selected) => {
      const btns = options.map(o => {
        const isActive = o.value === selected;
        return `<span class="pref-btn-locked px-2.5 py-1 text-xs rounded-full border ${
          isActive
            ? 'border-[#00c8ff] bg-[rgba(0,200,255,0.1)] text-[#00c8ff]'
            : 'border-zinc-200 dark:border-zinc-800 text-zinc-300 dark:text-zinc-600'
        }">${o.label}</span>`;
      }).join('');
      return `<div class="flex items-center gap-2">
        <span class="text-xs text-zinc-500 w-16 shrink-0">${label}</span>
        <div class="flex gap-1.5">${btns}</div>
      </div>`;
    };

    return `<div class="space-y-2.5 text-left py-2 px-1">
      ${renderRow('Diet', dietOptions, preferences.diet)}
      ${renderRow('Style', complexityOptions, preferences.complexity || 'normal')}
      ${renderRow('Serving size', servingOptions, preferences.serving || 'normal')}
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
      icon.innerHTML = this._statusIconCheck;
      line.appendChild(icon);

      if (entry.type === 'thinking' && entry.detail) {
        const label = document.createElement('span');
        label.className = 'status-toggle';
        label.textContent = entry.text;
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
        label.textContent = entry.text;
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
        link.textContent = entry.text;
        line.appendChild(link);
        wrap.appendChild(line);
      } else {
        const label = document.createElement('span');
        label.textContent = entry.text;
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
    this._ackOnDone = null;
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

    if (App.llm && !App.llm.enabled) {
      this.appendMessage('assistant', 'AI is unavailable in this environment, so chat is disabled here.');
      return;
    }

    if (!(await this._ensureLlmGrant())) {
      this.appendMessage('assistant', 'RecipeBot needs AI access to generate recipes. Approve access when prompted, then try again.');
      return;
    }

    if (App.pendingRecipe) {
      App.pendingRecipe = null;
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
        errEl.textContent = `Daily limit reached (${data.count}/${data.limit}). Resets at midnight UTC.`;
        this._streamWrapper.appendChild(errEl);
        this._cleanupStream();
        return;
      }

      if (!res.ok) {
        let errText = 'Something went wrong. Please try again.';
        if (res.status === 503) {
          try {
            const data = await res.json();
            errText = data.error || 'AI features are unavailable in this environment.';
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
      errEl.textContent = 'Connection error. Please try again.';
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
