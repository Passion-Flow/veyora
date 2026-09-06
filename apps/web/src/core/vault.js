/**
 * Vault session store.
 *
 * Owns the in-memory entry collection and the device-local vault metadata
 * (KDF salt, vault id, and a protocol-only recovery encoding). The current
 * encoding does not unwrap an existing Vault Key and is not exposed as a
 * recovery capability. In the production client the entries
 * arrive as opaque ciphertext from the API and are decrypted through the
 * kernel adapter; this module keeps the same shape so the swap is minimal.
 */
import { STORAGE_KEYS, SECURITY } from '../config.js';
import { kernel, randomHex } from './kernel.js';
import { storage } from './storage.js';

export const vault = {
  /** Decrypted entry collection for the current session (starts empty). */
  entries: [],
  /** Device-local vault metadata, or null before first run. */
  meta: null,

  /** Restore device metadata. Entries arrive from the API after unlock. */
  load() {
    try {
      this.meta = JSON.parse(storage.get(STORAGE_KEYS.vault) || 'null');
    } catch {
      this.meta = null;
    }
    this.entries = [];
  },

  persist() {
    storage.set(STORAGE_KEYS.vault, JSON.stringify(this.meta));
  },

  hasVault() {
    return Boolean(this.meta && this.meta.created);
  },

  /** Provision local metadata, including an unsupported protocol encoding. */
  create() {
    this.meta = {
      created: true,
      salt: randomHex(SECURITY.salt.bytes),
      vaultId: randomHex(SECURITY.vaultId.bytes),
      kit: kernel.generateRecoveryKit(),
      createdAt: new Date().toISOString(),
    };
    this.persist();
    return this.meta;
  },

  /** Regenerate protocol-only recovery material (no supported UI caller). */
  regenerateKit() {
    if (!this.meta) return null;
    this.meta.kit = kernel.generateRecoveryKit();
    this.persist();
    return this.meta.kit;
  },

  /** Wipe device metadata after an explicit local reset. */
  reset() {
    storage.remove(STORAGE_KEYS.vault);
    this.meta = null;
    // The destroyed vault's decrypted entries must not linger in memory
    // (they would render into a vault created later on the same page).
    this.entries = [];
  },
};
