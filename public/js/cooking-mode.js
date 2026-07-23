const CookingMode = {
  active: false,
  recipe: null,
  timers: [],
  wakeLock: null,
  overlay: null,

  enter(recipe) {
    if (!recipe?.steps?.length) return;
    this.recipe = recipe;
    this.active = true;
    const hasRunning = this.timers.some(t => t.remaining > 0);
    if (!hasRunning) this.timers = [];
    const bar = document.getElementById('timer-bar');
    if (bar) { bar.classList.add('hidden'); bar.classList.remove('flex'); }
    this.createOverlay();
    this.acquireWakeLock();
  },

  exit() {
    this.releaseWakeLock();
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
    const scale = (Recipe?.currentServings || recipe.default_servings) / recipe.default_servings;

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
      stepsHtml += `
        <div class="cm-step step-card rounded-2xl p-6 md:p-8 my-4 cursor-pointer bg-zinc-100/70 dark:bg-zinc-900/50${isActive ? ' step-active' : ''}" data-step="${i}">
          <div class="text-sm font-medium text-blue-500 dark:text-blue-400 mb-3">Step ${i + 1} of ${recipe.steps.length}</div>
          <p class="text-2xl md:text-3xl leading-relaxed font-light">${this.escapeHtml(step.description)}</p>
          ${temp ? `<div class="text-xl text-orange-500 dark:text-orange-400 mt-3">${temp}</div>` : ''}
          ${ingsHtml}
          ${timerHtml}
        </div>`;
    });

    el.innerHTML = `
      <div class="flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold">${this.escapeHtml(recipe.title)}</h2>
          <div id="cm-timers" class="flex flex-wrap gap-2"></div>
        </div>
        <button id="cm-exit" class="p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-zinc-400 hover:text-zinc-900 dark:hover:text-white">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div id="cm-body" class="flex-1 overflow-y-auto">
        <div class="max-w-2xl mx-auto px-6">
          ${this.buildIngredientSummary(recipe, scale)}
          ${stepsHtml}
          <div class="py-16 text-center">
            <p class="text-3xl mb-4">🎉</p>
            <p class="text-xl text-zinc-500 dark:text-zinc-400">You're done! Enjoy your meal.</p>
            <button id="cm-made-it" class="mt-6 px-6 py-3 text-base rounded-xl bg-green-600 hover:bg-green-500 text-white font-medium transition-colors">☑ Made it</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(el);
    this.overlay = el;

    el.querySelector('#cm-exit').addEventListener('click', () => this.exit());
    // "Made it" from the natural moment — the end-of-cook screen. Only
    // shown when there's a target to mark (own conversation or shared).
    const madeBtn = el.querySelector('#cm-made-it');
    if (madeBtn) {
      if (!App.currentConversationId && !App.viewingShared?.id) {
        madeBtn.classList.add('hidden');
      } else {
        madeBtn.addEventListener('click', () => {
          if (typeof Recipe !== 'undefined') Recipe.markMadeIt(madeBtn);
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
            inline.textContent = '⏱ Done!';
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
        inlineEl.title = 'Click to reset, or dismiss if done';
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

    el.querySelectorAll('.cm-ing-sync').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (!Recipe) return;
        const keys = JSON.parse(cb.dataset.stepKeys);
        keys.forEach((k) => {
          if (cb.checked) Recipe.checkedIngredients.add(k);
          else Recipe.checkedIngredients.delete(k);
        });
        Recipe.saveUIStateToServer();
      });
    });
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
      return `<div class="${cls} bg-green-600/20 text-green-400 animate-pulse" data-pill-timer="${t.id}">${badge} ⏱ Done!</div>`;
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
          inline.textContent = '⏱ Done!';
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
        el.textContent = '⏱ Done!';
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
        if (this.recipe) this.enter(this.recipe);
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

  buildIngredientSummary(recipe, scale) {
    const allIngs = [];
    recipe.steps.forEach((step, stepIdx) => {
      (step.ingredients || []).forEach((ing) => {
        const stepKey = `${stepIdx}-${ing.name}`;
        const existing = allIngs.find((a) => a.name === ing.name);
        if (existing) {
          existing.grams += ing.grams;
          existing.volume.amount += ing.volume.amount;
          existing.stepKeys.push(stepKey);
        } else {
          allIngs.push({
            name: ing.name,
            grams: ing.grams,
            volume: { amount: ing.volume.amount, unit: ing.volume.unit },
            stepKeys: [stepKey],
          });
        }
      });
    });

    if (!allIngs.length) return '';

    const checked = Recipe?.checkedIngredients || new Set();

    let rows = '';
    allIngs.forEach((ing, i) => {
      const g = Math.round(ing.grams * scale);
      const vol = Recipe ? Recipe.formatVolume(ing.volume, scale) : '';
      const id = `cm-ing-${i}`;
      const isChecked = ing.stepKeys.every((k) => checked.has(k));
      rows += `<label for="${id}" class="ingredient-label flex items-center justify-between py-1.5 text-base cursor-pointer">
        <span class="flex items-center gap-3">
          <input type="checkbox" id="${id}" class="ingredient-check cm-ing-sync" data-step-keys='${JSON.stringify(ing.stepKeys)}'${isChecked ? ' checked' : ''}>
          <span class="ing-name">${this.escapeHtml(ing.name)}</span>
        </span>
        <span class="ing-amt text-zinc-500 dark:text-zinc-400 tabular-nums ml-4 whitespace-nowrap">${g}g${vol ? ` (${vol})` : ''}</span>
      </label>`;
    });

    return `
      <div class="py-8 border-b border-zinc-200 dark:border-zinc-800">
        <div class="text-sm font-medium text-blue-500 dark:text-blue-400 mb-3">All Ingredients</div>
        <div class="bg-zinc-100 dark:bg-zinc-900 rounded-xl p-5 w-full max-w-lg">
          ${rows}
        </div>
      </div>`;
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
};
