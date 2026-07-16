// User menu (header) + App settings modal with the per-user AI model picker.
// The model list comes from /api/auth/me (App.llm.models); the choice is
// saved immediately into the same preferences JSONB the recipe chips use.
// The menu also shows "AI usage today" — the platform's authoritative spend
// meter via usernode.getLlmUsage() when available, falling back to the app's
// local estimate (GET /api/usage/today) in staging/standalone/direct-key mode.
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
    if (!nowHidden) refreshUsage();
  });

  function fmtCents(cents) {
    if (cents > 0 && cents < 1) return '< $0.01';
    return '$' + (cents / 100).toFixed(2);
  }

  // The platform's authoritative per-app spend meter, via the bridge.
  // Read-only: never call requestLlmAccess() here — opening the menu must
  // not pop the consent dialog. No shell, an older bridge, a rejected
  // promise, or granted:false all mean "no authoritative data" → null.
  async function fetchLlmUsage() {
    if (typeof usernode === 'undefined' || !usernode.getLlmUsage) return null;
    try {
      const state = await usernode.getLlmUsage();
      if (state && state.granted && typeof state.spentCentsToday === 'number') {
        return state;
      }
      return null;
    } catch {
      return null;
    }
  }

  function renderMeter(cents, capCents, authoritative) {
    const amountEl = document.getElementById('usage-amount');
    const barEl = document.getElementById('usage-bar');
    const fillEl = document.getElementById('usage-bar-fill');
    const footnoteEl = document.getElementById('usage-footnote');

    amountEl.className = 'text-sm text-zinc-700 dark:text-zinc-200 mt-1 truncate';
    footnoteEl.textContent = authoritative
      ? 'Resets at midnight UTC'
      : 'Estimate · resets at midnight UTC';
    footnoteEl.classList.remove('hidden');

    const prefix = authoritative ? '' : '≈ ';
    if (capCents != null && capCents > 0) {
      amountEl.textContent = `${prefix}${fmtCents(cents)} of ${fmtCents(capCents)} used today`;
      const pct = Math.min(100, (cents / capCents) * 100);
      fillEl.style.width = pct + '%';
      fillEl.className =
        'h-full rounded-full transition-all ' +
        (pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-blue-500');
      barEl.classList.remove('hidden');
    } else {
      amountEl.textContent = `${prefix}${fmtCents(cents)} used today`;
      barEl.classList.add('hidden');
    }
  }

  async function refreshUsage() {
    const section = document.getElementById('usage-section');
    const amountEl = document.getElementById('usage-amount');
    const barEl = document.getElementById('usage-bar');
    const footnoteEl = document.getElementById('usage-footnote');
    if (!section || !amountEl) return;

    // Muted "…" placeholder while loading — no reflow on refresh.
    section.classList.remove('hidden');
    amountEl.textContent = '…';
    amountEl.className = 'text-sm text-zinc-400 dark:text-zinc-500 mt-1 truncate';
    barEl.classList.add('hidden');
    footnoteEl.classList.add('hidden');

    // Preferred source: the platform's own meter — the same numbers its
    // Settings panel shows, so no "≈".
    const platformUsage = await fetchLlmUsage();
    if (platformUsage) {
      renderMeter(platformUsage.spentCentsToday, platformUsage.dailyCapCents, true);
      return;
    }

    // Fallback: the app's local estimate (staging/standalone/direct-key
    // mode, older bridge, or no grant yet). Cap unknown here — the bridge
    // just failed us — so spend-only with the "≈" estimate marker.
    let usage;
    try {
      const res = await fetch('/api/usage/today');
      if (!res.ok) throw new Error('usage fetch failed');
      usage = await res.json();
    } catch {
      // Endpoint unreachable — hide the section; the menu still works.
      section.classList.add('hidden');
      return;
    }

    const cents = usage.estimatedCents || 0;

    // LLM disabled (staging/standalone) with nothing recorded: a muted line
    // instead of a $0.00 meter. With data (e.g. the staging demo row) the
    // spend still renders so testers can see the meter.
    if (usage.llm && !usage.llm.enabled && cents === 0) {
      amountEl.textContent = 'AI is unavailable in this environment';
      return;
    }

    renderMeter(cents, null, false);
  }

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
