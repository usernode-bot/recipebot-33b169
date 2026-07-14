// Homepage: "Your favorites" + "Your recipes" + "Community recipes".
// Sections are hidden entirely when empty; the whole page shows an empty
// state only when all three have nothing to render.
const Home = {
  shared: [],
  mine: [],
  favorites: [],

  esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  async refresh() {
    try {
      const [sharedRes, mineRes, favRes] = await Promise.all([
        fetch('/api/shared-recipes'),
        fetch('/api/recipes'),
        fetch('/api/favorites'),
      ]);
      this.shared = sharedRes.ok ? await sharedRes.json() : [];
      this.mine = mineRes.ok ? await mineRes.json() : [];
      this.favorites = favRes.ok ? await favRes.json() : [];
      this.render();
    } catch { /* retry on next visit */ }
  },

  render() {
    const favSection = document.getElementById('home-favorites');
    const mineSection = document.getElementById('home-mine');
    const commSection = document.getElementById('home-community');
    const emptyEl = document.getElementById('home-empty');
    if (!favSection || !mineSection || !commSection) return;

    const favOwn = this.mine.filter((r) => r.is_favorited);
    const mineRest = this.mine.filter((r) => !r.is_favorited);

    const favList = document.getElementById('home-favorites-list');
    favList.innerHTML = '';
    favOwn.forEach((r) => favList.appendChild(this.ownCard(r)));
    this.favorites.forEach((s) => favList.appendChild(this.sharedCard(s, { favoritesSection: true })));
    favSection.classList.toggle('hidden', favOwn.length + this.favorites.length === 0);

    const mineList = document.getElementById('home-mine-list');
    mineList.innerHTML = '';
    mineRest.forEach((r) => mineList.appendChild(this.ownCard(r)));
    mineSection.classList.toggle('hidden', mineRest.length === 0);

    const commList = document.getElementById('home-community-list');
    commList.innerHTML = '';
    this.shared.forEach((s) => commList.appendChild(this.sharedCard(s)));
    commSection.classList.toggle('hidden', this.shared.length === 0);

    const allEmpty =
      favOwn.length + this.favorites.length + mineRest.length + this.shared.length === 0;
    emptyEl?.classList.toggle('hidden', !allEmpty);
  },

  _cardShell() {
    const el = document.createElement('div');
    el.className = 'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-4 flex flex-col gap-2';
    return el;
  },

  _heartBtn(filled) {
    const btn = document.createElement('button');
    btn.className = `p-1 rounded transition-colors ${filled ? 'text-pink-500 hover:text-pink-400' : 'text-zinc-400 hover:text-pink-500'}`;
    btn.title = filled ? 'Unfavorite' : 'Favorite';
    btn.innerHTML = filled
      ? '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/></svg>'
      : '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 20 20"><path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"/></svg>';
    return btn;
  },

  _metaLine(recipe) {
    const bits = [];
    if (recipe.prep_time) bits.push(`Prep: ${this.esc(recipe.prep_time)}`);
    if (recipe.cook_time) bits.push(`Cook: ${this.esc(recipe.cook_time)}`);
    return bits.join(' · ');
  },

  _actionBtn(label, primary) {
    const btn = document.createElement('button');
    btn.className = primary
      ? 'px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors'
      : 'px-3 py-1.5 text-xs rounded-lg bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 transition-colors';
    btn.textContent = label;
    return btn;
  },

  // Card for one of the requester's own conversations (from /api/recipes).
  ownCard(r) {
    const recipe = r.data || {};
    const el = this._cardShell();

    const head = document.createElement('div');
    head.className = 'flex items-start justify-between gap-2';
    head.innerHTML = `
      <div class="min-w-0">
        <h3 class="font-semibold text-sm truncate">${this.esc(recipe.title || r.conversation_title || 'Untitled')}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">by you${r.is_shared ? ' · <span class="text-blue-400">shared</span>' : ''}</p>
      </div>`;
    const heart = this._heartBtn(r.is_favorited);
    heart.addEventListener('click', () =>
      this.toggleConversationFavorite(r.conversation_id, r.is_favorited));
    head.appendChild(heart);
    el.appendChild(head);

    if (recipe.description) {
      const desc = document.createElement('p');
      desc.className = 'text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed line-clamp-2';
      desc.textContent = recipe.description;
      el.appendChild(desc);
    }

    const meta = this._metaLine(recipe);
    if (meta) {
      const metaEl = document.createElement('p');
      metaEl.className = 'text-xs text-zinc-400 dark:text-zinc-500';
      metaEl.innerHTML = meta;
      el.appendChild(metaEl);
    }

    const actions = document.createElement('div');
    actions.className = 'flex gap-2 mt-auto pt-1';
    const openBtn = this._actionBtn('Open', true);
    openBtn.addEventListener('click', () => {
      if (typeof Sidebar !== 'undefined') Sidebar.selectConversation(r.conversation_id);
    });
    const forkBtn = this._actionBtn('Fork');
    forkBtn.addEventListener('click', () => {
      if (typeof Sidebar !== 'undefined') Sidebar.forkRecipe(recipe);
    });
    actions.appendChild(openBtn);
    actions.appendChild(forkBtn);
    el.appendChild(actions);
    return el;
  },

  // Card for a shared recipe (community feed or favorited shared recipe).
  sharedCard(s, opts) {
    const recipe = s.data || {};
    const el = this._cardShell();

    const head = document.createElement('div');
    head.className = 'flex items-start justify-between gap-2';
    head.innerHTML = `
      <div class="min-w-0">
        <h3 class="font-semibold text-sm truncate">${this.esc(recipe.title || 'Untitled')}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">by ${s.is_mine ? 'you' : this.esc(s.username)}</p>
      </div>`;
    const heart = this._heartBtn(s.is_favorited);
    heart.addEventListener('click', () => this.toggleSharedFavorite(s.id, s.is_favorited));
    head.appendChild(heart);
    el.appendChild(head);

    if (recipe.description) {
      const desc = document.createElement('p');
      desc.className = 'text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed line-clamp-2';
      desc.textContent = recipe.description;
      el.appendChild(desc);
    }

    const meta = this._metaLine(recipe);
    if (meta) {
      const metaEl = document.createElement('p');
      metaEl.className = 'text-xs text-zinc-400 dark:text-zinc-500';
      metaEl.innerHTML = meta;
      el.appendChild(metaEl);
    }

    el.appendChild(this._ratingRow(s));

    const actions = document.createElement('div');
    actions.className = 'flex gap-2 mt-auto pt-1';
    const viewBtn = this._actionBtn('View', true);
    viewBtn.addEventListener('click', () => this.viewShared(s));
    const forkBtn = this._actionBtn('Fork');
    forkBtn.addEventListener('click', () => {
      if (typeof Sidebar !== 'undefined') {
        Sidebar.forkRecipe(recipe, s.is_mine ? null : { username: s.username });
      }
    });
    actions.appendChild(viewBtn);
    actions.appendChild(forkBtn);
    el.appendChild(actions);
    return el;
  },

  _ratingRow(s) {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 flex-wrap';

    const summary = document.createElement('span');
    summary.className = 'text-xs text-zinc-500 dark:text-zinc-400 tabular-nums';
    summary.textContent = s.rating_count
      ? `★ ${Number(s.avg_rating).toFixed(1)} · ${s.rating_count} rating${s.rating_count === 1 ? '' : 's'}`
      : 'No ratings yet';
    row.appendChild(summary);

    if (!s.is_mine) {
      const stars = document.createElement('span');
      stars.className = 'inline-flex items-center';
      stars.title = s.my_rating ? `Your rating: ${s.my_rating}` : 'Rate this recipe';
      for (let i = 1; i <= 5; i++) {
        const star = document.createElement('button');
        star.className = `text-base leading-none px-0.5 transition-colors ${
          s.my_rating && i <= s.my_rating ? 'text-yellow-400' : 'text-zinc-300 dark:text-zinc-600 hover:text-yellow-400'
        }`;
        star.textContent = s.my_rating && i <= s.my_rating ? '★' : '☆';
        star.title = `Rate ${i} star${i === 1 ? '' : 's'}`;
        star.addEventListener('click', () => this.rate(s.id, i));
        stars.appendChild(star);
      }
      row.appendChild(stars);
    }
    return row;
  },

  async rate(sharedId, rating) {
    try {
      await fetch(`/api/shared-recipes/${sharedId}/rating`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
    } catch { /* refresh below reflects server truth */ }
    this.refresh();
  },

  async toggleSharedFavorite(sharedId, isFavorited) {
    try {
      await fetch(`/api/shared-recipes/${sharedId}/favorite`, {
        method: isFavorited ? 'DELETE' : 'PUT',
      });
    } catch { /* refresh below reflects server truth */ }
    this.refresh();
    if (typeof Sidebar !== 'undefined') Sidebar.refresh();
  },

  async toggleConversationFavorite(conversationId, isFavorited) {
    try {
      await fetch(`/api/conversations/${conversationId}/favorite`, {
        method: isFavorited ? 'DELETE' : 'PUT',
      });
    } catch { /* refresh below reflects server truth */ }
    this.refresh();
    if (typeof Sidebar !== 'undefined') Sidebar.refresh();
  },

  // Read-only view of a shared recipe; chatting from here auto-forks it
  // (Chat.send posts forkRecipe when there's a recipe but no conversation).
  viewShared(s) {
    if (typeof Sidebar !== 'undefined') Sidebar.openShared(s);
  },
};
