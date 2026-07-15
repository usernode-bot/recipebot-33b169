const ShortcutsModal = {
  el: null,

  init() {
    this.el = document.getElementById('shortcuts-modal');
    document.getElementById('shortcuts-help-btn')?.addEventListener('click', () => this.toggle());
    document.getElementById('shortcuts-close')?.addEventListener('click', () => this.close());
    this.el?.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
  },

  toggle() {
    this.el?.classList.toggle('hidden');
  },

  close() {
    this.el?.classList.add('hidden');
  },

  isOpen() {
    return this.el && !this.el.classList.contains('hidden');
  },
};

ShortcutsModal.init();

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const input = document.activeElement;
  const typing = input?.tagName === 'TEXTAREA' || input?.tagName === 'INPUT';

  if (ShortcutsModal.isOpen()) {
    if (e.key === 'Escape') ShortcutsModal.close();
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
