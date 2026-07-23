window.App = {
  currentUser: null,
  // True once boot establishes there is no signed-in user — the app then
  // runs in browse-only anonymous mode (public feed + public collections,
  // sign-in prompts on every ownership/AI action).
  isAnonymous: false,
  // Where accounts live; every sign-in prompt links here.
  PLATFORM_APP_URL: 'https://social-vibecoding.usernodelabs.org/#app/recipebot-33b169/full',
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
    language: 'en',
  },
};

// Activate the saved/detected language before anything renders (i18n.js and
// the locale dictionaries load before this file — see index.html).
if (typeof I18N !== 'undefined') {
  I18N.init();
  App.preferences.language = I18N.lang;
}

// Central language switch: updates the UI immediately, persists to
// localStorage (via I18N.set) and — when signed in — to the account
// preferences, same as the diet/units/model chips.
App.setLanguage = function (code) {
  if (typeof I18N === 'undefined' || !I18N.isSupported(code)) return;
  if (code === I18N.lang) return;
  I18N.set(code);
  App.preferences.language = code;
  if (!App.isAnonymous && App.currentUser) savePreferences();
};

// Re-render dynamic views when the language changes. Static markup is
// re-applied by I18N.set itself; this covers JS-built content.
document.addEventListener('i18n:change', () => {
  if (App.currentView === 'home' && typeof Home !== 'undefined') Home.render();
  if (typeof Recipe !== 'undefined' && App.currentRecipe && !Recipe.diffMode &&
      App.currentView !== 'home' && !App.pendingRecipe) {
    Recipe.display(App.currentRecipe);
  }
  renderLanguageMenu();
});

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

// Anonymous mode: one dialog for every ownership/AI affordance. The reason
// line tells the visitor what signing in unlocks; the primary button opens
// the app inside Usernode where their account lives.
App.promptSignIn = function (reason) {
  const modal = document.getElementById('sign-in-modal');
  if (!modal) return;
  const reasonEl = document.getElementById('sign-in-reason');
  if (reasonEl) reasonEl.textContent = reason || t('signin.title');
  modal.classList.remove('hidden');
  const close = () => {
    modal.classList.add('hidden');
    document.getElementById('sign-in-cancel').onclick = null;
    document.getElementById('sign-in-backdrop').onclick = null;
  };
  document.getElementById('sign-in-cancel').onclick = close;
  document.getElementById('sign-in-backdrop').onclick = close;
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
  // app.js loads first (see the script tags in index.html) — wait for the
  // rest of the bundle (Store/Home/Chat/…) before booting. Without this,
  // the tokenless anonymous path runs synchronously and reaches
  // App.showView('home') before home.js has even loaded.
  if (document.readyState === 'loading') {
    await new Promise((resolve) =>
      document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }

  // Signed in automatically via the platform iframe token — no login page.
  // With no token at all we skip the probe (guaranteed 401) and go straight
  // to anonymous browse mode.
  try {
    const res = window.UsernodeAuth?.token
      ? await fetch('/api/auth/me')
      : { ok: false };
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
        // The account language wins over the device's localStorage choice
        // for signed-in users; the device value is then mirrored by I18N.set.
        const savedLang = (typeof I18N !== 'undefined' && I18N.isSupported(data.user.preferences.language))
          ? data.user.preferences.language
          : (typeof I18N !== 'undefined' ? I18N.lang : 'en');
        App.preferences = {
          diet: data.user.preferences.diet || null,
          complexity: data.user.preferences.complexity || 'normal',
          serving: data.user.preferences.serving || 'normal',
          tempUnit,
          // Effective model (saved choice validated server-side, else default)
          model: (data.llm && data.llm.model) || null,
          language: savedLang,
        };
        if (typeof I18N !== 'undefined' && savedLang !== I18N.lang) {
          I18N.set(savedLang);
        }
        if (typeof Recipe !== 'undefined') {
          Recipe.useCelsius = tempUnit !== 'F';
        }
      }

      if (App.llm && !App.llm.enabled) {
        const input = document.getElementById('chat-input');
        const sendBtn = document.getElementById('send-btn');
        if (input) {
          input.disabled = true;
          input.placeholder = t('chat.aiUnavailablePlaceholder');
          input.dataset.i18nPlaceholder = 'chat.aiUnavailablePlaceholder';
        }
        if (sendBtn) sendBtn.disabled = true;
      }
    } else {
      console.warn('[app] Not authenticated — running in anonymous browse mode');
    }
  } catch (e) {
    console.warn('[app] Failed to load user', e);
  }

  // No signed-in user → anonymous browse mode. Show the header Sign in
  // button and put the chat input into its sign-in-prompt state.
  App.isAnonymous = !App.currentUser;
  if (App.isAnonymous) {
    document.getElementById('sign-in-btn')?.classList.remove('hidden');
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    if (input) {
      input.disabled = true;
      input.placeholder = t('chat.signInPlaceholder');
      input.dataset.i18nPlaceholder = 'chat.signInPlaceholder';
    }
    if (sendBtn) sendBtn.disabled = true;
  }

  setupLanguageToggle();
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
  // ?c=<id> is a deep-link fallback for contexts that can't set a hash
  // (dapp.json test routes); the hash param wins when both are present.
  const query = new URLSearchParams(location.search);
  const queryC = query.get('c');
  // ?join=<token> / #join=<token> — group-cookbook invite link landing.
  const joinToken = hp.join || query.get('join');
  if (App.isAnonymous) {
    // Conversations are owner-scoped and joining needs an account —
    // anonymous deep links land on the browse homepage.
    App.showView('home');
    if (joinToken) {
      HashParams.set('join', null);
      App.promptSignIn(t('signin.joinCookbook'));
    }
  } else if (joinToken && typeof Home !== 'undefined') {
    App.showView('home');
    HashParams.set('join', null);
    Home.handleJoinToken(joinToken);
  } else if (hp.c && typeof Store !== 'undefined') {
    Store.selectConversation(parseInt(hp.c), { restore: true });
  } else if (queryC && typeof Store !== 'undefined') {
    Store.selectConversation(parseInt(queryC), { restore: true });
  } else {
    App.showView('home');
  }
})();

// Header globe dropdown: one row per supported language, shown in its own
// language, checkmark on the active one. Works signed-in and signed-out.
function renderLanguageMenu() {
  const menu = document.getElementById('language-menu');
  if (!menu || typeof I18N === 'undefined') return;
  menu.innerHTML = '';
  I18N.LANGS.forEach((l) => {
    const active = l.code === I18N.lang;
    const btn = document.createElement('button');
    btn.className =
      'w-full text-left px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex items-center justify-between gap-2 ' +
      (active ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-zinc-700 dark:text-zinc-200');
    btn.dataset.lang = l.code;
    const name = document.createElement('span');
    name.textContent = l.native;
    btn.appendChild(name);
    if (active) {
      const check = document.createElement('span');
      check.textContent = '✓';
      btn.appendChild(check);
    }
    btn.addEventListener('click', () => {
      menu.classList.add('hidden');
      document.getElementById('language-toggle')?.setAttribute('aria-expanded', 'false');
      App.setLanguage(l.code);
    });
    menu.appendChild(btn);
  });
}

function setupLanguageToggle() {
  const toggle = document.getElementById('language-toggle');
  const menu = document.getElementById('language-menu');
  if (!toggle || !menu) return;
  renderLanguageMenu();
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowHidden = menu.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!nowHidden));
  });
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (menu.contains(e.target) || toggle.contains(e.target)) return;
    menu.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
  });
}

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
    if (App.isAnonymous) return App.promptSignIn(t('signin.createRecipes'));
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

  const getMode = () =>
    ORDER.includes(localStorage.theme) ? localStorage.theme : 'system';

  function apply() {
    const mode = getMode();
    const dark = mode === 'dark' || (mode === 'system' && media.matches);
    document.documentElement.classList.toggle('dark', dark);
    toggle.title = t('theme.label', { mode: t(`theme.${mode}`) });
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

  // Keep the tooltip in the active language.
  document.addEventListener('i18n:change', apply);

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
