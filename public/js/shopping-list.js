// Shopping list detail view (replaces the homepage box, like a collection
// detail does). Owns fetching /api/shopping-list, rendering the grouped
// checklist and wiring check-off / remove / clear. Row markup reuses the
// recipe view's .ingredient-label / .ingredient-check checklist styles, and
// amounts are printed through Recipe.formatVolume so a list row looks
// exactly like a recipe row.
const ShoppingList = {
  // Mirrors Home.activeCollection: set while the detail is on screen.
  active: false,
  items: [],

  // Resolves true when the list actually opened; the boot restore path
  // clears the `list` param when it didn't (404, anonymous, fetch error).
  async open() {
    if (App.isAnonymous) return false;
    try {
      const res = await fetch('/api/shopping-list');
      if (!res.ok) return false;
      const data = await res.json();
      this.items = data.items || [];
      this.active = true;
      if (typeof Home !== 'undefined') Home.activeShoppingList = true;
      HashParams.set('list', '1');
      this.render();
      return true;
    } catch {
      return false;
    }
  },

  close() {
    this.active = false;
    if (typeof Home !== 'undefined') Home.activeShoppingList = false;
    HashParams.set('list', null);
    App.setSignInPath?.(null);
    if (typeof Home !== 'undefined') Home.render();
  },

  async refresh() {
    try {
      const res = await fetch('/api/shopping-list');
      if (res.ok) {
        const data = await res.json();
        this.items = data.items || [];
      }
    } catch { /* keep what we have */ }
    this.render();
  },

  render() {
    const view = document.getElementById('shopping-view');
    if (!view || !this.active) return;
    view.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'space-y-2 mb-5';
    const checked = this.items.filter((i) => i.checked).length;
    const count = this.items.length;
    head.innerHTML = `
      <a id="shopping-back" href="${App.deepLinkUrl(null)}" class="inline-block text-sm text-blue-500 hover:text-blue-400 transition-colors">${t('coll.back')}</a>
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <h2 class="text-xl font-bold">${this.escapeHtml(t('shop.title'))}</h2>
          <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-1">${this.escapeHtml(t('shop.progress', { checked, total: count }))}</p>
        </div>
        <div class="flex gap-2 flex-wrap" id="shopping-head-actions"></div>
      </div>`;
    view.appendChild(head);
    head.querySelector('#shopping-back').addEventListener('click', (e) => {
      if (App.wantsNewTab(e)) return;
      e.preventDefault();
      this.close();
    });

    const actions = head.querySelector('#shopping-head-actions');
    if (checked > 0) {
      const clearBtn = document.createElement('button');
      clearBtn.id = 'clear-checked';
      clearBtn.className = 'px-3 py-1.5 text-xs rounded-lg bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 transition-colors';
      clearBtn.textContent = t('shop.clearChecked');
      clearBtn.setAttribute('aria-label', t('shop.clearChecked'));
      clearBtn.addEventListener('click', async () => {
        await fetch('/api/shopping-list/clear-checked', { method: 'POST' }).catch(() => {});
        await this.refresh();
      });
      actions.appendChild(clearBtn);
    }

    if (!this.items.length) {
      const empty = document.createElement('p');
      empty.className = 'text-sm text-zinc-400 dark:text-zinc-600';
      empty.textContent = t('shop.empty');
      view.appendChild(empty);
      return;
    }

    // Group and order client-side from the flat payload so a future server
    // change cannot silently scramble the sections on screen.
    const groups = {};
    for (const cat of ['produce', 'dairy', 'meat', 'pantry', 'other']) groups[cat] = [];
    for (const item of this.items) {
      (groups[item.category] || groups.other).push(item);
    }

    for (const [cat, rows] of Object.entries(groups)) {
      if (!rows.length) continue;
      const done = rows.filter((r) => r.checked).length;
      const section = document.createElement('section');
      section.className = 'mb-5';
      const h = document.createElement('h3');
      h.className = 'text-base font-semibold mb-2 flex items-center gap-2';
      h.innerHTML = `<span>${this.escapeHtml(t('shop.cat_' + cat))}</span>
        <span class="text-xs font-normal text-zinc-400 dark:text-zinc-500 tabular-nums">${this.escapeHtml(t('shop.progress', { checked: done, total: rows.length }))}</span>`;
      section.appendChild(h);

      for (const item of rows) {
        section.appendChild(this.row(item));
      }
      view.appendChild(section);
    }
  },

  row(item) {
    const scale = 1; // amounts were scaled at add time; list rows show stored values
    const vol = item.volume_amount > 0 && item.volume_unit
      ? Recipe.formatVolume({ amount: item.volume_amount, unit: item.volume_unit }, scale)
      : '';
    const g = Math.round(item.grams);
    const amount = [g > 0 ? `${g}g` : '', vol].filter(Boolean).join(' · ');

    const label = document.createElement('label');
    label.className = 'ingredient-label flex items-center gap-2 py-1.5 cursor-pointer';
    label.innerHTML = `
      <input type="checkbox" class="ingredient-check" ${item.checked ? 'checked' : ''}>
      <span class="ing-name text-sm min-w-0 flex-1">${this.escapeHtml(item.name)}</span>
      ${amount ? `<span class="text-zinc-400 dark:text-zinc-500 tabular-nums text-xs whitespace-nowrap">${amount}</span>` : ''}
      ${item.recipe_title ? `<span class="text-xs text-zinc-400 dark:text-zinc-600 truncate hidden sm:block max-w-[12rem]">${this.escapeHtml(item.recipe_title)}</span>` : ''}
    `;
    label.querySelector('.ingredient-check').addEventListener('change', async (e) => {
      const checked = e.target.checked;
      await fetch(`/api/shopping-list/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked }),
      }).catch(() => {});
      item.checked = checked;
      this.render();
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-zinc-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0';
    removeBtn.title = this.escapeHtml(t('common.remove'));
    removeBtn.setAttribute('aria-label', `${t('common.remove')} ${item.name}`);
    removeBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="-2 -2 28 28"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
    removeBtn.addEventListener('click', async () => {
      await fetch(`/api/shopping-list/${item.id}`, { method: 'DELETE' }).catch(() => {});
      await this.refresh();
    });

    const wrap = document.createElement('div');
    wrap.className = 'flex items-center gap-2';
    wrap.appendChild(label);
    wrap.appendChild(removeBtn);
    return wrap;
  },

  escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
