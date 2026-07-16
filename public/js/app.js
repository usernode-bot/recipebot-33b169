window.App = {
  currentUser: null,
  currentConversationId: null,
  currentRecipe: null,
  pendingRecipe: null,
  // Set while viewing a shared recipe read-only ({ id, username, avg_rating,
  // rating_count, current_version, currentData }); chatting from that state
  // auto-forks the recipe.
  viewingShared: null,
  // Set while viewing an old version of a shared recipe ({ version }).
  viewingVersion: null,
  currentView: 'chat',

  preferences: {
    diet: null,
    complexity: 'normal',
    serving: 'normal',
    model: null,
  },
};

// Toggle between the homepage feed and the chat + recipe layout.
App.showView = function (view) {
  App.currentView = view;
  const isHome = view === 'home';
  const homepage = document.getElementById('homepage');
  const recipePanel = document.getElementById('recipe-panel');
  const chatPanel = document.getElementById('chat-panel');
  const divider = document.getElementById('panel-divider');
  const tabs = document.getElementById('mobile-tabs');
  const backBtn = document.getElementById('home-btn');
  if (homepage) homepage.style.display = isHome ? 'block' : 'none';
  if (backBtn) backBtn.style.display = isHome ? 'none' : '';
  if (recipePanel) recipePanel.style.display = isHome ? 'none' : '';
  if (chatPanel) chatPanel.style.display = isHome ? 'none' : '';
  if (divider) {
    divider.style.display =
      isHome || (chatPanel && chatPanel.classList.contains('chat-closed')) ? 'none' : '';
  }
  if (tabs) tabs.style.display = isHome ? 'none' : '';
  if (isHome && typeof Home !== 'undefined') Home.refresh();
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
        const menuBtn = document.getElementById('user-menu-btn');
        if (menuBtn) {
          menuBtn.classList.remove('hidden');
          menuBtn.classList.add('inline-flex');
        }
      }

      if (data.user.preferences) {
        const tempUnit = data.user.preferences.tempUnit === 'F' ? 'F' : 'C';
        App.preferences = {
          diet: data.user.preferences.diet || null,
          complexity: data.user.preferences.complexity || 'normal',
          serving: data.user.preferences.serving || 'normal',
          tempUnit,
          // Effective model (saved choice validated server-side, else default)
          model: (data.llm && data.llm.model) || null,
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

  setupMobileTabs();
  setupPreferences();
  const prefEl = document.getElementById('preferences');
  if (prefEl) prefEl.classList.remove('hidden');
  setupDarkMode();
  setupNewConversation();
  setupHomeButton();
  setupTextareaResize();
  setupPanelResize();
  setupChatToggle();

  const hp = HashParams.get();
  if (hp.c && typeof Store !== 'undefined') {
    Store.selectConversation(parseInt(hp.c), { restore: true });
  } else {
    App.showView('home');
  }
})();

function setupHomeButton() {
  document.getElementById('home-btn')?.addEventListener('click', () => {
    HashParams.set('c', null);
    App.showView('home');
  });
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
    App.viewingShared = null;
    App.viewingVersion = null;
    App.showView('chat');
    HashParams.clear();
    if (typeof Chat !== 'undefined') Chat.clear();
    document.getElementById('recipe-display')?.classList.add('hidden');
    document.getElementById('recipe-empty')?.classList.remove('hidden');
    document.getElementById('chat-input')?.focus();
  });
}

// Three-state theme toggle: System → Light → Dark → System. The mode is
// stored in localStorage.theme ('light' | 'dark' | 'system'; missing key =
// system); the button icon reflects the selected mode, not the effective
// theme. In system mode the app follows the OS preference live.
function setupDarkMode() {
  const toggle = document.getElementById('dark-mode-toggle');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const ORDER = ['system', 'light', 'dark'];
  const LABELS = { system: 'System', light: 'Light', dark: 'Dark' };

  const getMode = () =>
    ORDER.includes(localStorage.theme) ? localStorage.theme : 'system';

  function apply() {
    const mode = getMode();
    const dark = mode === 'dark' || (mode === 'system' && media.matches);
    document.documentElement.classList.toggle('dark', dark);
    toggle.title = `Theme: ${LABELS[mode]}`;
    for (const m of ORDER) {
      const icon = document.getElementById(m === 'system' ? 'icon-system' : m === 'light' ? 'icon-sun' : 'icon-moon');
      if (icon) icon.classList.toggle('hidden', m !== mode);
    }
  }

  toggle.addEventListener('click', () => {
    const next = ORDER[(ORDER.indexOf(getMode()) + 1) % ORDER.length];
    localStorage.theme = next;
    apply();
  });

  media.addEventListener('change', () => {
    if (getMode() === 'system') apply();
  });

  apply();
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
