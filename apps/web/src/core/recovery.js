/**
 * Vault Key wrapping and Recovery Key usage (PRD REC-001..005).
 *
 * The architecture separates the key that encrypts records from the
 * credentials that protect it:
 *
 *   Vault Key (VK)  — 32 random bytes generated at vault creation; every
 *                     record key derives from it, so record ciphertext is
 *                     independent of every password or recovery change.
 *   password wrap   — VK sealed under deriveRootKey(master password, vault
 *                     scope), stored as a reserved record in the vault
 *                     scope: `veyora-vkwrap-password-v1`.
 *   recovery wrap   — the same VK sealed under deriveRootKey(Recovery Key,
 *                     kit scope), where the kit scope is SHA-256 of the
 *                     71-character kit string. Stored at that derived
 *                     scope, a fresh device can find it with nothing but
 *                     the kit itself; the payload also carries the vault
 *                     scope so recovery can adopt the real vault.
 *
 * Legacy vaults (created before wraps existed) migrate transparently on
 * their next unlock: the old password-derived root key IS the Vault Key —
 * record keys derive from it identically — so migration writes the two
 * wraps and changes no record.
 */
import { kernel, toHex, fromHex, randomHex } from './kernel.js';

const PASSWORD_WRAP_ID = 'veyora-vkwrap-password-v1';
const RECOVERY_WRAP_ID = 'veyora-vkwrap-recovery-v1';

/** Wrap plaintext is JSON: the VK hex, plus the vault scope for recovery. */
async function sealWrap(key, payload) {
  const nonce = kernel.generateNonce();
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = kernel.seal(key, nonce, plaintextBytes);
  const sealedWithNonce = new Uint8Array(nonce.length + sealed.length);
  sealedWithNonce.set(nonce, 0);
  sealedWithNonce.set(sealed, nonce.length);
  return toHex(sealedWithNonce);
}

async function openWrap(key, hex) {
  const sealedWithNonce = fromHex(hex);
  const nonce = sealedWithNonce.slice(0, 24);
  const sealed = sealedWithNonce.slice(24);
  const plaintextBytes = kernel.open(key, nonce, sealed);
  return JSON.parse(new TextDecoder().decode(plaintextBytes));
}

/**
 * SHA-256 hex of a string, truncated to the KDF salt width (16 bytes /
 * 32 hex, the same shape as a vault salt; WebCrypto, no keys kept).
 */
async function sha256SaltHex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(text)));
  return toHex(digest.slice(0, 16));
}

/** The wrap-sealing key for a credential inside one scope. */
async function wrapKey(material, scope) {
  return kernel.deriveRootKey(material, scope);
}

/** Wrappers as opaque JSON envelopes ready to store as reserved records. */
export const wraps = {
  passwordId: () => PASSWORD_WRAP_ID,
  recoveryId: () => RECOVERY_WRAP_ID,

  /** The scope a fresh device derives from a kit alone. */
  async kitScope(kit) {
    return sha256SaltHex(`veyora-kit-scope:${kit}`);
  },

  /** Seal both wrappers for a vault scope under (password, kit). */
  async sealBoth(vaultKeyBytes, vaultSalt, password, kit) {
    const scope = await this.kitScope(kit);
    return {
      password: {
        record_id: PASSWORD_WRAP_ID,
        vault_id: vaultSalt,
        payload: await sealWrap(await wrapKey(password, vaultSalt),
          { vk: toHex(vaultKeyBytes) }),
      },
      recovery: {
        record_id: RECOVERY_WRAP_ID,
        vault_id: scope,
        payload: await sealWrap(await wrapKey(kit, scope),
          { vk: toHex(vaultKeyBytes), vault_salt: vaultSalt }),
      },
    };
  },

  /** Open the password wrapper; throws for a wrong password. */
  async openPassword(envelopeHex, password, vaultSalt) {
    const payload = await openWrap(await wrapKey(password, vaultSalt), envelopeHex);
    return fromHex(payload.vk);
  },

  /** Open the recovery wrapper; throws for a wrong or foreign kit. */
  async openRecovery(envelopeHex, kit) {
    const scope = await this.kitScope(kit);
    const payload = await openWrap(await wrapKey(kit, scope), envelopeHex);
    if (typeof payload.vault_salt !== 'string' || typeof payload.vk !== 'string') {
      throw new Error('PM-KERNEL-WRAP-FORMAT');
    }
    return { vaultKey: fromHex(payload.vk), vaultSalt: payload.vault_salt };
  },

  /** Fresh Vault Key material for a new vault. */
  newVaultKey() {
    return fromHex(randomHex(32));
  },
};
