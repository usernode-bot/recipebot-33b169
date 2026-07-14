const Sidebar = {
  recipes: {},
  conversations: [],
  searchQuery: '',

  async refresh() {
    try {
      const [convRes, recRes] = await Promise.all([
        fetch('/api/conversations'),
        fetch('/api/recipes'),
      ]);
      const conversations = convRes.ok ? await convRes.json() : [];
      const recipes = recRes.ok ? await recRes.json() : [];

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
    const visible = q
      ? conversations.filter((conv) => {
          const name = this.recipes[conv.id]?.title || conv.title || 'New conversation';
          return name.toLowerCase().includes(q);
        })
      : conversations;

    if (q && visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'px-2 py-3 text-sm text-zinc-500';
      empty.textContent = 'No recipes match your search';
      list.appendChild(empty);
      return;
    }

    for (const conv of visible) {
      const recipe = this.recipes[conv.id];
      const el = document.createElement('div');
      el.className = 'conversation-item flex items-center gap-1 group';
      el.dataset.id = conv.id;
      if (conv.id === App.currentConversationId) el.classList.add('active');

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

      const actions = document.createElement('div');
      actions.className = 'shrink-0 flex gap-0.5 opacity-0 transition-opacity';
      el.addEventListener('mouseenter', () => actions.style.opacity = '1');
      el.addEventListener('mouseleave', () => actions.style.opacity = '0');

      if (recipe) {
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
      });
      actions.appendChild(delBtn);

      el.appendChild(actions);

      el.addEventListener('click', () => this.selectConversation(conv.id));
      list.appendChild(el);
    }
  },

  async selectConversation(id, opts) {
    App.currentConversationId = id;
    App.currentRecipe = null;
    App.pendingRecipe = null;
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

  forkRecipe(recipeData) {
    App.currentConversationId = null;
    App.currentRecipe = recipeData;
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
