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
import { markSynced } from '../data/diagnostics.js';
import { pendingQueue } from './pending-queue.js';
import { wraps } from './recovery.js';

/**
 * Password verifier: a reserved record whose plaintext is a fixed constant.
 * Unlocking must decrypt it before anything else, so even an empty vault
 * rejects a wrong master password. Reserved ids never appear as entries.
 * DATA-003: the verifier identity is scoped per vault (derived from the
 * salt) — one global fixed record id across all vaults is never used for
 * new writes; the pre-scoping id is read only to migrate legacy vaults.
 */
const VERIFIER_PREFIX = 'veyora-verifier-v1';
/** Pre-scoping verifier id: accepted for unlock, migrated on sight. */
const VERIFIER_LEGACY_ID = VERIFIER_PREFIX;
const VERIFIER_PLAINTEXT = JSON.stringify({ purpose: 'verifier', check: VERIFIER_PREFIX });

/** True for any verifier-family id (current scope, legacy, prior salts). */
function isVerifierId(id) {
  return typeof id === 'string' && id.startsWith(VERIFIER_PREFIX);
}

/** The verifier record id for a vault scope (its salt). */
function verifierRecordId(salt) {
  return salt ? `${VERIFIER_PREFIX}-${salt}` : VERIFIER_LEGACY_ID;
}

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

/**
 * Optional bearer token for token-auth deployments. Mirrors the
 * `veyora-api-url` override in config.js: an explicit localStorage value
 * (set by the desktop shell or power users) wins; absent means the
 * deployment runs without API authentication.
 */
function readApiToken() {
  try {
    return globalThis.localStorage?.getItem('veyora-api-token') ?? null;
  } catch {
    return null;
  }
}

/** Fetch helper that normalizes API errors into Error objects with codes. */
/**
 * The declared vault scope (DATA-002) for record reads, listings, and
 * deletions: `?vault=<salt>`. Until authenticated pairing principals exist
 * (ADR 0005, Proposed) the scope is client-declared, but the server now
 * enforces it on every query instead of returning global rows.
 */
function vaultQuery() {
  const salt = vault.meta && vault.meta.salt;
  return salt ? `vault=${encodeURIComponent(salt)}` : '';
}

function withVault(path) {
  const scope = vaultQuery();
  if (!scope) return path;
  return path.includes('?') ? `${path}&${scope}` : `${path}?${scope}`;
}

/** The vault-scoped form of `path` for an explicit scope (rekey probes). */
function withVaultScope(path, scope) {
  if (!scope) return path;
  const query = `vault=${encodeURIComponent(scope)}`;
  return path.includes('?') ? `${path}&${query}` : `${path}?${query}`;
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = readApiToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response;
  try {
    response = await fetch(API.baseUrl + path, { ...options, headers });
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

/**
 * Fetch every page of a bounded, paginated listing (DATA-006). The server
 * marks a possibly-truncated page with `x-truncated: true`; this helper
 * follows pages until the marker clears so large vaults hydrate fully.
 */
async function apiFetchAllPages(path) {
  const pageSize = 500; // the server's default and embed maximum
  const headers = new Headers();
  const token = readApiToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const rows = [];
  let offset = 0;
  // A hard cap keeps a pathological server from looping a client forever.
  for (let page = 0; page < 100; page++) {
    const separator = path.includes('?') ? '&' : '?';
    let response;
    try {
      response = await fetch(`${API.baseUrl + path}${separator}limit=${pageSize}&offset=${offset}`, { headers });
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
    const body = await response.json();
    rows.push(...body);
    if (response.headers.get('x-truncated') !== 'true') return rows;
    offset += body.length;
    if (body.length === 0) return rows;
  }
  const error = new Error('PM-API-BAD-QUERY');
  error.code = 'PM-API-BAD-QUERY';
  throw error;
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
    // Replay offline writes first so a reconnecting client reads a list that
    // already contains its own pending changes (ITEM-006).
    await this.flushPending();
    const bodies = await apiFetch(withVault(`${API.paths.records}?embed=bodies`)).catch(() => null);
    if (Array.isArray(bodies) && bodies.length > 0 && bodies[0].ciphertext !== undefined) {
      const own = ownVaultRecords(bodies);
      await this.verifyRootKey(own);
      const entries = own
        .filter(dto => !dto.tombstone && !isReservedId(dto.record_id))
        .map(dto => this.decrypt(dto));
      markSynced(); // Diagnostics: a bare timestamp, no content (DIAG-001)
      return entries;
    }
    const summaries = await apiFetchAllPages(withVault(API.paths.records));
    await this.verifyRootKey(summaries);
    const live = summaries.filter(summary => !summary.tombstone && !isReservedId(summary.record_id));
    const dtos = await Promise.all(
      live.map(summary => apiFetch(withVault(`${API.paths.records}/${encodeURIComponent(summary.record_id)}`))),
    );
    // Summaries carry no vault_id — scope once the full DTOs are in hand.
    markSynced();
    return ownVaultRecords(dtos).map(dto => this.decrypt(dto));
  },

  /**
   * Decrypt the verifier record; throws when the master password is wrong.
   * Vaults from before the verifier existed fall back to their first live
   * record; a vault with neither accepts any key (nothing to check against).
   * Candidates whose full DTO belongs to a foreign vault are skipped, so a
   * leftover foreign verifier can never lock this vault out.
   */
  async verifyRootKey(summaries, scopeHint) {
    const salt = scopeHint || (vault.meta && vault.meta.salt);
    const candidates = [
      ...summaries.filter(summary =>
        summary.record_id === verifierRecordId(salt) && !summary.tombstone),
      ...summaries.filter(summary =>
        summary.record_id === VERIFIER_LEGACY_ID && !summary.tombstone),
      ...summaries.filter(summary => !summary.tombstone && !isReservedId(summary.record_id)),
    ];
    for (const candidate of candidates) {
      const dto = await apiFetch(
        withVaultScope(`${API.paths.records}/${encodeURIComponent(candidate.record_id)}`, salt));
      if (salt && dto.vault_id !== salt) continue;
      this.decrypt(dto);
      // DATA-003: a vault still keyed to the global verifier id migrates to
      // its scoped id once the key proves out (idempotent, best-effort).
      if (salt && candidate.record_id === VERIFIER_LEGACY_ID) {
        await this.migrateLegacyVerifier();
      }
      return true;
    }
    return true;
  },

  /**
   * Move a legacy global-id verifier onto this vault's scoped id: write the
   * scoped record first, then tombstone the legacy row. A crash between the
   * two leaves both readable; unlock prefers the scoped id and retries the
   * migration on the next unlock. A 409 on the write means another device
   * already migrated — only the legacy cleanup remains.
   */
  async migrateLegacyVerifier() {
    const salt = vault.meta && vault.meta.salt;
    if (!salt || !this.rootKey) return;
    try {
      const dto = await this.sealAsDto(verifierRecordId(salt), VERIFIER_PLAINTEXT, 1);
      await apiFetch(withVault(`${API.paths.records}/${encodeURIComponent(verifierRecordId(salt))}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      });
    } catch {
      return; // already migrated, or transient — retried on the next unlock
    }
    try {
      const legacy = await apiFetch(withVault(`${API.paths.records}/${encodeURIComponent(VERIFIER_LEGACY_ID)}`));
      await this.tombstone(VERIFIER_LEGACY_ID, legacy.revision);
    } catch {
      // Already gone or raced; the scoped verifier governs from now on.
    }
  },

  /** Store (or rotate) the password verifier under the active root key. */
  async ensureVerifier() {
    const id = verifierRecordId(vault.meta && vault.meta.salt);
    const dto = await this.sealAsDto(id, VERIFIER_PLAINTEXT, 1);
    await apiFetch(withVault(`${API.paths.records}/${encodeURIComponent(id)}`), {
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
    // DATA-007/API-010: the batch is all-or-nothing — committed must equal
    // the requested row count or the whole import failed with nothing
    // applied (surfaced as the error envelope, never a partial success).
    if (results.committed !== results.requested || results.committed !== results.results.length) {
      const error = new Error('batch failed');
      error.code = 'PM-STORE-CONFLICT';
      throw error;
    }
    vault.entries = await this.fetchAll();
    return rows.length;
  },

  /**
   * Verify a master password against the stored verifier without touching
   * session state. Plaintext-export re-authentication (EXP-002) and any
   * future sensitive ceremony call this instead of re-implementing the
   * derive-and-decrypt check. Throws when the password is wrong; the
   * session root key is restored either way.
   */
  async verifyPassword(password) {
    // The proof is the password wrapper itself: the supplied password must
    // open it to the Vault Key that decrypts the verifier (wrapped model).
    const previousKey = this.rootKey;
    await this.unlockViaWrappers(password);
    this.rootKey = previousKey;
    return true;
  },

  /**
   * Change the master password atomically (server-side vault rekey).
   *
   * The current password must decrypt the old verifier; then every row of
   * the old scope (verifier included) is re-sealed under a fresh salt and
   * committed through POST /vault/rekey, which inserts the new scope and
   * deletes the old one in one storage transaction. A failure anywhere
   * leaves the server holding the intact old scope, so the old password
   * keeps working and nothing is orphaned.
   *
   * Crash safety: the device records a pending-rekey marker before the
   * request and clears it after adoption; `resolvePendingRekey` lets the
   * next unlock find a committed new scope or prove it never committed.
   * Offline queued writes are refused up front — sealed under the old key,
   * they could never be delivered after the rekey.
   */
  async changeMasterPassword(currentPassword, nextPassword) {
    const fromSalt = vault.meta && vault.meta.salt;
    if (!fromSalt) throw new Error('PM-CLIENT-NO-VAULT');
    if (pendingQueue.pendingIds(fromSalt).length > 0) {
      const error = new Error('PM-CLIENT-PENDING-WRITES');
      error.code = 'PM-CLIENT-PENDING-WRITES';
      throw error;
    }

    // Wrapped vaults (every vault after its first post-wrap unlock): the
    // Vault Key never changes, so a password change replaces ONLY the
    // password wrapper — no record is touched and the Recovery Key keeps
    // working unchanged (REC-005).
    if (await this.hasPasswordWrap()) {
      const previousKey = this.rootKey;
      // Prove the current password against the existing wrapper first.
      await this.unlockViaWrappers(currentPassword);
      const vaultKey = this.rootKey;
      await this.ensureWrappers(vaultKey, nextPassword);
      this.rootKey = previousKey === null ? vaultKey : previousKey;
      return undefined; // no rows moved — only the wrapper was replaced
    }

    // 1. The current password must decrypt the verifier under the old salt.
    const oldRoot = await kernel.deriveRootKey(currentPassword, fromSalt);
    const previousKey = this.rootKey;
    this.rootKey = oldRoot;
    try {
      await this.verifyRootKey(await apiFetchAllPages(withVault(API.paths.records)));
    } finally {
      this.rootKey = previousKey;
    }

    // 2. Snapshot every old-scope row as plaintext (verifier included).
    const summaries = await apiFetchAllPages(withVault(API.paths.records));
    const inventory = [];
    for (const summary of summaries) {
      const dto = await apiFetch(withVault(`${API.paths.records}/${encodeURIComponent(summary.record_id)}`));
      const plaintext = isVerifierId(summary.record_id)
        ? VERIFIER_PLAINTEXT
        : JSON.stringify(this.toPlaintext(this.decrypt(dto)));
      inventory.push({ id: summary.record_id, plaintext, tombstone: summary.tombstone });
    }

    // 3. Seal everything for the fresh salt; the verifier's identity moves
    //    to the new scope's derived id.
    const nextSalt = randomHex(16);
    const nextRoot = await kernel.deriveRootKey(nextPassword, nextSalt);
    const nextVerifier = verifierRecordId(nextSalt);
    this.rootKey = nextRoot;
    const rows = [];
    for (const item of inventory) {
      const id = isVerifierId(item.id) ? nextVerifier : item.id;
      const dto = await this.sealForScope(id, item.plaintext, 1, nextSalt);
      // Trash state travels with the row: a password change never
      // resurrects a tombstoned entry.
      dto.tombstone = item.tombstone;
      rows.push(dto);
    }

    // 4. Crash window: record the intent before the request so a lost
    //    response is recoverable at the next unlock.
    vault.meta.pendingRekey = { from: fromSalt, to: nextSalt };
    vault.persist();
    let moved;
    try {
      ({ moved } = await apiFetch(withVault(API.paths.vaultRekey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_vault: nextSalt, records: rows }),
      }));
    } catch (error) {
      // The server never committed: the old scope is authoritative, the
      // device still unlocks with the old password, and the marker clears.
      this.rootKey = previousKey;
      delete vault.meta.pendingRekey;
      vault.persist();
      throw error;
    }

    // 5. Adopt: one authoritative salt, no marker left behind. The Vault
    //    Key wrappers are rewritten for the new scope — the recovery
    //    wrapper keeps the same kit, the password wrapper the new password.
    vault.meta.salt = nextSalt;
    delete vault.meta.pendingRekey;
    vault.persist();
    this.rootKey = nextRoot;
    await this.ensureWrappers(nextRoot, nextPassword);
    vault.entries = await this.fetchAll();
    return moved;
  },

  /**
   * Resolve an interrupted Master Password change at unlock: with a pending
   * marker, the server either committed the target scope (rows decrypt
   * under the new password/salt — adopt it) or never did (fall back to the
   * old salt; the change can simply be retried). Returns the salt to use.
   */
  async resolvePendingRekey(password) {
    const pending = vault.meta && vault.meta.pendingRekey;
    if (!pending || !pending.to) return vault.meta && vault.meta.salt;
    let committed = false;
    const candidate = await kernel.deriveRootKey(password, pending.to);
    const previousKey = this.rootKey;
    this.rootKey = candidate;
    try {
      const summaries = await apiFetchAllPages(withVaultScope(API.paths.records, pending.to));
      const preferred = summaries.find(summary => summary.record_id === verifierRecordId(pending.to))
        || summaries[0];
      if (preferred) {
        const dto = await apiFetch(
          withVaultScope(`${API.paths.records}/${encodeURIComponent(preferred.record_id)}`, pending.to));
        this.decrypt(dto);
        committed = true;
      }
    } catch {
      committed = false;
    } finally {
      this.rootKey = previousKey;
    }
    if (committed) vault.meta.salt = pending.to;
    delete vault.meta.pendingRekey;
    vault.persist();
    return vault.meta.salt;
  },

  /**
   * Stage and commit whole entries through the atomic batch endpoint
   * (DATA-007): every entry is sealed and stored all-or-nothing, then the
   * listing refreshes. Ids must already be de-duplicated by the caller.
   */
  async importEntries(entries) {
    const dtos = await Promise.all(entries.map(entry =>
      this.sealAsDto(entry.id, JSON.stringify(this.toPlaintext(entry)), 1)));
    const results = await apiFetch(`${API.paths.records}/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dtos),
    });
    if (results.committed !== results.requested || results.committed !== results.results.length) {
      const error = new Error('batch failed');
      error.code = 'PM-STORE-CONFLICT';
      throw error;
    }
    vault.entries = await this.fetchAll();
    return entries.length;
  },

  /**
   * Permanently delete every tombstoned row of this vault (ITEM-008):
   * the user-facing early purge ahead of the retention window. Returns
   * the removed count; live rows are never touched.
   */
  async purgeVaultTrash() {
    const { purged } = await apiFetch(withVault(API.paths.vaultPurge), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return purged;
  },

  /**
   * DATA-009 remote scope: delete every record of this vault on the service
   * — live rows (the reserved verifier included) are tombstoned first, then
   * one purge removes every tombstone at the current epoch. Throws without
   * touching anything local when any step fails, so an unreachable remote
   * orphan is never created by accident.
   */
  async deleteAllVaultRecords() {
    const summaries = await apiFetchAllPages(withVault(API.paths.records));
    let tombstoned = 0;
    for (const summary of summaries) {
      if (summary.tombstone) continue;
      await this.tombstone(summary.record_id, summary.revision);
      tombstoned++;
    }
    const { purged } = await apiFetch(withVault(API.paths.vaultPurge), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return { tombstoned, purged };
  },

  /**
   * Store an already-sealed opaque payload as a reserved record (Vault Key
   * wrappers, REC-001..005): the payload is sealed by the caller under its
   * own wrap key; this only builds the record envelope for the given scope.
   */
  async putOpaqueRecord(recordId, scope, payloadHex, knownRevision) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(payloadHex)));
    // Wrapper rewrites use compare-and-set. A caller that already knows the
    // current revision (it just read the wrapper) skips the existence
    // probe, so first-time creation never surfaces a 404.
    let priorRevision = knownRevision;
    if (priorRevision === undefined) {
      const existing = await apiFetch(
        withVaultScope(`${API.paths.records}/${encodeURIComponent(recordId)}`, scope))
        .catch(() => null);
      priorRevision = existing && typeof existing.revision === 'number'
        ? existing.revision : null;
    }
    const revision = priorRevision === null ? 1 : priorRevision + 1;
    const dto = {
      protocol_version: PROTOCOL.version,
      suite_id: PROTOCOL.suiteId,
      deployment_id: scope,
      vault_id: scope,
      record_id: recordId,
      revision,
      ciphertext: payloadHex,
      ciphertext_hash: toHex(digest),
      ciphertext_length: payloadHex.length / 2,
      tombstone: false,
      template_envelope_hash: PROTOCOL.zeroHash,
      manifest_binding: PROTOCOL.zeroHash,
    };
    if (priorRevision !== null && priorRevision !== undefined) {
      dto.expected_prior_revision = priorRevision;
    }
    await apiFetch(withVaultScope(`${API.paths.records}/${encodeURIComponent(recordId)}`, scope), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    return revision;
  },

  /** True once the vault scope carries a password wrapper. */
  async hasPasswordWrap() {
    const summaries = await apiFetchAllPages(withVault(API.paths.records));
    return summaries.some(summary =>
      summary.record_id === wraps.passwordId() && !summary.tombstone);
  },

  /** Persist both Vault Key wrappers (password + recovery scopes). */
  async ensureWrappers(vaultKey, password) {
    const vaultSalt = vault.meta && vault.meta.salt;
    const kit = vault.meta && vault.meta.kit;
    if (!vaultSalt || !kit) return;
    const pair = await wraps.sealBoth(vaultKey, vaultSalt, password, kit);
    const known = wrap => {
      if (this.wrapsKnownFresh) return null; // listing proved absence
      return wrap === pair.password ? this.passwordWrapRevision : undefined;
    };
    // A lost create race answers 409; one compare-and-set retry converges.
    for (const wrap of [pair.password, pair.recovery]) {
      try {
        const revision = await this.putOpaqueRecord(
          wrap.record_id, wrap.vault_id, wrap.payload, known(wrap));
        if (wrap === pair.password) this.passwordWrapRevision = revision;
      } catch (error) {
        if (error.code !== 'PM-STORE-CONFLICT') throw error;
        const revision = await this.putOpaqueRecord(wrap.record_id, wrap.vault_id, wrap.payload);
        if (wrap === pair.password) this.passwordWrapRevision = revision;
      }
    }
    this.wrapsKnownFresh = false;
  },

  /**
   * New-vault initialization (REC-001): a random Vault Key encrypts every
   * record; the password and Recovery Key each receive their own wrapper.
   */
  async initializeVault(password) {
    const vaultKey = wraps.newVaultKey();
    this.rootKey = vaultKey;
    await this.ensureVerifier();
    this.passwordWrapRevision = null; // creation: both wrappers are new
    this.wrapsKnownFresh = true;
    await this.ensureWrappers(vaultKey, password);
  },

  /**
   * Unlock through the password wrapper. Vaults from before wrappers
   * existed migrate transparently: the legacy password-derived root key IS
   * the Vault Key (record keys derive from it identically), so migration
   * only writes the two wrappers.
   */
  async unlockViaWrappers(password, saltHint) {
    const vaultSalt = saltHint || (vault.meta && vault.meta.salt);
    const summaries = await apiFetchAllPages(withVault(API.paths.records));
    const wrapSummary = summaries.find(summary =>
      summary.record_id === wraps.passwordId() && !summary.tombstone);
    if (wrapSummary) {
      const dto = await apiFetch(
        withVault(`${API.paths.records}/${encodeURIComponent(wraps.passwordId())}`));
      this.rootKey = await wraps.openPassword(dto.ciphertext, password, vaultSalt);
      this.passwordWrapRevision = dto.revision;
      this.wrapsKnownFresh = false;
      return;
    }
    this.passwordWrapRevision = null; // known absent: create without probing
    this.wrapsKnownFresh = true; // the listing proved both wrappers absent
    // Legacy migration path.
    const legacyRoot = await kernel.deriveRootKey(password, vaultSalt);
    this.rootKey = legacyRoot;
    await this.ensureWrappers(legacyRoot, password);
  },

  /**
   * Recover a vault with only the Recovery Key and a new Master Password
   * (REC-002/005): find the recovery wrapper at the kit-derived scope,
   * open the Vault Key, prove it against the real vault's verifier, then
   * adopt the vault locally and replace only the password wrapper.
   */
  async recoverVault(kit, newPassword) {
    if (!kernel.validateRecoveryKit(kit)) {
      throw new Error('PM-KERNEL-INVALID-RECOVERY-KIT');
    }
    const scope = await wraps.kitScope(kit);
    const dto = await apiFetch(
      withVaultScope(`${API.paths.records}/${encodeURIComponent(wraps.recoveryId())}`, scope));
    // A tombstoned wrapper is a REVOKED kit (REC-006): the row may still
    // carry its old ciphertext, but recovery must treat it as gone.
    if (dto.tombstone) {
      const error = new Error('PM-STORE-NOT-FOUND');
      error.code = 'PM-STORE-NOT-FOUND';
      throw error;
    }
    const { vaultKey, vaultSalt } = await wraps.openRecovery(dto.ciphertext, kit);
    // Prove the key against the real vault scope before adopting anything.
    const previousKey = this.rootKey;
    this.rootKey = vaultKey;
    try {
      const vaultSummaries = await apiFetchAllPages(withVaultScope(API.paths.records, vaultSalt));
      await this.verifyRootKey(vaultSummaries, vaultSalt);
    } catch (error) {
      this.rootKey = previousKey;
      throw error;
    }
    // Adopt the vault locally, then replace only the password wrapper.
    vault.meta = {
      created: true,
      salt: vaultSalt,
      vaultId: randomHex(4),
      kit,
      createdAt: new Date().toISOString(),
      recoveredAt: new Date().toISOString(),
    };
    vault.persist();
    await this.putOpaqueRecord(wraps.passwordId(), vaultSalt,
      (await wraps.sealBoth(vaultKey, vaultSalt, newPassword, kit)).password.payload);
    vault.entries = await this.fetchAll();
    return vault.entries;
  },

  /**
   * Regenerate the Recovery Key (REC-006): re-authenticate with the master
   * password, write the new kit's wrapper FIRST, then delete the old kit's
   * wrapper so the old Recovery Key can never find the vault again — a
   * crash between the two leaves both keys valid, never neither.
   * Returns the new kit for the ceremony to display.
   */
  async regenerateRecoveryKey(password) {
    const vaultSalt = vault.meta && vault.meta.salt;
    const oldKit = vault.meta && vault.meta.kit;
    if (!vaultSalt || !oldKit) throw new Error('PM-CLIENT-NO-VAULT');
    // 1. Re-authentication: the current master password must open the wrap.
    const previousKey = this.rootKey;
    await this.unlockViaWrappers(password);
    const vaultKey = this.rootKey;
    this.rootKey = previousKey === null ? vaultKey : previousKey;
    // 2. New wrapper first, at the new kit's derived scope.
    const newKit = kernel.generateRecoveryKit();
    vault.meta.kit = newKit;
    const pair = await wraps.sealBoth(vaultKey, vaultSalt, password, newKit);
    await this.putOpaqueRecord(pair.recovery.record_id, pair.recovery.vault_id,
      pair.recovery.payload, null);
    // Also refresh the password wrapper revision bookkeeping.
    await this.putOpaqueRecord(pair.password.record_id, pair.password.vault_id,
      pair.password.payload, this.passwordWrapRevision);
    // 3. Invalidate the old kit: tombstone its wrapper (compare-and-set).
    const oldScope = await wraps.kitScope(oldKit);
    const oldWrapPath = `${API.paths.records}/${encodeURIComponent(wraps.recoveryId())}`;
    const oldWrap = await apiFetch(withVaultScope(oldWrapPath, oldScope));
    await apiFetch(withVaultScope(oldWrapPath, oldScope), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_prior_revision: oldWrap.revision }),
    });
    vault.persist();
    return newKit;
  },

  /**
   * Fetch tombstoned entries for the trash view. Ciphertext is still on
   * the server; we decrypt it to show the name, and restoration re-PUTs
   * the same ciphertext with tombstone=false.
   */
  async fetchTrash() {
    const bodies = await apiFetch(withVault(`${API.paths.records}?embed=bodies`));
    if (!Array.isArray(bodies)) throw new Error('PM-STORE-INVALID-RESPONSE');
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
    const dto = await apiFetch(withVault(`${API.paths.records}/${encodeURIComponent(entry.id)}`));
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
    const summaries = await apiFetchAllPages(withVault(API.paths.records));
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
    const dto = await this.sealForScope(
      id, plaintextString, revision, vault.meta ? vault.meta.salt : '');
    if (expectedPriorRevision !== undefined) {
      dto.expected_prior_revision = expectedPriorRevision;
    }
    return dto;
  },

  /**
   * Seal a record DTO for an explicit vault scope — rekey writes target
   * rows while the session still describes the old scope.
   */
  async sealForScope(id, plaintextString, revision, scope) {
    const plaintextBytes = new TextEncoder().encode(plaintextString);
    const recordKey = kernel.deriveRecordKey(this.rootKey);
    const nonce = kernel.generateNonce();
    const sealed = kernel.seal(recordKey, nonce, plaintextBytes);
    const sealedWithNonce = new Uint8Array(nonce.length + sealed.length);
    sealedWithNonce.set(nonce, 0);
    sealedWithNonce.set(sealed, nonce.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', sealedWithNonce));
    const identity = scope;
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
    return dto;
  },

  /**
   * Seal an entry and store it. `expectedPriorRevision` enables the
   * compare-and-swap update path; omit it to create.
   * Mutates `entry.revision` to the server-assigned value.
   *
   * When the service is unreachable (offline), the sealed DTO is queued in
   * local storage and the error is re-thrown with `queued: true` so callers
   * can report the save as pending instead of lost (ITEM-006).
   */
  async saveEntry(entry, expectedPriorRevision) {
    const body = await this.sealAsDto(
      entry.id,
      JSON.stringify(this.toPlaintext(entry)),
      (entry.revision || 0) + 1,
      expectedPriorRevision,
    );
    try {
      const result = await apiFetch(`${API.paths.records}/${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      entry.revision = result.revision;
      markSynced(); // Diagnostics: a bare timestamp, no content (DIAG-001)
      return entry;
    } catch (error) {
      if (error.code === 'PM-NETWORK-UNREACHABLE') {
        pendingQueue.enqueue(vault.meta && vault.meta.salt, body);
        error.queued = true;
      }
      throw error;
    }
  },

  /**
   * Replay queued offline writes. Items that reach the server are removed;
   * the queue survives a still-unreachable service untouched. A definitive
   * server rejection (e.g. a compare-and-set conflict) drops the queued
   * write — the server is authoritative — and is counted so the caller can
   * surface it. Runs before every listing (see fetchAll).
   */
  async flushPending() {
    const salt = vault.meta && vault.meta.salt;
    const items = pendingQueue.list(salt);
    let synced = 0;
    let conflicts = 0;
    for (const item of items) {
      try {
        await apiFetch(`${API.paths.records}/${encodeURIComponent(item.record_id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.dto),
        });
        pendingQueue.remove(salt, item.record_id);
        synced++;
        markSynced();
      } catch (error) {
        if (error.code === 'PM-NETWORK-UNREACHABLE') break;
        pendingQueue.remove(salt, item.record_id);
        conflicts++;
      }
    }
    return { synced, conflicts, pending: pendingQueue.list(salt).length };
  },

  /** Tombstone a record (soft delete) via the CAS path. */
  async tombstone(id, expectedPriorRevision) {
    return apiFetch(withVault(`${API.paths.records}/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_prior_revision: expectedPriorRevision }),
    });
  },
};
