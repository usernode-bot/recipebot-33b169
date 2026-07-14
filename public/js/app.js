window.App = {
  currentUser: null,
  currentConversationId: null,
  currentRecipe: null,
  pendingRecipe: null,

  preferences: {
    diet: null,
    complexity: 'normal',
    serving: 'normal',
  },
};

window.HashParams = {
  get() {
    const raw = location.hash.replace(/^#/, '');
    const params = {};
    for (const part of raw.split('&')) {
      const [k, v] = part.split('=');
      if (k) params[k] = decodeURIComponent(v || '');
    }
    return params;
  },

  set(key, value) {
    const params = this.get();
    if (value == null || value === '' || value === false) {
      delete params[key];
    } else {
      params[key] = value;
    }
    const hash = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
  },

  clear() {
    history.replaceState(null, '', location.pathname);
  },
};

(async function init() {
  // Signed in automatically via the platform iframe token — no login page.
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      App.currentUser = data.user;
      App.llm = data.llm || { enabled: true, mode: 'unknown' };

      const usernameEl = document.getElementById('username-display');
      if (usernameEl && data.user.username) {
        usernameEl.textContent = data.user.username;
      }

      if (data.user.preferences) {
        const tempUnit = data.user.preferences.tempUnit === 'F' ? 'F' : 'C';
        App.preferences = {
          diet: data.user.preferences.diet || null,
          complexity: data.user.preferences.complexity || 'normal',
          serving: data.user.preferences.serving || 'normal',
          tempUnit,
        };
        if (typeof Recipe !== 'undefined') {
          Recipe.useCelsius = tempUnit !== 'F';
        }
      }

      if (App.llm && !App.llm.enabled) {
        const input = document.getElementById('chat-input');
        const sendBtn = document.getElementById('send-btn');
        if (input) {
          input.disabled = true;
          input.placeholder = 'AI is unavailable in this environment (staging previews have no AI access).';
        }
        if (sendBtn) sendBtn.disabled = true;
      }
    } else {
      console.warn('[app] Not authenticated — open this app inside Usernode');
    }
  } catch (e) {
    console.warn('[app] Failed to load user', e);
  }

  setupSidebar();
  setupMobileTabs();
  setupPreferences();
  const prefEl = document.getElementById('preferences');
  if (prefEl) prefEl.classList.remove('hidden');
  setupDarkMode();
  setupNewConversation();
  setupTextareaResize();
  setupPanelResize();
  setupChatToggle();

  const hp = HashParams.get();
  if (hp.c && typeof Sidebar !== 'undefined') {
    Sidebar.selectConversation(parseInt(hp.c), { restore: true });
  }
})();

function setupSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  const overlay = document.getElementById('sidebar-overlay');

  function closeSidebar(updateHash) {
    sidebar.classList.remove('sidebar-open');
    sidebar.classList.add('sidebar-closed');
    overlay.classList.add('hidden');
    if (updateHash !== false) HashParams.set('sb', '0');
  }

  function openSidebar(updateHash) {
    sidebar.classList.remove('sidebar-closed');
    sidebar.classList.add('sidebar-open');
    if (window.innerWidth < 1024) {
      overlay.classList.remove('hidden');
    }
    if (updateHash !== false) HashParams.set('sb', null);
  }

  toggle.addEventListener('click', () => {
    if (sidebar.classList.contains('sidebar-open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  overlay.addEventListener('click', closeSidebar);

  if (!sidebar.classList.contains('sidebar-open') && !sidebar.classList.contains('sidebar-closed')) {
    const hp = HashParams.get();
    if (window.innerWidth < 1024 || hp.sb === '0') {
      closeSidebar(false);
    }
  }
}

function setupMobileTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const recipePanel = document.getElementById('recipe-panel');
  const chatPanel = document.getElementById('chat-panel');

  function setTab(tab) {
    tabs.forEach((t) => {
      const active = t.dataset.tab === tab;
      t.classList.toggle('bg-zinc-300', active);
      t.classList.toggle('dark:bg-zinc-700', active);
      t.classList.toggle('text-zinc-900', active);
      t.classList.toggle('dark:text-white', active);
      t.classList.toggle('text-zinc-500', !active);
      t.classList.toggle('dark:text-zinc-400', !active);
    });

    if (window.innerWidth < 1024) {
      recipePanel.classList.toggle('panel-hidden', tab !== 'recipe');
      chatPanel.classList.toggle('panel-hidden', tab !== 'chat');
    }
  }

  tabs.forEach((t) => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  if (window.innerWidth < 1024) {
    setTab('chat');
  }
}

let _prefSaveTimer;
function savePreferences() {
  clearTimeout(_prefSaveTimer);
  _prefSaveTimer = setTimeout(() => {
    fetch('/api/auth/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(App.preferences),
    }).catch(() => {});
  }, 500);
}

function setupPreferences() {
  document.querySelectorAll('.pref-btn').forEach((btn) => {
    const group = btn.dataset.pref;
    const value = btn.dataset.value;

    const isActive =
      (group === 'diet' && App.preferences.diet === value) ||
      (group === 'complexity' && (App.preferences.complexity || 'normal') === value) ||
      (group === 'serving' && (App.preferences.serving || 'normal') === value);
    if (isActive) btn.classList.add('active');

    btn.addEventListener('click', () => {
      if (group === 'diet') {
        if (App.preferences.diet === value) {
          App.preferences.diet = null;
          btn.classList.remove('active');
        } else {
          document
            .querySelectorAll(`[data-pref="diet"]`)
            .forEach((b) => b.classList.remove('active'));
          App.preferences.diet = value;
          btn.classList.add('active');
        }
      } else if (group === 'complexity') {
        document
          .querySelectorAll(`[data-pref="complexity"]`)
          .forEach((b) => b.classList.remove('active'));
        App.preferences.complexity = value;
        btn.classList.add('active');
      } else if (group === 'serving') {
        document
          .querySelectorAll(`[data-pref="serving"]`)
          .forEach((b) => b.classList.remove('active'));
        App.preferences.serving = value;
        btn.classList.add('active');
      }

      savePreferences();
    });
  });
}

function setupNewConversation() {
  document.getElementById('new-conversation-btn').addEventListener('click', () => {
    App.currentConversationId = null;
    App.currentRecipe = null;
    App.pendingRecipe = null;
    HashParams.clear();
    if (typeof Chat !== 'undefined') Chat.clear();
    document.getElementById('recipe-display')?.classList.add('hidden');
    document.getElementById('recipe-empty')?.classList.remove('hidden');
    document.querySelectorAll('.conversation-item').forEach((el) => el.classList.remove('active'));
    document.getElementById('chat-input')?.focus();
  });
}

function setupDarkMode() {
  const toggle = document.getElementById('dark-mode-toggle');
  toggle.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.theme = isDark ? 'dark' : 'light';
  });
}

function setupTextareaResize() {
  const textarea = document.getElementById('chat-input');
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  });
}

function setupPanelResize() {
  const divider = document.getElementById('panel-divider');
  const chatPanel = document.getElementById('chat-panel');
  if (!divider || !chatPanel) return;

  const saved = localStorage.getItem('chatPanelWidth');
  if (saved && chatPanel.classList.contains('chat-open')) {
    chatPanel.style.width = saved + 'px';
  }

  let dragging = false;

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    chatPanel.classList.remove('chat-ready');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const containerRight = chatPanel.parentElement.getBoundingClientRect().right;
    const width = Math.max(280, Math.min(800, containerRight - e.clientX));
    chatPanel.style.width = width + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    chatPanel.classList.add('chat-ready');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('chatPanelWidth', parseInt(chatPanel.style.width));
  });
}

function setupChatToggle() {
  const toggle = document.getElementById('chat-toggle');
  const chatPanel = document.getElementById('chat-panel');
  const divider = document.getElementById('panel-divider');
  if (!toggle || !chatPanel) return;

  let chatOpen = chatPanel.classList.contains('chat-open');

  function closeChat() {
    chatOpen = false;
    chatPanel.classList.remove('chat-open');
    chatPanel.classList.add('chat-closed');
    chatPanel.style.width = '';
    if (divider) divider.style.display = 'none';
    HashParams.set('ch', '0');
  }

  function openChat() {
    chatOpen = true;
    chatPanel.classList.remove('chat-closed');
    chatPanel.classList.add('chat-open');
    const saved = localStorage.getItem('chatPanelWidth');
    chatPanel.style.width = saved ? saved + 'px' : '';
    if (divider) divider.style.display = '';
    HashParams.set('ch', null);
  }

  toggle.addEventListener('click', () => {
    if (chatOpen) closeChat();
    else openChat();
  });
}
