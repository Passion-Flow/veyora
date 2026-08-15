/**
 * i18n unit tests: negotiation chains, plural categories, interpolation,
 * and fallback behavior — driven through injected catalogs (no network).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { t, setLocale, formatDate, formatNumber } from '../src/i18n/index.js';

const CATALOGS = {
  en: {
    schema_version: 1, locale: 'en', direction: 'ltr',
    messages: {
      'app.name': { text: 'Veyora' },
      'table.count': { text: '{count, plural, one {# record} other {# records}}' },
      'toast.copied': { text: 'Copied · clears in {seconds}s' },
    },
  },
  ru: {
    schema_version: 1, locale: 'ru', direction: 'ltr',
    messages: {
      'table.count': {
        plural: { one: '# запись', few: '# записи', many: '# записей', other: '# записей' },
      },
    },
  },
  ar: {
    schema_version: 1, locale: 'ar', direction: 'rtl',
    messages: {
      'table.count': {
        plural: { zero: 'لا سجلات', one: 'سجل واحد', two: 'سجلان', few: '# سجلات', many: '# سجلًا', other: '# سجل' },
      },
    },
  },
};

const load = async tag => CATALOGS[tag] ?? null;

test('english plural selects one and other', async () => {
  await setLocale('en', { load });
  assert.equal(t('table.count', { count: 1 }), '1 record');
  assert.equal(t('table.count', { count: 5 }), '5 records');
});

test('russian plural covers one, few, and many', async () => {
  await setLocale('ru', { load });
  assert.equal(t('table.count', { count: 1 }), '1 запись');
  assert.equal(t('table.count', { count: 3 }), '3 записи');
  assert.equal(t('table.count', { count: 11 }), '11 записей');
  assert.equal(t('table.count', { count: 25 }), '25 записей');
});

test('arabic plural covers zero, one, two, few, and many', async () => {
  await setLocale('ar', { load });
  assert.equal(t('table.count', { count: 0 }), 'لا سجلات');
  assert.equal(t('table.count', { count: 1 }), 'سجل واحد');
  assert.equal(t('table.count', { count: 2 }), 'سجلان');
  assert.equal(t('table.count', { count: 7 }), '7 سجلات');
  assert.equal(t('table.count', { count: 100 }), '100 سجل');
});

test('missing keys fall back to english and then the key itself', async () => {
  await setLocale('ru', { load });
  assert.equal(t('app.name'), 'Veyora');          // not in ru → en chain
  assert.equal(t('totally.missing'), 'totally.missing');
});

test('interpolation substitutes named parameters', async () => {
  await setLocale('en', { load });
  assert.equal(t('toast.copied', { seconds: 30 }), 'Copied · clears in 30s');
});

test('unregistered locales fall back to the terminal chain', async () => {
  const activated = await setLocale('xx-YY', { load });
  assert.equal(activated, 'en');
  assert.equal(t('app.name'), 'Veyora');
});

test('dates and numbers format through Intl for the active locale', async () => {
  await setLocale('en', { load });
  assert.match(formatDate('2026-08-16T00:00:00Z'), /2026/);
  assert.equal(formatNumber(1234), '1,234');
});
