// Native-kit presentation layer (issue #39).
//
// Every dialog, menu, confirm, prompt and transient status in RecipeBot goes
// through here. The app keeps owning its CONTENT markup (ids, data-i18n
// attributes, listeners); the kit owns presentation, dismissal and motion:
//
//   Dialogs.present(contentEl, …)  → unNative.presentSheet / presentModal
//   Dialogs.menu(anchorEl, el, …)  → unNative.popover
//   UI.toast / UI.alert / UI.prompt / UI.confirmDestructive
//
// Two invariants worth knowing before editing:
//
//  1. Content elements live in index.html and are re-used. The kit MOVES the
//     node into its own layer, so every present() records a comment anchor
//     and puts the node back on dismiss — otherwise the kit would take the
//     element with it when it tears its container down.
//  2. `html[data-dialog="<name>"]` is set while something is presented. It is
//     the app-owned hook for the ?ui= screenshot deep links, the dapp.json
//     tests and print.css. Never assert on kit-internal class names.
//
// The kit is loaded from the platform CDN, so `window.unNative` can be absent
// (offline dev, a blocked CDN). Every entry point below falls back to a small
// app-rendered equivalent with identical semantics — the app must never lose a
// dialog because a third-party script didn't arrive.
(function () {
  const kit = () => (typeof unNative !== 'undefined' ? unNative : null);
  const isNarrow = () => window.matchMedia('(max-width: 639px)').matches;
  const label = (key, fallback) =>
    (typeof t === 'function' ? t(key) : null) || fallback;

  // ── Fallback chrome (only used when the kit didn't load) ──────────

  function fallbackLayer(className) {
    const backdrop = document.createElement('div');
    backdrop.className = 'rb-fallback-backdrop ' + (className || '');
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function fallbackPresent(contentEl, onDismiss) {
    const backdrop = fallbackLayer(isNarrow() ? 'rb-fallback-sheet' : '');
    const card = document.createElement('div');
    card.className = 'rb-fallback-card';
    card.appendChild(contentEl);
    backdrop.appendChild(card);

    const close = () => { cleanup(); onDismiss(); };
    const onBackdrop = (e) => { if (e.target === backdrop) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function cleanup() {
      backdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
    }
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    return { dismiss: () => { cleanup(); }, el: card };
  }

  function fallbackPopover(anchorEl, contentEl, onDismiss) {
    const wrap = document.createElement('div');
    wrap.className = 'rb-fallback-popover';
    wrap.appendChild(contentEl);
    document.body.appendChild(wrap);

    const rect = anchorEl.getBoundingClientRect();
    wrap.style.top = Math.round(rect.bottom + 4) + 'px';
    const width = wrap.offsetWidth || 220;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    wrap.style.left = Math.round(left) + 'px';

    const close = () => { cleanup(); onDismiss(); };
    const onDoc = (e) => {
      if (wrap.contains(e.target) || anchorEl.contains(e.target)) return;
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function cleanup() {
      document.removeEventListener('click', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
    }
    // Deferred so the click that opened the menu doesn't immediately close it.
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
    document.addEventListener('keydown', onKey, true);
    return { dismiss: () => { cleanup(); }, el: wrap };
  }

  // ── Dialogs ───────────────────────────────────────────────────────

  const Dialogs = {
    // The single presented dialog, if any. RecipeBot never stacks two.
    _current: null,
    // Restores queued behind a dismiss animation, keyed by element.
    _pending: new Map(),

    _flushPending(el) {
      const restore = this._pending.get(el);
      if (restore) restore();
    },

    // contentEl: an element living in index.html, `hidden` when idle.
    // opts: { name, onDismiss, dismissible, onPresent }
    present(contentEl, opts) {
      if (!contentEl) return null;
      opts = opts || {};
      const name = opts.name || 'dialog';

      if (this._current) this._current.dismiss();
      this._flushPending(contentEl);

      const home = document.createComment('un-dialog:' + name);
      if (contentEl.parentNode) contentEl.parentNode.insertBefore(home, contentEl);
      contentEl.classList.remove('hidden');
      document.documentElement.dataset.dialog = name;

      let closed = false;
      let handle = null;

      const restoreNode = () => {
        this._pending.delete(contentEl);
        contentEl.classList.add('hidden');
        if (home.parentNode) {
          home.parentNode.insertBefore(contentEl, home);
          home.parentNode.removeChild(home);
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        if (this._current === api) this._current = null;
        if (document.documentElement.dataset.dialog === name) {
          delete document.documentElement.dataset.dialog;
        }
        // Let the kit's dismissal animation run with the content still in
        // place; put the node back a beat later (flushed early if the same
        // dialog is re-opened before then).
        this._pending.set(contentEl, restoreNode);
        setTimeout(() => {
          if (this._pending.get(contentEl) === restoreNode) restoreNode();
        }, 260);
        if (opts.onDismiss) opts.onDismiss();
      };

      const api = {
        el: contentEl,
        dismiss() {
          if (closed) return;
          const h = handle;
          finish();
          if (h && h.dismiss) h.dismiss();
        },
      };

      const k = kit();
      if (k && (k.presentSheet || k.presentModal)) {
        const present = isNarrow() && k.presentSheet ? k.presentSheet : k.presentModal;
        handle = present.call(k, {
          contentEl,
          dismissible: opts.dismissible !== false,
          onDismiss: finish,
        });
      } else {
        handle = fallbackPresent(contentEl, finish);
      }

      this._current = api;
      if (opts.onPresent) opts.onPresent(contentEl);
      return api;
    },

    // Anchored menu (theme control, account menu, recipe export).
    menu(anchorEl, contentEl, opts) {
      if (!anchorEl || !contentEl) return null;
      opts = opts || {};
      const name = opts.name || 'menu';

      if (this._current) this._current.dismiss();
      this._flushPending(contentEl);

      const home = document.createComment('un-menu:' + name);
      if (contentEl.parentNode) contentEl.parentNode.insertBefore(home, contentEl);
      contentEl.classList.remove('hidden');
      document.documentElement.dataset.dialog = name;

      let closed = false;
      let handle = null;

      const restoreNode = () => {
        this._pending.delete(contentEl);
        contentEl.classList.add('hidden');
        if (home.parentNode) {
          home.parentNode.insertBefore(contentEl, home);
          home.parentNode.removeChild(home);
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        if (this._current === api) this._current = null;
        if (document.documentElement.dataset.dialog === name) {
          delete document.documentElement.dataset.dialog;
        }
        // Menus are instant (no animation), so the node goes straight back.
        restoreNode();
        if (opts.onDismiss) opts.onDismiss();
      };

      const api = {
        el: contentEl,
        dismiss() {
          if (closed) return;
          const h = handle;
          finish();
          if (h && h.dismiss) h.dismiss();
        },
      };

      const k = kit();
      if (k && k.popover) {
        handle = k.popover({
          anchorEl,
          contentEl,
          placement: opts.placement || 'bottom-end',
          onDismiss: finish,
        });
      } else {
        handle = fallbackPopover(anchorEl, contentEl, finish);
      }

      this._current = api;
      if (opts.onPresent) opts.onPresent(contentEl);
      return api;
    },

    dismiss() {
      if (this._current) this._current.dismiss();
    },
  };

  // ── Transient status + prompts ────────────────────────────────────

  let _fallbackToastTimer = null;

  const UI = {
    // Fire-and-forget confirmation ("Copied", "Saved", "Share failed").
    toast(message, opts) {
      if (!message) return;
      const k = kit();
      if (k && k.toast) return k.toast(message, opts || {});

      let el = document.getElementById('rb-fallback-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'rb-fallback-toast';
        el.className = 'rb-fallback-toast';
        document.body.appendChild(el);
      }
      el.textContent = message;
      el.classList.add('is-visible');
      clearTimeout(_fallbackToastTimer);
      _fallbackToastTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
      return { dismiss: () => el.classList.remove('is-visible'), el };
    },

    // Informational / two-button alert. Resolves true when the primary
    // (non-cancel) button was chosen.
    async alert({ title, message, okLabel, cancelLabel, destructive }) {
      const k = kit();
      const buttons = [];
      if (cancelLabel) buttons.push({ label: cancelLabel, style: 'cancel' });
      buttons.push({
        label: okLabel || label('common.ok', 'OK'),
        style: destructive ? 'destructive' : 'default',
        _ok: true,
      });

      if (k && k.alert) {
        const res = await k.alert({ title, message, buttons });
        return !!(res && res.button && res.button._ok);
      }
      if (!cancelLabel) {
        window.alert([title, message].filter(Boolean).join('\n\n'));
        return true;
      }
      return window.confirm([title, message].filter(Boolean).join('\n\n'));
    },

    // Single-field prompt. Resolves the trimmed string, or null when
    // cancelled / left empty.
    async prompt({ title, message, value, placeholder, okLabel }) {
      const k = kit();
      if (k && k.alert) {
        const res = await k.alert({
          title,
          message,
          field: { value: value || '', placeholder: placeholder || '' },
          buttons: [
            { label: label('common.cancel', 'Cancel'), style: 'cancel' },
            { label: okLabel || label('common.ok', 'OK'), style: 'default', _ok: true },
          ],
        });
        if (!res || !res.button || !res.button._ok) return null;
        const out = (res.value || '').trim();
        return out || null;
      }
      const out = window.prompt(title || '', value || '');
      return out && out.trim() ? out.trim() : null;
    },

    // Destructive confirmation — an action sheet with a red primary action.
    // Resolves true when confirmed.
    async confirmDestructive({ title, confirmLabel, destructive = true }) {
      const k = kit();
      if (k && k.actionSheet) {
        const chosen = await k.actionSheet({
          title,
          actions: [{
            label: confirmLabel || label('common.delete', 'Delete'),
            destructive,
            _ok: true,
          }],
          cancelLabel: label('common.cancel', 'Cancel'),
        });
        return !!(chosen && chosen._ok);
      }
      return window.confirm(title || '');
    },

    // Read-only value the user can copy by hand (clipboard API blocked).
    async showValue({ title, value }) {
      const k = kit();
      if (k && k.alert) {
        await k.alert({
          title,
          field: { value },
          buttons: [{ label: label('common.ok', 'OK'), style: 'default' }],
        });
        return;
      }
      window.prompt(title || '', value);
    },
  };

  window.Dialogs = Dialogs;
  window.UI = UI;
})();
