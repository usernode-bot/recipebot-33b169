// Shared data store + navigation actions. This used to be the sidebar; the
// sidebar UI is gone (its controls live on the homepage now), but the rest of
// the app still needs the conversation/recipe data and the open/fork actions.
const Store = {
  recipes: {},
  conversations: [],
  favoriteShared: [],

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
    } catch { /* retry on next refresh */ }
  },

  async selectConversation(id, opts) {
    App.currentConversationId = id;
    App.currentRecipe = null;
    App.pendingRecipe = null;
    App.viewingShared = null;
    App.viewingVersion = null;
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

    if (typeof Chat !== 'undefined') await Chat.loadMessages(id);
  },

  // Read-only view of a shared recipe. Chatting from this state auto-forks
  // (Chat.send posts forkRecipe when a recipe is loaded with no conversation).
  openShared(item) {
    App.showView('chat');
    App.currentConversationId = null;
    App.pendingRecipe = null;
    App.currentRecipe = item.data;
    App.viewingVersion = null;
    App.viewingShared = {
      id: item.id,
      username: item.username,
      is_mine: item.is_mine,
      avg_rating: item.avg_rating,
      rating_count: item.rating_count,
      current_version: item.current_version || 1,
      // Kept so "Back to current" can restore after viewing an old version.
      currentData: item.data,
    };
    Recipe.currentServings = item.data.default_servings;
    Recipe.servingScale = 1.0;
    Recipe.display(item.data);

    if (typeof Chat !== 'undefined') Chat.clear();
    HashParams.clear();
  },

  forkRecipe(recipeData, meta) {
    App.showView('chat');
    App.currentConversationId = null;
    App.currentRecipe = recipeData;
    App.viewingShared = meta ? { username: meta.username } : null;
    App.viewingVersion = null;
    Recipe.currentServings = recipeData.default_servings;
    Recipe.display(recipeData);

    if (typeof Chat !== 'undefined') {
      Chat.clear();
      Chat.appendMessage('assistant', `Ready to modify "${recipeData.title}". What changes would you like?`);
    }

    HashParams.clear();
    document.getElementById('chat-input')?.focus();
  },

  async deleteConversation(id) {
    if (!confirm('Delete this conversation?')) return;
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' }).catch(() => {});
    if (App.currentConversationId === id) {
      App.currentConversationId = null;
      App.currentRecipe = null;
      App.pendingRecipe = null;
      HashParams.clear();
      if (typeof Chat !== 'undefined') Chat.clear();
      document.getElementById('recipe-display')?.classList.add('hidden');
      document.getElementById('recipe-empty')?.classList.remove('hidden');
    }
    this.refresh();
    if (typeof Home !== 'undefined' && App.currentView === 'home') Home.refresh();
  },
};

Store.refresh();
