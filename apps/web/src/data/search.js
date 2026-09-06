/**
 * Local vault search (NAV-006).
 *
 * Search runs entirely on this device against decrypted entries already in
 * memory. SEARCH_FIELDS is the complete, documented match surface: the
 * query never leaves the client and is never sent to the service.
 */

/** Entry fields covered by search, in match order. `typeLabel` is the
 *  localized item-type name; it is the only derived field. */
export const SEARCH_FIELDS = Object.freeze([
  'name', 'username', 'website', 'service', 'host', 'notes', 'secret', 'typeLabel', 'tags',
]);

/** Build the lowercase haystack for one entry from the documented fields. */
export function entrySearchHaystack(entry, typeLabel) {
  return [
    entry.name, entry.username, entry.website, entry.service,
    entry.host, entry.notes, entry.secret, typeLabel,
    Array.isArray(entry.tags) ? entry.tags.join(' ') : entry.tags,
  ].filter(Boolean).join(' ').toLowerCase();
}

/** True when the entry matches the query across the documented fields. */
export function matchesQuery(entry, query, typeLabel) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return true;
  return entrySearchHaystack(entry, typeLabel).includes(needle);
}
