/**
 * Locale catalog integrity checker.
 *
 * Validates every catalog under `locales/` against the `en` source of truth:
 *   1. JSON parses and follows the contract shape (schema_version / locale /
 *      direction / messages).
 *   2. Every key present in `en` exists in the catalog (partial coverage is
 *      allowed but reported so gaps are a deliberate decision).
 *   3. No keys unknown to `en` (usually typos after refactors).
 *   4. Placeholders `{name}` used by `en` also appear in the translation.
 *   5. Plural messages keep at least an `other` branch.
 *
 * Usage: node tools/check-locales.mjs   — exits non-zero on hard errors.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'locales');

function placeholdersOf(text) {
  const found = new Set();
  for (const match of String(text).matchAll(/\{(\w+)(?:,[^}]*)?\}/g)) {
    // Skip ICU plural branch internals like {count, plural, ...}; the outer
    // matcher already captured the variable name in those cases.
    found.add(match[1]);
  }
  return found;
}

function messageText(message) {
  if (typeof message.text === 'string') return message.text;
  if (message.plural) return Object.values(message.plural).join(' ');
  return '';
}

const files = (await readdir(localesDir)).filter(name => name.endsWith('.json')).sort();
if (files.length === 0) {
  console.error('FAIL: no catalogs found in', localesDir);
  process.exit(1);
}

const catalogs = new Map();
for (const file of files) {
  try {
    const catalog = JSON.parse(await readFile(join(localesDir, file), 'utf8'));
    catalogs.set(file, catalog);
  } catch (error) {
    console.error(`FAIL: ${file} does not parse: ${error.message}`);
    process.exitCode = 1;
  }
}

const reference = catalogs.get('en.json');
if (!reference) {
  console.error('FAIL: en.json (source of truth) is missing');
  process.exit(1);
}
const referenceKeys = Object.keys(reference.messages);

let hardErrors = 0;
for (const [file, catalog] of catalogs) {
  const problems = [];

  if (catalog.schema_version !== 1) problems.push(`schema_version is ${catalog.schema_version}, expected 1`);
  if (!catalog.locale) problems.push('missing "locale" field');
  if (!['ltr', 'rtl'].includes(catalog.direction)) problems.push(`invalid direction ${catalog.direction}`);
  if (!catalog.messages || typeof catalog.messages !== 'object') problems.push('missing "messages" object');

  if (!problems.length) {
    const keys = Object.keys(catalog.messages);
    for (const key of keys) {
      if (!reference.messages[key]) problems.push(`unknown key "${key}" (not in en.json)`);
      const message = catalog.messages[key];
      if (message.plural && !message.plural.other) {
        problems.push(`"${key}" plural message lacks an "other" branch`);
      }
      if (!message.text && !message.plural) {
        problems.push(`"${key}" has neither "text" nor "plural"`);
      }
    }
    for (const key of referenceKeys) {
      if (!(key in catalog.messages)) problems.push(`missing key "${key}" (falls back to en)`);
    }
    for (const key of referenceKeys) {
      const message = catalog.messages[key];
      if (!message) continue;
      const expected = placeholdersOf(messageText(reference.messages[key]));
      const actual = placeholdersOf(messageText(message));
      for (const name of expected) {
        if (!actual.has(name)) problems.push(`"${key}" lost placeholder {${name}}`);
      }
    }
  }

  const tag = `${catalog.locale || file} (${catalog.direction || '?'})`;
  if (problems.length) {
    const fatal = problems.some(p => !p.includes('falls back to en'));
    if (fatal) hardErrors += 1;
    console.log(`${fatal ? 'FAIL' : 'WARN'}  ${tag}`);
    for (const problem of problems) console.log(`      - ${problem}`);
  } else {
    console.log(`PASS  ${tag} — ${referenceKeys.length} keys, complete`);
  }
}

console.log(`\n${catalogs.size} catalogs checked against ${referenceKeys.length} source keys.`);
if (hardErrors) {
  console.error(`${hardErrors} catalog(s) failed.`);
  process.exit(1);
}
console.log('All catalogs structurally valid.');
