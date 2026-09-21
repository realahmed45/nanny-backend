import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCALE_CODES, resolveLocale, languageMenu, localeFromMenuChoice, isSupported,
} from '../src/utils/locales.js';

test('every promised language is offered', () => {
  // The list the business asked for, by the name it asked for them in.
  for (const code of ['en', 'id', 'es', 'pt', 'fr', 'de', 'ru', 'ar', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
    assert.ok(isSupported(code), `${code} should be supported`);
  }
  assert.equal(LOCALE_CODES.length, 12);
});

test('the picker lists every language in its own script', () => {
  const menu = languageMenu();
  assert.match(menu, /Español/);
  assert.match(menu, /العربية/);
  assert.match(menu, /简体中文/);
  assert.match(menu, /繁體中文/);
  assert.match(menu, /한국어/);
  // Numbered from 1, so a reply of "1" is unambiguous.
  assert.match(menu, /^1\. English/m);
});

test('a menu number picks the language it shows', () => {
  const menu = languageMenu().split('\n');
  menu.forEach((line, i) => {
    const picked = localeFromMenuChoice(String(i + 1));
    assert.equal(picked, LOCALE_CODES[i], `option ${i + 1} should map to ${LOCALE_CODES[i]}`);
  });
});

test('people can name a language instead of numbering it', () => {
  assert.equal(localeFromMenuChoice('Español'), 'es');
  assert.equal(localeFromMenuChoice('spanish'), 'es');
  assert.equal(localeFromMenuChoice('한국어'), 'ko');
  assert.equal(localeFromMenuChoice('Korean'), 'ko');
});

test('an unreadable answer is rejected rather than guessed', () => {
  assert.equal(localeFromMenuChoice('99'), null);
  assert.equal(localeFromMenuChoice('maybe'), null);
  assert.equal(localeFromMenuChoice(''), null);
});

test('a regional locale falls back to its base language', () => {
  assert.equal(resolveLocale('es-MX'), 'es');
  assert.equal(resolveLocale('pt-BR'), 'pt');
  // Unqualified Chinese is not readable as both, so it takes the larger one
  // rather than silently dropping to English.
  assert.equal(resolveLocale('zh'), 'zh-CN');
});

test('an unknown or missing locale becomes English, never undefined', () => {
  assert.equal(resolveLocale('klingon'), 'en');
  assert.equal(resolveLocale(null), 'en');
  assert.equal(resolveLocale(undefined), 'en');
});

/* ------------------------------------------------------------------ *
 * Translation guardrails
 *
 * A translation that scrambles a menu number or drops a placeholder is worse
 * than no translation: it routes people to the wrong option, or sends a
 * message with a blank where a name should be. Both fail to English instead.
 * ------------------------------------------------------------------ */

import { __test } from '../src/services/translate.js';

test('a translation that renumbers a menu is rejected', () => {
  const english = '1. Find a Nanny\n2. My Bookings\n3. Help';
  const good = '1. Buscar niñera\n2. Mis reservas\n3. Ayuda';
  const reordered = '2. Buscar niñera\n1. Mis reservas\n3. Ayuda';
  const dropped = '1. Buscar niñera\n2. Mis reservas';

  assert.equal(__test.menuNumbersIntact(english, good), true);
  assert.equal(__test.menuNumbersIntact(english, reordered), false);
  assert.equal(__test.menuNumbersIntact(english, dropped), false);
});

test('a translation that alters a placeholder is rejected', () => {
  const english = 'Hello {{name}}, your booking on {{date}} is confirmed.';
  const good = 'Hola {{name}}, su reserva del {{date}} está confirmada.';
  const translated = 'Hola {{nombre}}, su reserva del {{fecha}} está confirmada.';
  const missing = 'Hola, su reserva está confirmada.';

  assert.equal(__test.placeholdersIntact(english, good), true);
  assert.equal(__test.placeholdersIntact(english, translated), false);
  assert.equal(__test.placeholdersIntact(english, missing), false);
});
