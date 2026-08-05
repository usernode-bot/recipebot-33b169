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

  // Resolves true when the conversation actually loaded — the boot restore
  // path falls back to the homepage when it didn't (deleted recipe, 404).
  async selectConversation(id, opts) {
    App.currentConversationId = id;
    App.currentRecipe = null;
    App.pendingRecipe = null;
    App.viewingShared = null;
    App.viewingVersion = null;
    App.showView('chat');
    HashParams.set('s', null);
    HashParams.set('c', id);
    App.setSignInPath?.(null);
    if (!opts?.restore) {
      HashParams.set('ing', null);
      if (typeof Recipe !== 'undefined') {
        Recipe.ingredientSummaryOpen = false;
        Recipe.checkedIngredients.clear();
        Recipe.activeSteps.clear();
      }
    }

    if (typeof Chat === 'undefined') return false;
    const ok = await Chat.loadMessages(id);
    // Recipe-first (issue #30): loadMessages sets App.currentRecipe from the
    // conversation's latest recipe message, so only now can we tell a recipe
    // apart from a draft. Drafts have nothing to show but the transcript.
    App.setMobileTab?.(App.currentRecipe ? 'recipe' : 'chat');
    return ok;
  },

  // Look up one shared recipe by id for the `#s=<id>` / `?s=<id>` route.
  // Both feeds return the shape openShared consumes; the anonymous one just
  // omits the personalized fields (is_mine / my_rating / is_favorited).
  async loadSharedById(id) {
    if (!id || Number.isNaN(id)) return null;
    if (typeof Home !== 'undefined' && Home.shared?.length) {
      const cached = Home.shared.find((s) => s.id === id);
      if (cached) return cached;
    }
    try {
      const res = await fetch(App.isAnonymous ? '/api/public/feed' : '/api/shared-recipes');
      if (!res.ok) return null;
      const rows = await res.json();
      return rows.find((s) => s.id === id) || null;
    } catch {
      return null;
    }
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
      share_slug: item.share_slug || null,
      forked_from_shared_id: item.forked_from_shared_id || null,
      forked_from_username: item.forked_from_username || null,
      made_count: item.made_count || 0,
      remix_count: item.remix_count || 0,
      // Kept so "Back to current" can restore after viewing an old version.
      currentData: item.data,
    };
    Recipe.currentServings = item.data.default_servings;
    Recipe.servingScale = 1.0;
    Recipe.display(item.data);
    // A shared item always carries a recipe — show it (issue #30).
    App.setMobileTab?.('recipe');

    if (typeof Chat !== 'undefined') Chat.clear();

    // Addressable as `#s=<id>` so a refresh reloads this recipe. Snapshot-only
    // copies (id === null) have nothing to look up, so they stay routeless.
    HashParams.set('c', null);
    HashParams.set('ing', null);
    HashParams.set('mac', null);
    HashParams.set('s', item.id || null);
    // Signing in from here should come back to this recipe.
    App.setSignInPath?.(item.id ? `/?s=${item.id}` : null);
  },

  // meta (when forking someone else's shared recipe) carries the lineage
  // source: { username, id, current_version } — Chat.send forwards it as
  // forkSource so the fork records where it came from.
  forkRecipe(recipeData, meta) {
    App.showView('chat');
    App.currentConversationId = null;
    App.currentRecipe = recipeData;
    App.viewingShared = meta ? {
      username: meta.username,
      id: meta.id || null,
      current_version: meta.current_version || null,
      is_mine: false,
    } : null;
    App.viewingVersion = null;
    Recipe.currentServings = recipeData.default_servings;
    Recipe.display(recipeData);
    // You forked in order to ask for changes — the message box is the point.
    App.setMobileTab?.('chat');

    if (typeof Chat !== 'undefined') {
      Chat.clear();
      Chat.appendMessage('assistant', t('chat.readyToModify', { title: recipeData.title }));
    }

    // An unsaved fork draft has nothing server-side to reload — no route.
    HashParams.clear();
    App.setSignInPath?.(null);
    document.getElementById('chat-input')?.focus();
  },

  async deleteConversation(id) {
    const ok = await UI.confirmDestructive({
      title: t('confirm.deleteConversation'),
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
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

// Boot refresh only makes sense with a platform token — anonymous visitors
// have no conversations/recipes/favorites, and skipping avoids 401 noise.
if (window.UsernodeAuth?.token) Store.refresh();
