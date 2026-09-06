/**
 * Offline pending-write queue (ITEM-006, connected web scope).
 *
 * When the service cannot be reached, a save keeps its already-sealed record
 * DTO — ciphertext only, never plaintext or key material — in localStorage,
 * one list per vault salt. The queue is drained by recordSync.flushPending()
 * before any listing, so a reconnecting client replays its offline writes
 * before it reads. A queued write for a record replaces any earlier queued
 * write for the same record, so retries can never duplicate work.
 */

const KEY_PREFIX = 'veyora-pending-';

function storageKey(salt) {
  return KEY_PREFIX + (salt || 'default');
}

function readList(salt) {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(salt));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(item => item && item.record_id && item.dto) : [];
  } catch {
    return [];
  }
}

function writeList(salt, items) {
  try {
    globalThis.localStorage?.setItem(storageKey(salt), JSON.stringify(items));
  } catch {
    // Storage unavailable (quota/private mode): the queue degrades to empty
    // and offline saves report as unsaved rather than pretending to persist.
  }
}

export const pendingQueue = {
  /** All queued items for a vault, oldest first. */
  list(salt) {
    return readList(salt);
  },

  /** Queue a sealed DTO; replaces any earlier queued write for the record. */
  enqueue(salt, dto) {
    if (!dto || typeof dto.record_id !== 'string') return;
    const items = readList(salt).filter(item => item.record_id !== dto.record_id);
    items.push({ record_id: dto.record_id, enqueued_at: new Date().toISOString(), dto });
    writeList(salt, items);
  },

  /** Drop one queued record (after a successful replay, or a conflict). */
  remove(salt, recordId) {
    writeList(salt, readList(salt).filter(item => item.record_id !== recordId));
  },

  /** Record ids still waiting to sync, for status badges and panels. */
  pendingIds(salt) {
    return readList(salt).map(item => item.record_id);
  },

  /** Drop every queued write for a vault (local vault removal, DATA-009). */
  clear(salt) {
    writeList(salt, []);
  },
};
