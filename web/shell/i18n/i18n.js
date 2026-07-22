// GeneralsX Web - launch-screen localization.
//
// Uses the first supported browser language unless the player has explicitly
// selected one. This changes the web shell only; it never changes the game
// build or its language.
//
// GeneralsX @feature Lolendor 22/07/2026 Add Russian/English shell localization.

'use strict';

(() => {
  const STORAGE_KEY = 'gx-language';
  const SUPPORTED = ['ru', 'en'];

  function storedLanguage() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED.includes(value) ? value : null;
    } catch {
      return null;
    }
  }

  function browserLanguage() {
    const preferred = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || 'en'];
    for (const locale of preferred) {
      const language = String(locale).toLowerCase().split('-')[0];
      if (SUPPORTED.includes(language)) return language;
    }
    return 'en';
  }

  function interpolate(text, values) {
    return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(values || {}, key) ? values[key] : match);
  }

  const api = {
    language: storedLanguage() || browserLanguage(),

    t(key, values) {
      const current = window.gxLocales[this.language] || {};
      const fallback = window.gxLocales.en || {};
      return interpolate(current[key] ?? fallback[key] ?? key, values);
    },

    apply(root = document) {
      document.documentElement.lang = this.language === 'en' ? 'en-US' : 'ru-RU';
      root.querySelectorAll('[data-i18n]').forEach((element) => {
        element.textContent = this.t(element.dataset.i18n);
      });

      const switcher = document.getElementById('gx-language-switch');
      if (switcher) {
        const flag = document.getElementById('gx-language-flag');
        if (flag) flag.setAttribute('src', this.language === 'ru' ? 'i18n/flags/us.svg' : 'i18n/flags/ru.svg');
        switcher.title = this.t('language.switch');
        switcher.setAttribute('aria-label', this.t('language.switch'));
      }
    },

    setLanguage(language) {
      if (!SUPPORTED.includes(language) || language === this.language) return;
      this.language = language;
      try { localStorage.setItem(STORAGE_KEY, language); } catch {}
      this.apply();
      window.dispatchEvent(new CustomEvent('gxlanguagechange', { detail: { language } }));
    },

    toggle() {
      this.setLanguage(this.language === 'ru' ? 'en' : 'ru');
    },
  };

  window.gxI18n = api;
  api.apply();

  const switcher = document.getElementById('gx-language-switch');
  if (switcher) switcher.addEventListener('click', () => api.toggle());
})();
