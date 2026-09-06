/**
 * Generic login CSV parsing (contract: contracts/interchange/generic-login-csv-v1).
 *
 * RFC-4180 dialect: comma-separated, double-quoted fields with `""`
 * escapes, LF or CRLF line endings. The contract rejects a BOM, duplicate
 * headers, and duplicate derived record ids; every row must carry a name
 * and a password. Parsing is all-or-nothing: any violation throws a
 * stable error code and nothing is imported.
 */
import { slugify } from './schema.js';

/** Stable error codes surfaced to the caller for localized messages. */
export const CSV_ERRORS = Object.freeze({
  bom: 'csv.bom',
  header: 'csv.header',
  row: 'csv.row',
  duplicateId: 'csv.duplicateId',
});

const EXPECTED_HEADER = Object.freeze(['name', 'website', 'username', 'password', 'notes', 'tags_json']);

/** Parse one RFC-4180 record starting at `index`; returns [fields, nextIndex]. */
function parseRecord(text, index) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  let i = index;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      fields.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      break;
    }
    field += ch;
    i += 1;
  }
  fields.push(field);
  return [fields, i + 1];
}

/** Split the document into non-empty raw records. */
function splitRecords(text) {
  const records = [];
  let index = 0;
  while (index < text.length) {
    const [fields, next] = parseRecord(text, index);
    const significant = fields.some(field => field.length > 0);
    if (significant || fields.length > 1) records.push(fields);
    index = next;
  }
  return records;
}

/**
 * Serialize vault entries back into the contract CSV format.
 *
 * Every entry type is preserved: the interchange columns carry login-shaped
 * data, and the entry type rides in `tags_json` (a JSON string array) so an
 * export can be re-imported losslessly.
 */
export function exportLoginCsv(entries) {
  const quote = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [EXPECTED_HEADER.join(',')];
  for (const entry of entries) {
    const tags = JSON.stringify(entry.type && entry.type !== 'login' ? [`type:${entry.type}`] : []);
    const columns = [
      entry.name,
      entry.website || '',
      entry.username || '',
      entry.secret || '',
      entry.notes || '',
      tags,
    ];
    lines.push(columns.map(quote).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Type carried through `tags_json`, or 'login' by default. */
export function typeFromTagsJson(tagsJson) {
  try {
    const tags = JSON.parse(tagsJson || '[]');
    const typed = Array.isArray(tags) ? tags.find(tag => typeof tag === 'string' && tag.startsWith('type:')) : null;
    return typed ? typed.slice('type:'.length) : 'login';
  } catch {
    return 'login';
  }
}
/**
 * Parse and validate a generic login CSV document.
 *
 * @param {string} text raw file contents
 * @param {Iterable<string>} existingIds record ids already in the vault
 * @returns {{rows: Array<{id,name,website,username,secret,notes}>}}
 * @throws {Error} with `code` from {@link CSV_ERRORS}
 */
export function parseLoginCsv(text, existingIds = []) {
  if (text.charCodeAt(0) === 0xFEFF) {
    throw Object.assign(new Error('byte order mark'), { code: CSV_ERRORS.bom });
  }
  const records = splitRecords(text);
  if (records.length === 0) {
    throw Object.assign(new Error('missing header'), { code: CSV_ERRORS.header });
  }
  const header = records[0];
  if (header.length !== EXPECTED_HEADER.length
      || header.some((column, i) => column !== EXPECTED_HEADER[i])) {
    throw Object.assign(new Error('unexpected header'), { code: CSV_ERRORS.header });
  }
  const seen = new Set(existingIds);
  const rows = [];
  for (let r = 1; r < records.length; r++) {
    const fields = records[r];
    if (fields.length !== EXPECTED_HEADER.length) {
      throw Object.assign(new Error(`row ${r} has ${fields.length} columns`), { code: CSV_ERRORS.row });
    }
    const [name, website, username, password, notes] = fields;
    if (!name || !password) {
      throw Object.assign(new Error(`row ${r} misses name or password`), { code: CSV_ERRORS.row });
    }
    const id = slugify(name);
    if (seen.has(id)) {
      throw Object.assign(new Error(`duplicate derived id ${id}`), { code: CSV_ERRORS.duplicateId });
    }
    seen.add(id);
    rows.push({ id, name, website, username, secret: password, notes, tagsJson: fields[5] });
  }
  return { rows };
}
