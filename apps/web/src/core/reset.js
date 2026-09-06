/**
 * The destructive Reset matrix (PRD DATA-009).
 *
 * Every reset action names exactly one scope, deletes only that scope, and
 * never silently leaves an unreachable remote vault behind:
 *
 *   local metadata   — device preferences and diagnostics state; never
 *                      vault material or service data.
 *   connected cache  — the saved service URL/token overrides.
 *   local vault      — this device's vault material and queued writes. The
 *                      service copy keeps existing but becomes unreachable
 *                      from this device, so callers MUST name that
 *                      consequence in their confirmation copy.
 *   remote + local   — every record of this vault on the service is deleted
 *                      FIRST; only after the service confirms does the
 *                      local material go. Any failure leaves the device
 *                      untouched and the error surfaced.
 */
import { STORAGE_KEYS } from '../config.js';
import { storage } from './storage.js';
import { vault } from './vault.js';
import { pendingQueue } from './pending-queue.js';
import { recordSync } from './records.js';

/** Device-preference keys wiped by the local-metadata scope. */
const METADATA_KEYS = Object.freeze([
  STORAGE_KEYS.theme,
  STORAGE_KEYS.locale,
  STORAGE_KEYS.trashRetention,
  STORAGE_KEYS.startHere,
  STORAGE_KEYS.firstSuccess,
  STORAGE_KEYS.lastSync,
  'veyora.web.sort',
  'veyora.web.nav',
]);

/** Scope 1 — local metadata only. Vault and service data stay untouched. */
export function clearLocalMetadata() {
  for (const key of METADATA_KEYS) storage.remove(key);
}

/** Scope 2 — the saved service connection overrides. */
export function clearConnectedCache() {
  storage.remove(STORAGE_KEYS.apiUrl);
  storage.remove(STORAGE_KEYS.apiToken);
}

/**
 * Scope 3 — this vault's device material: queued offline writes and the
 * vault record itself (which carries the salt). The service copy survives
 * but is unreachable from this device without the salt; the confirmation
 * copy must say so before this runs.
 */
export function removeLocalVault() {
  const salt = vault.meta && vault.meta.salt;
  if (salt) pendingQueue.clear(salt);
  vault.reset();
}

/**
 * Scope 4 — remote first, then local (DATA-009's no-orphan guarantee).
 * Returns the service counts on success; throws with nothing local removed
 * when the service deletion fails for any reason.
 */
export async function deleteVaultEverywhere() {
  const result = await recordSync.deleteAllVaultRecords();
  removeLocalVault();
  return result;
}
