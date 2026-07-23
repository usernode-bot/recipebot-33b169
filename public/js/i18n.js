// Tiny hand-rolled i18n runtime (no build step, no library).
// Locale dictionaries live in /js/locales/<code>.js and register themselves
// via I18N.register(). English is the source of truth: a key missing from
// the active dictionary falls back to the English string.
//
// The language is NOT an in-app setting: it follows the platform-level user
// preference (usernode.getUserLocale() / the JWT locale claim — see app.js),
// falling back to the browser language, then English. localStorage.language
// is only a mirror of the last resolution, kept for anti-flash <html lang>.
(function () {
  // The dictionaries this app ships. The server keeps its own copy of the
  // codes (src/services/llm.js) for the AI prompt directive.
  const LANGS = [
    { code: 'en', native: 'English' },
    { code: 'es', native: 'Español' },
    { code: 'fr', native: 'Français' },
    { code: 'de', native: 'Deutsch' },
    { code: 'id', native: 'Bahasa Indonesia' },
  ];

  const dicts = {};

  const I18N = {
    LANGS,
    lang: 'en',

    register(code, dict) {
      dicts[code] = dict;
    },

    isSupported(code) {
      return LANGS.some((l) => l.code === code);
    },

    // Map a BCP-47 tag ("pt-BR", "id", "es-419") onto a shipped dictionary
    // by language-subtag prefix. Returns null when nothing matches (map,
    // don't match exactly — per the platform conventions).
    resolve(tag) {
      if (typeof tag !== 'string' || !tag) return null;
      const sub = tag.split('-')[0].toLowerCase();
      return I18N.isSupported(sub) ? sub : null;
    },

    t(key, params) {
      const active = dicts[I18N.lang] || {};
      const en = dicts.en || {};
      let str = active[key] != null ? active[key] : en[key];
      if (str == null) return key;
      if (params) {
        for (const k in params) {
          str = str.split('{' + k + '}').join(params[k]);
        }
      }
      return str;
    },

    // Plural helper: resolves `<key>_one` / `<key>_other` by count and
    // interpolates {n} alongside any extra params.
    tn(key, n, params) {
      const suffix = n === 1 ? '_one' : '_other';
      return I18N.t(key + suffix, Object.assign({ n }, params));
    },

    // Walk data-i18n* attributes and swap in the active language's strings.
    // The English text stays inline in the markup as the default render.
    apply(root) {
      root.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = I18N.t(el.dataset.i18n);
      });
      root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.placeholder = I18N.t(el.dataset.i18nPlaceholder);
      });
      root.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.title = I18N.t(el.dataset.i18nTitle);
      });
      root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
        el.setAttribute('aria-label', I18N.t(el.dataset.i18nAriaLabel));
      });
    },

    // Set the active language: mirror to localStorage (anti-flash cache for
    // the next load), update <html lang>, re-apply static markup, and notify
    // views so they can re-render dynamic content.
    set(code, opts) {
      if (!I18N.isSupported(code)) code = 'en';
      I18N.lang = code;
      try { localStorage.language = code; } catch { /* private mode */ }
      document.documentElement.lang = code;
      I18N.apply(document);
      if (!opts || !opts.silent) {
        document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: code } }));
      }
    },

    // Initial guess before the platform locale arrives (async, via the
    // bridge): last mirrored resolution, else the browser language, else
    // English. app.js corrects this to the platform truth once known.
    detect() {
      try {
        if (localStorage.language && I18N.isSupported(localStorage.language)) {
          return localStorage.language;
        }
      } catch { /* private mode */ }
      return I18N.resolve(navigator.language) || 'en';
    },

    init() {
      I18N.set(I18N.detect(), { silent: true });
    },
  };

  window.I18N = I18N;
  window.t = I18N.t;
  window.tn = I18N.tn;
})();
