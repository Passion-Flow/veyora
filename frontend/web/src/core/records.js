/**
 * Record synchronization: the bridge between the kernel and the records API.
 *
 * Every entry leaving this device is sealed through the kernel adapter
 * (XChaCha20-Poly1305 under an Argon2id-derived root key) and stored as
 * opaque ciphertext; every entry arriving is opened the same way. The API
 * only ever sees hex ciphertext, hashes, and revision metadata.
 */
import { API, PROTOCOL } from '../config.js';
import { kernel, toHex, fromHex } from './kernel.js';
import { vault } from './vault.js';

/** Fetch helper that normalizes API errors into Error objects with codes. */
async function apiFetch(path, options = {}) {
  let response;
  try {
    response = await fetch(API.baseUrl + path, options);
  } catch (cause) {
    const error = new Error('PM-NETWORK-UNREACHABLE', { cause });
    error.code = 'PM-NETWORK-UNREACHABLE';
    error.status = 0;
    throw error;
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const code = detail && detail.error ? detail.error.code : `HTTP-${response.status}`;
    const error = new Error(code);
    error.code = code;
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export const recordSync = {
  /** Root key for the unlocked session; null while locked. */
  rootKey: null,

  lock() {
    this.rootKey = null;
  },

  /**
   * Unlock: derive the root key from the master password, then fetch and
   * decrypt every live record. Decryption failure means the wrong password —
   * it surfaces as an error the entry flow maps to the unlock error state.
   */
  async unlock(password, saltHex) {
    this.rootKey = await kernel.deriveRootKey(password, saltHex);
    vault.entries = await this.fetchAll();
    return vault.entries;
  },

  /** Fetch summaries, then decrypt each live record. */
  async fetchAll() {
    const summaries = await apiFetch(API.paths.records);
    const entries = [];
    for (const summary of summaries) {
      if (summary.tombstone) continue;
      const dto = await apiFetch(`${API.paths.records}/${encodeURIComponent(summary.record_id)}`);
      entries.push(this.decrypt(dto));
    }
    return entries;
  },

  /** Server-visible record count (no decryption; safe pre-unlock). */
  async countRecords() {
    const summaries = await apiFetch(API.paths.records);
    return summaries.filter(summary => !summary.tombstone).length;
  },

  /** Decrypt one record DTO into a vault entry. */
  decrypt(dto) {
    const recordKey = kernel.deriveRecordKey(this.rootKey);
    const sealedWithNonce = fromHex(dto.ciphertext);
    const nonce = sealedWithNonce.slice(0, PROTOCOL.nonceLength);
    const sealed = sealedWithNonce.slice(PROTOCOL.nonceLength);
    const plaintextBytes = kernel.open(recordKey, nonce, sealed);
    const entry = JSON.parse(new TextDecoder().decode(plaintextBytes));
    entry.id = dto.record_id;
    entry.revision = dto.revision;
    return entry;
  },

  /** Strip session-only fields before encryption. */
  toPlaintext(entry) {
    const copy = { ...entry };
    delete copy.id;
    delete copy.revision;
    return copy;
  },

  /**
   * Seal an entry and store it. `expectedPriorRevision` enables the
   * compare-and-swap update path; omit it to create.
   * Mutates `entry.revision` to the server-assigned value.
   */
  async saveEntry(entry, expectedPriorRevision) {
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(this.toPlaintext(entry)));
    const recordKey = kernel.deriveRecordKey(this.rootKey);
    const nonce = kernel.generateNonce();
    const sealed = kernel.seal(recordKey, nonce, plaintextBytes);
    const sealedWithNonce = new Uint8Array(nonce.length + sealed.length);
    sealedWithNonce.set(nonce, 0);
    sealedWithNonce.set(sealed, nonce.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', sealedWithNonce));
    const identity = vault.meta ? vault.meta.salt : '';
    const body = {
      protocol_version: PROTOCOL.version,
      suite_id: PROTOCOL.suiteId,
      deployment_id: identity,
      vault_id: identity,
      record_id: entry.id,
      revision: (entry.revision || 0) + 1,
      ciphertext: toHex(sealedWithNonce),
      ciphertext_hash: toHex(digest),
      ciphertext_length: sealed.length,
      tombstone: false,
      template_envelope_hash: PROTOCOL.zeroHash,
      manifest_binding: PROTOCOL.zeroHash,
    };
    if (expectedPriorRevision !== undefined) {
      body.expected_prior_revision = expectedPriorRevision;
    }
    const result = await apiFetch(`${API.paths.records}/${encodeURIComponent(entry.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    entry.revision = result.revision;
    return entry;
  },

  /** Tombstone a record (soft delete) via the CAS path. */
  async tombstone(id, expectedPriorRevision) {
    return apiFetch(`${API.paths.records}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_prior_revision: expectedPriorRevision }),
    });
  },
};
