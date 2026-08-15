/**
 * Vault session store.
 *
 * Owns the in-memory entry collection and the device-local vault metadata
 * (KDF salt, vault id, recovery kit). In the production client the entries
 * arrive as opaque ciphertext from the API and are decrypted through the
 * kernel adapter; this module keeps the same shape so the swap is minimal.
 */
import { STORAGE_KEYS, SECURITY } from '../config.js';
import { kernel, randomHex } from './kernel.js';

export const vault = {
  /** Decrypted entry collection for the current session (starts empty). */
  entries: [],
  /** Device-local vault metadata, or null before first run. */
  meta: null,

  /** Restore device metadata. Entries arrive from the API after unlock. */
  load() {
    try {
      this.meta = JSON.parse(localStorage.getItem(STORAGE_KEYS.vault) || 'null');
    } catch {
      this.meta = null;
    }
    this.entries = [];
  },

  persist() {
    localStorage.setItem(STORAGE_KEYS.vault, JSON.stringify(this.meta));
  },

  hasVault() {
    return Boolean(this.meta && this.meta.created);
  },

  /** Provision a new vault: salt, id, and one-time recovery kit. */
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

  /** Regenerate the recovery kit for an existing vault. */
  regenerateKit() {
    if (!this.meta) return null;
    this.meta.kit = kernel.generateRecoveryKit();
    this.persist();
    return this.meta.kit;
  },

  /** Wipe device metadata (demo reset). */
  reset() {
    localStorage.removeItem(STORAGE_KEYS.vault);
    this.meta = null;
  },

  /** Derive a fresh root key — demo staging until WASM is wired. */
  async deriveRootKey(password) {
    return kernel.deriveRootKey(password, this.meta ? this.meta.salt : '');
  },
};
