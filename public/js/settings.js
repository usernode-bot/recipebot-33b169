// User menu (header) + App settings modal with the per-user AI model picker.
// The model list comes from /api/auth/me (App.llm.models); the choice is
// saved immediately into the same preferences JSONB the recipe chips use.
(function () {
  const menuBtn = document.getElementById('user-menu-btn');
  const menu = document.getElementById('user-menu');
  const modal = document.getElementById('settings-modal');
  const optionsEl = document.getElementById('model-options');
  const statusEl = document.getElementById('settings-status');
  if (!menuBtn || !menu || !modal) return;

  function closeMenu() {
    menu.classList.add('hidden');
    menuBtn.setAttribute('aria-expanded', 'false');
  }

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowHidden = menu.classList.toggle('hidden');
    menuBtn.setAttribute('aria-expanded', String(!nowHidden));
  });

  document.addEventListener('click', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (menu.contains(e.target) || menuBtn.contains(e.target)) return;
    closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();
    if (!modal.classList.contains('hidden')) showModal(false);
  });

  document.getElementById('open-settings').addEventListener('click', () => {
    closeMenu();
    showModal(true);
  });
  document.getElementById('settings-close').addEventListener('click', () => showModal(false));
  document.getElementById('settings-backdrop').addEventListener('click', () => showModal(false));

  function showModal(visible) {
    modal.classList.toggle('hidden', !visible);
    if (visible) {
      statusEl.classList.add('hidden');
      renderOptions();
    }
  }

  function currentModel() {
    if (App.preferences && App.preferences.model) return App.preferences.model;
    if (App.llm && App.llm.model) return App.llm.model;
    return 'claude-sonnet-5';
  }

  function renderOptions() {
    const models = (App.llm && App.llm.models) || [];
    const selected = currentModel();
    optionsEl.innerHTML = '';

    if (!models.length) {
      optionsEl.innerHTML = '<p class="text-sm text-zinc-500 dark:text-zinc-400">Model options unavailable — try reloading.</p>';
      return;
    }

    models.forEach((m) => {
      const active = m.id === selected;
      const btn = document.createElement('button');
      btn.dataset.model = m.id;
      btn.className =
        'w-full text-left rounded-lg border px-3 py-2 transition-colors ' +
        (active
          ? 'border-blue-500 ring-1 ring-blue-500 bg-blue-50 dark:bg-blue-500/10'
          : 'border-zinc-300 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500');
      btn.innerHTML =
        '<div class="flex items-center justify-between gap-2">' +
        '<span class="text-sm font-medium"></span>' +
        (active
          ? '<svg class="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>'
          : '') +
        '</div>' +
        '<p class="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5"></p>';
      btn.querySelector('span').textContent = m.label + (m.default ? ' (default)' : '');
      btn.querySelector('p').textContent = m.description || '';
      btn.addEventListener('click', () => selectModel(m.id));
      optionsEl.appendChild(btn);
    });
  }

  async function selectModel(id) {
    if (id === currentModel()) return;
    App.preferences.model = id;
    renderOptions();

    try {
      const res = await fetch('/api/auth/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(App.preferences),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showStatus(data.error || 'Failed to save', true);
        return;
      }
      showStatus('Saved — applies to your next message', false);
    } catch {
      showStatus('Network error — not saved', true);
    }
  }

  let _statusTimer;
  function showStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = 'text-sm mt-3 ' + (isError ? 'text-red-500' : 'text-green-500');
    statusEl.classList.remove('hidden');
    clearTimeout(_statusTimer);
    _statusTimer = setTimeout(() => statusEl.classList.add('hidden'), 3000);
  }
})();
