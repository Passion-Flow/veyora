/**
 * Record synchronization: the bridge between the kernel and the records API.
 *
 * Every entry leaving this device is sealed through the kernel adapter
 * (XChaCha20-Poly1305 under an Argon2id-derived root key) and stored as
 * opaque ciphertext; every entry arriving is opened the same way. The API
 * only ever sees hex ciphertext, hashes, and revision metadata.
 */
import { API, PROTOCOL } from '../config.js';
import { kernel, toHex, fromHex, randomHex } from './kernel.js';
import { vault } from './vault.js';
import { parseLoginCsv, typeFromTagsJson } from '../data/csv.js';

/**
 * Password verifier: a reserved record whose plaintext is a fixed constant.
 * Unlocking must decrypt it before anything else, so even an empty vault
 * rejects a wrong master password. Reserved ids never appear as entries.
 */
const VERIFIER_ID = 'veyora-verifier-v1';
const VERIFIER_PLAINTEXT = JSON.stringify({ purpose: 'verifier', check: VERIFIER_ID });

/** True for ids the vault reserves for protocol purposes. */
export function isReservedId(id) {
  return typeof id === 'string' && id.startsWith('veyora-');
}

/**
 * Restrict a server listing to this device's vault. Every sealed record
 * carries `vault_id` (= the vault salt); records left over from another
 * vault on the same store — e.g. after a vault reset that did not purge
 * the server — must never reach verification or decryption, or unlock
 * would fail against a foreign verifier.
 */
function ownVaultRecords(list) {
  const salt = vault.meta && vault.meta.salt;
  if (!salt) return list;
  return list.filter(dto => dto.vault_id === salt);
}

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

  /**
   * Hydrate the vault. Prefers the single-round-trip `?embed=bodies` fast
   * path when the server supports it, falling back to per-record GETs
   * against older APIs. Verification (verifier record / first live record)
   * runs before anything else so a wrong password fails fast.
   */
  async fetchAll() {
    const bodies = await apiFetch(`${API.paths.records}?embed=bodies`).catch(() => null);
    if (Array.isArray(bodies) && bodies.length > 0 && bodies[0].ciphertext !== undefined) {
      const own = ownVaultRecords(bodies);
      await this.verifyRootKey(own);
      return own
        .filter(dto => !dto.tombstone && !isReservedId(dto.record_id))
        .map(dto => this.decrypt(dto));
    }
    const summaries = await apiFetch(API.paths.records);
    await this.verifyRootKey(summaries);
    const live = summaries.filter(summary => !summary.tombstone && !isReservedId(summary.record_id));
    const dtos = await Promise.all(
      live.map(summary => apiFetch(`${API.paths.records}/${encodeURIComponent(summary.record_id)}`)),
    );
    // Summaries carry no vault_id — scope once the full DTOs are in hand.
    return ownVaultRecords(dtos).map(dto => this.decrypt(dto));
  },

  /**
   * Decrypt the verifier record; throws when the master password is wrong.
   * Vaults from before the verifier existed fall back to their first live
   * record; a vault with neither accepts any key (nothing to check against).
   * Candidates whose full DTO belongs to a foreign vault are skipped, so a
   * leftover foreign verifier can never lock this vault out.
   */
  async verifyRootKey(summaries) {
    const salt = vault.meta && vault.meta.salt;
    const candidates = [
      ...summaries.filter(summary => summary.record_id === VERIFIER_ID && !summary.tombstone),
      ...summaries.filter(summary => !summary.tombstone && !isReservedId(summary.record_id)),
    ];
    for (const candidate of candidates) {
      const dto = await apiFetch(`${API.paths.records}/${encodeURIComponent(candidate.record_id)}`);
      if (salt && dto.vault_id !== salt) continue;
      this.decrypt(dto);
      return true;
    }
    return true;
  },

  /** Store (or rotate) the password verifier under the active root key. */
  async ensureVerifier() {
    const dto = await this.sealAsDto(VERIFIER_ID, VERIFIER_PLAINTEXT, 1);
    await apiFetch(`${API.paths.records}/${encodeURIComponent(VERIFIER_ID)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
  },

  /**
   * Import a generic login CSV: parse + validate (all-or-nothing), encrypt
   * every row, and store through the batch endpoint. Returns the row count.
   */
  async importCsv(text) {
    const existingIds = vault.entries.map(entry => entry.id);
    const { rows } = parseLoginCsv(text, existingIds);
    const dtos = await Promise.all(rows.map((row, index) => {
      const plaintext = JSON.stringify({
        _imported: true, seq: index,
        name: row.name, website: row.website, username: row.username,
        secret: row.secret, notes: row.notes,
        type: typeFromTagsJson(row.tagsJson),
      });
      return this.sealAsDto(row.id, plaintext, 1);
    }));
    const results = await apiFetch(`${API.paths.records}/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dtos),
    });
    if (!results.every(result => result.ok)) {
      const failed = results.find(result => !result.ok);
      const error = new Error(failed.error || 'batch failed');
      error.code = failed.error || 'PM-STORE-CONFLICT';
      throw error;
    }
    vault.entries = await this.fetchAll();
    return rows.length;
  },

  /**
   * Change the master password: derive a key from the new password over a
   * fresh salt, verify the current password first, then re-seal the verifier
   * and every entry with compare-and-swap updates. A mid-flight failure
   * rolls back the records already re-keyed (re-sealed under the old key),
   * leaving the vault consistent under the old password.
   */
  async changeMasterPassword(currentPassword, nextPassword) {
    // 1. The current password must decrypt the verifier under the old salt.
    const oldRoot = await kernel.deriveRootKey(currentPassword, vault.meta.salt);
    const previousKey = this.rootKey;
    this.rootKey = oldRoot;
    try {
      await this.verifyRootKey(await apiFetch(API.paths.records));
    } finally {
      this.rootKey = previousKey;
    }

    // 2. Snapshot everything that must be re-keyed.
    const inventory = [];
    const summaries = await apiFetch(API.paths.records);
    for (const summary of summaries) {
      if (summary.tombstone) continue;
      const dto = await apiFetch(`${API.paths.records}/${encodeURIComponent(summary.record_id)}`);
      const isVerifier = summary.record_id === VERIFIER_ID;
      const plaintext = isVerifier
        ? VERIFIER_PLAINTEXT
        : JSON.stringify(this.toPlaintext(this.decrypt(dto)));
      inventory.push({ id: summary.record_id, revision: dto.revision, plaintext, isVerifier });
    }

    // 3. Re-key everything under the new salt; roll back on any failure.
    const nextSalt = randomHex(16);
    const nextRoot = await kernel.deriveRootKey(nextPassword, nextSalt);
    this.rootKey = nextRoot;
    const rekeyed = [];
    try {
      for (const item of inventory) {
        const dto = await this.sealAsDto(item.id, item.plaintext, item.revision + 1, item.revision);
        await apiFetch(`${API.paths.records}/${encodeURIComponent(item.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dto),
        });
        rekeyed.push(item);
      }
    } catch (error) {
      // Best-effort rollback: restore re-keyed records under the old key.
      this.rootKey = oldRoot;
      for (const item of rekeyed) {
        try {
          const dto = await this.sealAsDto(item.id, item.plaintext, item.revision + 2, item.revision + 1);
          await apiFetch(`${API.paths.records}/${encodeURIComponent(item.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dto),
          });
        } catch {
          // The rollback path itself failed; the vault may need the new
          // password for some records. Surface the original error.
        }
      }
      this.rootKey = previousKey;
      throw error;
    }

    // 4. Commit: persist the new salt and keep the session on the new key.
    vault.meta.salt = nextSalt;
    vault.persist();
    vault.entries = await this.fetchAll();
    return true;
  },

  /**
   * Fetch tombstoned entries for the trash view. Ciphertext is still on
   * the server; we decrypt it to show the name, and restoration re-PUTs
   * the same ciphertext with tombstone=false.
   */
  async fetchTrash() {
    const bodies = await apiFetch(`${API.paths.records}?embed=bodies`).catch(() => null);
    if (!Array.isArray(bodies)) return [];
    return ownVaultRecords(bodies)
      .filter(dto => dto.tombstone && !isReservedId(dto.record_id))
      .map(dto => {
        try {
          return this.decrypt(dto);
        } catch {
          return { id: dto.record_id, type: 'login', name: dto.record_id, secret: '', revision: dto.revision, _undecryptable: true };
        }
      });
  },

  /** Restore a tombstoned entry by re-PUTting with tombstone=false. */
  async restoreEntry(entry) {
    const dto = await apiFetch(`${API.paths.records}/${encodeURIComponent(entry.id)}`);
    dto.tombstone = false;
    dto.revision = dto.revision + 1;
    dto.expected_prior_revision = dto.revision - 1;
    const result = await apiFetch(`${API.paths.records}/${encodeURIComponent(entry.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    entry.revision = result.revision;
    return entry;
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
   * Seal an arbitrary plaintext string into a complete record DTO.
   * Async because the ciphertext hash uses WebCrypto.
   */
  async sealAsDto(id, plaintextString, revision, expectedPriorRevision) {
    const plaintextBytes = new TextEncoder().encode(plaintextString);
    const recordKey = kernel.deriveRecordKey(this.rootKey);
    const nonce = kernel.generateNonce();
    const sealed = kernel.seal(recordKey, nonce, plaintextBytes);
    const sealedWithNonce = new Uint8Array(nonce.length + sealed.length);
    sealedWithNonce.set(nonce, 0);
    sealedWithNonce.set(sealed, nonce.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', sealedWithNonce));
    const identity = vault.meta ? vault.meta.salt : '';
    const dto = {
      protocol_version: PROTOCOL.version,
      suite_id: PROTOCOL.suiteId,
      deployment_id: identity,
      vault_id: identity,
      record_id: id,
      revision,
      ciphertext: toHex(sealedWithNonce),
      ciphertext_hash: toHex(digest),
      ciphertext_length: sealed.length,
      tombstone: false,
      template_envelope_hash: PROTOCOL.zeroHash,
      manifest_binding: PROTOCOL.zeroHash,
    };
    if (expectedPriorRevision !== undefined) {
      dto.expected_prior_revision = expectedPriorRevision;
    }
    return dto;
  },

  /**
   * Seal an entry and store it. `expectedPriorRevision` enables the
   * compare-and-swap update path; omit it to create.
   * Mutates `entry.revision` to the server-assigned value.
   */
  async saveEntry(entry, expectedPriorRevision) {
    const body = await this.sealAsDto(
      entry.id,
      JSON.stringify(this.toPlaintext(entry)),
      (entry.revision || 0) + 1,
      expectedPriorRevision,
    );
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
