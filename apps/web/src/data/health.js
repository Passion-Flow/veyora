/**
 * Password health analysis (client-side, zero-knowledge).
 *
 * Computes reuse and staleness across the decrypted vault. Nothing leaves
 * the browser; the server never sees the results.
 *
 * Basis:
 * - NIST SP 800-63B §5.1.1.2: verifiers shall reject secrets that are
 *   reused across subscriptions; in a zero-knowledge vault only the client
 *   can perform this comparison.
 * - NIST SP 800-63B §5.1.1.1: periodic rotation guidance (the standard no
 *   longer mandates arbitrary rotation, so staleness is reported as
 *   information rather than enforced).
 */

/** Days after which a password is considered stale for reporting. */
export const STALE_AFTER_DAYS = 180;

/**
 * @param {Array} entries decrypted vault entries
 * @returns {{ reusedIds: Set<string>, staleIds: Set<string>, ageDays: Map<string, number> }}
 */
export function analyzePasswordHealth(entries) {
  const secretToIds = new Map();
  for (const entry of entries) {
    if (!entry.secret) continue;
    const list = secretToIds.get(entry.secret) || [];
    list.push(entry.id);
    secretToIds.set(entry.secret, list);
  }
  const reusedIds = new Set();
  for (const ids of secretToIds.values()) {
    if (ids.length > 1) ids.forEach(id => reusedIds.add(id));
  }

  const staleIds = new Set();
  const ageDays = new Map();
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.updated) continue;
    const days = Math.floor((now - new Date(entry.updated).getTime()) / 86400000);
    ageDays.set(entry.id, days);
    if (days >= STALE_AFTER_DAYS) staleIds.add(entry.id);
  }
  return { reusedIds, staleIds, ageDays };
}

/** Human-readable age label for the detail view. */
export function ageLabel(days, formatNumber) {
  if (days < 1) return null;
  if (days < 30) return `${formatNumber(days)}d`;
  if (days < 365) return `${formatNumber(Math.floor(days / 30))}mo`;
  return `${formatNumber(Math.floor(days / 365))}y`;
}
