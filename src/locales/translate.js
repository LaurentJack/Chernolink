/*
 * Traduction partagée par le processus principal (require) et l'interface (<script>).
 * Une valeur peut être une chaîne, ou un objet de formes plurielles
 * ({ one, few, many, other }) choisi selon {n} via Intl.PluralRules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.chernolinkTranslate = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const SUPPORTED = ['fr', 'en', 'de', 'es', 'ru'];
  const FALLBACK = 'en';

  /** 'auto' ou un code ; renvoie toujours une langue disponible. */
  function resolveLanguage(preference, systemLocale) {
    if (preference && preference !== 'auto' && SUPPORTED.includes(preference)) return preference;
    const sys = String(systemLocale || '').toLowerCase().split(/[-_]/)[0];
    return SUPPORTED.includes(sys) ? sys : FALLBACK;
  }

  function createTranslator(locales, lang) {
    const dict = locales[lang] || {};
    const fallback = locales[FALLBACK] || {};
    const reference = locales.fr || {};
    const plural = new Intl.PluralRules(lang);
    return function t(key, vars) {
      let value = dict[key] ?? fallback[key] ?? reference[key] ?? key;
      if (value && typeof value === 'object') {
        const n = vars && typeof vars.n === 'number' ? vars.n : 0;
        value = value[plural.select(n)] ?? value.other;
      }
      if (!vars) return value;
      return String(value).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    };
  }

  return { SUPPORTED, FALLBACK, resolveLanguage, createTranslator };
}));
