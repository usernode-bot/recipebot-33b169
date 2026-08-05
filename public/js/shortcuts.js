// Presented by the native kit (see js/dialogs.js) — backdrop tap, Escape and
// swipe-down dismissal all come from there, so this only owns open/close.
const ShortcutsModal = {
  el: null,
  handle: null,

  init() {
    this.el = document.getElementById('shortcuts-modal');
    document.getElementById('shortcuts-help-btn')?.addEventListener('click', () => this.toggle());
    document.getElementById('shortcuts-close')?.addEventListener('click', () => this.close());
  },

  open() {
    if (!this.el || this.handle) return;
    this.handle = Dialogs.present(this.el, {
      name: 'shortcuts',
      onDismiss: () => { this.handle = null; },
    });
  },

  toggle() {
    if (this.handle) this.close();
    else this.open();
  },

  close() {
    if (this.handle) this.handle.dismiss();
  },

  isOpen() {
    return !!this.handle;
  },
};

ShortcutsModal.init();

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const input = document.activeElement;
  const typing = input?.tagName === 'TEXTAREA' || input?.tagName === 'INPUT';

  // The kit owns Escape while a dialog is presented; '?' still toggles.
  if (ShortcutsModal.isOpen()) {
    if (e.key === '?' && !mod && !typing) ShortcutsModal.close();
    return;
  }

  if (e.key === '?' && !mod && !typing) {
    e.preventDefault();
    ShortcutsModal.toggle();
    return;
  }

  if (mod && e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('chat-form')?.requestSubmit();
    return;
  }

  if (mod && e.key === 'n') {
    e.preventDefault();
    document.getElementById('new-conversation-btn')?.click();
  }

  if (mod && e.key === 'p') {
    e.preventDefault();
    window.print();
  }

  if (e.key === 'Escape') {
    if (typeof CookingMode !== 'undefined' && CookingMode.active) {
      CookingMode.exit();
    }
  }
});
