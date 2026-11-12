'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SUPPORTED, resolveLanguage, createTranslator } = require('../src/locales/translate');

const locales = Object.fromEntries(SUPPORTED.map((c) => [c, require(`../src/locales/${c}`)]));
const reference = locales.fr;
const variables = (value) => {
  const text = typeof value === 'object' ? Object.values(value).join(' ') : String(value);
  return [...new Set(text.match(/\{\w+\}/g) || [])].sort();
};

for (const code of SUPPORTED.filter((c) => c !== 'fr')) {
  test(`${code} : mêmes clés et mêmes variables que le français`, () => {
    const dict = locales[code];
    assert.deepStrictEqual(Object.keys(reference).filter((k) => !(k in dict)), [], 'clés manquantes');
    assert.deepStrictEqual(Object.keys(dict).filter((k) => !(k in reference)), [], 'clés en trop');
    for (const key of Object.keys(reference)) {
      assert.deepStrictEqual(variables(dict[key]), variables(reference[key]), `variables de « ${key} »`);
    }
  });
}

test('resolveLanguage : préférence, langue du système, puis anglais', () => {
  assert.strictEqual(resolveLanguage('de', 'fr-FR'), 'de');
  assert.strictEqual(resolveLanguage('auto', 'ru-RU'), 'ru');
  assert.strictEqual(resolveLanguage(undefined, 'es_MX'), 'es');
  assert.strictEqual(resolveLanguage('auto', 'pt-BR'), 'en');
  assert.strictEqual(resolveLanguage('xx', ''), 'en');
});

test('pluriels russes et variables', () => {
  const t = createTranslator(locales, 'ru');
  assert.strictEqual(t('offline.launchWith', { n: 1 }), 'Запустить с 1 модом');
  assert.strictEqual(t('offline.launchWith', { n: 3 }), 'Запустить с 3 модами');
  assert.strictEqual(t('err.workshopPage', { id: '42', status: 404 }), 'Страница Мастерской недоступна для 42 (HTTP 404)');
  assert.strictEqual(t('cle.inconnue'), 'cle.inconnue');
});
