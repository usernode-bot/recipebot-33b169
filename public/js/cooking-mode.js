const CookingMode = {
  active: false,
  recipe: null,
  timers: [],
  wakeLock: null,
  overlay: null,
  // Checklist ticks for the current cooking session (issue #116): step
  // indexes and aggregated ingredient names. Persisted to localStorage so a
  // reload of the same recipe message resumes mid-cook; a fresh "Cook mode"
  // start resets them.
  ticks: { steps: new Set(), ings: new Set() },
  _finishShown: false,

  enter(recipe, { resume = false } = {}) {
    if (!recipe?.steps?.length) return;
    this.recipe = recipe;
    this.active = true;
    this._finishShown = false;
    if (resume) this._resumeTicks(recipe);
    else this._resetTicks(recipe);
    const hasRunning = this.timers.some(t => t.remaining > 0);
    if (!hasRunning) this.timers = [];
    const bar = document.getElementById('timer-bar');
    if (bar) { bar.classList.add('hidden'); bar.classList.remove('flex'); }
    this.createOverlay();
    this.acquireWakeLock();
    // Part of the route so a refresh comes back into cooking mode.
    if (typeof HashParams !== 'undefined') HashParams.set('cook', '1');
    document.body.setAttribute('data-cooking', '1');
  },

  exit() {
    if (typeof HashParams !== 'undefined') HashParams.set('cook', null);
    this.releaseWakeLock();
    document.body.removeAttribute('data-cooking');
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    document.removeEventListener('keydown', this.handleKey);
    if (typeof Recipe !== 'undefined' && App?.currentRecipe) {
      Recipe.display(App.currentRecipe);
    }
    this.active = false;
    this.renderTimerBar();
  },

  createOverlay() {
    if (this.overlay) this.overlay.remove();

    const recipe = this.recipe;
    // One multiplier for the whole app: servings AND the `Scale` control
    // (issue #49 — cooking mode used to drop the latter, so a scaled recipe
    // showed its original amounts once you started cooking).
    const scale = Recipe ? Recipe.scaleFor(recipe) : 1;

    const el = document.createElement('div');
    el.id = 'cooking-overlay';
    el.className = 'fixed inset-0 z-50 bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col';

    let stepsHtml = '';
    recipe.steps.forEach((step, i) => {
      const temp = step.temperature_f
        ? (typeof Recipe !== 'undefined' && Recipe.useCelsius
            ? `${Math.round((step.temperature_f - 32) * 5 / 9)}°C`
            : `${step.temperature_f}°F`)
        : null;

      let ingsHtml = '';
      if (step.ingredients?.length) {
        ingsHtml = '<div class="ing-grid mt-4 ml-1 pl-4 border-l-2 border-zinc-200 dark:border-zinc-800">';
        step.ingredients.forEach((ing) => {
          const g = Math.round(ing.grams * scale);
          const vol = Recipe ? Recipe.formatVolume(ing.volume, scale) : '';
          ingsHtml += `
            <span class="text-zinc-600 dark:text-zinc-400 text-lg">${this.escapeHtml(ing.name)}</span>
            <span class="text-zinc-400 dark:text-zinc-500 tabular-nums text-base">${g}g${vol ? ` · ${vol}` : ''}</span>`;
        });
        ingsHtml += '</div>';
      }

      const durations = this.parseDurations(step.description);
      let timerHtml = '';
      if (durations.length) {
        timerHtml = '<div class="flex flex-wrap gap-2 mt-4">';
        durations.forEach((d, j) => {
          const timerId = `cm-timer-${i}-${j}`;
          timerHtml += `<button class="timer-start-btn px-5 py-2.5 rounded-xl bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 transition-colors text-base" data-timer-id="${timerId}" data-seconds="${d.seconds}" data-step="${i}">
            ⏱ ${this.formatTime(d.seconds)}
          </button>
          <span id="${timerId}-inline" class="hidden items-center px-4 py-2.5 rounded-xl bg-zinc-200 dark:bg-zinc-800 text-base tabular-nums"></span>`;
        });
        timerHtml += '</div>';
      }

      const isActive = Recipe?.activeSteps?.has(String(i));
      const isDone = this.ticks.steps.has(String(i));
      stepsHtml += `
        <div class="cm-step step-card rounded-2xl p-6 md:p-8 my-4 cursor-pointer bg-zinc-100/70 dark:bg-zinc-900/50${isActive ? ' step-active' : ''}${isDone ? ' cm-step-done' : ''}" data-step="${i}">
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" class="ingredient-check cm-step-check" data-step="${i}" aria-label="${this.escapeAttr(t('cook.tickStep', { n: i + 1 }))}"${isDone ? ' checked' : ''}>
            <span class="text-sm font-medium text-blue-500 dark:text-blue-400">${t('cook.stepOf', { n: i + 1, total: recipe.steps.length })}</span>
          </label>
          <div class="cm-step-body">
            <p class="text-2xl md:text-3xl leading-relaxed font-light mt-3">${this.escapeHtml(step.description)}</p>
            ${temp ? `<div class="text-xl text-orange-500 dark:text-orange-400 mt-3">${temp}</div>` : ''}
            ${ingsHtml}
            ${timerHtml}
          </div>
        </div>`;
    });

    el.innerHTML = `
      <div class="flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold">${this.escapeHtml(recipe.title)}</h2>
          ${typeof Recipe !== 'undefined' ? Recipe.playlistHtml(recipe, { compact: true }) : ''}
          <div id="cm-timers" class="flex flex-wrap gap-2"></div>
        </div>
        <div class="flex items-center gap-2">
        ${this.buildScaleControls(recipe)}
        <button id="cm-exit" class="p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-zinc-400 hover:text-zinc-900 dark:hover:text-white">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
        </div>
      </div>
      <div id="cm-progress" class="shrink-0 px-4 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <div class="max-w-2xl mx-auto flex items-center gap-3">
          <div id="cm-progress-track" class="flex-1 min-w-0 h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden" role="progressbar" aria-valuemin="0" aria-valuemax="${this._checklistTotal(recipe)}" aria-valuenow="0" aria-label="${this.escapeAttr(t('cook.progressAria'))}">
            <div id="cm-progress-bar" class="h-full rounded-full bg-green-600 dark:bg-green-400" style="width:0%"></div>
          </div>
          <span id="cm-progress-label" class="text-sm font-medium tabular-nums text-zinc-500 dark:text-zinc-400 shrink-0">0/${this._checklistTotal(recipe)}</span>
        </div>
        <div id="cm-finish-wrap" class="max-w-2xl mx-auto"></div>
      </div>
      <div id="cm-body" class="flex-1 overflow-y-auto">
        <div class="max-w-2xl mx-auto px-6">
          ${this.buildIngredientSummary(recipe, scale)}
          ${stepsHtml}
          <div class="py-16 text-center">
            <p class="text-3xl mb-4">🎉</p>
            <p class="text-xl text-zinc-500 dark:text-zinc-400">${t('cook.done')}</p>
            <button id="cm-made-it" class="mt-6 px-6 py-3 text-base rounded-xl bg-green-600 hover:bg-green-500 text-white font-medium transition-colors">${t('recipe.madeIt')}</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(el);
    this.overlay = el;

    el.querySelector('#cm-exit').addEventListener('click', () => this.exit());
    this.bindScaleControls(el, recipe);
    // "Made it" from the natural moment — the end-of-cook screen. Only
    // shown when there's a target to mark (own conversation or shared).
    const madeBtn = el.querySelector('#cm-made-it');
    if (madeBtn) {
      if (!App.currentConversationId && !App.viewingShared?.id) {
        madeBtn.classList.add('hidden');
      } else {
        madeBtn.addEventListener('click', () => {
          if (typeof Recipe !== 'undefined') Recipe.markMadeIt();
        });
      }
    }
    document.addEventListener('keydown', this.handleKey);

    el.querySelectorAll('.timer-start-btn').forEach((btn) => {
      const existing = this.timers.find(t => t.id === btn.dataset.timerId);
      if (existing) {
        btn.classList.add('hidden');
        const inline = el.querySelector(`#${btn.dataset.timerId}-inline`);
        if (inline) {
          inline.classList.remove('hidden');
          inline.classList.add('flex');
          if (existing.remaining <= 0) {
            inline.textContent = t('cook.timerDone');
            inline.classList.add('animate-pulse', 'text-green-500');
          } else {
            inline.textContent = `⏱ ${this.formatTime(existing.remaining)} / ${this.formatTime(existing.total)}`;
          }
        }
      }
      btn.addEventListener('click', () => {
        const stepNum = parseInt(btn.dataset.step) + 1;
        this.startTimer(btn.dataset.timerId, parseInt(btn.dataset.seconds), stepNum);
        btn.classList.add('hidden');
        const inline = el.querySelector(`#${btn.dataset.timerId}-inline`);
        if (inline) inline.classList.remove('hidden');
        if (inline) inline.classList.add('flex');
      });

      const inlineEl = el.querySelector(`#${btn.dataset.timerId}-inline`);
      if (inlineEl) {
        inlineEl.style.cursor = 'pointer';
        inlineEl.title = t('cook.timerResetTitle');
        inlineEl.addEventListener('click', () => {
          const timer = this.timers.find(t => t.id === btn.dataset.timerId);
          if (!timer) return;
          if (timer.remaining <= 0) {
            this.dismissTimer(timer);
          } else {
            this.resetTimer(timer);
          }
        });
      }
    });

    el.querySelectorAll('.cm-step.step-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, label')) return;
        card.classList.toggle('step-active');
        const step = card.dataset.step;
        if (Recipe) {
          if (card.classList.contains('step-active')) {
            Recipe.activeSteps.add(step);
          } else {
            Recipe.activeSteps.delete(step);
          }
          Recipe.saveUIStateToServer();
        }
      });
    });

    el.querySelectorAll('.cm-step-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        this.setStepTicked(parseInt(cb.dataset.step, 10), cb.checked);
      });
    });

    el.querySelectorAll('.cm-ing-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        const ing = this._aggregateIngredients(this.recipe)[parseInt(cb.dataset.ingIdx, 10)];
        if (ing) this.setIngTicked(ing.name, cb.checked);
      });
    });

    this.updateProgress();
  },

  // Servings / scale, right where the cook needs them: changing either one
  // re-renders every amount on screen and is saved like any other change
  // made in the recipe view.
  buildScaleControls(recipe) {
    if (typeof Recipe === 'undefined') return '';
    const btn = 'w-7 h-7 rounded flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-500';
    const group = 'flex items-center gap-1 rounded-lg bg-zinc-100 dark:bg-zinc-900 px-1';
    return `
      <div id="cm-scale-controls" class="flex items-center gap-2 text-sm">
        <span class="text-zinc-400 dark:text-zinc-500 hidden sm:inline">${t('recipe.servings')}</span>
        <div class="${group}">
          <button class="cm-servings-btn ${btn}" data-delta="-1" aria-label="${this.escapeHtml(t('recipe.servings'))} -">&minus;</button>
          <span id="cm-servings-count" class="font-semibold w-5 text-center tabular-nums">${Recipe.servingsFor(recipe)}</span>
          <button class="cm-servings-btn ${btn}" data-delta="1" aria-label="${this.escapeHtml(t('recipe.servings'))} +">+</button>
        </div>
        <span class="text-zinc-400 dark:text-zinc-500 hidden sm:inline">${t('recipe.scale')}</span>
        <div class="${group}">
          <button class="cm-scale-btn ${btn}" data-delta="-0.25" aria-label="${this.escapeHtml(t('recipe.scale'))} -">&minus;</button>
          <span id="cm-scale-count" class="font-semibold w-8 text-center tabular-nums">${Recipe.scaleLabel()}</span>
          <button class="cm-scale-btn ${btn}" data-delta="0.25" aria-label="${this.escapeHtml(t('recipe.scale'))} +">+</button>
        </div>
      </div>`;
  },

  bindScaleControls(el, recipe) {
    if (typeof Recipe === 'undefined') return;
    el.querySelectorAll('.cm-servings-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = parseInt(btn.dataset.delta);
        Recipe.currentServings = Math.max(1, Recipe.servingsFor(recipe) + delta);
        Recipe.saveUIStateToServer();
        this.rerender();
      });
    });
    el.querySelectorAll('.cm-scale-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = parseFloat(btn.dataset.delta);
        Recipe.servingScale = Math.max(0.5, Math.min(2.0,
          Math.round(((Recipe.servingScale || 1) + delta) * 100) / 100));
        Recipe.saveUIStateToServer();
        this.rerender();
      });
    });
  },

  // Rebuild the overlay in place (running timers and scroll position
  // survive) after something that changes every printed amount.
  rerender() {
    if (!this.active || !this.recipe) return;
    const scrollTop = this.overlay?.querySelector('#cm-body')?.scrollTop || 0;
    this.createOverlay();
    const body = this.overlay?.querySelector('#cm-body');
    if (body) body.scrollTop = scrollTop;
    this.renderTimers();
  },

  handleKey(e) {
    if (!CookingMode.active) return;
    if (e.key === 'Escape') CookingMode.exit();
  },

  startTimer(id, seconds, stepNum) {
    const existing = this.timers.find(t => t.id === id);
    if (existing) {
      this.resetTimer(existing);
      return;
    }
    const timer = { id, total: seconds, remaining: seconds, stepNum, interval: null, chimeInterval: null };
    timer.interval = setInterval(() => {
      timer.remaining--;
      this.renderTimers();
      if (timer.remaining <= 0) {
        clearInterval(timer.interval);
        timer.interval = null;
        this.startChime(timer);
      }
    }, 1000);
    this.timers.push(timer);
    this.renderTimers();
  },

  resetTimer(timer) {
    if (timer.interval) clearInterval(timer.interval);
    this.stopChime(timer);
    this.dismissTimer(timer);
  },

  dismissTimer(timer) {
    this.stopChime(timer);
    if (timer.interval) clearInterval(timer.interval);
    this.timers = this.timers.filter(t => t.id !== timer.id);
    if (this.overlay) {
      const btn = this.overlay.querySelector(`.timer-start-btn[data-timer-id="${timer.id}"]`);
      const inline = this.overlay.querySelector(`#${timer.id}-inline`);
      if (btn) btn.classList.remove('hidden');
      if (inline) { inline.classList.add('hidden'); inline.classList.remove('flex', 'animate-pulse', 'text-green-500'); }
    }
    this.renderTimers();
    if (!this.active) this.renderTimerBar();
  },

  _timerBadge(stepNum) {
    return `<span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 dark:bg-blue-400 text-white dark:text-zinc-950 text-xs font-bold shrink-0">${stepNum}</span>`;
  },

  _timerPill(t) {
    const badge = this._timerBadge(t.stepNum);
    const cls = 'flex items-center gap-1.5 px-3 py-1 rounded-full text-sm cursor-pointer';
    if (t.remaining <= 0) {
      return `<div class="${cls} bg-green-600/20 text-green-400 animate-pulse" data-pill-timer="${t.id}">${badge} ${window.t('cook.timerDone')}</div>`;
    }
    return `<div class="${cls} bg-zinc-200 dark:bg-zinc-800 tabular-nums" data-pill-timer="${t.id}">${badge} ⏱ ${this.formatTime(t.remaining)} / ${this.formatTime(t.total)}</div>`;
  },

  _bindPillClicks(container) {
    if (!container) return;
    container.querySelectorAll('[data-pill-timer]').forEach((pill) => {
      pill.addEventListener('click', () => {
        const timer = this.timers.find(t => t.id === pill.dataset.pillTimer);
        if (!timer) return;
        if (timer.remaining <= 0) this.dismissTimer(timer);
        else this.resetTimer(timer);
      });
    });
  },

  renderTimers() {
    if (this.overlay) {
      const container = this.overlay.querySelector('#cm-timers');
      if (container) {
        container.innerHTML = this.timers.map(t => this._timerPill(t)).join('');
        this._bindPillClicks(container);
      }

      this.timers.forEach((t) => {
        const inline = this.overlay.querySelector(`#${t.id}-inline`);
        if (!inline) return;
        if (t.remaining <= 0) {
          inline.textContent = window.t('cook.timerDone');
          inline.classList.add('animate-pulse', 'text-green-500');
        } else {
          inline.textContent = `⏱ ${this.formatTime(t.remaining)} / ${this.formatTime(t.total)}`;
        }
      });
    }

    if (!this.active) this.renderTimerBar();

    // Update regular mode step timer inlines
    this.timers.forEach((t) => {
      const el = document.querySelector(`.step-timer-inline[data-timer-id="${t.id}"]`);
      if (!el) return;
      if (t.remaining <= 0) {
        el.textContent = window.t('cook.timerDone');
        el.classList.add('animate-pulse');
      } else {
        el.textContent = `⏱ ${this.formatTime(t.remaining)} / ${this.formatTime(t.total)}`;
      }
    });
  },

  renderTimerBar() {
    const bar = document.getElementById('timer-bar');
    const items = document.getElementById('timer-bar-items');
    if (!bar || !items) return;

    const active = this.timers.filter(t => t.remaining > 0);
    const done = this.timers.filter(t => t.remaining <= 0);

    if (!this.timers.length || (active.length === 0 && done.length === 0)) {
      bar.classList.add('hidden');
      bar.classList.remove('flex');
      this.timers = [];
      return;
    }

    bar.classList.remove('hidden');
    bar.classList.add('flex');
    items.innerHTML = this.timers.map(t => this._timerPill(t)).join('');
    this._bindPillClicks(items);

    const resumeBtn = document.getElementById('timer-bar-resume');
    if (resumeBtn) {
      resumeBtn.onclick = () => {
        if (this.recipe) this.enter(this.recipe, { resume: true });
      };
    }

    if (active.length === 0) {
      setTimeout(() => {
        bar.classList.add('hidden');
        bar.classList.remove('flex');
        this.timers = [];
      }, 5000);
    }
  },

  parseDurations(text) {
    const pattern = /(\d+)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)/gi;
    const results = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const num = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      let seconds;
      if (unit.startsWith('h')) seconds = num * 3600;
      else if (unit.startsWith('m')) seconds = num * 60;
      else seconds = num;
      results.push({ text: match[0], seconds });
    }
    return results;
  },

  formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  },

  _audioCtx: null,
  _getAudioCtx() {
    if (!this._audioCtx || this._audioCtx.state === 'closed') {
      this._audioCtx = new AudioContext();
    }
    if (this._audioCtx.state === 'suspended') {
      this._audioCtx.resume();
    }
    return this._audioCtx;
  },

  _playChimeNote(freq, volume, time) {
    try {
      const ctx = this._getAudioCtx();
      const t = time || ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc.start(t);
      osc.stop(t + 0.5);
    } catch { /* Audio not supported */ }
  },

  startChime(timer) {
    this.stopChime(timer);
    const baseVolume = 0.25;
    const notes = [659.25, 783.99, 659.25, 523.25];
    const burstGap = 0.3;
    const loopGap = 1500;

    const playBurst = () => {
      try {
        const ctx = this._getAudioCtx();
        const now = ctx.currentTime;
        notes.forEach((freq, i) => {
          const vol = baseVolume * Math.pow(0.65, i);
          this._playChimeNote(freq, vol, now + i * burstGap);
        });
      } catch { /* Audio not supported */ }
    };

    playBurst();
    timer.chimeInterval = setInterval(playBurst, notes.length * burstGap * 1000 + loopGap);
  },

  stopChime(timer) {
    if (timer.chimeInterval) {
      clearInterval(timer.chimeInterval);
      timer.chimeInterval = null;
    }
  },

  async acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {
      // Wake lock not supported or denied
    }
  },

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  },

  // One row per distinct ingredient across all steps, in first-seen order.
  // Drives both the summary checklist and the progress total.
  _aggregateIngredients(recipe) {
    const allIngs = [];
    recipe.steps.forEach((step) => {
      (step.ingredients || []).forEach((ing) => {
        const existing = allIngs.find((a) => a.name === ing.name);
        if (existing) {
          existing.grams += ing.grams;
          existing.volume.amount += ing.volume.amount;
        } else {
          allIngs.push({
            name: ing.name,
            grams: ing.grams,
            volume: { amount: ing.volume.amount, unit: ing.volume.unit },
          });
        }
      });
    });
    return allIngs;
  },

  _checklistTotal(recipe) {
    return recipe.steps.length + this._aggregateIngredients(recipe).length;
  },

  // Checklist tick state (issue #116). Keyed per recipe message: conversation
  // (or shared copy) plus a title/steps fingerprint, so a reload of the same
  // recipe resumes mid-cook and an edited recipe starts a clean sheet.
  _tickStoreKey(recipe) {
    const scope = App.currentConversationId
      ? `c${App.currentConversationId}`
      : (App.viewingShared?.id ? `s${App.viewingShared.id}` : null);
    if (!scope) return null;
    return `recipebot:cookticks:${scope}:${recipe.title}|${recipe.steps.length}`;
  },

  _resetTicks(recipe) {
    this.ticks.steps.clear();
    this.ticks.ings.clear();
    const key = this._tickStoreKey(recipe);
    if (key) { try { localStorage.removeItem(key); } catch { /* storage blocked */ } }
  },

  _resumeTicks(recipe) {
    this.ticks.steps.clear();
    this.ticks.ings.clear();
    const key = this._tickStoreKey(recipe);
    if (!key) return;
    let data = null;
    try { data = JSON.parse(localStorage.getItem(key) || 'null'); } catch { data = null; }
    if (!data) return;
    const ingNames = new Set(this._aggregateIngredients(recipe).map((a) => a.name));
    (Array.isArray(data.steps) ? data.steps : []).forEach((s) => {
      const i = Number(s);
      if (Number.isInteger(i) && i >= 0 && i < recipe.steps.length) this.ticks.steps.add(String(i));
    });
    (Array.isArray(data.ings) ? data.ings : []).forEach((n) => {
      if (typeof n === 'string' && ingNames.has(n)) this.ticks.ings.add(n);
    });
  },

  _saveTicks(recipe) {
    const key = this._tickStoreKey(recipe);
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({
        steps: Array.from(this.ticks.steps),
        ings: Array.from(this.ticks.ings),
      }));
    } catch { /* storage blocked */ }
  },

  setStepTicked(i, checked) {
    if (!this.recipe) return;
    if (checked) this.ticks.steps.add(String(i));
    else this.ticks.steps.delete(String(i));
    this._saveTicks(this.recipe);
    this._applyStepTick(i);
    this.updateProgress();
  },

  _applyStepTick(i) {
    const card = this.overlay?.querySelector(`.cm-step[data-step="${i}"]`);
    if (!card) return;
    const done = this.ticks.steps.has(String(i));
    card.classList.toggle('cm-step-done', done);
    const cb = card.querySelector('.cm-step-check');
    if (cb) cb.checked = done;
  },

  setIngTicked(name, checked) {
    if (!this.recipe) return;
    if (checked) this.ticks.ings.add(name);
    else this.ticks.ings.delete(name);
    this._saveTicks(this.recipe);
    this._syncIngChecks();
    this.updateProgress();
  },

  _syncIngChecks() {
    if (!this.overlay || !this.recipe) return;
    const ings = this._aggregateIngredients(this.recipe);
    this.overlay.querySelectorAll('.cm-ing-check').forEach((cb) => {
      const ing = ings[parseInt(cb.dataset.ingIdx, 10)];
      if (ing) cb.checked = this.ticks.ings.has(ing.name);
    });
  },

  // Done and total for the progress bar, plus the Finish cooking button,
  // which only exists in the DOM once every step and ingredient is ticked.
  updateProgress() {
    if (!this.overlay || !this.recipe) return;
    const total = this._checklistTotal(this.recipe);
    const done = Math.min(total, this.ticks.steps.size + this.ticks.ings.size);
    const label = this.overlay.querySelector('#cm-progress-label');
    if (label) label.textContent = `${done}/${total}`;
    const track = this.overlay.querySelector('#cm-progress-track');
    if (track) track.setAttribute('aria-valuenow', String(done));
    const bar = this.overlay.querySelector('#cm-progress-bar');
    if (bar) bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;

    const complete = total > 0 && done >= total;
    if (complete !== this._finishShown) {
      this._finishShown = complete;
      const wrap = this.overlay.querySelector('#cm-finish-wrap');
      if (wrap) {
        wrap.innerHTML = complete
          ? `<button id="cm-finish" class="mt-2 w-full px-4 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 text-white font-medium transition-colors">${t('cook.finish')}</button>`
          : '';
        wrap.querySelector('#cm-finish')?.addEventListener('click', () => this.finishCooking());
      }
    }
  },

  finishCooking() {
    if (this.recipe) this._resetTicks(this.recipe);
    this.exit();
    // Marks that the finish flow completed this session (used by checks).
    document.body.setAttribute('data-cook-finished', '1');
  },

  // ?ui= deep links for the checklist (see openUiState in app.js): each one
  // drives the checklist through its real code paths so a URL reaches the
  // state deterministically. Pure UI state — ticks live in localStorage
  // only, nothing touches the database.
  demoState(name) {
    const recipe = App.currentRecipe;
    if (!recipe?.steps?.length) return;
    const tickAll = () => {
      recipe.steps.forEach((_, i) => this.setStepTicked(i, true));
      this._aggregateIngredients(recipe).forEach((ing) => this.setIngTicked(ing.name, true));
    };
    switch (name) {
      case 'cooktick':
        this.enter(recipe);
        this.setStepTicked(0, true);
        break;
      case 'cookall':
        this.enter(recipe);
        tickAll();
        break;
      case 'cookpersist':
        // A session that ended mid-cook, then boots the way a reload does:
        // the tick comes back out of storage.
        this.enter(recipe);
        this.setStepTicked(0, true);
        this.exit();
        this.enter(recipe, { resume: true });
        break;
      case 'cookfinish':
        this.enter(recipe);
        tickAll();
        this.finishCooking();
        break;
      case 'cookrestart':
        // Leftover ticks from a previous session; starting to cook again
        // resets them.
        this.enter(recipe);
        this.setStepTicked(0, true);
        this.exit();
        this.enter(recipe);
        break;
    }
  },

  buildIngredientSummary(recipe, scale) {
    const allIngs = this._aggregateIngredients(recipe);
    if (!allIngs.length) return '';

    let rows = '';
    allIngs.forEach((ing, i) => {
      const g = Math.round(ing.grams * scale);
      const vol = Recipe ? Recipe.formatVolume(ing.volume, scale) : '';
      const id = `cm-ing-${i}`;
      const isChecked = this.ticks.ings.has(ing.name);
      rows += `<label for="${id}" class="ingredient-label flex items-center justify-between py-1.5 text-base cursor-pointer">
        <span class="flex items-center gap-3">
          <input type="checkbox" id="${id}" class="ingredient-check cm-ing-check" data-ing-idx="${i}"${isChecked ? ' checked' : ''}>
          <span class="ing-name">${this.escapeHtml(ing.name)}</span>
        </span>
        <span class="ing-amt text-zinc-500 dark:text-zinc-400 tabular-nums ml-4 whitespace-nowrap">${g}g${vol ? ` (${vol})` : ''}</span>
      </label>`;
    });

    return `
      <div class="py-8 border-b border-zinc-200 dark:border-zinc-800">
        <div class="text-sm font-medium text-blue-500 dark:text-blue-400 mb-3">${t('cook.allIngredients')}</div>
        <div class="bg-zinc-100 dark:bg-zinc-900 rounded-xl p-5 w-full max-w-lg">
          ${rows}
        </div>
      </div>`;
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  // For attribute values: also escapes quotes so a value can't close the
  // attribute it sits in.
  escapeAttr(str) {
    return this.escapeHtml(String(str ?? '')).replace(/"/g, '&quot;');
  },
};
