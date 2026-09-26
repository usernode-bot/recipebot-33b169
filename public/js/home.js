// Homepage ("the box"): a sticky search + new-recipe toolbar over two
// labelled bands (issue #32) —
//   Your box:        drafts → favorites → your recipes → collections
//   From community:  community recipes → community collections
// Sections are hidden entirely when empty; the whole page shows an empty
// state only when every section has nothing to render.
//
// Within the box, drafts and your own recipes are ordered newest activity
// first (issue #40) — drafts by their last message, recipes by their last
// recipe message. The servers already sort that way; the client re-sorts
// anyway so a cached or partial response can't resurrect the old order.
const Home = {
  shared: [],
  mine: [],
  favorites: [],
  conversations: [],
  collections: [],
  publicCollections: [],
  searchQuery: '',
  tagFilter: new Set(),
  // Cookbook: the recipes this cook marked Made it, or forked. Not a
  // route of its own — it replaces the box the way a collection does,
  // and the toolbar search (already live above it) narrows it by name.
  cookbookOpen: false,
  cookbook: [],
  // When set, the homepage shows this collection's detail instead of the box.
  activeCollection: null,
  // Drafts are collapsed past this many rows until "Show all" is clicked.
  DRAFT_PREVIEW: 3,
  draftsExpanded: false,

  esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // Newest activity first, id descending as the tiebreaker — seeded rows
  // and rapid-fire edits can share a timestamp, and an unstable order would
  // shuffle cards between renders. Sorts in place: callers pass the fresh
  // arrays that `filter` already returned, never `this.mine` itself.
  _byRecency(rows, stamp) {
    return rows.sort((a, b) => {
      const ta = Date.parse(stamp(a)) || 0;
      const tb = Date.parse(stamp(b)) || 0;
      return tb - ta || (b.id || 0) - (a.id || 0);
    });
  },

  // Short localized date for the "updated …" line. Returns '' for a missing
  // or unparseable timestamp so the caller can drop the bit entirely.
  _shortDate(value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(I18N.lang);
  },

  async refresh() {
    try {
      // Anonymous browse mode reads only the GET-only /api/public/ surface;
      // the personal box sections stay empty and hidden.
      if (App.isAnonymous) {
        const [feedRes, pubCollRes] = await Promise.all([
          fetch('/api/public/feed'),
          fetch('/api/public/collections'),
        ]);
        this.shared = feedRes.ok ? await feedRes.json() : [];
        this.publicCollections = pubCollRes.ok ? await pubCollRes.json() : [];
        this.mine = [];
        this.favorites = [];
        this.conversations = [];
        this.collections = [];
        if (this.activeCollection) {
          await this.reloadActiveCollection();
        }
        this.render();
        return;
      }

      const [sharedRes, mineRes, favRes, convRes, collRes, pubCollRes, cookRes] = await Promise.all([
        fetch('/api/shared-recipes'),
        fetch('/api/recipes'),
        fetch('/api/favorites'),
        fetch('/api/conversations'),
        fetch('/api/collections'),
        fetch('/api/collections/public'),
        this.cookbookOpen ? fetch('/api/cookbook') : Promise.resolve({ ok: false }),
      ]);
      this.shared = sharedRes.ok ? await sharedRes.json() : [];
      this.mine = mineRes.ok ? await mineRes.json() : [];
      this.favorites = favRes.ok ? await favRes.json() : [];
      this.conversations = convRes.ok ? await convRes.json() : [];
      this.collections = collRes.ok ? await collRes.json() : [];
      this.publicCollections = pubCollRes.ok ? await pubCollRes.json() : [];
      if (this.cookbookOpen) this.cookbook = cookRes.ok ? await cookRes.json() : [];
      if (this.activeCollection) {
        await this.reloadActiveCollection();
      }
      this.render();
    } catch { /* retry on next visit */ }
  },

  // Writes the "· N" count pill in a section header.
  _setCount(sectionId, n) {
    const el = document.getElementById(sectionId)?.querySelector('.home-count');
    if (el) el.textContent = n ? `· ${n}` : '';
  },

  render() {
    const bandMine = document.getElementById('home-band-mine');
    const bandComm = document.getElementById('home-band-community');
    const collSection = document.getElementById('home-collections');
    const favSection = document.getElementById('home-favorites');
    const mineSection = document.getElementById('home-mine');
    const convSection = document.getElementById('home-convs');
    const commSection = document.getElementById('home-community');
    const pubCollSection = document.getElementById('home-public-collections');
    const emptyEl = document.getElementById('home-empty');
    const noMatchEl = document.getElementById('home-no-match');
    const detailEl = document.getElementById('collection-view');
    const cookbookEl = document.getElementById('cookbook-view');
    const toolbar = document.getElementById('home-toolbar');
    if (!favSection || !mineSection || !commSection) return;

    // Collection detail replaces the box until closed. Blanking the two
    // bands covers every section inside them.
    const inDetail = !!this.activeCollection;
    detailEl?.classList.toggle('hidden', !inDetail);
    for (const el of [bandMine, bandComm, emptyEl, noMatchEl, toolbar]) {
      if (el) el.style.display = inDetail ? 'none' : '';
    }
    document.getElementById('home-cookbook-entry')
      ?.classList.toggle('hidden', inDetail);
    const inCookbook = this.cookbookOpen && !inDetail;
    cookbookEl?.classList.toggle('hidden', !inCookbook);
    if (inDetail) {
      this.renderCollectionDetail(detailEl);
      return;
    }
    if (inCookbook) {
      this.renderCookbook(cookbookEl);
      return;
    }

    // Anonymous visitors get the community band only, with a lead-in.
    if (bandMine) bandMine.style.display = App.isAnonymous ? 'none' : '';
    document.getElementById('home-cookbook-entry')
      ?.classList.toggle('hidden', App.isAnonymous);
    document.getElementById('home-anon-lead')
      ?.classList.toggle('hidden', !App.isAnonymous);

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

    // `created_at` on a recipe row is its latest recipe message's timestamp
    // — when the recipe was created or last edited.
    const recipeStamp = (r) => r.created_at;
    const favOwn = this._byRecency(this.mine.filter((r) =>
      r.is_favorited && matches(r.data?.title || r.conversation_title, r.data?.tags)), recipeStamp);
    const mineRest = this._byRecency(this.mine.filter((r) =>
      !r.is_favorited && matches(r.data?.title || r.conversation_title, r.data?.tags)), recipeStamp);
    const favShared = this.favorites.filter((s) => matches(s.data?.title, s.tags));
    const shared = this.shared.filter((s) => matches(s.data?.title, s.tags) && tagMatch(s.tags));

    // Conversations without a recipe yet (recipe-bearing ones already show
    // as cards in "Your recipes" / "Your favorites"), most recently worked
    // on first.
    const recipeConvIds = new Set(this.mine.map((r) => r.conversation_id));
    const bareConvs = this._byRecency(this.conversations.filter(
      (c) => !recipeConvIds.has(c.id) && matches(c.title || t('card.newConversation'))),
    (c) => c.last_activity_at || c.created_at);

    this.renderTagFilters();

    const favList = document.getElementById('home-favorites-list');
    favList.innerHTML = '';
    favOwn.forEach((r) => favList.appendChild(this.ownCard(r)));
    favShared.forEach((s) => favList.appendChild(this.sharedCard(s, { favoritesSection: true })));
    favSection.classList.toggle('hidden', favOwn.length + favShared.length === 0);
    this._setCount('home-favorites', favOwn.length + favShared.length);

    const mineList = document.getElementById('home-mine-list');
    mineList.innerHTML = '';
    mineRest.forEach((r) => mineList.appendChild(this.ownCard(r)));
    mineSection.classList.toggle('hidden', mineRest.length === 0);
    this._setCount('home-mine', mineRest.length);

    // Collections (the box's organizer) — always shown when signed in, so
    // "+ New collection" is reachable from an empty box.
    const collList = document.getElementById('home-collections-list');
    let colls = [];
    if (collList && !App.isAnonymous) {
      collList.innerHTML = '';
      colls = this.collections.filter((c) => matches(c.name));
      colls.forEach((c) => collList.appendChild(this.collectionCard(c)));
      document.getElementById('home-collections-empty')
        ?.classList.toggle('hidden', colls.length > 0);
      this._setCount('home-collections', colls.length);
    }

    if (convSection) {
      const convList = document.getElementById('home-convs-list');
      const moreBtn = document.getElementById('home-convs-more');
      convList.innerHTML = '';
      const shownDrafts = this.draftsExpanded
        ? bareConvs : bareConvs.slice(0, this.DRAFT_PREVIEW);
      shownDrafts.forEach((c) => convList.appendChild(this.conversationRow(c)));
      convSection.classList.toggle('hidden', bareConvs.length === 0);
      this._setCount('home-convs', bareConvs.length);
      if (moreBtn) {
        const hidden = bareConvs.length - shownDrafts.length;
        moreBtn.classList.toggle('hidden', hidden === 0 && !this.draftsExpanded);
        moreBtn.textContent = this.draftsExpanded
          ? t('home.draftsLess') : t('home.draftsMore', { n: hidden });
        moreBtn.onclick = () => {
          this.draftsExpanded = !this.draftsExpanded;
          this.render();
        };
      }
    }

    const commList = document.getElementById('home-community-list');
    commList.innerHTML = '';
    shared.forEach((s) => commList.appendChild(this.sharedCard(s)));
    commSection.classList.toggle('hidden', shared.length === 0 && !this.tagFilter.size);
    this._setCount('home-community', shared.length);

    let pubs = [];
    if (pubCollSection) {
      const pubList = document.getElementById('home-public-collections-list');
      pubList.innerHTML = '';
      pubs = this.publicCollections.filter((c) => matches(c.name));
      pubs.forEach((c) => pubList.appendChild(this.publicCollectionCard(c)));
      pubCollSection.classList.toggle('hidden', pubs.length === 0);
      this._setCount('home-public-collections', pubs.length);
    }

    // The community band still carries its label when both its sections are
    // empty (a signed-out visitor on a fresh install would otherwise see a
    // bare page); the box band hides its own sections individually.
    if (bandComm) {
      bandComm.style.display =
        (shared.length === 0 && !this.tagFilter.size && pubs.length === 0 && !App.isAnonymous)
          ? 'none' : '';
    }

    const visible =
      favOwn.length + favShared.length + mineRest.length + bareConvs.length + shared.length;
    emptyEl?.classList.toggle('hidden', !(visible === 0 && !q && colls.length === 0));
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
  // min-w-0 matters: without it the card's min-content width (driven by the
  // line-clamped description, which is a -webkit-box and contributes close
  // to its max-content width) becomes the floor for its grid track and the
  // page scrolls sideways on a phone (issue #31).
  _cardShell() {
    const el = document.createElement('div');
    el.className = 'min-w-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 flex flex-col gap-2 shadow-[0_1px_3px_rgba(31,43,71,0.06)]';
    return el;
  },

  // Two-line clamped description, safe to put straight into a card.
  _description(text) {
    const el = document.createElement('p');
    el.className = 'min-w-0 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed line-clamp-2 break-words';
    el.textContent = text;
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
    btn.title = filled ? t('card.unfavorite') : t('card.favorite');
    btn.innerHTML = filled
      ? '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/></svg>'
      : '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 20 20"><path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"/></svg>';
    return btn;
  },

  _metaLine(recipe) {
    const bits = [];
    if (recipe.prep_time) bits.push(t('card.prep', { t: this.esc(recipe.prep_time) }));
    if (recipe.cook_time) bits.push(t('card.cook', { t: this.esc(recipe.cook_time) }));
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

  _actionClasses(primary) {
    return primary
      ? 'px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors'
      : 'px-3 py-1.5 text-xs rounded-lg bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 transition-colors';
  },

  _actionBtn(label, primary) {
    const btn = document.createElement('button');
    btn.className = this._actionClasses(primary);
    btn.textContent = label;
    return btn;
  },

  // Navigation twin of _actionBtn: a real <a> whose href is the platform
  // deep link for the app-relative route `path`, so cmd/ctrl/shift- and
  // middle-clicks open the destination in a new tab (issue #45). A plain
  // click is intercepted and stays in-app via onOpen.
  _actionLink(label, primary, path, onOpen) {
    const a = document.createElement('a');
    a.className = `${this._actionClasses(primary)} inline-block text-center`;
    a.textContent = label;
    a.href = App.deepLinkUrl(path);
    a.addEventListener('click', (e) => {
      if (App.wantsNewTab(e)) return;
      e.preventDefault();
      onOpen();
    });
    return a;
  },

  // Icon-only so the five-button action row still fits a phone-width card.
  _deleteBtn(conversationId) {
    const btn = document.createElement('button');
    btn.className = 'p-1.5 rounded-lg bg-zinc-200 dark:bg-zinc-800 hover:bg-red-100 dark:hover:bg-red-900/40 text-zinc-500 dark:text-zinc-400 hover:text-red-500 transition-colors ml-auto shrink-0';
    btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>';
    btn.title = t('tip.deleteConversation');
    btn.setAttribute('aria-label', t('common.delete'));
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
    el.appendChild(this._kicker(t('card.yourRecipe')));

    const madeBit = r.made_count > 0 ? ` · ${t('card.made', { n: r.made_count })}` : '';
    const remixBit = r.forked_from_username
      ? ` · <span title="${this.esc(t('card.forkedFromTitle', { name: r.forked_from_username }))}">${t('card.forkedFrom', { name: this.esc(r.forked_from_username) })}</span>` : '';
    // Names the recency the list is sorted by (issue #40).
    const dated = this._shortDate(r.created_at);
    const updatedBit = dated ? ` · ${t('card.updated', { d: this.esc(dated) })}` : '';
    const head = document.createElement('div');
    head.className = 'flex items-start justify-between gap-2';
    head.innerHTML = `
      <div class="min-w-0">
        <h3 class="font-semibold text-sm truncate">${this.esc(recipe.title || r.conversation_title || t('common.untitled'))}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">${t('card.byYou')}${r.is_shared ? ` · <span class="text-blue-400">${t('card.shared')}</span>` : ''}${madeBit}${remixBit}${updatedBit}</p>
      </div>`;
    const heart = this._heartBtn(r.is_favorited);
    heart.addEventListener('click', () =>
      this.toggleConversationFavorite(r.conversation_id, r.is_favorited));
    head.appendChild(heart);
    el.appendChild(head);

    if (recipe.description) el.appendChild(this._description(recipe.description));

    const meta = this._metaLine(recipe);
    if (meta) {
      const metaEl = document.createElement('p');
      metaEl.className = 'text-xs text-zinc-400 dark:text-zinc-500';
      metaEl.innerHTML = meta;
      el.appendChild(metaEl);
    }

    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap items-center gap-2 mt-auto pt-1';
    const openBtn = this._actionLink(t('common.open'), true, `/?c=${r.conversation_id}`, () => {
      if (typeof Store !== 'undefined') Store.selectConversation(r.conversation_id);
    });
    const forkBtn = this._actionBtn(t('common.fork'));
    forkBtn.addEventListener('click', () => {
      if (typeof Store !== 'undefined') Store.forkRecipe(recipe);
    });
    actions.appendChild(openBtn);
    actions.appendChild(forkBtn);
    if (!r.is_shared) {
      const shareBtn = this._actionBtn(t('common.share'));
      shareBtn.title = t('tip.shareToFeed');
      shareBtn.addEventListener('click', () => this.share(r.conversation_id));
      actions.appendChild(shareBtn);
    }
    const collectBtn = this._actionBtn(t('recipe.addCollection'));
    collectBtn.title = t('tip.addToCollection');
    collectBtn.addEventListener('click', () =>
      this.openCollectionPicker({ conversationId: r.conversation_id }));
    actions.appendChild(collectBtn);
    actions.appendChild(this._deleteBtn(r.conversation_id));
    el.appendChild(actions);
    return el;
  },

  // Draft: one of the requester's conversations with no recipe yet. A
  // compact row rather than a card — there's no recipe content to show, and
  // full cards would give the leading section all the page weight.
  conversationRow(c) {
    const el = document.createElement('div');
    const dated = this._shortDate(c.last_activity_at || c.created_at);
    const updatedBit = dated ? ` · ${t('card.updated', { d: this.esc(dated) })}` : '';
    el.className = 'min-w-0 flex items-center gap-2 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2';
    el.innerHTML = `
      <div class="min-w-0 flex-1">
        <p class="text-sm truncate">${this.esc(c.title || t('card.newConversation'))}</p>
        <p class="text-xs text-zinc-400 dark:text-zinc-500">${t('card.noRecipeYet')}${updatedBit}</p>
      </div>`;
    const openBtn = this._actionLink(t('common.open'), true, `/?c=${c.id}`, () => {
      if (typeof Store !== 'undefined') Store.selectConversation(c.id);
    });
    openBtn.classList.add('shrink-0');
    el.appendChild(openBtn);
    el.appendChild(this._deleteBtn(c.id));
    return el;
  },

  // Card for a shared recipe (community feed or favorited shared recipe).
  sharedCard(s, opts) {
    const recipe = s.data || {};
    const el = this._cardShell();
    el.appendChild(this._kicker(s.forked_from_username ? t('card.remix') : t('card.communityRecipe')));

    const remixBit = s.forked_from_username
      ? ` · ${t('card.remixedFrom', { name: this.esc(s.forked_from_username) })}` : '';
    const byline = s.is_mine ? t('card.byYou') : t('card.by', { name: this.esc(s.username) });
    const head = document.createElement('div');
    head.className = 'flex items-start justify-between gap-2';
    head.innerHTML = `
      <div class="min-w-0">
        <h3 class="font-semibold text-sm truncate">${this.esc(recipe.title || t('common.untitled'))}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">${byline}${s.current_version > 1 ? ` · v${s.current_version}` : ''}${remixBit}</p>
      </div>`;
    if (!App.isAnonymous) {
      const heart = this._heartBtn(s.is_favorited);
      heart.addEventListener('click', () => this.toggleSharedFavorite(s.id, s.is_favorited));
      head.appendChild(heart);
    }
    el.appendChild(head);

    if (recipe.description) el.appendChild(this._description(recipe.description));

    const meta = this._metaLine(recipe);
    const socialBits = [];
    if (s.made_count > 0) socialBits.push(t('card.cooked', { n: s.made_count }));
    if (s.comment_count > 0) socialBits.push(tn('card.comments', s.comment_count));
    if (s.remix_count > 0) socialBits.push(tn('card.remixes', s.remix_count));
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
    actions.className = 'flex flex-wrap items-center gap-2 mt-auto pt-1';
    const viewBtn = this._actionLink(t('common.view'), true, `/?s=${s.id}`, () => this.viewShared(s));
    const forkBtn = this._actionBtn(t('common.fork'));
    forkBtn.addEventListener('click', () => {
      if (App.isAnonymous) return App.promptSignIn(t('signin.fork'));
      if (typeof Store !== 'undefined') {
        Store.forkRecipe(recipe, s.is_mine ? null : {
          username: s.username, id: s.id, current_version: s.current_version,
        });
      }
    });
    actions.appendChild(viewBtn);
    actions.appendChild(forkBtn);
    const collectBtn = this._actionBtn(t('common.save'));
    collectBtn.title = t('tip.saveToCollection');
    collectBtn.addEventListener('click', () => {
      if (App.isAnonymous) return App.promptSignIn(t('signin.saveBox'));
      this.openCollectionPicker({ sharedRecipeId: s.id });
    });
    actions.appendChild(collectBtn);
    if (s.share_slug) {
      const linkBtn = this._actionBtn(t('common.link'));
      linkBtn.title = t('tip.copyShareLink');
      linkBtn.addEventListener('click', () => this.copyShareLink(s.share_slug, linkBtn));
      actions.appendChild(linkBtn);
    }
    el.appendChild(actions);
    return el;
  },

  // Confirmation is a toast, not a rewritten button label — the button the
  // visitor pressed stays labelled as itself.
  copyShareLink(slug) {
    const url = `${location.origin}/r/${slug}`;
    navigator.clipboard?.writeText(url)
      .then(() => UI.toast(t('toast.linkCopied')))
      .catch(() => UI.showValue({ title: t('prompt.copyLink'), value: url }));
  },

  _ratingRow(s) {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 flex-wrap';

    const summary = document.createElement('span');
    summary.className = 'text-xs text-zinc-500 dark:text-zinc-400 tabular-nums';
    summary.textContent = s.rating_count
      ? tn('card.ratings', s.rating_count, { avg: Number(s.avg_rating).toFixed(1) })
      : t('card.noRatings');
    row.appendChild(summary);

    // Anonymous visitors see the average summary only — rating is an
    // ownership action.
    if (!s.is_mine && !App.isAnonymous) {
      const stars = document.createElement('span');
      stars.className = 'inline-flex items-center';
      stars.title = s.my_rating ? t('card.yourRating', { n: s.my_rating }) : t('card.rateThis');
      for (let i = 1; i <= 5; i++) {
        const star = document.createElement('button');
        star.className = `text-base leading-none px-0.5 transition-colors ${
          s.my_rating && i <= s.my_rating ? 'text-yellow-400' : 'text-zinc-300 dark:text-zinc-600 hover:text-yellow-400'
        }`;
        star.textContent = s.my_rating && i <= s.my_rating ? '★' : '☆';
        star.title = tn('card.rateStars', i);
        star.addEventListener('click', () => this.rate(s.id, i));
        stars.appendChild(star);
      }
      row.appendChild(stars);
    }
    return row;
  },

  // ── Cookbook ──────────────────────────────────────────────────────

  async openCookbook() {
    if (App.isAnonymous) return App.promptSignIn(t('signin.madeIt'));
    this.cookbookOpen = true;
    this.activeCollection = null;
    HashParams.set('book', '1');
    await this.refresh();
  },

  closeCookbook() {
    this.cookbookOpen = false;
    HashParams.set('book', null);
    this.render();
  },

  // Feed rows, not cards: one line per recipe, title + provenance +
  // View. Same primitives as the drafts rows so the two lists read as
  // one system.
  cookbookRow(r) {
    const el = document.createElement('div');
    el.className = 'min-w-0 flex items-center gap-2 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2';
    const dated = this._shortDate(r.created_at);
    const updatedBit = dated ? ' · ' + t('card.updated', { d: this.esc(dated) }) : '';
    const title = r.data?.title || t('common.untitled');
    const from = r.forked_from_username
      ? ' · ' + t('card.forkedFrom', { name: this.esc(r.forked_from_username) })
      : r.is_mine ? ' · ' + t('card.byYou')
      : ' · ' + t('card.by', { name: this.esc(r.username) });
    el.innerHTML = `
      <div class="min-w-0 flex-1">
        <p class="text-sm truncate">${this.esc(title)}</p>
        <p class="text-xs text-zinc-400 dark:text-zinc-500">${t('card.yourRecipe')}${from}${updatedBit}</p>
      </div>`;
    const path = r.shared_id ? '/?s=' + r.shared_id : '/?c=' + r.conversation_id;
    const open = () => {
      if (r.shared_id) {
        const shared = this.shared.find((s2) => s2.id === r.shared_id);
        if (shared) return this.viewShared(shared);
        if (typeof Store !== 'undefined') {
          Store.openShared({ id: r.shared_id, data: r.data, username: r.username, is_mine: r.is_mine, current_version: r.current_version });
        }
      } else if (r.conversation_id && typeof Store !== 'undefined') {
        Store.selectConversation(r.conversation_id);
      }
    };
    const viewBtn = this._actionLink(t('common.view'), true, path, open);
    viewBtn.classList.add('shrink-0');
    el.appendChild(viewBtn);
    return el;
  },

  renderCookbook(container) {
    if (!container) return;
    container.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'space-y-2 mb-5';
    const q = this.searchQuery.trim().toLowerCase();
    const rows = this.cookbook.filter((r) =>
      !q || (r.data?.title || '').toLowerCase().includes(q));
    head.innerHTML = `
      <a id="cookbook-back" href="${App.deepLinkUrl(null)}" class="inline-block text-sm text-blue-500 hover:text-blue-400 transition-colors">${t('coll.back')}</a>
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <h2 class="text-xl font-bold">${this.esc(t('home.cookbook'))}</h2>
          <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-1">${t('cookbook.subtitle')}</p>
        </div>
      </div>`;
    container.appendChild(head);
    head.querySelector('#cookbook-back').addEventListener('click', (e) => {
      if (App.wantsNewTab(e)) return;
      e.preventDefault();
      this.closeCookbook();
    });

    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'text-sm text-zinc-400 dark:text-zinc-600';
      empty.textContent = q ? t('home.noMatch') : t('cookbook.empty');
      container.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.id = 'cookbook-list';
      list.className = 'space-y-2';
      rows.forEach((r) => list.appendChild(this.cookbookRow(r)));
      container.appendChild(list);
    }
  },

  // ── Collections ───────────────────────────────────────────────────

  // One concept, three labels (issue #34): public wins, then "shared" when
  // other people are in it or an invite link is out, else a plain
  // collection. There is no "group cookbook" any more.
  collectionKind(c) {
    if (c.visibility === 'public') return t('card.publicCollection');
    if (c.is_shared) return t('card.sharedCollection');
    return t('card.collection');
  },

  _collectionMeta(c) {
    const bits = [tn('card.recipes', c.item_count)];
    if (c.is_shared && c.member_count) bits.push(tn('card.members', c.member_count));
    if (c.comment_count) bits.push(tn('card.collectionComments', c.comment_count));
    return bits;
  },

  collectionCard(c) {
    const el = this._cardShell();
    el.appendChild(this._kicker(this.collectionKind(c)));
    const bits = this._collectionMeta(c);
    if (!c.is_owner) bits.push(t('card.by', { name: this.esc(c.username) }));
    const meta = document.createElement('div');
    meta.className = 'min-w-0';
    meta.innerHTML = `
        <h3 class="font-semibold text-sm truncate">${this.esc(c.name)}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">${bits.join(' · ')}</p>`;
    el.appendChild(meta);
    if (c.description) el.appendChild(this._description(c.description));
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap items-center gap-2 mt-auto pt-1';
    const openBtn = this._actionLink(t('common.open'), true, `/?coll=${c.id}`,
      () => this.openCollection(c.id));
    actions.appendChild(openBtn);
    el.appendChild(actions);
    return el;
  },

  publicCollectionCard(c) {
    const el = this._cardShell();
    el.appendChild(this._kicker(t('card.communityCollection')));
    const byline = c.is_mine ? t('card.byYou') : t('card.by', { name: this.esc(c.username) });
    const bits = [byline, tn('card.recipes', c.item_count)];
    if (c.comment_count) bits.push(tn('card.collectionComments', c.comment_count));
    // appendChild, not `innerHTML +=` — the latter would drop the kicker's
    // node identity and any listener attached above it.
    const meta = document.createElement('div');
    meta.className = 'min-w-0';
    meta.innerHTML = `
        <h3 class="font-semibold text-sm truncate">${this.esc(c.name)}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">${bits.join(' · ')}</p>`;
    el.appendChild(meta);
    if (c.description) el.appendChild(this._description(c.description));
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap items-center gap-2 mt-auto pt-1';
    const openBtn = this._actionLink(t('common.browse'), true, `/?coll=${c.id}`,
      () => this.openCollection(c.id));
    actions.appendChild(openBtn);
    el.appendChild(actions);
    return el;
  },

  // Anonymous visitors read public collections through the /api/public/
  // surface (public-visibility only, live shared items only, no members).
  _collectionUrl(id) {
    return App.isAnonymous ? `/api/public/collections/${id}` : `/api/collections/${id}`;
  },

  // Resolves true when the collection actually opened — the boot restore
  // path clears the `coll` param when it didn't (deleted, private, 404).
  async openCollection(id) {
    if (!id || Number.isNaN(id)) return false;
    try {
      const res = await fetch(this._collectionUrl(id));
      if (!res.ok) return false;
      this.activeCollection = await res.json();
      // Addressable as `#coll=<id>` so a refresh reopens it, and signing in
      // from a public collection comes back here.
      HashParams.set('coll', id);
      if (App.isAnonymous) App.setSignInPath?.(`/?coll=${id}`);
      this.render();
      return true;
    } catch {
      return false;
    }
  },

  async reloadActiveCollection() {
    if (!this.activeCollection) return;
    try {
      const res = await fetch(this._collectionUrl(this.activeCollection.id));
      if (res.ok) this.activeCollection = await res.json();
      else this.activeCollection = null;
    } catch { /* keep stale copy */ }
  },

  closeCollection() {
    this.activeCollection = null;
    HashParams.set('coll', null);
    App.setSignInPath?.(null);
    this.render();
  },

  renderCollectionDetail(container) {
    const c = this.activeCollection;
    if (!container || !c) return;
    container.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'space-y-2 mb-5';
    const kind = this.collectionKind(c);
    const headBits = [kind, t('card.by', { name: this.esc(c.username) }),
      tn('card.recipes', c.items.length)];
    if (c.is_shared && c.members?.length) headBits.push(tn('card.members', c.members.length));
    head.innerHTML = `
      <a id="collection-back" href="${App.deepLinkUrl(null)}" class="inline-block text-sm text-blue-500 hover:text-blue-400 transition-colors">${t('coll.back')}</a>
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <h2 class="text-xl font-bold">${this.esc(c.name)}</h2>
          <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-1">${headBits.join(' · ')}</p>
          ${c.description ? `<p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1 break-words">${this.esc(c.description)}</p>` : ''}
        </div>
        <div class="flex gap-2 flex-wrap" id="collection-detail-actions"></div>
      </div>`;
    container.appendChild(head);
    head.querySelector('#collection-back').addEventListener('click', (e) => {
      if (App.wantsNewTab(e)) return;
      e.preventDefault();
      this.closeCollection();
    });

    const actions = head.querySelector('#collection-detail-actions');
    const copyInvite = (token) => {
      const url = `${location.origin}/?join=${token}`;
      navigator.clipboard?.writeText(url)
        .then(() => UI.toast(t('toast.inviteCopied')))
        .catch(() => UI.showValue({ title: t('prompt.shareInvite'), value: url }));
    };
    // Invite links live on ANY collection now, not just the old group kind.
    if (c.invite_token && c.is_member) {
      const inviteBtn = this._actionBtn(t('coll.copyInvite'));
      inviteBtn.title = t('tip.inviteLink');
      inviteBtn.addEventListener('click', () => copyInvite(c.invite_token));
      actions.appendChild(inviteBtn);
    }
    if (c.is_owner) {
      if (!c.invite_token) {
        const shareBtn = this._actionBtn(t('coll.invitePeople'));
        shareBtn.title = t('tip.inviteLink');
        shareBtn.addEventListener('click', async () => {
          try {
            const res = await fetch(`/api/collections/${c.id}/invite`, { method: 'POST' });
            if (!res.ok) throw new Error();
            const { invite_token: token } = await res.json();
            copyInvite(token);
            await this.reloadActiveCollection();
            this.render();
          } catch { /* leave the button as-is */ }
        });
        actions.appendChild(shareBtn);
      }
      // Publicity is one-way (issue #33): "Make public" until it is, then a
      // plain badge. Deleting the collection is the only way back.
      if (c.visibility === 'public') {
        const badge = document.createElement('span');
        badge.className = 'px-3 py-1.5 text-xs rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400 font-medium';
        badge.textContent = t('coll.publicBadge');
        actions.appendChild(badge);
      } else {
        const pubBtn = this._actionBtn(t('coll.makePublic'));
        pubBtn.addEventListener('click', async () => {
          // One-way (issue #33) — the action sheet spells that out.
          const ok = await UI.confirmDestructive({
            title: t('coll.makePublicConfirm', { name: c.name }),
            confirmLabel: t('coll.makePublic'),
          });
          if (!ok) return;
          await fetch(`/api/collections/${c.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visibility: 'public' }),
          }).catch(() => {});
          this.refresh();
        });
        actions.appendChild(pubBtn);
      }
      const renameBtn = this._actionBtn(t('common.rename'));
      renameBtn.addEventListener('click', async () => {
        const name = await UI.prompt({
          title: t('prompt.collectionName'),
          value: c.name,
          okLabel: t('common.rename'),
        });
        if (!name) return;
        await fetch(`/api/collections/${c.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }).catch(() => {});
        this.refresh();
      });
      actions.appendChild(renameBtn);
      const delBtn = this._actionBtn(t('common.delete'));
      delBtn.classList.add('hover:text-red-500');
      delBtn.addEventListener('click', async () => {
        const ok = await UI.confirmDestructive({
          title: t('coll.deleteConfirm', { name: c.name }),
          confirmLabel: t('common.delete'),
        });
        if (!ok) return;
        await fetch(`/api/collections/${c.id}`, { method: 'DELETE' }).catch(() => {});
        this.closeCollection();
        this.refresh();
      });
      actions.appendChild(delBtn);
    } else if (c.is_member && App.currentUser) {
      const leaveBtn = this._actionBtn(t('coll.leave'));
      leaveBtn.addEventListener('click', async () => {
        const ok = await UI.confirmDestructive({
          title: t('coll.leaveConfirm', { name: c.name }),
          confirmLabel: t('coll.leave'),
        });
        if (!ok) return;
        await fetch(`/api/collections/${c.id}/members/${App.currentUser.id}`, { method: 'DELETE' }).catch(() => {});
        this.closeCollection();
        this.refresh();
      });
      actions.appendChild(leaveBtn);
    }

    if (c.members?.length > 1) {
      const membersEl = document.createElement('p');
      membersEl.className = 'text-xs text-zinc-400 dark:text-zinc-500 mb-4 break-words';
      membersEl.textContent = t('coll.members', {
        list: c.members.map((m) => m.username + (m.role === 'owner' ? t('coll.ownerSuffix') : '')).join(', '),
      });
      container.appendChild(membersEl);
    }

    if (!c.items.length) {
      const empty = document.createElement('p');
      empty.className = 'text-sm text-zinc-400 dark:text-zinc-600';
      empty.textContent = t('coll.empty');
      container.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3';
      c.items.forEach((item) => grid.appendChild(this.collectionItemCard(c, item)));
      container.appendChild(grid);
    }

    // Comment thread (issue #35) — same widget as the recipe panel's.
    const commentsWrap = document.createElement('div');
    commentsWrap.className = 'mt-6 pt-4 border-t border-zinc-200 dark:border-zinc-800';
    container.appendChild(commentsWrap);
    CommentThread.render(commentsWrap, {
      comments: c.comments || [],
      canModerate: !!c.is_owner,
      heading: (n) => t('social.collectionComments', { n }),
      placeholder: t('social.addCollectionComment'),
      signInReason: t('signin.commentCollection'),
      onPost: async (body) => {
        await fetch(`/api/collections/${c.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        }).catch(() => {});
        await this.reloadActiveCollection();
        this.render();
      },
      onDelete: async (id) => {
        await fetch(`/api/collection-comments/${id}`, { method: 'DELETE' }).catch(() => {});
        await this.reloadActiveCollection();
        this.render();
      },
    });
  },

  collectionItemCard(c, item) {
    const recipe = item.data || {};
    const el = this._cardShell();
    el.appendChild(this._kicker(item.snapshot_only ? t('card.savedCopy') : t('card.recipe')));
    const srcBit = item.snapshot_only
      ? `<span class="text-amber-500" title="${this.esc(t('card.savedCopyTitle'))}">${t('coll.savedCopyBadge')}</span>`
      : item.conversation_id ? t('coll.yourRecipe') : t('card.by', { name: this.esc(item.username) });
    const meta = document.createElement('div');
    meta.className = 'min-w-0';
    meta.innerHTML = `
        <h3 class="font-semibold text-sm truncate">${this.esc(recipe.title || item.snapshot_title || t('common.untitled'))}</h3>
        <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">${srcBit} · ${t('card.addedBy', { name: this.esc(item.added_by_username) })}</p>`;
    el.appendChild(meta);
    if (recipe.description) el.appendChild(this._description(recipe.description));

    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap items-center gap-2 mt-auto pt-1';
    const openItem = () => {
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
    };
    // Snapshot-only copies are routeless (see Store.openShared), so there is
    // no deep link to carry — those keep a plain button.
    const itemPath = item.conversation_id ? `/?c=${item.conversation_id}`
      : item.shared_recipe_id ? `/?s=${item.shared_recipe_id}` : null;
    let viewBtn;
    if (itemPath) {
      viewBtn = this._actionLink(t('common.view'), true, itemPath, openItem);
    } else {
      viewBtn = this._actionBtn(t('common.view'), true);
      viewBtn.addEventListener('click', openItem);
    }
    actions.appendChild(viewBtn);
    if (!App.isAnonymous) {
      const removeBtn = this._actionBtn(t('common.remove'));
      removeBtn.addEventListener('click', async () => {
        await fetch(`/api/collections/${c.id}/items/${item.id}`, { method: 'DELETE' }).catch(() => {});
        this.refresh();
      });
      actions.appendChild(removeBtn);
    }
    el.appendChild(actions);
    return el;
  },

  // Add-to-collection picker: target is { sharedRecipeId } or { conversationId }.
  // A null target is the ?ui=collectionpick screenshot state — the picker
  // renders, but there is nothing to add, so picking a row just closes it.
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

    const dialog = Dialogs.present(modal, {
      name: 'collectionpick',
      onDismiss() {
        document.getElementById('collection-pick-create').onclick = null;
      },
    });
    const close = () => dialog && dialog.dismiss();
    document.getElementById('collection-pick-close').onclick = close;

    const hasTarget = !!(target && (target.conversationId || target.sharedRecipeId));

    const addTo = async (collectionId) => {
      if (!hasTarget) return close();
      try {
        const res = await fetch(`/api/collections/${collectionId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(target),
        });
        if (!res.ok) throw new Error();
        close();
        UI.toast(t('toast.addedToCollection'));
        this.refresh();
      } catch {
        close();
      }
    };

    list.innerHTML = '';
    if (!this.collections.length) {
      const p = document.createElement('p');
      p.className = 'text-sm text-zinc-400 dark:text-zinc-500';
      p.textContent = t('collPick.empty');
      list.appendChild(p);
    }
    this.collections.forEach((c) => {
      const row = document.createElement('button');
      row.className = 'w-full text-left px-3 py-2.5 text-sm rounded-lg bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 hover:border-blue-400 dark:hover:border-blue-600 transition-colors flex justify-between items-center gap-2';
      row.innerHTML = `<span class="truncate">${this.esc(c.name)}</span>
        <span class="text-xs text-zinc-400 shrink-0">${c.is_shared && c.member_count ? `${tn('card.members', c.member_count)} · ` : ''}${tn('card.recipes', c.item_count)}</span>`;
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

  // New collection dialog (from the Collections header). One kind of
  // collection now — inviting and publishing happen on the collection.
  openNewCollection() {
    const modal = document.getElementById('new-collection-modal');
    if (!modal) return;
    document.getElementById('new-collection-title').textContent = t('newColl.title');
    const input = document.getElementById('new-collection-name');
    input.value = '';
    input.placeholder = t('newColl.placeholder');

    const dialog = Dialogs.present(modal, {
      name: 'newcollection',
      onPresent() { input.focus({ preventScroll: true }); },
      onDismiss() {
        document.getElementById('new-collection-cancel').onclick = null;
        document.getElementById('new-collection-confirm').onclick = null;
      },
    });
    const close = () => dialog && dialog.dismiss();
    document.getElementById('new-collection-close').onclick = close;
    document.getElementById('new-collection-cancel').onclick = close;
    document.getElementById('new-collection-confirm').onclick = async () => {
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
        const ok = await UI.alert({
          title: t('coll.joinTitle'),
          message: t('coll.joinConfirm', {
            name: info.name,
            members: tn('card.members', info.member_count),
            recipes: tn('card.recipes', info.item_count),
          }),
          okLabel: t('coll.join'),
          cancelLabel: t('common.cancel'),
        });
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
document.getElementById('open-cookbook-btn')?.addEventListener('click', () => {
  Home.openCookbook();
});
document.getElementById('new-collection-btn')?.addEventListener('click', () => {
  Home.openNewCollection();
});
