/**
 * i18n core — catalog loading, fallback chains, message formatting.
 *
 * Catalog files follow the repository contract `contracts/i18n/catalog-v1`:
 *   { "schema_version": 1, "locale": "zh-CN", "direction": "ltr",
 *     "messages": {
 *       "key": { "text": "…" },
 *       "key.plural": { "plural": { "one": "…", "other": "…" } }
 *     } }
 *
 * Formatting supports `{var}` interpolation and an ICU plural subset:
 *   "{count, plural, one {# item} other {# items}}"
 * Plural categories are chosen with Intl.PluralRules for the active locale,
 * falling back to `other`. Dates and numbers format via Intl helpers below.
 */
import { localeChain, findLocale, FALLBACK_LOCALE } from './registry.js';

/** Re-exported for a single public i18n surface. */
export { detectLocale } from './registry.js';

const catalogs = new Map();
let currentLocale = FALLBACK_LOCALE;

/** Load one catalog, tolerant of missing files (partial coverage is valid). */
async function defaultLoadCatalog(tag) {
  try {
    const response = await fetch(`../../locales/${tag}.json`);
    if (response.ok) return await response.json();
  } catch {
    return null; // absent locale simply falls through the chain
  }
  return null;
}

/**
 * Activate a locale: loads its chain and applies document metadata.
 * `options.load` overrides the catalog source (used by the test suite).
 * Returns the tag actually activated.
 */
export async function setLocale(tag, { load = defaultLoadCatalog } = {}) {
  const chain = localeChain(tag);
  await Promise.all(chain.map(async (locale) => {
    catalogs.set(locale, await load(locale));
  }));
  const entry = findLocale(tag) || findLocale(chain[0]) || findLocale(FALLBACK_LOCALE);
  currentLocale = entry ? entry.tag : FALLBACK_LOCALE;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = currentLocale;
    document.documentElement.dir = (entry && entry.dir) || 'ltr';
  }
  return currentLocale;
}

export function getLocale() {
  return currentLocale;
}

/** Look a key up through the active chain; `en` is the terminal fallback. */
function resolve(key) {
  for (const tag of localeChain(currentLocale)) {
    const catalog = catalogs.get(tag);
    const message = catalog && catalog.messages && catalog.messages[key];
    if (message) return message;
  }
  return null;
}

/**
 * Translate a key. `params` supply `{var}` values. A `plural` message is
 * selected via `params.count` (or the first numeric param found).
 * Missing keys render their own key so gaps are visible in review.
 */
export function t(key, params) {
  const message = resolve(key);
  if (!message) return key;
  if (message.plural) {
    const count = params && (params.count ?? firstNumber(params));
    if (typeof count !== 'number') return key;
    const branch = selectPlural(message.plural, count);
    return formatPattern(branch, { ...params, count }).replace(/#/g, formatNumber(count));
  }
  return formatPattern(message.text || '', params || {});
}

function firstNumber(params) {
  for (const value of Object.values(params)) {
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function selectPlural(plural, count) {
  let category = 'other';
  try {
    category = new Intl.PluralRules(currentLocale).select(count);
  } catch {
    category = 'other';
  }
  return plural[category] ?? plural.other ?? '';
}

/**
 * Expand `{var}` and `{var, plural, cat {…} cat {…}}` inside a pattern.
 * `#` inside plural branches renders the count in the active locale.
 */
function formatPattern(pattern, params) {
  return pattern.replace(/\{(\w+)(,\s*plural,\s*((?:[^{}]|\{[^{}]*\})*))\}/g,
    (_, name, branches) => {
      const count = Number(params[name]);
      if (!Number.isFinite(count)) return '';
      return expandBranches(branches, count);
    })
    .replace(/\{(\w+)\}/g, (_, name) =>
      name in params ? String(params[name]) : '');
}

function expandBranches(branches, count) {
  const matches = branches.matchAll(/(\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g);
  const options = new Map();
  for (const m of matches) options.set(m[1], m[2]);
  let category = 'other';
  try {
    category = new Intl.PluralRules(currentLocale).select(count);
  } catch {
    category = 'other';
  }
  const branch = options.get(category) ?? options.get('other') ?? '';
  return branch.replace(/#/g, formatNumber(count));
}

/** Locale-aware number rendering. */
export function formatNumber(value) {
  try {
    return new Intl.NumberFormat(currentLocale).format(value);
  } catch {
    return String(value);
  }
}

/** Locale-aware short date ("Aug 14, 2026" style, per locale conventions). */
export function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat(currentLocale, {
      year: 'numeric', month: 'short', day: 'numeric',
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}
