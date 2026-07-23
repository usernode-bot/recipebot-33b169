const Recipe = {
  currentServings: null,
  servingScale: 1.0,
  useCelsius: true,
  diffMode: false,
  ingredientSummaryOpen: false,
  checkedIngredients: new Set(),
  activeSteps: new Set(),

  handleRecipeEvent(recipeData) {
    if (App.currentRecipe) {
      App.pendingRecipe = recipeData;
      this.showDiff(App.currentRecipe, recipeData);
    } else {
      App.currentRecipe = recipeData;
      this.currentServings = recipeData.default_servings;
      this.ingredientSummaryOpen = false;
      this.checkedIngredients.clear();
      this.activeSteps.clear();
      this.servingScale = 1.0;
      this.display(recipeData);
    }
  },

  display(recipe) {
    const empty = document.getElementById('recipe-empty');
    const display = document.getElementById('recipe-display');

    if (!this.diffMode) this.saveUIState(display);

    empty.classList.add('hidden');
    display.classList.remove('hidden');
    this.diffMode = false;

    const servings = this.currentServings || recipe.default_servings;
    const ss = this.servingScale;
    const ingredientScale = (servings / recipe.default_servings) * ss;
    const baseMacros = this.computeMacros(recipe, 1);
    const perServingMacros = {
      calories: (baseMacros.calories / servings) * ss,
      protein_g: (baseMacros.protein_g / servings) * ss,
      carbs_g: (baseMacros.carbs_g / servings) * ss,
      fat_g: (baseMacros.fat_g / servings) * ss,
      fiber_g: (baseMacros.fiber_g / servings) * ss,
    };

    const timeInfo = [
      recipe.prep_time ? `Prep: ${recipe.prep_time}` : '',
      recipe.cook_time ? `Cook: ${recipe.cook_time}` : '',
    ].filter(Boolean).join('  ·  ');

    const scaleLabel = ss === 1.0 ? '1×' : `${ss}×`;

    // Byline while viewing someone's shared recipe read-only (no owned
    // conversation yet — sending a chat message auto-forks it).
    let bylineHtml = '';
    if (App.viewingShared && !App.currentConversationId) {
      const vs = App.viewingShared;
      const ratingBit = vs.rating_count
        ? ` · ★ ${Number(vs.avg_rating).toFixed(1)} (${vs.rating_count})`
        : '';
      const displayedVersion = App.viewingVersion ? App.viewingVersion.version : vs.current_version;
      const versionBit = displayedVersion ? ` · v${displayedVersion}` : '';
      const madeBit = vs.made_count ? ` · cooked ${vs.made_count}×` : '';
      const historyBit = vs.id && vs.current_version > 1
        ? ` · <button id="history-btn" class="underline hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">History</button>`
        : '';
      bylineHtml = `<p class="text-sm text-zinc-400 dark:text-zinc-500 mt-1">by ${this.escapeHtml(vs.is_mine ? 'you' : vs.username)}${ratingBit}${versionBit}${madeBit}${historyBit}</p>`;
      if (vs.forked_from_username) {
        bylineHtml += `<p class="text-sm text-zinc-400 dark:text-zinc-500 mt-0.5">⑂ remixed from ${this.escapeHtml(vs.forked_from_username)}'s recipe</p>`;
      }
    }

    // Tag chips on the recipe view (from the recipe JSON).
    const tagChipsHtml = (recipe.tags && recipe.tags.length)
      ? `<div class="flex flex-wrap gap-1 mt-2">${recipe.tags.slice(0, 8).map((t) =>
          `<span class="px-2 py-0.5 text-[11px] rounded-full bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400">${this.escapeHtml(t)}</span>`
        ).join('')}</div>`
      : '';

    // Banner while viewing an older version of a shared recipe.
    let versionBannerHtml = '';
    if (App.viewingVersion && App.viewingShared &&
        App.viewingVersion.version !== App.viewingShared.current_version) {
      versionBannerHtml = `
        <div class="flex items-center justify-between gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <span class="text-sm font-medium text-blue-800 dark:text-blue-200">Viewing v${App.viewingVersion.version} — current version is v${App.viewingShared.current_version}</span>
          <button id="version-back-current" class="shrink-0 px-3 py-1 text-sm rounded-lg bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors">Back to current</button>
        </div>`;
    }

    display.innerHTML = `
      <div class="space-y-5">
        ${versionBannerHtml}
        <div>
          <h2 class="text-2xl font-bold tracking-tight">${this.escapeHtml(recipe.title)}</h2>
          ${bylineHtml}
          ${recipe.description ? `<p class="text-zinc-500 dark:text-zinc-400 text-sm mt-1.5 leading-relaxed">${this.renderInline(recipe.description)}</p>` : ''}
          ${tagChipsHtml}
        </div>

        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <div class="flex items-center gap-2">
            <span class="text-zinc-400 dark:text-zinc-500">Servings</span>
            <div class="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-lg px-1 py-0.5">
              <button class="servings-btn w-6 h-6 rounded flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-500" data-delta="-1">&minus;</button>
              <span id="servings-count" class="font-semibold w-5 text-center text-sm">${servings}</span>
              <button class="servings-btn w-6 h-6 rounded flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-500" data-delta="1">+</button>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-zinc-400 dark:text-zinc-500">Scale</span>
            <div class="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-lg px-1 py-0.5">
              <button class="scale-btn w-6 h-6 rounded flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-500" data-delta="-0.25">&minus;</button>
              <span id="scale-count" class="font-semibold w-8 text-center text-sm">${scaleLabel}</span>
              <button class="scale-btn w-6 h-6 rounded flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-500" data-delta="0.25">+</button>
            </div>
          </div>
          ${timeInfo ? `<span class="text-zinc-400 dark:text-zinc-500">${timeInfo}</span>` : ''}
          <div id="temp-toggle" class="flex text-xs rounded-full bg-zinc-100 dark:bg-zinc-900 overflow-hidden cursor-pointer select-none">
            <span class="px-2.5 py-1 rounded-full transition-all ${this.useCelsius ? 'bg-blue-200 dark:bg-blue-700/40 text-blue-800 dark:text-blue-100 font-medium shadow-sm' : 'text-zinc-400 dark:text-zinc-500'}">°C</span>
            <span class="px-2.5 py-1 rounded-full transition-all ${!this.useCelsius ? 'bg-blue-200 dark:bg-blue-700/40 text-blue-800 dark:text-blue-100 font-medium shadow-sm' : 'text-zinc-400 dark:text-zinc-500'}">°F</span>
          </div>
          <button id="reset-progress" class="text-xs px-2 py-0.5 rounded-full border border-zinc-200 dark:border-zinc-800 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors" title="Reset step highlights and ingredient checks">
            Reset progress
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-zinc-400 dark:text-zinc-500">per serving${ss !== 1.0 ? ` (${scaleLabel})` : ''}</span>
          <span class="macro-pill bg-orange-50 dark:bg-orange-950/40 text-orange-600 dark:text-orange-400">${Math.round(perServingMacros.calories)} cal</span>
          <span class="macro-pill bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400">${Math.round(perServingMacros.protein_g)}g protein</span>
          <span class="macro-pill bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">${Math.round(perServingMacros.carbs_g)}g carbs</span>
          <span class="macro-pill bg-violet-50 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400">${Math.round(perServingMacros.fat_g)}g fat</span>
          <span class="macro-pill bg-green-50 dark:bg-green-950/40 text-green-600 dark:text-green-400">${Math.round(perServingMacros.fiber_g)}g fiber</span>
          ${recipe.serving_item ? `<span class="macro-pill bg-zinc-100 dark:bg-zinc-800/60 text-zinc-600 dark:text-zinc-300">${Math.round(recipe.serving_item.count * ss)} ${this.escapeHtml(recipe.serving_item.name)}</span>` : ''}
        </div>

        <div class="flex flex-wrap gap-2 pt-1">
          <button id="cook-btn" class="px-4 py-2 text-sm rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors">🍳 Cook Mode</button>
          ${this.renderMadeItControl()}
          ${this.renderForkControl()}
          ${this.renderShareControls()}
          ${this.renderCollectionControl()}
          ${this.renderShareLinkControl()}
          <div class="relative">
            <button id="export-btn" class="px-4 py-2 text-sm rounded-xl bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors">Export ▾</button>
            <div id="export-menu" class="hidden absolute top-full mt-1 left-0 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg overflow-hidden z-10 min-w-[160px]">
              <button id="export-md" class="block w-full px-4 py-2.5 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800">Download Markdown</button>
              <button id="export-copy-md" class="block w-full px-4 py-2.5 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800">Copy Markdown</button>
              <button id="export-json" class="block w-full px-4 py-2.5 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800">Download JSON</button>
              <div class="border-t border-zinc-200 dark:border-zinc-700"></div>
              <label id="import-json-label" class="block w-full px-4 py-2.5 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer">Import JSON
                <input type="file" id="import-json-input" accept=".json,application/json" class="hidden">
              </label>
            </div>
          </div>
        </div>

        ${this.renderIngredientSummary(recipe, ingredientScale)}

        <div class="space-y-3 pt-1">
          ${recipe.steps.map((step, i) => this.renderStep(step, i, ingredientScale)).join('')}
        </div>

        ${recipe.notes ? `<div class="mt-3 p-4 bg-zinc-100/70 dark:bg-zinc-900/50 rounded-xl text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed"><strong class="text-zinc-700 dark:text-zinc-300">Notes:</strong> ${this.renderInline(recipe.notes)}</div>` : ''}

        <div id="social-section"></div>
      </div>
    `;

    this.bindActions(recipe, display);
    this.restoreUIState(display);
    // Made-it gallery, remixes and comments for published recipes.
    if (App.viewingShared?.id && !App.currentConversationId) {
      this.loadSocialSection(App.viewingShared.id);
    }
  },

  saveUIState(display) {
    if (display.classList.contains('hidden') || CookingMode?.active) return;

    const details = display.querySelector('details');
    if (details) this.ingredientSummaryOpen = details.open;

    this.checkedIngredients.clear();
    display.querySelectorAll('.ingredient-check[data-key]').forEach((cb) => {
      if (cb.checked) this.checkedIngredients.add(cb.dataset.key);
    });

    this.activeSteps.clear();
    display.querySelectorAll('.step-card.step-active').forEach((card) => {
      this.activeSteps.add(card.dataset.step);
    });
  },

  restoreUIState(display) {
    const details = display.querySelector('details');
    if (details) {
      details.open = this.ingredientSummaryOpen;
      details.addEventListener('toggle', () => {
        this.ingredientSummaryOpen = details.open;
        HashParams.set('ing', details.open ? '1' : null);
        this.saveUIStateToServer();
      });
    }

    display.querySelectorAll('.ingredient-check').forEach((cb) => {
      if (this.checkedIngredients.has(cb.dataset.key)) cb.checked = true;
    });

    display.querySelectorAll('.step-card').forEach((card) => {
      if (this.activeSteps.has(card.dataset.step)) card.classList.add('step-active');
    });
  },

  _remapUIState(oldRecipe, newRecipe) {
    const checkedNames = new Set();
    for (const key of this.checkedIngredients) {
      if (key) checkedNames.add(key.replace(/^\d+-/, ''));
    }
    this.checkedIngredients.clear();
    newRecipe.steps.forEach((step, i) => {
      (step.ingredients || []).forEach((ing) => {
        if (checkedNames.has(ing.name)) {
          this.checkedIngredients.add(`${i}-${ing.name}`);
        }
      });
    });

    const activeDescs = new Set();
    for (const idx of this.activeSteps) {
      const step = oldRecipe.steps[Number(idx)];
      if (step) activeDescs.add(step.description);
    }
    this.activeSteps.clear();
    newRecipe.steps.forEach((step, i) => {
      if (activeDescs.has(step.description)) {
        this.activeSteps.add(String(i));
      }
    });
  },

  saveUIStateToServer() {
    if (!App.currentConversationId) return;
    fetch(`/api/conversations/${App.currentConversationId}/ui-state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui_state: {
        activeSteps: Array.from(this.activeSteps),
        checkedIngredients: Array.from(this.checkedIngredients),
        servings: this.currentServings,
        servingScale: this.servingScale,
        showIngMacros: this._showIngMacros || false,
        ingredientSummaryOpen: this.ingredientSummaryOpen || false,
      } }),
    }).catch(() => {});
  },

  // Share / Update controls for the recipe of an owned conversation
  // (shared state comes from the store's conversation list). When the
  // shared copy already matches the latest recipe, the button is disabled.
  renderShareControls() {
    if (!App.currentConversationId) return '';
    const conv = (typeof Store !== 'undefined')
      ? Store.conversations.find((c) => c.id === App.currentConversationId)
      : null;
    if (conv?.is_shared) {
      if (conv.shared_up_to_date) {
        return `
        <button id="share-btn" disabled title="Shared copy is up to date" class="px-4 py-2 text-sm rounded-xl bg-zinc-100 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-600 opacity-60 cursor-default">Shared ✓</button>`;
      }
      return `
        <button id="share-btn" class="px-4 py-2 text-sm rounded-xl bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors">Update shared copy</button>`;
    }
    return `<button id="share-btn" class="px-4 py-2 text-sm rounded-xl bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors">Share</button>`;
  },

  // Fork button for the recipe view. Hidden in the unsaved-fork state
  // (no conversation and not viewing a shared recipe) — forking an
  // untouched fork would do nothing useful.
  renderForkControl() {
    if (!App.currentConversationId && !App.viewingShared) return '';
    return `<button id="fork-btn" title="Fork this recipe into a new conversation" class="px-4 py-2 text-sm rounded-xl bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors">Fork</button>`;
  },

  // "Made it" for an owned conversation or a published recipe.
  renderMadeItControl() {
    if (!App.currentConversationId && !App.viewingShared?.id) return '';
    return `<button id="made-it-btn" title="Mark that you cooked this (optional note)" class="px-4 py-2 text-sm rounded-xl bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors">☑ Made it</button>`;
  },

  // Add to a collection (own conversation or a published recipe).
  renderCollectionControl() {
    if (!App.currentConversationId && !App.viewingShared?.id) return '';
    return `<button id="add-collection-btn" title="Add this recipe to a collection" class="px-4 py-2 text-sm rounded-xl bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors">+ Collection</button>`;
  },

  // Copy the public share link (published recipes only).
  _currentShareSlug() {
    if (App.viewingShared?.share_slug) return App.viewingShared.share_slug;
    if (App.currentConversationId && typeof Store !== 'undefined') {
      const conv = Store.conversations.find((c) => c.id === App.currentConversationId);
      if (conv?.is_shared && conv.share_slug) return conv.share_slug;
    }
    return null;
  },

  renderShareLinkControl() {
    if (!this._currentShareSlug()) return '';
    return `<button id="copy-link-btn" title="Copy the public share link — anyone can view and cook it, no login" class="px-4 py-2 text-sm rounded-xl bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors">🔗 Link</button>`;
  },

  // ── "Made it" ────────────────────────────────────────────────

  promptMadeItNote() {
    return new Promise((resolve) => {
      const modal = document.getElementById('made-it-modal');
      const input = document.getElementById('made-it-note');
      if (!modal || !input) return resolve('');
      const confirmBtn = document.getElementById('made-it-confirm');
      const cancelBtn = document.getElementById('made-it-cancel');
      const closeBtn = document.getElementById('made-it-close');
      const backdrop = document.getElementById('made-it-backdrop');

      input.value = '';
      modal.classList.remove('hidden');
      input.focus();

      const done = (val) => {
        modal.classList.add('hidden');
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        closeBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onCancel);
        resolve(val);
      };
      const onConfirm = () => done(input.value.trim());
      const onCancel = () => done(null);
      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onCancel);
    });
  },

  async markMadeIt(btn) {
    const note = await this.promptMadeItNote();
    if (note === null) return; // cancelled
    const target = App.currentConversationId
      ? { conversationId: App.currentConversationId }
      : App.viewingShared?.id ? { sharedRecipeId: App.viewingShared.id } : null;
    if (!target) return;
    try {
      const res = await fetch('/api/made-it', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...target, note: note || undefined }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (btn) btn.textContent = `☑ Made it ✓ (${data.made_count}×)`;
      if (App.viewingShared) {
        App.viewingShared.made_count = data.made_count;
        if (App.viewingShared.id) this.loadSocialSection(App.viewingShared.id);
      }
    } catch {
      if (btn) btn.textContent = 'Failed — try again';
    }
  },

  // ── Publish dialog: creator tags + optional update note ─────────

  // Resolves { tags, note } or null when cancelled. AI-proposed tags from
  // the recipe JSON pre-fill the chips; the creator confirms/edits.
  promptPublish(recipe, { isUpdate } = {}) {
    return new Promise((resolve) => {
      const modal = document.getElementById('share-note-modal');
      const input = document.getElementById('share-note-input');
      if (!modal || !input) return resolve({ tags: undefined, note: '' });
      const confirmBtn = document.getElementById('share-note-confirm');
      const cancelBtn = document.getElementById('share-note-cancel');
      const closeBtn = document.getElementById('share-note-close');
      const backdrop = document.getElementById('share-note-backdrop');
      const titleEl = document.getElementById('share-note-title');
      const noteField = document.getElementById('share-note-field');
      const tagsList = document.getElementById('share-tags-list');
      const tagInput = document.getElementById('share-tag-input');

      const tags = Array.isArray(recipe?.tags)
        ? recipe.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
        : [];
      const renderTags = () => {
        tagsList.innerHTML = '';
        if (!tags.length) {
          tagsList.innerHTML = '<span class="text-xs text-zinc-400 dark:text-zinc-500">No tags yet — add some below (e.g. cuisine, diet, course, method)</span>';
        }
        tags.forEach((t, idx) => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'px-2.5 py-1 text-xs rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-red-100 dark:hover:bg-red-900/40 hover:text-red-600 transition-colors';
          chip.textContent = `${t} ✕`;
          chip.title = 'Remove tag';
          chip.addEventListener('click', () => { tags.splice(idx, 1); renderTags(); });
          tagsList.appendChild(chip);
        });
      };

      titleEl.textContent = isUpdate ? 'Update shared copy' : 'Share to the community feed';
      confirmBtn.textContent = isUpdate ? 'Update' : 'Share';
      noteField.style.display = isUpdate ? '' : 'none';
      input.value = '';
      tagInput.value = '';
      renderTags();
      modal.classList.remove('hidden');

      const onTagKey = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const t = tagInput.value.trim().toLowerCase().slice(0, 32);
        if (t && !tags.includes(t) && tags.length < 12) {
          tags.push(t);
          renderTags();
        }
        tagInput.value = '';
      };
      tagInput.addEventListener('keydown', onTagKey);

      const done = (val) => {
        modal.classList.add('hidden');
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        closeBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onCancel);
        tagInput.removeEventListener('keydown', onTagKey);
        resolve(val);
      };
      const onConfirm = () => done({ tags: tags.slice(), note: input.value.trim() });
      const onCancel = () => done(null);
      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onCancel);
    });
  },

  // ── Social section (made-it gallery, remixes, comments) ─────────

  async loadSocialSection(sharedId) {
    const container = document.getElementById('social-section');
    if (!container) return;
    try {
      const [madeRes, commentsRes, remixRes] = await Promise.all([
        fetch(`/api/shared-recipes/${sharedId}/made-it`),
        fetch(`/api/shared-recipes/${sharedId}/comments`),
        fetch(`/api/shared-recipes/${sharedId}/remixes`),
      ]);
      if (document.getElementById('social-section') !== container) return;
      const madeIt = madeRes.ok ? await madeRes.json() : [];
      const comments = commentsRes.ok ? await commentsRes.json() : [];
      const remixes = remixRes.ok ? await remixRes.json() : [];
      this.renderSocialSection(container, sharedId, madeIt, comments, remixes);
    } catch { /* leave section empty */ }
  },

  renderSocialSection(container, sharedId, madeIt, comments, remixes) {
    let html = '<div class="space-y-4 mt-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">';

    if (remixes.length) {
      html += `<div>
        <h3 class="text-sm font-semibold mb-2">⑂ ${remixes.length} remix${remixes.length === 1 ? '' : 'es'}</h3>
        <div class="space-y-1">`;
      remixes.slice(0, 10).forEach((r) => {
        html += `<p class="text-sm text-zinc-500 dark:text-zinc-400">${this.escapeHtml(r.title || 'Untitled')} <span class="text-zinc-400 dark:text-zinc-500">by ${this.escapeHtml(r.username)}</span>${r.share_slug ? ` · <a class="text-blue-500 hover:text-blue-400" href="/r/${this.escapeHtml(r.share_slug)}" target="_blank" rel="noopener">view</a>` : ''}</p>`;
      });
      html += '</div></div>';
    }

    const notes = madeIt.filter((m) => m.note);
    if (madeIt.length) {
      html += `<div>
        <h3 class="text-sm font-semibold mb-2">☑ Made it (${madeIt.length})</h3>`;
      if (notes.length) {
        html += '<div class="space-y-2">';
        notes.slice(0, 10).forEach((m) => {
          html += `<div class="p-3 rounded-lg bg-zinc-100/70 dark:bg-zinc-900/50 text-sm">
            <span class="font-medium">${this.escapeHtml(m.username)}</span>
            <p class="text-zinc-500 dark:text-zinc-400 mt-0.5">${this.escapeHtml(m.note)}</p>
          </div>`;
        });
        html += '</div>';
      } else {
        html += `<p class="text-xs text-zinc-400 dark:text-zinc-500">${madeIt.map((m) => this.escapeHtml(m.username)).slice(0, 8).join(', ')} cooked this.</p>`;
      }
      html += '</div>';
    }

    html += `<div>
      <h3 class="text-sm font-semibold mb-2">Comments (${comments.filter((c) => !c.deleted).length})</h3>
      <div id="comments-list" class="space-y-2"></div>
      <form id="comment-form" class="flex gap-2 mt-2">
        <input id="comment-input" type="text" maxlength="1000" placeholder="Add a comment…"
          class="flex-1 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500">
        <button type="submit" class="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors shrink-0">Post</button>
      </form>
    </div>`;

    html += '</div>';
    container.innerHTML = html;

    const list = container.querySelector('#comments-list');
    const isRecipeOwner = App.viewingShared?.is_mine;
    if (!comments.length) {
      list.innerHTML = '<p class="text-xs text-zinc-400 dark:text-zinc-500">No comments yet.</p>';
    }
    comments.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'p-3 rounded-lg bg-zinc-100/70 dark:bg-zinc-900/50 text-sm flex items-start justify-between gap-2';
      if (c.deleted) {
        row.innerHTML = '<p class="text-xs italic text-zinc-400 dark:text-zinc-600">comment deleted</p>';
      } else {
        row.innerHTML = `<div class="min-w-0">
          <span class="font-medium">${this.escapeHtml(c.username)}</span>
          <p class="text-zinc-500 dark:text-zinc-400 mt-0.5 break-words">${this.escapeHtml(c.body)}</p>
        </div>`;
        if (c.is_mine || isRecipeOwner) {
          const del = document.createElement('button');
          del.className = 'text-xs text-zinc-400 hover:text-red-500 transition-colors shrink-0';
          del.textContent = 'Delete';
          del.addEventListener('click', async () => {
            await fetch(`/api/comments/${c.id}`, { method: 'DELETE' }).catch(() => {});
            this.loadSocialSection(sharedId);
          });
          row.appendChild(del);
        }
      }
      list.appendChild(row);
    });

    container.querySelector('#comment-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = container.querySelector('#comment-input');
      const body = input.value.trim();
      if (!body) return;
      input.value = '';
      await fetch(`/api/shared-recipes/${sharedId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      }).catch(() => {});
      this.loadSocialSection(sharedId);
    });
  },

  // ── Version history (shared recipes) ─────────────────────────

  async openVersionHistory() {
    const vs = App.viewingShared;
    if (!vs?.id) return;
    const modal = document.getElementById('version-history-modal');
    const list = document.getElementById('version-history-list');
    if (!modal || !list) return;
    list.innerHTML = '<p class="text-sm text-zinc-400 dark:text-zinc-500">Loading…</p>';
    modal.classList.remove('hidden');

    try {
      const res = await fetch(`/api/shared-recipes/${vs.id}/versions`);
      if (!res.ok) throw new Error('versions failed');
      const versions = await res.json();
      if (versions.length) vs.current_version = versions[0].version;

      list.innerHTML = '';
      versions.forEach((v) => {
        const isCurrent = v.version === vs.current_version;
        const row = document.createElement('div');
        row.className = 'flex items-start justify-between gap-3 p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50';
        const date = v.created_at ? new Date(v.created_at).toLocaleDateString() : '';
        row.innerHTML = `
          <div class="min-w-0">
            <p class="text-sm font-medium">v${v.version}${isCurrent ? ' <span class="text-xs font-normal text-blue-500">current</span>' : ''}</p>
            <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">by ${this.escapeHtml(v.username)}${date ? ` · ${date}` : ''}</p>
            ${v.note ? `<p class="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">${this.escapeHtml(v.note)}</p>` : ''}
          </div>
          <button class="version-view-btn shrink-0 px-3 py-1.5 text-xs rounded-lg bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 transition-colors">View</button>`;
        row.querySelector('.version-view-btn').addEventListener('click', () => this.viewVersion(v));
        list.appendChild(row);
      });
    } catch {
      list.innerHTML = '<p class="text-sm text-red-500">Could not load version history</p>';
    }
  },

  viewVersion(v) {
    const vs = App.viewingShared;
    document.getElementById('version-history-modal')?.classList.add('hidden');
    if (!vs) return;
    if (v.version === vs.current_version) return this.backToCurrentVersion();
    App.viewingVersion = { version: v.version };
    App.currentRecipe = v.recipe_data;
    this.currentServings = v.recipe_data.default_servings;
    this.servingScale = 1.0;
    this.display(v.recipe_data);
  },

  backToCurrentVersion() {
    const vs = App.viewingShared;
    App.viewingVersion = null;
    if (!vs?.currentData) return;
    App.currentRecipe = vs.currentData;
    this.currentServings = vs.currentData.default_servings;
    this.servingScale = 1.0;
    this.display(vs.currentData);
  },

  bindActions(recipe, display) {
    display.querySelector('#share-btn')?.addEventListener('click', async () => {
      const btn = display.querySelector('#share-btn');
      if (btn?.disabled) return;

      // Publish dialog: confirm creator tags (AI-proposed) every time; the
      // "what changed" note is only asked when updating a shared copy.
      const conv = (typeof Store !== 'undefined')
        ? Store.conversations.find((c) => c.id === App.currentConversationId)
        : null;
      const result = await this.promptPublish(recipe, { isUpdate: !!conv?.is_shared });
      if (result === null) return; // cancelled

      try {
        const res = await fetch('/api/recipes/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: App.currentConversationId,
            note: result.note || undefined,
            tags: result.tags,
          }),
        });
        if (!res.ok) throw new Error('share failed');
        if (btn) btn.textContent = 'Shared!';
        if (App.currentRecipe) App.currentRecipe.tags = result.tags;
        if (typeof Store !== 'undefined') await Store.refresh();
        setTimeout(() => this.display(App.currentRecipe), 800);
      } catch {
        if (btn) btn.textContent = 'Share failed';
      }
    });

    display.querySelector('#made-it-btn')?.addEventListener('click', (e) => {
      this.markMadeIt(e.currentTarget);
    });

    display.querySelector('#add-collection-btn')?.addEventListener('click', () => {
      if (typeof Home === 'undefined') return;
      const target = App.currentConversationId
        ? { conversationId: App.currentConversationId }
        : App.viewingShared?.id ? { sharedRecipeId: App.viewingShared.id } : null;
      if (target) Home.openCollectionPicker(target);
    });

    display.querySelector('#copy-link-btn')?.addEventListener('click', (e) => {
      const slug = this._currentShareSlug();
      if (slug && typeof Home !== 'undefined') Home.copyShareLink(slug, e.currentTarget);
    });

    display.querySelector('#fork-btn')?.addEventListener('click', () => {
      if (typeof Store === 'undefined') return;
      const vs = App.viewingShared;
      Store.forkRecipe(App.currentRecipe, vs && !vs.is_mine ? { username: vs.username } : null);
    });

    display.querySelector('#history-btn')?.addEventListener('click', () => this.openVersionHistory());
    display.querySelector('#version-back-current')?.addEventListener('click', () => this.backToCurrentVersion());

    display.querySelectorAll('.servings-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = parseInt(btn.dataset.delta);
        this.currentServings = Math.max(1, (this.currentServings || recipe.default_servings) + delta);
        this.display(App.currentRecipe);
        this.saveUIStateToServer();
      });
    });

    display.querySelectorAll('.scale-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = parseFloat(btn.dataset.delta);
        this.servingScale = Math.max(0.5, Math.min(2.0, Math.round((this.servingScale + delta) * 100) / 100));
        this.display(App.currentRecipe);
        this.saveUIStateToServer();
      });
    });

    display.querySelector('#cook-btn')?.addEventListener('click', () => {
      if (typeof CookingMode !== 'undefined') CookingMode.enter(App.currentRecipe);
    });

    display.querySelector('#temp-toggle')?.addEventListener('click', () => {
      this.useCelsius = !this.useCelsius;
      if (typeof App !== 'undefined' && App.preferences) {
        App.preferences.tempUnit = this.useCelsius ? 'C' : 'F';
        if (typeof savePreferences === 'function') savePreferences();
      }
      this.display(App.currentRecipe);
    });

    display.querySelector('#reset-progress')?.addEventListener('click', () => {
      this.activeSteps.clear();
      this.checkedIngredients.clear();
      this.currentServings = recipe.default_servings;
      this.servingScale = 1.0;
      this.saveUIStateToServer();
      this.display(App.currentRecipe);
    });

    const exportBtn = display.querySelector('#export-btn');
    const exportMenu = display.querySelector('#export-menu');
    exportBtn?.addEventListener('click', () => exportMenu.classList.toggle('hidden'));
    display.querySelector('#export-md')?.addEventListener('click', () => { this.exportMarkdown(recipe); exportMenu.classList.add('hidden'); });
    display.querySelector('#export-copy-md')?.addEventListener('click', () => { this.copyMarkdown(recipe); exportMenu.classList.add('hidden'); });
    display.querySelector('#export-json')?.addEventListener('click', () => { this.exportJSON(recipe); exportMenu.classList.add('hidden'); });
    display.querySelector('#import-json-input')?.addEventListener('change', (e) => { this.importJSON(e); exportMenu.classList.add('hidden'); });

    // Step timer buttons
    display.querySelectorAll('.step-timer-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const timerId = btn.dataset.timerId;
        const seconds = parseInt(btn.dataset.seconds);
        const stepNum = parseInt(btn.dataset.step);
        CookingMode.recipe = recipe;
        CookingMode.startTimer(timerId, seconds, stepNum);
        btn.outerHTML = `<span class="step-timer-inline inline-flex items-center gap-1 px-3 py-1 text-xs rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 tabular-nums cursor-pointer" data-timer-id="${timerId}">⏱ ${CookingMode.formatTime(seconds)} / ${CookingMode.formatTime(seconds)}</span>`;
      });
    });

    display.querySelectorAll('.step-timer-inline').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const timer = CookingMode.timers.find(t => t.id === el.dataset.timerId);
        if (timer) CookingMode.resetTimer(timer);
      });
    });

    display.querySelectorAll('.step-card').forEach((card) => {
      card.style.cursor = 'pointer';
      card.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, .step-timer-inline')) return;
        card.classList.toggle('step-active');
        const step = card.dataset.step;
        if (card.classList.contains('step-active')) {
          this.activeSteps.add(step);
        } else {
          this.activeSteps.delete(step);
        }
        this.saveUIStateToServer();
      });
    });

    display.querySelectorAll('.ingredient-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          this.checkedIngredients.add(cb.dataset.key);
        } else {
          this.checkedIngredients.delete(cb.dataset.key);
        }
        this.saveUIStateToServer();
      });
    });

    // Keep the summary-line macros label from toggling the <details> open
    // state (the summary's default action fires on its click event).
    display.querySelector('.ing-macros-summary-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    display.querySelector('#ing-macros-toggle')?.addEventListener('change', (e) => {
      this._showIngMacros = e.target.checked;
      HashParams.set('mac', e.target.checked ? '1' : null);
      const grid = display.querySelector('.summary-grid');
      if (grid) grid.classList.toggle('show-macros', e.target.checked);
      this.saveUIStateToServer();
    });

    display.querySelectorAll('.ing-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this.appendToChatInput(`Remove ${btn.dataset.name} from the recipe`);
      });
    });

    display.querySelectorAll('.ing-swap').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this.appendToChatInput(`Find a substitute for ${btn.dataset.name}`);
      });
    });
  },

  appendToChatInput(text) {
    const input = document.getElementById('chat-input');
    if (!input) return;
    input.focus();
    const prefix = input.value.trim() ? '\n' : '';
    input.setSelectionRange(input.value.length, input.value.length);
    document.execCommand('insertText', false, prefix + text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },

  // ── Diff View ────────────────────────────────────────────────

  showDiff(oldRecipe, newRecipe) {
    const display = document.getElementById('recipe-display');
    this.saveUIState(display);
    this.diffMode = true;
    document.getElementById('recipe-empty').classList.add('hidden');
    display.classList.remove('hidden');

    let html = `
      <div class="space-y-4">
        <div class="flex items-center justify-between p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <span class="text-sm font-medium text-yellow-800 dark:text-yellow-200">Recipe modified</span>
          <div class="flex gap-2">
            <button id="diff-accept" class="px-3 py-1 text-sm rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors">Accept</button>
            <button id="diff-reject" class="px-3 py-1 text-sm rounded-lg bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors">Reject</button>
          </div>
        </div>
    `;

    html += `<div>`;
    if (oldRecipe.title !== newRecipe.title) {
      html += `<h2 class="text-xl font-bold"><span class="diff-removed">${this.escapeHtml(oldRecipe.title)}</span> <span class="diff-added">${this.escapeHtml(newRecipe.title)}</span></h2>`;
    } else {
      html += `<h2 class="text-xl font-bold">${this.escapeHtml(newRecipe.title)}</h2>`;
    }
    html += `</div>`;

    const oldMacros = this.computeMacros(oldRecipe, 1);
    const newMacros = this.computeMacros(newRecipe, 1);
    html += `<div class="flex gap-3 text-sm font-medium">`;
    html += this.diffMacroValue('cal', oldMacros.calories, newMacros.calories, 'text-orange-500 dark:text-orange-400');
    html += this.diffMacroValue('P', oldMacros.protein_g, newMacros.protein_g, 'text-blue-500 dark:text-blue-400');
    html += this.diffMacroValue('C', oldMacros.carbs_g, newMacros.carbs_g, 'text-yellow-600 dark:text-yellow-400');
    html += this.diffMacroValue('F', oldMacros.fat_g, newMacros.fat_g, 'text-violet-500 dark:text-violet-400');
    html += `</div>`;

    const maxSteps = Math.max(oldRecipe.steps.length, newRecipe.steps.length);
    html += `<div class="space-y-4 pt-2">`;
    for (let i = 0; i < maxSteps; i++) {
      const oldStep = oldRecipe.steps[i];
      const newStep = newRecipe.steps[i];

      if (!oldStep) {
        const newTitle = newStep.title ? `: ${this.escapeHtml(newStep.title)}` : '';
        html += `<div class="border-l-2 border-green-500 pl-4 diff-added">
          <div class="text-xs text-zinc-500 mb-1">+ Step ${i + 1}${newTitle}</div>
          <p class="text-sm">${this.escapeHtml(newStep.description)}</p>
          ${this.renderStepIngredients(newStep, 1, 'diff-added')}
        </div>`;
      } else if (!newStep) {
        const oldTitle = oldStep.title ? `: ${this.escapeHtml(oldStep.title)}` : '';
        html += `<div class="border-l-2 border-red-500 pl-4 diff-removed">
          <div class="text-xs text-zinc-500 mb-1">- Step ${i + 1}${oldTitle}</div>
          <p class="text-sm">${this.escapeHtml(oldStep.description)}</p>
        </div>`;
      } else {
        const stepTitle = newStep.title ? `: ${this.escapeHtml(newStep.title)}` : '';
        const changed = oldStep.description !== newStep.description || JSON.stringify(oldStep.ingredients) !== JSON.stringify(newStep.ingredients);
        html += `<div class="border-l-2 ${changed ? 'border-yellow-500' : 'border-zinc-300 dark:border-zinc-700'} pl-4">
          <div class="text-xs text-zinc-500 mb-1">Step ${i + 1}${stepTitle}</div>`;

        if (oldStep.description !== newStep.description) {
          html += `<p class="text-sm"><span class="diff-removed">${this.escapeHtml(oldStep.description)}</span></p>
                   <p class="text-sm"><span class="diff-added">${this.escapeHtml(newStep.description)}</span></p>`;
        } else {
          html += `<p class="text-sm">${this.escapeHtml(newStep.description)}</p>`;
        }

        html += this.diffIngredients(oldStep.ingredients || [], newStep.ingredients || []);
        html += `</div>`;
      }
    }
    html += `</div></div>`;

    display.innerHTML = html;

    display.querySelector('#diff-accept')?.addEventListener('click', () => {
      try { this._remapUIState(oldRecipe, newRecipe); } catch (e) { console.warn('remapUIState:', e); }

      App.currentRecipe = newRecipe;
      App.pendingRecipe = null;
      if (!this.currentServings) this.currentServings = newRecipe.default_servings;
      this.display(newRecipe);
      this.saveUIStateToServer();
      // Re-render once fresh conversation state arrives so the share button
      // re-arms ("Shared ✓" → "Update shared copy") after accepting changes.
      Store.refresh().then(() => {
        if (!this.diffMode && !App.pendingRecipe) this.display(App.currentRecipe);
      });
      Chat.resolveDiffReply();
    });

    display.querySelector('#diff-reject')?.addEventListener('click', () => {
      App.pendingRecipe = null;
      this.display(App.currentRecipe);
      Chat.resolveDiffReply();
    });
  },

  diffMacroValue(label, oldVal, newVal, colorClass) {
    const o = Math.round(oldVal);
    const n = Math.round(newVal);
    if (o === n) return `<span class="${colorClass}">${n}${label === 'cal' ? '' : 'g'} ${label}</span>`;
    return `<span class="${colorClass}">${o} → ${n}${label === 'cal' ? '' : 'g'} ${label}</span>`;
  },

  diffIngredients(oldIngs, newIngs) {
    const oldMap = new Map(oldIngs.map((i) => [i.name, i]));
    const newMap = new Map(newIngs.map((i) => [i.name, i]));
    let html = '<div class="mt-2 space-y-0.5">';

    for (const ing of oldIngs) {
      if (!newMap.has(ing.name)) {
        html += `<div class="text-sm diff-removed flex gap-2"><span>${this.escapeHtml(ing.name)}</span><span class="tabular-nums">${ing.grams}g</span></div>`;
      }
    }

    for (const ing of newIngs) {
      const old = oldMap.get(ing.name);
      if (!old) {
        html += `<div class="text-sm diff-added flex gap-2"><span>${this.escapeHtml(ing.name)}</span><span class="tabular-nums">${ing.grams}g</span></div>`;
      } else if (old.grams !== ing.grams) {
        html += `<div class="text-sm text-zinc-500 dark:text-zinc-400 flex gap-2"><span>${this.escapeHtml(ing.name)}</span><span class="tabular-nums"><span class="diff-removed">${old.grams}g</span> → <span class="diff-added">${ing.grams}g</span></span></div>`;
      } else {
        html += `<div class="text-sm text-zinc-500 dark:text-zinc-400 flex gap-2"><span>${this.escapeHtml(ing.name)}</span><span class="tabular-nums">${ing.grams}g</span></div>`;
      }
    }

    html += '</div>';
    return html;
  },

  renderStepIngredients(step, scale, extraClass) {
    if (!step.ingredients?.length) return '';
    let html = '<div class="mt-2 space-y-0.5">';
    step.ingredients.forEach((ing) => {
      const g = Math.round(ing.grams * scale);
      html += `<div class="text-sm ${extraClass || 'text-zinc-500 dark:text-zinc-400'} flex gap-2">
        <span>${this.escapeHtml(ing.name)}</span><span class="tabular-nums">${g}g</span></div>`;
    });
    return html + '</div>';
  },

  // ── Export ────────────────────────────────────────────────────

  exportMarkdown(recipe) {
    const servings = this.currentServings || recipe.default_servings;
    const scale = (servings / recipe.default_servings) * this.servingScale;
    const baseMacros = this.computeMacros(recipe, 1);
    const macros = {
      calories: (baseMacros.calories / servings) * this.servingScale,
      protein_g: (baseMacros.protein_g / servings) * this.servingScale,
      carbs_g: (baseMacros.carbs_g / servings) * this.servingScale,
      fat_g: (baseMacros.fat_g / servings) * this.servingScale,
    };
    let md = `# ${recipe.title}\n\n`;
    if (recipe.description) md += `${recipe.description}\n\n`;
    md += `**Servings:** ${servings}`;
    if (recipe.prep_time) md += ` | **Prep:** ${recipe.prep_time}`;
    if (recipe.cook_time) md += ` | **Cook:** ${recipe.cook_time}`;
    md += `\n\n`;
    md += `**Macros per serving:** ${Math.round(macros.calories)} cal | ${Math.round(macros.protein_g)}g protein | ${Math.round(macros.carbs_g)}g carbs | ${Math.round(macros.fat_g)}g fat\n\n`;

    md += `## Ingredients\n\n`;
    recipe.steps.forEach((step, i) => {
      if (!step.ingredients?.length) return;
      md += `**Step ${i + 1}:**\n`;
      step.ingredients.forEach((ing) => {
        const g = Math.round(ing.grams * scale);
        const vol = this.formatVolume(ing.volume, scale);
        md += `- ${ing.name} — ${g}g (${vol})\n`;
      });
      md += '\n';
    });

    md += `## Steps\n\n`;
    recipe.steps.forEach((step, i) => {
      md += `${i + 1}. ${step.description}\n`;
    });

    if (recipe.notes) md += `\n## Notes\n\n${recipe.notes}\n`;

    this.downloadFile(`${recipe.title}.md`, md, 'text/markdown');
  },

  exportJSON(recipe) {
    const json = JSON.stringify(recipe, null, 2);
    this.downloadFile(`${recipe.title}.json`, json, 'application/json');
  },

  downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  copyMarkdown(recipe) {
    const servings = this.currentServings || recipe.default_servings;
    const scale = (servings / recipe.default_servings) * this.servingScale;
    const baseMacros = this.computeMacros(recipe, 1);
    const macros = {
      calories: (baseMacros.calories / servings) * this.servingScale,
      protein_g: (baseMacros.protein_g / servings) * this.servingScale,
      carbs_g: (baseMacros.carbs_g / servings) * this.servingScale,
      fat_g: (baseMacros.fat_g / servings) * this.servingScale,
    };
    let md = `# ${recipe.title}\n\n`;
    if (recipe.description) md += `${recipe.description}\n\n`;
    md += `**Servings:** ${servings}`;
    if (recipe.prep_time) md += ` | **Prep:** ${recipe.prep_time}`;
    if (recipe.cook_time) md += ` | **Cook:** ${recipe.cook_time}`;
    md += `\n\n`;
    md += `**Macros per serving:** ${Math.round(macros.calories)} cal | ${Math.round(macros.protein_g)}g protein | ${Math.round(macros.carbs_g)}g carbs | ${Math.round(macros.fat_g)}g fat\n\n`;

    md += `## Ingredients\n\n`;
    recipe.steps.forEach((step, i) => {
      if (!step.ingredients?.length) return;
      md += `**Step ${i + 1}:**\n`;
      step.ingredients.forEach((ing) => {
        const g = Math.round(ing.grams * scale);
        const vol = this.formatVolume(ing.volume, scale);
        md += `- ${ing.name} — ${g}g (${vol})\n`;
      });
      md += '\n';
    });

    md += `## Steps\n\n`;
    recipe.steps.forEach((step, i) => {
      md += `${i + 1}. ${step.description}\n`;
    });

    if (recipe.notes) md += `\n## Notes\n\n${recipe.notes}\n`;

    navigator.clipboard.writeText(md).then(() => {
      const btn = document.getElementById('export-copy-md');
      if (btn) {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy Markdown'; }, 1500);
      }
    });
  },

  importJSON(event) {
    const file = event.target?.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const recipe = JSON.parse(e.target.result);

        if (!recipe.title || !recipe.steps || !Array.isArray(recipe.steps)) {
          alert('Invalid recipe file. Must have "title" and "steps".');
          return;
        }

        if (!recipe.version) recipe.version = 1;
        if (!recipe.default_servings) recipe.default_servings = recipe.servings || 4;

        App.currentRecipe = recipe;
        this.currentServings = recipe.default_servings;
        this.servingScale = 1.0;
        this._showIngMacros = false;
        this._ingredientChecks = {};
        this.display(recipe);

        Chat.appendMessage('assistant', `Imported recipe: **${recipe.title}**`);
      } catch (err) {
        alert('Could not parse JSON file: ' + err.message);
      }

      event.target.value = '';
    };
    reader.readAsText(file);
  },

  // ── Ingredient Summary ────────────────────────────────────────

  renderIngredientSummary(recipe, scale) {
    let totalIngredients = 0;
    recipe.steps.forEach((s) => { totalIngredients += (s.ingredients || []).length; });

    const showMacros = this._showIngMacros || false;
    // The macros toggle sits on the summary line itself (right-aligned) and
    // is only visible while the section is expanded (see app.css). Flex on
    // <summary> drops the native disclosure marker, so a chevron stands in.
    let html = `
      <details class="rounded-xl bg-zinc-100/70 dark:bg-zinc-900/50">
        <summary class="px-4 py-2.5 cursor-pointer text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 transition-colors flex items-center justify-between gap-2">
          <span class="flex items-center gap-1.5"><span class="summary-chevron text-[0.6rem]">▶</span>All Ingredients (${totalIngredients})</span>
          <label class="ing-macros-summary-toggle flex items-center gap-1.5 cursor-pointer text-xs text-zinc-400 dark:text-zinc-500 select-none">
            <input type="checkbox" id="ing-macros-toggle" class="ingredient-check" ${showMacros ? 'checked' : ''}>
            Macros per serving
          </label>
        </summary>
        <div class="summary-grid px-4 pb-4 pt-2 ${showMacros ? 'show-macros' : ''}">
    `;

    const servings = this.currentServings || recipe.default_servings || 1;
    const perServing = (val) => val * scale / servings;

    const maxMacro = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
    recipe.steps.forEach((step) => {
      (step.ingredients || []).forEach((ing) => {
        if (ing.from_step) return;
        for (const k in maxMacro) {
          const ps = perServing(ing.macros[k]);
          if (ps > maxMacro[k]) maxMacro[k] = ps;
        }
      });
    });

    const macroIntensity = (val, max) => {
      const t = max <= 0 ? 0 : Math.sqrt(val / max);
      return {
        opacity: (0.6 + 0.4 * t).toFixed(2),
        weight: Math.round(300 + 400 * t),
      };
    };

    recipe.steps.forEach((step, i) => {
      if (!step.ingredients?.length) return;
      const stepLabel = step.title ? `Step ${i + 1}: ${this.escapeHtml(step.title)}` : `Step ${i + 1}`;
      html += `<div class="text-xs font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider summary-grid-header">${stepLabel}</div>`;
      step.ingredients.forEach((ing) => {
        const g = Math.round(ing.grams * scale);
        const vol = this.formatVolume(ing.volume, scale);
        const key = `${i}-${ing.name}`;
        const escapedName = this.escapeHtml(ing.name);
        const fromStep = ing.from_step;
        const psCal = perServing(ing.macros.calories);
        const psP = perServing(ing.macros.protein_g);
        const psC = perServing(ing.macros.carbs_g);
        const psF = perServing(ing.macros.fat_g);
        const psFi = perServing(ing.macros.fiber_g);
        const mo = {
          cal: macroIntensity(psCal, maxMacro.calories),
          p: macroIntensity(psP, maxMacro.protein_g),
          c: macroIntensity(psC, maxMacro.carbs_g),
          f: macroIntensity(psF, maxMacro.fat_g),
          fi: macroIntensity(psFi, maxMacro.fiber_g),
        };
        html += `
          <div class="summary-grid-row contents">
            <label class="ingredient-label flex items-center gap-2 py-0.5 cursor-pointer">
              <input type="checkbox" class="ingredient-check" data-key="${this.escapeHtml(key)}">
              <span class="ing-name text-sm">${escapedName}${fromStep ? ' <span class="text-zinc-400 dark:text-zinc-600 text-xs italic">(prev step)</span>' : ''}</span>
            </label>
            <span class="ing-amt text-zinc-400 dark:text-zinc-500 tabular-nums text-xs py-0.5">${g}g${vol ? ` · ${vol}` : ''}</span>
            <span class="ing-actions flex items-center gap-0.5 py-0.5">
              <button class="ing-remove p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-zinc-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 transition-colors" data-name="${escapedName}" title="Remove ingredient">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="-2 -2 28 28"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
              <button class="ing-swap p-1 rounded hover:bg-yellow-100 dark:hover:bg-yellow-900/30 text-zinc-300 dark:text-zinc-600 hover:text-yellow-500 dark:hover:text-yellow-400 transition-colors" data-name="${escapedName}" title="Substitute ingredient">
                <svg class="w-3.5 h-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" viewBox="-1 -1 26 26"><path d="M21.5 2v6h-6M2.5 22v-6h6M21.5 8A10 10 0 0 0 3.2 5.3L2.5 6M2.5 16a10 10 0 0 0 18.3 2.7l.7-.7"/></svg>
              </button>
            </span>
            ${fromStep ? `
            <span class="ing-macro"></span><span class="ing-macro"></span><span class="ing-macro"></span><span class="ing-macro"></span><span class="ing-macro"></span>
            ` : `
            <span class="ing-macro tabular-nums text-xs py-0.5 text-orange-400 dark:text-orange-500 text-right" style="opacity:${mo.cal.opacity};font-weight:${mo.cal.weight}">${Math.round(psCal)} cal</span>
            <span class="ing-macro tabular-nums text-xs py-0.5 text-blue-400 dark:text-blue-500 text-right" style="opacity:${mo.p.opacity};font-weight:${mo.p.weight}">${Math.round(psP)}p</span>
            <span class="ing-macro tabular-nums text-xs py-0.5 text-amber-400 dark:text-amber-500 text-right" style="opacity:${mo.c.opacity};font-weight:${mo.c.weight}">${Math.round(psC)}c</span>
            <span class="ing-macro tabular-nums text-xs py-0.5 text-violet-400 dark:text-violet-500 text-right" style="opacity:${mo.f.opacity};font-weight:${mo.f.weight}">${Math.round(psF)}f</span>
            <span class="ing-macro tabular-nums text-xs py-0.5 text-green-400 dark:text-green-500 text-right" style="opacity:${mo.fi.opacity};font-weight:${mo.fi.weight}">${Math.round(psFi)}fi</span>
            `}
          </div>`;
      });
    });

    html += '</div></details>';
    return html;
  },

  renderStep(step, index, scale) {
    let desc = this.renderInline(step.description);
    if (step.temperature_f) {
      const temp = this.useCelsius ? `${Math.round((step.temperature_f - 32) * 5 / 9)}°C` : `${step.temperature_f}°F`;
      desc = desc.replace(/\d+°F/g, temp);
      if (!desc.includes('°')) {
        desc += ` <span class="text-orange-500 dark:text-orange-400 font-medium">(${temp})</span>`;
      }
    }

    let ingredientsHtml = '';
    if (step.ingredients?.length) {
      ingredientsHtml = '<div class="ing-grid mt-3 ml-1 pl-3 border-l-2 border-zinc-200 dark:border-zinc-800">';
      step.ingredients.forEach((ing) => {
        const g = Math.round(ing.grams * scale);
        const vol = this.formatVolume(ing.volume, scale);
        ingredientsHtml += `
          <span class="text-zinc-600 dark:text-zinc-400 text-sm">${this.escapeHtml(ing.name)}</span>
          <span class="text-zinc-400 dark:text-zinc-500 tabular-nums text-xs">${g}g${vol ? ` · ${vol}` : ''}</span>`;
      });
      ingredientsHtml += '</div>';
    }

    let timersHtml = '';
    if (typeof CookingMode !== 'undefined') {
      const durations = CookingMode.parseDurations(step.description);
      if (durations.length) {
        timersHtml = '<div class="flex flex-wrap gap-2 mt-2">';
        durations.forEach((d, j) => {
          const timerId = `step-timer-${index}-${j}`;
          const existing = CookingMode.timers.find(t => t.id === timerId);
          if (existing && existing.remaining > 0) {
            timersHtml += `<span class="step-timer-inline inline-flex items-center gap-1 px-3 py-1 text-xs rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 tabular-nums cursor-pointer" data-timer-id="${timerId}">⏱ ${CookingMode.formatTime(existing.remaining)} / ${CookingMode.formatTime(existing.total)}</span>`;
          } else {
            timersHtml += `<button class="step-timer-btn inline-flex items-center gap-1 px-3 py-1 text-xs rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400 transition-colors" data-timer-id="${timerId}" data-seconds="${d.seconds}" data-step="${index}">⏱ ${CookingMode.formatTime(d.seconds)}</button>`;
          }
        });
        timersHtml += '</div>';
      }
    }

    const titleHtml = step.title ? `<h4 class="text-sm font-semibold mb-1">${this.escapeHtml(step.title)}</h4>` : '';

    return `
      <div class="step-card flex gap-4 p-4 rounded-xl bg-zinc-100/70 dark:bg-zinc-900/50" data-step="${index}">
        <div class="step-number shrink-0 w-8 h-8 rounded-full bg-blue-600 dark:bg-blue-400 text-white dark:text-zinc-950 flex items-center justify-center text-sm font-bold mt-0.5">${index + 1}</div>
        <div class="flex-1 min-w-0">
          ${titleHtml}
          <p class="text-sm leading-relaxed">${desc}</p>
          ${ingredientsHtml}
          ${timersHtml}
        </div>
      </div>`;
  },

  // ── Helpers ────────────────────────────────────────────────────

  computeMacros(recipe, scale) {
    const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
    for (const step of recipe.steps) {
      for (const ing of step.ingredients || []) {
        if (!ing.macros || ing.from_step) continue;
        totals.calories += ing.macros.calories || 0;
        totals.protein_g += ing.macros.protein_g || 0;
        totals.carbs_g += ing.macros.carbs_g || 0;
        totals.fat_g += ing.macros.fat_g || 0;
        totals.fiber_g += ing.macros.fiber_g || 0;
      }
    }
    const perServing = recipe.default_servings || 1;
    const s = this.currentServings || perServing;
    return {
      calories: (totals.calories / perServing) * s,
      protein_g: (totals.protein_g / perServing) * s,
      carbs_g: (totals.carbs_g / perServing) * s,
      fat_g: (totals.fat_g / perServing) * s,
      fiber_g: (totals.fiber_g / perServing) * s,
    };
  },

  formatVolume(volume, scale) {
    if (!volume) return '';
    const amount = volume.amount * scale;
    return `${this.friendlyFraction(amount)} ${volume.unit}`;
  },

  friendlyFraction(n) {
    if (n === 0) return '0';
    const whole = Math.floor(n);
    const frac = n - whole;

    const fractions = [
      [0, ''], [0.125, '\u215B'], [0.25, '\u00BC'], [0.333, '\u2153'],
      [0.375, '\u215C'], [0.5, '\u00BD'], [0.625, '\u215D'], [0.667, '\u2154'],
      [0.75, '\u00BE'], [0.875, '\u215E'], [1, ''],
    ];

    let closest = fractions[0];
    for (const f of fractions) {
      if (Math.abs(frac - f[0]) < Math.abs(frac - closest[0])) closest = f;
    }

    if (closest[0] >= 1) return String(whole + 1);
    if (closest[1] === '') return String(whole || '') || '0';
    return whole ? `${whole}${closest[1]}` : closest[1];
  },

  renderInline(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
  },
};

document.getElementById('version-history-close')?.addEventListener('click', () => {
  document.getElementById('version-history-modal')?.classList.add('hidden');
});
document.getElementById('version-history-backdrop')?.addEventListener('click', () => {
  document.getElementById('version-history-modal')?.classList.add('hidden');
});
