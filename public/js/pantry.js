// Pantry: enter the ingredients you have and see the recipes you can cook,
// ranked by how much of each recipe they cover. Suggestions come from the
// recipes the app already knows about — your own recipes plus community
// shares — so the list is deterministic and works without the AI.
//
// The page lives in the homepage container (see #pantry-view in index.html)
// and replaces the homepage bands while open. Its route is `#pantry=1`, with
// the ingredient list mirrored in `#pantryIn` so a refresh comes back to the
// same search.
const Pantry = {
  active: false,
  ingredients: [],
  suggestions: [],
  loading: false,
  error: false,
  searched: false,
  // Guards against a slow earlier request overwriting a newer one.
  _seq: 0,
  // Matches MAX_INGREDIENTS in src/routes/pantry.js.
  MAX_INGREDIENTS: 25,
  MAX_LENGTH: 60,

  open(opts) {
    if (App.isAnonymous) {
      // A direct ?pantry=1 link must not leave a route behind for a
      // visitor who cannot see the page.
      HashParams.set('pantry', null);
      HashParams.set('pantryIn', null);
      App.promptSignIn(t('signin.pantry'));
      return;
    }
    this.active = true;
    // showView('home') refreshes the box behind the pantry; set `active`
    // first so that render already knows to show this page.
    App.showView('home');
    // Addressable as `#pantry=1` so a refresh (or a re-embed in the
    // platform iframe) comes back to this page.
    HashParams.set('pantry', '1');
    this._invalidateSearch();

    const list = Array.isArray(opts?.ingredients) ? opts.ingredients : [];
    if (list.length) {
      this.ingredients = [];
      list.forEach((name) => this.addIngredient(name));
    }
    this.syncUrl();
    Home.render();

    if (this.ingredients.length) this.search();
    else this.render();
  },

  close() {
    this.active = false;
    HashParams.set('pantry', null);
    HashParams.set('pantryIn', null);
    if (typeof Home !== 'undefined') Home.render();
  },

  // Adds one or more comma-separated ingredients. Returns true when at
  // least one was new. Duplicates are ignored case-insensitively.
  addIngredient(value) {
    let changed = false;
    for (const part of String(value || '').split(',')) {
      const text = part.trim().replace(/\s+/g, ' ');
      if (!text) continue;
      const clipped = text.slice(0, this.MAX_LENGTH);
      if (this.ingredients.some((name) => name.toLowerCase() === clipped.toLowerCase())) continue;
      if (this.ingredients.length >= this.MAX_INGREDIENTS) break;
      this.ingredients.push(clipped);
      changed = true;
    }
    return changed;
  },

  removeIngredient(name) {
    const wasSearched = this.searched;
    this.ingredients = this.ingredients.filter((item) => item !== name);
    this._invalidateSearch();
    this.syncUrl();
    if (wasSearched && this.ingredients.length) {
      // Keep a result list in step with the chips that produced it.
      this.search();
    } else {
      this.render();
    }
  },

  // The chip list changed under a search that is still in flight: drop that
  // response when it lands (the `_seq` guard in search) and clear the
  // loading state it would otherwise leave behind.
  _invalidateSearch() {
    this._seq += 1;
    this.loading = false;
    this.searched = false;
    this.suggestions = [];
    this.error = false;
  },

  syncUrl() {
    HashParams.set('pantryIn', this.ingredients.length ? this.ingredients.join(',') : null);
  },

  async search() {
    if (!this.active) return;
    if (!this.ingredients.length) {
      this.searched = false;
      this.suggestions = [];
      this.error = false;
      this.render();
      return;
    }
    const seq = ++this._seq;
    this.loading = true;
    this.error = false;
    this.searched = false;
    this.suggestions = [];
    this.render();

    try {
      const params = new URLSearchParams();
      this.ingredients.forEach((name) => params.append('ingredient', name));
      const res = await fetch(`/api/pantry/suggest?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== this._seq) return;
      this.suggestions = Array.isArray(data) ? data : [];
      this.searched = true;
    } catch (err) {
      if (seq !== this._seq) return;
      console.warn('[pantry] suggestion search failed', err);
      this.error = true;
    } finally {
      if (seq === this._seq) {
        this.loading = false;
        this.render();
      }
    }
  },

  render() {
    if (!this.active) return;
    this.renderChips();

    const findBtn = document.getElementById('pantry-find');
    if (findBtn) findBtn.disabled = this.loading || this.ingredients.length === 0;

    const emptyEl = document.getElementById('pantry-empty');
    const statusEl = document.getElementById('pantry-status');
    const resultsEl = document.getElementById('pantry-results');
    if (!statusEl || !resultsEl) return;

    const showEmpty = !this.ingredients.length && !this.loading && !this.searched && !this.error;
    emptyEl?.classList.toggle('hidden', !showEmpty);

    let statusText = '';
    if (this.loading) statusText = t('pantry.loading');
    else if (this.error) statusText = t('pantry.error');
    else if (this.searched && !this.suggestions.length) statusText = t('pantry.noResults');
    statusEl.textContent = statusText;
    statusEl.classList.toggle('hidden', !statusText);

    resultsEl.innerHTML = '';
    if (!this.loading && !this.error && this.searched && this.suggestions.length) {
      const heading = document.createElement('p');
      heading.className = 'kicker';
      heading.textContent = tn('pantry.results', this.suggestions.length);
      resultsEl.appendChild(heading);
      this.suggestions.forEach((suggestion) => {
        resultsEl.appendChild(this.card(suggestion));
      });
    } else if (!this.loading && !this.error && this.searched) {
      const newBtn = Home._actionBtn(t('pantry.newWith'), false);
      newBtn.addEventListener('click', () => {
        App.startNewRecipe(t('pantry.newRecipePrompt', {
          list: this.ingredients.join(', '),
        }));
      });
      resultsEl.appendChild(newBtn);
    }
  },

  renderChips() {
    const wrap = document.getElementById('pantry-chips');
    if (!wrap) return;
    wrap.innerHTML = '';
    this.ingredients.forEach((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'px-2.5 py-1 text-xs rounded-full border border-blue-400 dark:border-blue-600 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 transition-colors';
      chip.textContent = `${name} ✕`;
      chip.title = t('pantry.removeChip', { name });
      chip.setAttribute('aria-label', t('pantry.removeChip', { name }));
      chip.addEventListener('click', () => this.removeIngredient(name));
      wrap.appendChild(chip);
    });
  },

  // One suggestion: what matched, what is missing, and the simple numbered
  // instructions anyone can follow.
  card(suggestion) {
    const recipe = suggestion.recipe || {};
    const el = Home._cardShell();
    el.appendChild(Home._kicker(
      suggestion.source === 'mine' ? t('card.yourRecipe') : t('card.communityRecipe')
    ));

    const head = document.createElement('div');
    head.className = 'min-w-0';
    const title = document.createElement('h3');
    title.className = 'font-semibold text-sm';
    title.textContent = recipe.title || t('common.untitled');

    const meta = document.createElement('p');
    meta.className = 'text-xs text-zinc-400 dark:text-zinc-500 mt-0.5';
    const bits = [t('pantry.haveOf', {
      have: suggestion.have_count,
      total: suggestion.ingredient_count,
    })];
    if (suggestion.source === 'shared' && suggestion.username) {
      bits.push(t('card.by', { name: suggestion.username }));
    }
    meta.textContent = bits.join(' · ');
    head.appendChild(title);
    head.appendChild(meta);
    el.appendChild(head);

    const missing = document.createElement('p');
    missing.className = 'text-xs text-zinc-500 dark:text-zinc-400';
    missing.textContent = suggestion.missing?.length
      ? t('pantry.missing', {
        list: suggestion.missing.slice(0, 6).join(', ') +
          (suggestion.missing.length > 6 ? '…' : ''),
      })
      : t('pantry.allHave');
    el.appendChild(missing);

    const stepsLabel = document.createElement('p');
    stepsLabel.className = 'text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mt-1';
    stepsLabel.textContent = t('pantry.steps');
    el.appendChild(stepsLabel);

    const ol = document.createElement('ol');
    ol.className = 'space-y-2';
    (Array.isArray(recipe.steps) ? recipe.steps : []).forEach((step, index) => {
      const li = document.createElement('li');
      li.className = 'flex gap-3';

      const number = document.createElement('span');
      number.className = 'shrink-0 w-6 h-6 rounded-full bg-blue-600 dark:bg-blue-400 text-white dark:text-zinc-950 flex items-center justify-center text-xs font-bold mt-0.5';
      number.textContent = String(index + 1);

      const body = document.createElement('div');
      body.className = 'min-w-0';
      if (step?.title) {
        const stepTitle = document.createElement('p');
        stepTitle.className = 'text-sm font-semibold';
        stepTitle.textContent = step.title;
        body.appendChild(stepTitle);
      }
      const description = document.createElement('p');
      description.className = 'text-sm leading-relaxed text-zinc-700 dark:text-zinc-300';
      description.textContent = step?.description || '';
      body.appendChild(description);

      li.appendChild(number);
      li.appendChild(body);
      ol.appendChild(li);
    });
    el.appendChild(ol);

    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap items-center gap-2 mt-auto pt-1';
    const path = suggestion.source === 'mine'
      ? `/?c=${suggestion.conversation_id}`
      : `/?s=${suggestion.shared_id}`;
    actions.appendChild(Home._actionLink(t('common.open'), true, path, () => {
      if (suggestion.source === 'mine') {
        if (typeof Store !== 'undefined') Store.selectConversation(suggestion.conversation_id);
      } else if (typeof Store !== 'undefined') {
        Store.openShared({
          id: suggestion.shared_id,
          data: recipe,
          username: suggestion.username,
          is_mine: false,
          current_version: 1,
        });
      }
    }));
    el.appendChild(actions);

    return el;
  },
};

// ── Wiring ──────────────────────────────────────────────────────────

document.getElementById('pantry-btn')?.addEventListener('click', () => {
  if (App.isAnonymous) {
    App.promptSignIn(t('signin.pantry'));
    return;
  }
  Pantry.open();
  // The button lives in the homepage toolbar; when the page is opened from
  // the chat view, Home.showView has hidden the homepage until now.
  document.getElementById('pantry-input')?.focus({ preventScroll: true });
});

document.getElementById('pantry-back')?.addEventListener('click', (e) => {
  if (App.wantsNewTab(e)) return;
  e.preventDefault();
  App.setSignInPath?.(null);
  Pantry.close();
});

document.getElementById('pantry-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('pantry-input');
  if (!input) return;
  if (input.value.trim()) {
    Pantry.addIngredient(input.value);
    input.value = '';
    Pantry.syncUrl();
  }
  if (!Pantry.ingredients.length) {
    Pantry.render();
    return;
  }
  Pantry.search();
});

// Commas split ingredients as they are typed, so "eggs, rice, soy sauce"
// becomes three chips without leaving the input.
document.getElementById('pantry-input')?.addEventListener('input', (e) => {
  if (!e.target.value.includes(',')) return;
  const parts = e.target.value.split(',');
  const tail = parts.pop();
  let added = false;
  parts.forEach((part) => { if (Pantry.addIngredient(part)) added = true; });
  e.target.value = tail.replace(/^\s+/, '');
  if (added) {
    // The visible suggestions no longer match the chips; the primary
    // action ("Find recipes") is how they come back.
    Pantry._invalidateSearch();
  }
  Pantry.syncUrl();
  Pantry.render();
});

document.getElementById('pantry-find')?.addEventListener('click', () => {
  Pantry.search();
});
