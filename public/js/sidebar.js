const Sidebar = {
  recipes: {},
  conversations: [],
  favoriteShared: [],
  searchQuery: '',

  _heartIcon(filled) {
    return filled
      ? '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/></svg>'
      : '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 20 20"><path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"/></svg>';
  },

  _refreshHome() {
    if (typeof Home !== 'undefined' && App.currentView === 'home') Home.refresh();
  },

  async refresh() {
    try {
      const [convRes, recRes, favRes] = await Promise.all([
        fetch('/api/conversations'),
        fetch('/api/recipes'),
        fetch('/api/favorites'),
      ]);
      const conversations = convRes.ok ? await convRes.json() : [];
      const recipes = recRes.ok ? await recRes.json() : [];
      this.favoriteShared = favRes.ok ? await favRes.json() : [];

      this.recipes = {};
      for (const r of recipes) {
        if (r.conversation_id) this.recipes[r.conversation_id] = r.data;
      }

      this.conversations = conversations;
      this.render(conversations);
    } catch { /* retry on next refresh */ }
  },

  render(conversations) {
    const list = document.getElementById('conversation-list');
    list.innerHTML = '';

    const q = this.searchQuery.trim().toLowerCase();
    const matches = (name) => !q || (name || '').toLowerCase().includes(q);

    const convName = (conv) =>
      this.recipes[conv.id]?.title || conv.title || 'New conversation';

    // Favorites pinned first: own favorited conversations, then favorited
    // shared recipes from other users, then the remaining conversations.
    const favConvs = conversations.filter((c) => c.is_favorited && matches(convName(c)));
    const favShared = this.favoriteShared.filter((s) => matches(s.data?.title));
    const rest = conversations.filter((c) => !c.is_favorited && matches(convName(c)));

    if (q && favConvs.length + favShared.length + rest.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'px-2 py-3 text-sm text-zinc-500';
      empty.textContent = 'No recipes match your search';
      list.appendChild(empty);
      return;
    }

    favConvs.forEach((conv) => list.appendChild(this.renderConversation(conv)));
    favShared.forEach((item) => list.appendChild(this.renderSharedFavorite(item)));
    rest.forEach((conv) => list.appendChild(this.renderConversation(conv)));
  },

  renderConversation(conv) {
    const recipe = this.recipes[conv.id];
    const el = document.createElement('div');
    el.className = 'conversation-item flex items-center gap-1 group';
    el.dataset.id = conv.id;
    if (conv.id === App.currentConversationId) el.classList.add('active');

    if (conv.is_favorited) {
      const heart = document.createElement('span');
      heart.className = 'shrink-0 text-pink-500';
      heart.innerHTML = this._heartIcon(true);
      el.appendChild(heart);
    }

    if (recipe) {
      const icon = document.createElement('span');
      icon.className = 'shrink-0 text-orange-400 text-xs';
      icon.textContent = '🍳';
      el.appendChild(icon);
    }

    const title = document.createElement('span');
    title.className = 'flex-1 truncate';
    title.textContent = conv.title || 'New conversation';
    el.appendChild(title);

    if (conv.is_shared) {
      const badge = document.createElement('span');
      badge.className = 'shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-500 dark:text-blue-400';
      badge.textContent = 'shared';
      el.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'shrink-0 flex gap-0.5 opacity-0 transition-opacity';
    el.addEventListener('mouseenter', () => actions.style.opacity = '1');
    el.addEventListener('mouseleave', () => actions.style.opacity = '0');

    const favBtn = document.createElement('button');
    favBtn.className = 'p-0.5 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-400 hover:text-pink-500';
    favBtn.innerHTML = this._heartIcon(conv.is_favorited);
    favBtn.title = conv.is_favorited ? 'Unfavorite' : 'Favorite';
    favBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/conversations/${conv.id}/favorite`, {
        method: conv.is_favorited ? 'DELETE' : 'PUT',
      }).catch(() => {});
      this.refresh();
      this._refreshHome();
    });
    actions.appendChild(favBtn);

    if (recipe) {
      const shareBtn = document.createElement('button');
      shareBtn.className = 'p-0.5 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-400 hover:text-blue-400';
      shareBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>';
      shareBtn.title = conv.is_shared ? 'Unshare recipe' : 'Share recipe to the community feed';
      shareBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (conv.is_shared) {
          if (!confirm('Unshare this recipe? Its ratings and favorites from other users will be removed.')) return;
          await fetch(`/api/recipes/share/${conv.id}`, { method: 'DELETE' }).catch(() => {});
        } else {
          await fetch('/api/recipes/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: conv.id }),
          }).catch(() => {});
        }
        this.refresh();
        this._refreshHome();
      });
      actions.appendChild(shareBtn);

      const forkBtn = document.createElement('button');
      forkBtn.className = 'p-0.5 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-400 hover:text-blue-400';
      forkBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.99 1.99 0 013 12V7a4 4 0 014-4z"/></svg>';
      forkBtn.title = 'Fork recipe into new conversation';
      forkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.forkRecipe(recipe);
      });
      actions.appendChild(forkBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'p-0.5 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-400 hover:text-red-400';
    delBtn.innerHTML = '&times;';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this conversation?')) return;
      await fetch(`/api/conversations/${conv.id}`, { method: 'DELETE' });
      if (App.currentConversationId === conv.id) {
        App.currentConversationId = null;
        App.currentRecipe = null;
        App.pendingRecipe = null;
        HashParams.clear();
        if (typeof Chat !== 'undefined') Chat.clear();
        document.getElementById('recipe-display')?.classList.add('hidden');
        document.getElementById('recipe-empty')?.classList.remove('hidden');
      }
      this.refresh();
      this._refreshHome();
    });
    actions.appendChild(delBtn);

    el.appendChild(actions);
    el.addEventListener('click', () => this.selectConversation(conv.id));
    return el;
  },

  // A favorited shared recipe, pinned in the sidebar. Opens read-only.
  renderSharedFavorite(item) {
    const el = document.createElement('div');
    el.className = 'conversation-item flex items-center gap-1 group';

    const heart = document.createElement('span');
    heart.className = 'shrink-0 text-pink-500';
    heart.innerHTML = this._heartIcon(true);
    el.appendChild(heart);

    const label = document.createElement('span');
    label.className = 'flex-1 min-w-0 truncate';
    const title = document.createElement('span');
    title.textContent = item.data?.title || 'Untitled';
    const by = document.createElement('span');
    by.className = 'text-xs text-zinc-400 dark:text-zinc-500';
    by.textContent = ` · ${item.is_mine ? 'you' : item.username}`;
    label.appendChild(title);
    label.appendChild(by);
    el.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'shrink-0 flex gap-0.5 opacity-0 transition-opacity';
    el.addEventListener('mouseenter', () => actions.style.opacity = '1');
    el.addEventListener('mouseleave', () => actions.style.opacity = '0');

    const unfavBtn = document.createElement('button');
    unfavBtn.className = 'p-0.5 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 text-pink-500 hover:text-pink-400';
    unfavBtn.innerHTML = this._heartIcon(true);
    unfavBtn.title = 'Unfavorite';
    unfavBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/shared-recipes/${item.id}/favorite`, { method: 'DELETE' }).catch(() => {});
      this.refresh();
      this._refreshHome();
    });
    actions.appendChild(unfavBtn);

    const forkBtn = document.createElement('button');
    forkBtn.className = 'p-0.5 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-400 hover:text-blue-400';
    forkBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.99 1.99 0 013 12V7a4 4 0 014-4z"/></svg>';
    forkBtn.title = 'Fork recipe into new conversation';
    forkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.forkRecipe(item.data, item.is_mine ? null : { username: item.username });
    });
    actions.appendChild(forkBtn);

    el.appendChild(actions);
    el.addEventListener('click', () => this.openShared(item));
    return el;
  },

  async selectConversation(id, opts) {
    App.currentConversationId = id;
    App.currentRecipe = null;
    App.pendingRecipe = null;
    App.viewingShared = null;
    App.showView('chat');
    HashParams.set('c', id);
    if (!opts?.restore) {
      HashParams.set('ing', null);
      if (typeof Recipe !== 'undefined') {
        Recipe.ingredientSummaryOpen = false;
        Recipe.checkedIngredients.clear();
        Recipe.activeSteps.clear();
      }
    }

    document.querySelectorAll('.conversation-item').forEach((el) => {
      el.classList.toggle('active', parseInt(el.dataset?.id) === id);
    });

    if (typeof Chat !== 'undefined') await Chat.loadMessages(id);
  },

  // Read-only view of a shared recipe. Chatting from this state auto-forks
  // (Chat.send posts forkRecipe when a recipe is loaded with no conversation).
  openShared(item) {
    App.showView('chat');
    App.currentConversationId = null;
    App.pendingRecipe = null;
    App.currentRecipe = item.data;
    App.viewingShared = {
      username: item.username,
      is_mine: item.is_mine,
      avg_rating: item.avg_rating,
      rating_count: item.rating_count,
    };
    Recipe.currentServings = item.data.default_servings;
    Recipe.servingScale = 1.0;
    Recipe.display(item.data);

    if (typeof Chat !== 'undefined') Chat.clear();
    HashParams.clear();
    document.querySelectorAll('.conversation-item').forEach((el) => el.classList.remove('active'));
  },

  forkRecipe(recipeData, meta) {
    App.showView('chat');
    App.currentConversationId = null;
    App.currentRecipe = recipeData;
    App.viewingShared = meta ? { username: meta.username } : null;
    Recipe.currentServings = recipeData.default_servings;
    Recipe.display(recipeData);

    if (typeof Chat !== 'undefined') {
      Chat.clear();
      Chat.appendMessage('assistant', `Ready to modify "${recipeData.title}". What changes would you like?`);
    }

    HashParams.clear();
    document.querySelectorAll('.conversation-item').forEach((el) => el.classList.remove('active'));
    document.getElementById('chat-input')?.focus();
  },
};

document.getElementById('sidebar-search')?.addEventListener('input', (e) => {
  Sidebar.searchQuery = e.target.value;
  Sidebar.render(Sidebar.conversations);
});

Sidebar.refresh();
