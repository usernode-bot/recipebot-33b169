// Homepage ("the box"): search + new recipe toolbar, Collections (incl.
// group cookbooks), then "Your favorites" + "Your recipes" + "Your
// conversations" + "Community recipes" + public collections.
// Sections are hidden entirely when empty; the whole page shows an empty
// state only when all sections have nothing to render.
const Home = {
  shared: [],
  mine: [],
  favorites: [],
  conversations: [],
  collections: [],
  publicCollections: [],
  searchQuery: '',
  tagFilter: new Set(),
  // When set, the homepage shows this collection's detail instead of the box.
  activeCollection: null,

  esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  async refresh() {
    try {
      const [sharedRes, mineRes, favRes, convRes, collRes, pubCollRes] = await Promise.all([
        fetch('/api/shared-recipes'),
        fetch('/api/recipes'),
        fetch('/api/favorites'),
        fetch('/api/conversations'),
        fetch('/api/collections'),
        fetch('/api/collections/public'),
      ]);
      this.shared = sharedRes.ok ? await sharedRes.json() : [];
      this.mine = mineRes.ok ? await mineRes.json() : [];
      this.favorites = favRes.ok ? await favRes.json() : [];
      this.conversations = convRes.ok ? await convRes.json() : [];
      this.collections = collRes.ok ? await collRes.json() : [];
      this.publicCollections = pubCollRes.ok ? await pubCollRes.json() : [];
      if (this.activeCollection) {
        await this.reloadActiveCollection();
      }
      this.render();
    } catch { /* retry on next visit */ }
  },

  render() {
    const collSection = document.getElementById('home-collections');
    const favSection = document.getElementById('home-favorites');
    const mineSection = document.getElementById('home-mine');
    const convSection = document.getElementById('home-convs');
    const commSection = document.getElementById('home-community');
    const pubCollSection = document.getElementById('home-public-collections');
    const emptyEl = document.getElementById('home-empty');
    const noMatchEl = document.getElementById('home-no-match');
    const detailEl = document.getElementById('collection-view');
    const toolbar = document.getElementById('home-search')?.parentElement;
    if (!favSection || !mineSection || !commSection) return;

    // Collection detail replaces the box until closed.
    const inDetail = !!this.activeCollection;
    detailEl?.classList.toggle('hidden', !inDetail);
    for (const el of [collSection, favSection, mineSection, convSection, commSection, pubCollSection, emptyEl, noMatchEl, toolbar]) {
      if (el) el.style.display = inDetail ? 'none' : '';
    }
    if (inDetail) {
      this.renderCollectionDetail(detailEl);
      return;
    }

    const q = this.searchQuery.trim().toLowerCase();
    const matches = (name, tags) => {
      if (!q) return true;
      if ((name || '').toLowerCase().includes(q)) return true;
      return (tags || []).some((t) => t.toLowerCase().includes(q));
    };
    const tagMatch = (tags) => {
      if (!this.tagFilter.size) return true;
      return (tags || []).some((t) => this.tagFilter.has(t));
    };

    const favOwn = this.mine.filter((r) =>
      r.is_favorited && matches(r.data?.title || r.conversation_title, r.data?.tags));
    const mineRest = this.mine.filter((r) =>
      !r.is_favorited && matches(r.data?.title || r.conversation_title, r.data?.tags));
    const favShared = this.favorites.filter((s) => matches(s.data?.title, s.tags));
    const shared = this.shared.filter((s) => matches(s.data?.title, s.tags) && tagMatch(s.tags));

    // Conversations without a recipe yet (recipe-bearing ones already show
    // as cards in "Your recipes" / "Your favorites").
    const recipeConvIds = new Set(this.mine.map((r) => r.conversation_id));
    const bareConvs = this.conversations.filter(
      (c) => !recipeConvIds.has(c.id) && matches(c.title || 'New conversation'));

    // Collections section (always visible — it's the box's organizer).
    const collList = document.getElementById('home-collections-list');
    if (collList) {
      collList.innerHTML = '';
      const colls = this.collections.filter((c) => matches(c.name));
      colls.forEach((c) => collList.appendChild(this.collectionCard(c)));
      document.getElementById('home-collections-empty')
        ?.classList.toggle('hidden', colls.length > 0);
    }

    this.renderTagFilters();

    const favList = document.getElementById('home-favorites-list');
    favList.innerHTML = '';
    favOwn.forEach((r) => favList.appendChild(this.ownCard(r)));
    favShared.forEach((s) => favList.appendChild(this.sharedCard(s, { favoritesSection: true })));
    favSection.classList.toggle('hidden', favOwn.length + favShared.length === 0);

    const mineList = document.getElementById('home-mine-list');
    mineList.innerHTML = '';
    mineRest.forEach((r) => mineList.appendChild(this.ownCard(r)));
    mineSection.classList.toggle('hidden', mineRest.length === 0);

    if (convSection) {
      const convList = document.getElementById('home-convs-list');
      convList.innerHTML = '';
      bareConvs.forEach((c) => convList.appendChild(this.conversationCard(c)));
      convSection.classList.toggle('hidden', bareConvs.length === 0);
    }

    const commList = document.getElementById('home-community-list');
    commList.innerHTML = '';
    shared.forEach((s) => commList.appendChild(this.sharedCard(s)));
    commSection.classList.toggle('hidden', shared.length === 0 && !this.tagFilter.size);

    if (pubCollSection) {
      const pubList = document.getElementById('home-public-collections-list');
      pubList.innerHTML = '';
      const pubs = this.publicCollections.filter((c) => matches(c.name));
      pubs.forEach((c) => pubList.appendChild(this.publicCollectionCard(c)));
      pubCollSection.classList.toggle('hidden', pubs.length === 0);
    }

    const visible =
      favOwn.length + favShared.length + mineRest.length + bareConvs.length + shared.length;
    emptyEl?.classList.toggle('hidden', !(visible === 0 && !q && this.collections.length === 0));
    noMatchEl?.classList.toggle('hidden', !(visible === 0 && q));
  },

  // ── Tag filter chips (community feed) ─────────────────────────────

  renderTagFilters() {
    const wrap = document.getElementById('home-tag-filters');
    if (!wrap) return;
    const freq = new Map();
    this.shared.forEach((s) => (s.tags || []).forEach((t) => freq.set(t, (freq.get(t) || 0) + 1)));
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    wrap.innerHTML = '';
    wrap.classList.toggle('hidden', top.length === 0);
    top.forEach(([tag]) => {
      const active = this.tagFilter.has(tag);
      const chip = document.createElement('button');
      chip.className = `px-2.5 py-1 text-xs rounded-full border transition-colors ${
        active
          ? 'bg-blue-100 dark:bg-blue-900/40 border-blue-400 dark:border-blue-600 text-blue-700 dark:text-blue-300'
          : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-zinc-400 dark:hover:border-zinc-500'
      }`;
      chip.textContent = active ? `${tag} ✕` : tag;
      chip.addEventListener('click', () => {
        if (active) this.tagFilter.delete(tag);
        else this.tagFilter.add(tag);
        this.render();
      });
      wrap.appendChild(chip);
    });
  },

  // Editorial "newspaper clipping": white card on the paper page, hairline
  // border, tight radius, whisper of a shadow. A brass kicker (below) names
  // what kind of clipping it is.
  _cardShell() {
    const el = document.createElement('div');
    el.className = 'rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 flex flex-col gap-2 shadow-[0_1px_3px_rgba(31,43,71,0.06)]';
    return el;
  },

  _kicker(text) {
    const el = document.createElement('p');
    el.className = 'kicker';
    el.textContent = text;
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

  _tagChips(tags) {
    if (!tags?.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-wrap gap-1';
    tags.slice(0, 5).forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'px-2 py-0.5 text-[11px] rounded-full bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400';
      chip.textContent = t;
      wrap.appendChild(chip);
    });
    return wrap;
  },

  _actionBtn(label, primary) {
    const btn = document.createElement('button');
    btn.className = primary
      ? 'px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors'
      : 'px-3 py-1.5 text-xs rounded-lg bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 transition-colors';
    btn.textContent = label;
    return btn;
  },

  _deleteBtn(conversationId) {
    const btn = document.createElement('button');
    btn.className = 'px-3 py-1.5 text-xs rounded-lg bg-zinc-200 dark:bg-zinc-800 hover:bg-red-100 dark:hover:bg-red-900/40 text-zinc-500 dark:text-zinc-400 hover:text-red-500 transition-colors ml-auto';
    btn.textContent = 'Delete';
    btn.title = 'Delete this conversation';
    btn.addEventListener('click', async () => {
      if (typeof Store !== 'undefined') await Store.deleteConversation(conversationId);
      this.refresh();
    });
    return btn;
  },

  // Card for one of the requester's own conversations (from /api/recipes).
  ownCard(r) {
    const recipe = r.data || {};
    const el = this._cardShell();
    el.appendChild(this._kicker('Your recipe'));

    const madeBit = r.made_count > 0 ? ` · made ${r.made_count}×` : '';
    const remixBit = r.forked_from_username
      ? ` · <span title="Forked from ${this.esc(r.forked_from_username)}">⑂ from ${this.esc(r.forked_from_username)}</span>` : '';
    const head = document.createElement('div');
    head.className = 'flex items-start justify-between gap-2';
    head.innerHTML = `
      <div class="min-w-0">
        <h3 class="font-semibold text-sm truncate">${this.esc(recipe.title || r.conversation_title || 'Untitled')}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">by you${r.is_shared ? ' · <span class="text-blue-400">shared</span>' : ''}${madeBit}${remixBit}</p>
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
    actions.className = 'flex flex-wrap gap-2 mt-auto pt-1';
    const openBtn = this._actionBtn('Open', true);
    openBtn.addEventListener('click', () => {
      if (typeof Store !== 'undefined') Store.selectConversation(r.conversation_id);
    });
    const forkBtn = this._actionBtn('Fork');
    forkBtn.addEventListener('click', () => {
      if (typeof Store !== 'undefined') Store.forkRecipe(recipe);
    });
    actions.appendChild(openBtn);
    actions.appendChild(forkBtn);
    if (!r.is_shared) {
      const shareBtn = this._actionBtn('Share');
      shareBtn.title = 'Share recipe to the community feed';
      shareBtn.addEventListener('click', () => this.share(r.conversation_id));
      actions.appendChild(shareBtn);
    }
    const collectBtn = this._actionBtn('+ Collection');
    collectBtn.title = 'Add to a collection';
    collectBtn.addEventListener('click', () =>
      this.openCollectionPicker({ conversationId: r.conversation_id }));
    actions.appendChild(collectBtn);
    actions.appendChild(this._deleteBtn(r.conversation_id));
    el.appendChild(actions);
    return el;
  },

  // Card for one of the requester's conversations that has no recipe yet.
  conversationCard(c) {
    const el = this._cardShell();
    el.appendChild(this._kicker('Conversation'));

    const head = document.createElement('div');
    head.className = 'flex items-start justify-between gap-2';
    head.innerHTML = `
      <div class="min-w-0">
        <h3 class="font-semibold text-sm truncate">${this.esc(c.title || 'New conversation')}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">no recipe yet</p>
      </div>`;
    const heart = this._heartBtn(c.is_favorited);
    heart.addEventListener('click', () =>
      this.toggleConversationFavorite(c.id, c.is_favorited));
    head.appendChild(heart);
    el.appendChild(head);

    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-2 mt-auto pt-1';
    const openBtn = this._actionBtn('Open', true);
    openBtn.addEventListener('click', () => {
      if (typeof Store !== 'undefined') Store.selectConversation(c.id);
    });
    actions.appendChild(openBtn);
    actions.appendChild(this._deleteBtn(c.id));
    el.appendChild(actions);
    return el;
  },

  // Card for a shared recipe (community feed or favorited shared recipe).
  sharedCard(s, opts) {
    const recipe = s.data || {};
    const el = this._cardShell();
    el.appendChild(this._kicker(s.forked_from_username ? 'Remix' : 'Community recipe'));

    const remixBit = s.forked_from_username
      ? ` · ⑂ remixed from ${this.esc(s.forked_from_username)}` : '';
    const head = document.createElement('div');
    head.className = 'flex items-start justify-between gap-2';
    head.innerHTML = `
      <div class="min-w-0">
        <h3 class="font-semibold text-sm truncate">${this.esc(recipe.title || 'Untitled')}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">by ${s.is_mine ? 'you' : this.esc(s.username)}${s.current_version > 1 ? ` · v${s.current_version}` : ''}${remixBit}</p>
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
    const socialBits = [];
    if (s.made_count > 0) socialBits.push(`cooked ${s.made_count}×`);
    if (s.comment_count > 0) socialBits.push(`${s.comment_count} comment${s.comment_count === 1 ? '' : 's'}`);
    if (s.remix_count > 0) socialBits.push(`${s.remix_count} remix${s.remix_count === 1 ? '' : 'es'}`);
    const line = [meta, socialBits.join(' · ')].filter(Boolean).join(' · ');
    if (line) {
      const metaEl = document.createElement('p');
      metaEl.className = 'text-xs text-zinc-400 dark:text-zinc-500';
      metaEl.innerHTML = line;
      el.appendChild(metaEl);
    }

    const chips = this._tagChips(s.tags);
    if (chips) el.appendChild(chips);

    el.appendChild(this._ratingRow(s));

    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-2 mt-auto pt-1';
    const viewBtn = this._actionBtn('View', true);
    viewBtn.addEventListener('click', () => this.viewShared(s));
    const forkBtn = this._actionBtn('Fork');
    forkBtn.addEventListener('click', () => {
      if (typeof Store !== 'undefined') {
        Store.forkRecipe(recipe, s.is_mine ? null : {
          username: s.username, id: s.id, current_version: s.current_version,
        });
      }
    });
    actions.appendChild(viewBtn);
    actions.appendChild(forkBtn);
    const collectBtn = this._actionBtn('Save');
    collectBtn.title = 'Save to a collection (keeps your own copy)';
    collectBtn.addEventListener('click', () =>
      this.openCollectionPicker({ sharedRecipeId: s.id }));
    actions.appendChild(collectBtn);
    if (s.share_slug) {
      const linkBtn = this._actionBtn('Link');
      linkBtn.title = 'Copy the public share link (no login needed to view or cook)';
      linkBtn.addEventListener('click', () => this.copyShareLink(s.share_slug, linkBtn));
      actions.appendChild(linkBtn);
    }
    el.appendChild(actions);
    return el;
  },

  copyShareLink(slug, btn) {
    const url = `${location.origin}/r/${slug}`;
    navigator.clipboard?.writeText(url).then(() => {
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }
    }).catch(() => window.prompt('Copy this link:', url));
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

  // ── Collections ───────────────────────────────────────────────────

  collectionCard(c) {
    const el = this._cardShell();
    const kind = c.visibility === 'group' ? '👥 Group cookbook'
      : c.visibility === 'public' ? 'Public collection' : 'Collection';
    el.appendChild(this._kicker(kind));
    const meta = document.createElement('div');
    meta.className = 'min-w-0';
    meta.innerHTML = `
        <h3 class="font-semibold text-sm truncate">${this.esc(c.name)}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">${c.item_count} recipe${c.item_count === 1 ? '' : 's'}${c.visibility === 'group' ? ` · ${c.member_count} member${c.member_count === 1 ? '' : 's'}` : ''}${c.is_owner ? '' : ` · by ${this.esc(c.username)}`}</p>
        ${c.description ? `<p class="text-xs text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2">${this.esc(c.description)}</p>` : ''}`;
    el.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-2 mt-auto pt-1';
    const openBtn = this._actionBtn('Open', true);
    openBtn.addEventListener('click', () => this.openCollection(c.id));
    actions.appendChild(openBtn);
    el.appendChild(actions);
    return el;
  },

  publicCollectionCard(c) {
    const el = this._cardShell();
    el.appendChild(this._kicker('Community collection'));
    el.innerHTML += `
      <div class="min-w-0">
        <h3 class="font-semibold text-sm truncate">${this.esc(c.name)}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">by ${c.is_mine ? 'you' : this.esc(c.username)} · ${c.item_count} recipe${c.item_count === 1 ? '' : 's'}</p>
        ${c.description ? `<p class="text-xs text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2">${this.esc(c.description)}</p>` : ''}
      </div>`;
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-2 mt-auto pt-1';
    const openBtn = this._actionBtn('Browse', true);
    openBtn.addEventListener('click', () => this.openCollection(c.id));
    actions.appendChild(openBtn);
    el.appendChild(actions);
    return el;
  },

  async openCollection(id) {
    try {
      const res = await fetch(`/api/collections/${id}`);
      if (!res.ok) return;
      this.activeCollection = await res.json();
      this.render();
    } catch { /* ignore */ }
  },

  async reloadActiveCollection() {
    if (!this.activeCollection) return;
    try {
      const res = await fetch(`/api/collections/${this.activeCollection.id}`);
      if (res.ok) this.activeCollection = await res.json();
      else this.activeCollection = null;
    } catch { /* keep stale copy */ }
  },

  closeCollection() {
    this.activeCollection = null;
    this.render();
  },

  renderCollectionDetail(container) {
    const c = this.activeCollection;
    if (!container || !c) return;
    container.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'space-y-2 mb-5';
    const kind = c.visibility === 'group' ? 'Group cookbook' : c.visibility === 'public' ? 'Public collection' : 'Private collection';
    head.innerHTML = `
      <button id="collection-back" class="text-sm text-blue-500 hover:text-blue-400 transition-colors">← Back to your box</button>
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <h2 class="text-xl font-bold">${this.esc(c.name)}</h2>
          <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-1">${kind} · by ${this.esc(c.username)} · ${c.items.length} recipe${c.items.length === 1 ? '' : 's'}</p>
          ${c.description ? `<p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">${this.esc(c.description)}</p>` : ''}
        </div>
        <div class="flex gap-2 flex-wrap" id="collection-detail-actions"></div>
      </div>`;
    container.appendChild(head);
    head.querySelector('#collection-back').addEventListener('click', () => this.closeCollection());

    const actions = head.querySelector('#collection-detail-actions');
    if (c.visibility === 'group' && c.invite_token && c.is_member) {
      const inviteBtn = this._actionBtn('Copy invite link');
      inviteBtn.title = 'Anyone with this link can join the cookbook';
      inviteBtn.addEventListener('click', () => {
        const url = `${location.origin}/?join=${c.invite_token}`;
        navigator.clipboard?.writeText(url).then(() => {
          inviteBtn.textContent = 'Copied!';
          setTimeout(() => { inviteBtn.textContent = 'Copy invite link'; }, 1500);
        }).catch(() => window.prompt('Share this invite link:', url));
      });
      actions.appendChild(inviteBtn);
    }
    if (c.is_owner) {
      if (c.visibility !== 'group') {
        const pubBtn = this._actionBtn(c.visibility === 'public' ? 'Make private' : 'Publish to feed');
        pubBtn.addEventListener('click', async () => {
          await fetch(`/api/collections/${c.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visibility: c.visibility === 'public' ? 'private' : 'public' }),
          }).catch(() => {});
          this.refresh();
        });
        actions.appendChild(pubBtn);
      }
      const renameBtn = this._actionBtn('Rename');
      renameBtn.addEventListener('click', async () => {
        const name = window.prompt('Collection name:', c.name);
        if (!name || !name.trim()) return;
        await fetch(`/api/collections/${c.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() }),
        }).catch(() => {});
        this.refresh();
      });
      actions.appendChild(renameBtn);
      const delBtn = this._actionBtn('Delete');
      delBtn.classList.add('hover:text-red-500');
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Delete "${c.name}"? Recipes themselves are not deleted.`)) return;
        await fetch(`/api/collections/${c.id}`, { method: 'DELETE' }).catch(() => {});
        this.closeCollection();
        this.refresh();
      });
      actions.appendChild(delBtn);
    } else if (c.visibility === 'group' && c.is_member && App.currentUser) {
      const leaveBtn = this._actionBtn('Leave cookbook');
      leaveBtn.addEventListener('click', async () => {
        if (!confirm(`Leave "${c.name}"?`)) return;
        await fetch(`/api/collections/${c.id}/members/${App.currentUser.id}`, { method: 'DELETE' }).catch(() => {});
        this.closeCollection();
        this.refresh();
      });
      actions.appendChild(leaveBtn);
    }

    if (c.visibility === 'group' && c.members?.length) {
      const membersEl = document.createElement('p');
      membersEl.className = 'text-xs text-zinc-400 dark:text-zinc-500 mb-4';
      membersEl.textContent = `Members: ${c.members.map((m) => m.username + (m.role === 'owner' ? ' (owner)' : '')).join(', ')}`;
      container.appendChild(membersEl);
    }

    const grid = document.createElement('div');
    grid.className = 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3';
    container.appendChild(grid);
    if (!c.items.length) {
      const empty = document.createElement('p');
      empty.className = 'text-sm text-zinc-400 dark:text-zinc-600';
      empty.textContent = 'Nothing in here yet — use "Save" / "+ Collection" on any recipe card to add one.';
      container.appendChild(empty);
      return;
    }
    c.items.forEach((item) => grid.appendChild(this.collectionItemCard(c, item)));
  },

  collectionItemCard(c, item) {
    const recipe = item.data || {};
    const el = this._cardShell();
    el.appendChild(this._kicker(item.snapshot_only ? 'Saved copy' : 'Recipe'));
    const srcBit = item.snapshot_only
      ? '<span class="text-amber-500" title="The original shared recipe was deleted — this is your saved copy">saved copy</span>'
      : item.conversation_id ? 'your recipe' : `by ${this.esc(item.username)}`;
    el.innerHTML += `
      <div class="min-w-0">
        <h3 class="font-semibold text-sm truncate">${this.esc(recipe.title || item.snapshot_title || 'Untitled')}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">${srcBit} · added by ${this.esc(item.added_by_username)}</p>
        ${recipe.description ? `<p class="text-xs text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2">${this.esc(recipe.description)}</p>` : ''}
      </div>`;

    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-2 mt-auto pt-1';
    const viewBtn = this._actionBtn('View', true);
    viewBtn.addEventListener('click', () => {
      if (item.conversation_id && typeof Store !== 'undefined') {
        Store.selectConversation(item.conversation_id);
      } else if (item.shared_recipe_id) {
        const shared = this.shared.find((s) => s.id === item.shared_recipe_id);
        if (shared) return this.viewShared(shared);
        Store.openShared({ id: item.shared_recipe_id, data: recipe, username: item.username, is_mine: false, current_version: 1 });
      } else if (typeof Store !== 'undefined') {
        // Snapshot-only: open read-only from the saved copy.
        Store.openShared({ id: null, data: recipe, username: item.username, is_mine: false, current_version: 1 });
      }
    });
    actions.appendChild(viewBtn);
    const removeBtn = this._actionBtn('Remove');
    removeBtn.addEventListener('click', async () => {
      await fetch(`/api/collections/${c.id}/items/${item.id}`, { method: 'DELETE' }).catch(() => {});
      this.refresh();
    });
    actions.appendChild(removeBtn);
    el.appendChild(actions);
    return el;
  },

  // Add-to-collection picker: target is { sharedRecipeId } or { conversationId }.
  async openCollectionPicker(target) {
    const modal = document.getElementById('collection-pick-modal');
    const list = document.getElementById('collection-pick-list');
    if (!modal || !list) return;
    // Fresh list — the picker can open from the recipe view before the
    // homepage has ever loaded collections.
    try {
      const res = await fetch('/api/collections');
      if (res.ok) this.collections = await res.json();
    } catch { /* fall back to whatever is cached */ }
    modal.classList.remove('hidden');

    const close = () => {
      modal.classList.add('hidden');
      document.getElementById('collection-pick-close').onclick = null;
      document.getElementById('collection-pick-backdrop').onclick = null;
      document.getElementById('collection-pick-create').onclick = null;
    };
    document.getElementById('collection-pick-close').onclick = close;
    document.getElementById('collection-pick-backdrop').onclick = close;

    const addTo = async (collectionId) => {
      try {
        const res = await fetch(`/api/collections/${collectionId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(target),
        });
        if (!res.ok) throw new Error();
        close();
        this.refresh();
      } catch {
        close();
      }
    };

    list.innerHTML = '';
    if (!this.collections.length) {
      list.innerHTML = '<p class="text-sm text-zinc-400 dark:text-zinc-500">No collections yet — create one below.</p>';
    }
    this.collections.forEach((c) => {
      const row = document.createElement('button');
      row.className = 'w-full text-left px-3 py-2.5 text-sm rounded-lg bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 hover:border-blue-400 dark:hover:border-blue-600 transition-colors flex justify-between items-center gap-2';
      row.innerHTML = `<span class="truncate">${this.esc(c.name)}${c.visibility === 'group' ? ' 👥' : ''}</span>
        <span class="text-xs text-zinc-400 shrink-0">${c.item_count} recipe${c.item_count === 1 ? '' : 's'}</span>`;
      row.addEventListener('click', () => addTo(c.id));
      list.appendChild(row);
    });

    document.getElementById('collection-pick-create').onclick = async () => {
      const input = document.getElementById('collection-pick-new-name');
      const name = input.value.trim();
      if (!name) return input.focus();
      try {
        const res = await fetch('/api/collections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error();
        const created = await res.json();
        input.value = '';
        await addTo(created.id);
      } catch { close(); }
    };
  },

  // New collection / group cookbook dialog (from the Collections header).
  openNewCollection(isGroup) {
    const modal = document.getElementById('new-collection-modal');
    if (!modal) return;
    document.getElementById('new-collection-title').textContent =
      isGroup ? 'New group cookbook' : 'New collection';
    document.getElementById('new-collection-hint').classList.toggle('hidden', !isGroup);
    const input = document.getElementById('new-collection-name');
    input.value = '';
    input.placeholder = isGroup ? 'e.g. Family Cookbook' : 'e.g. Weeknight dinners';
    modal.classList.remove('hidden');
    input.focus();

    const close = () => {
      modal.classList.add('hidden');
      document.getElementById('new-collection-close').onclick = null;
      document.getElementById('new-collection-backdrop').onclick = null;
      document.getElementById('new-collection-cancel').onclick = null;
      document.getElementById('new-collection-confirm').onclick = null;
    };
    document.getElementById('new-collection-close').onclick = close;
    document.getElementById('new-collection-backdrop').onclick = close;
    document.getElementById('new-collection-cancel').onclick = close;
    document.getElementById('new-collection-confirm').onclick = async () => {
      const name = input.value.trim();
      if (!name) return input.focus();
      try {
        const res = await fetch('/api/collections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, group: isGroup }),
        });
        if (!res.ok) throw new Error();
        const created = await res.json();
        close();
        await this.refresh();
        this.openCollection(created.id);
      } catch { close(); }
    };
  },

  // Invite-link landing (?join=<token>, handled by app.js on boot).
  async handleJoinToken(token) {
    try {
      const res = await fetch(`/api/collections/invite/${encodeURIComponent(token)}`);
      if (!res.ok) return;
      const info = await res.json();
      if (!info.already_member) {
        const ok = confirm(`Join "${info.name}"? ${info.member_count} member${info.member_count === 1 ? '' : 's'} · ${info.item_count} recipe${info.item_count === 1 ? '' : 's'}.`);
        if (!ok) return;
        await fetch(`/api/collections/join/${encodeURIComponent(token)}`, { method: 'POST' });
      }
      await this.refresh();
      this.openCollection(info.id);
    } catch { /* ignore bad invites */ }
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

  async share(conversationId) {
    // First-time share from a card goes through the publish dialog so the
    // creator confirms tags (recipe.js owns the dialog).
    const rec = this.mine.find((r) => r.conversation_id === conversationId);
    let tags;
    if (typeof Recipe !== 'undefined' && rec?.data) {
      const result = await Recipe.promptPublish(rec.data, { isUpdate: false });
      if (result === null) return; // cancelled
      tags = result.tags;
    }
    try {
      await fetch('/api/recipes/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, tags }),
      });
    } catch { /* refresh below reflects server truth */ }
    this.refresh();
    if (typeof Store !== 'undefined') Store.refresh();
  },

  async toggleSharedFavorite(sharedId, isFavorited) {
    try {
      await fetch(`/api/shared-recipes/${sharedId}/favorite`, {
        method: isFavorited ? 'DELETE' : 'PUT',
      });
    } catch { /* refresh below reflects server truth */ }
    this.refresh();
    if (typeof Store !== 'undefined') Store.refresh();
  },

  async toggleConversationFavorite(conversationId, isFavorited) {
    try {
      await fetch(`/api/conversations/${conversationId}/favorite`, {
        method: isFavorited ? 'DELETE' : 'PUT',
      });
    } catch { /* refresh below reflects server truth */ }
    this.refresh();
    if (typeof Store !== 'undefined') Store.refresh();
  },

  // Read-only view of a shared recipe; chatting from here auto-forks it
  // (Chat.send posts forkRecipe when there's a recipe but no conversation).
  viewShared(s) {
    if (typeof Store !== 'undefined') Store.openShared(s);
  },
};

document.getElementById('home-search')?.addEventListener('input', (e) => {
  Home.searchQuery = e.target.value;
  Home.render();
});
document.getElementById('new-collection-btn')?.addEventListener('click', () => {
  Home.openNewCollection(false);
});
document.getElementById('new-cookbook-btn')?.addEventListener('click', () => {
  Home.openNewCollection(true);
});
