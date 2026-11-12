'use strict';

/** Traductions côté processus principal (et processus Workshop). */
const { SUPPORTED, resolveLanguage, createTranslator } = require('./locales/translate');

const locales = Object.fromEntries(SUPPORTED.map((code) => [code, require(`./locales/${code}`)]));

let current = 'fr';
let translator = createTranslator(locales, current);

function setLanguage(preference, systemLocale) {
  current = resolveLanguage(preference, systemLocale);
  translator = createTranslator(locales, current);
  return current;
}

module.exports = {
  t: (key, vars) => translator(key, vars),
  setLanguage,
  getLanguage: () => current,
  languages: SUPPORTED.map((code) => ({ code, name: locales[code]['lang.name'] })),
};
