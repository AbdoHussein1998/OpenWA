// Everything the lazy locale split can break is runtime behaviour no build gate can see: the active
// catalogue has to be in place before anything renders, a language switch has to pull its catalogue
// in before components re-read it, and the direction flip that dresses Hebrew and Arabic has to
// survive both. Exercised against the real i18n module under the same JSDOM bootstrap the page
// render tests use, because the loader only exists at runtime — `locales.test.ts` deliberately reads
// this module as text and so can say nothing about any of it.
//
// Runner constraints honored here: loader hooks registered before any app-module import (see
// test-helpers/register-hooks), and JSDOM installed before importing a module that touches
// `document` and `localStorage` while it initializes.
import '../test-helpers/register-hooks.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

type I18nModule = typeof import('./index.ts');

let i18n: I18nModule['default'];

before(async () => {
  const { installJsdomGlobals } = (await import('../test-helpers/jsdom.ts')) as {
    installJsdomGlobals: typeof installJsdomGlobalsFn;
  };
  await installJsdomGlobals();
  const module = (await import('./index.ts')) as I18nModule;
  i18n = module.default;
  await module.i18nReady;
});

// If the catalogue were still in flight when this settles, `t` would hand back the raw key and the
// shell would paint it before swapping in real copy a tick later.
test('the detected catalogue is loaded by the time i18nReady settles', () => {
  assert.equal(i18n.t('sessionStatus.failed'), 'Failed');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(document.documentElement.dir, 'ltr');
});

// The whole reason the loader is an i18next backend rather than a hand-rolled fetch: i18next holds
// `languageChanged` until the catalogue has arrived. Reading the Arabic copy straight after the
// await is what proves that ordering — a half-loaded switch would answer with the English fallback.
test('switching language at runtime loads that catalogue before it resolves', async () => {
  await i18n.changeLanguage('ar');
  assert.equal(i18n.t('sessionStatus.failed'), 'فشل');

  await i18n.changeLanguage('de');
  assert.equal(i18n.t('sessionStatus.failed'), 'Fehlgeschlagen');
});

test('direction follows the language in both directions, for both RTL locales', async () => {
  await i18n.changeLanguage('he');
  assert.equal(document.documentElement.dir, 'rtl');
  assert.equal(document.documentElement.lang, 'he');

  await i18n.changeLanguage('ar');
  assert.equal(document.documentElement.dir, 'rtl');

  // Back to an LTR language: a direction that only ever gets set is a direction that sticks.
  await i18n.changeLanguage('en');
  assert.equal(document.documentElement.dir, 'ltr');
  assert.equal(document.documentElement.lang, 'en');
});

// The catalogue is fetched now instead of bundled, so first paint is only free of untranslated text
// while the entry keeps rendering behind that promise. Nothing in a build or a type check notices
// if the gate is dropped, and the flash it brings back is a tick long — easy to miss by hand.
test('main.tsx renders behind i18nReady', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.tsx'), 'utf8');
  assert.match(source, /i18nReady\.then\(/, 'main.tsx no longer defers the first render until the catalogue is loaded');
  assert.doesNotMatch(
    source,
    /^createRoot\(/m,
    'main.tsx calls createRoot at module scope again — the first paint no longer waits for the catalogue',
  );
});
