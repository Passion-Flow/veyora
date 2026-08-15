/**
 * Locale registry.
 *
 * Adding a language = drop a catalog file into `locales/<tag>.json` following
 * the contract format (schema_version / locale / direction / messages) and
 * add one entry here. The i18n loader handles arbitrary BCP-47 tags and
 * always falls back to `en`, so partial catalogs are valid.
 */
export const LOCALES = Object.freeze([
  Object.freeze({ tag: 'en',    name: 'English',              dir: 'ltr' }),
  Object.freeze({ tag: 'zh-CN', name: '简体中文',              dir: 'ltr' }),
  Object.freeze({ tag: 'zh-TW', name: '繁體中文',              dir: 'ltr' }),
  Object.freeze({ tag: 'ja',    name: '日本語',                dir: 'ltr' }),
  Object.freeze({ tag: 'ko',    name: '한국어',                dir: 'ltr' }),
  Object.freeze({ tag: 'de',    name: 'Deutsch',              dir: 'ltr' }),
  Object.freeze({ tag: 'fr',    name: 'Français',             dir: 'ltr' }),
  Object.freeze({ tag: 'es',    name: 'Español',              dir: 'ltr' }),
  Object.freeze({ tag: 'ru',    name: 'Русский',              dir: 'ltr' }),
  Object.freeze({ tag: 'ar',    name: 'العربية',               dir: 'rtl' }),
]);

/** Source-of-truth locale: every key must exist here; others may partial. */
export const FALLBACK_LOCALE = 'en';

/** Resolve a registry entry, or null for an unknown tag. */
export function findLocale(tag) {
  return LOCALES.find(l => l.tag === tag) || null;
}

/** Build the lookup chain for a requested tag: exact → language → fallback. */
export function localeChain(tag) {
  const chain = [];
  const base = tag || FALLBACK_LOCALE;
  if (!chain.includes(base)) chain.push(base);
  const language = base.split('-')[0];
  if (language && !chain.includes(language)) chain.push(language);
  if (!chain.includes(FALLBACK_LOCALE)) chain.push(FALLBACK_LOCALE);
  return chain;
}

/** Pick the best supported locale from browser preferences. */
export function detectLocale() {
  const preferred = (navigator.languages && navigator.languages.length)
    ? navigator.languages
    : [navigator.language || FALLBACK_LOCALE];
  for (const candidate of preferred) {
    const exact = findLocale(candidate);
    if (exact) return exact.tag;
    const language = findLocale(candidate.split('-')[0]);
    if (language) return language.tag;
  }
  return FALLBACK_LOCALE;
}
