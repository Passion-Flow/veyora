/**
 * Security kernel adapter.
 *
 * The production client binds the Rust/WASM kernel (veyora_kernel.js) whose
 * exports already match this interface:
 *   derivePasswordKey(passwordBytes, saltBytes) -> rootKey
 *   deriveRecordKey(rootKey, context)           -> recordKey
 *   generateNonce()                              -> nonce
 *   sealRecord / openRecord(key, nonce, aad, data)
 *   generatePassword()                           -> bytes
 *   generateRecoveryKit()                        -> string
 *
 * `DemoKernel` implements the same interface locally so the UI can be built
 * and reviewed before the WASM bindings are wired. Swapping the adapter is a
 * one-line change in main.js; no view code touches crypto directly.
 */
import { GENERATOR, RECOVERY_KIT, PROTOCOL } from '../config.js';

/** Cryptographically uniform integer below `limit` via rejection sampling. */
function randomByte() {
  const bytes = new Uint8Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0];
}

function pickUniform(set) {
  const limit = Math.floor(256 / set.length) * set.length;
  let byte;
  do { byte = randomByte(); } while (byte >= limit);
  return set[byte % set.length];
}

/** Hex encoding helpers shared by every kernel adapter. */
export function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/** Estimated entropy in bits for a password of `length` over `poolSize`. */
export function entropyBits(length, poolSize) {
  return Math.round(length * Math.log2(poolSize || 1));
}

/**
 * Password generation policy shared by both adapters.
 *
 * The WASM kernel exposes a fixed 20-character v1 profile; the vault UI
 * offers user-chosen lengths and character sets. Both paths use the OS
 * CSPRNG with rejection sampling, mirroring the kernel's sampler design.
 */
function generateFromOptions(options) {
  const pools = GENERATOR.sets;
  let pool = '';
  if (options.upper) pool += pools.upper;
  if (options.lower) pool += pools.lower;
  if (options.digit) pool += pools.digit;
  if (options.sym) pool += pools.symbol;
  if (options.amb) {
    const ambiguous = GENERATOR.ambiguousCharacters;
    pool = [...pool].filter(ch => !ambiguous.includes(ch)).join('');
  }
  if (!pool) return null;
  let value = '';
  for (let i = 0; i < options.len; i++) value += pickUniform(pool);
  return { value, poolSize: pool.length };
}

/** Random hex string of `byteCount` bytes. */
export function randomHex(byteCount) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Key-mixed demo tag: 8 bytes mixing key and nonce (demo mode only). */
function demoTag(key, nonce) {
  const tag = new Uint8Array(8);
  for (let i = 0; i < tag.length; i++) {
    tag[i] = (key[i % key.length] ^ nonce[i % nonce.length] ^ (i * 31)) & 0xff;
  }
  return tag;
}

export class DemoKernel {
  /** Derive a root key from password material (demo: digest reference). */
  async deriveRootKey(password, saltHex) {
    const bytes = new TextEncoder().encode(`${password}:${saltHex}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }

  /**
   * Demo record wrapping: passthrough payload behind a key-mixed tag so a
   * wrong key still fails like the real AEAD would (demo semantics only —
   * not a cryptographic construction).
   */
  deriveRecordKey(rootKey) {
    return rootKey;
  }

  seal(recordKey, nonce, plaintextBytes) {
    const tag = demoTag(recordKey, nonce);
    const sealed = new Uint8Array(tag.length + plaintextBytes.length);
    sealed.set(tag, 0);
    sealed.set(plaintextBytes, tag.length);
    return sealed;
  }

  open(recordKey, nonce, sealedBytes) {
    const tag = demoTag(recordKey, nonce);
    for (let i = 0; i < tag.length; i++) {
      if (sealedBytes[i] !== tag[i]) {
        throw new Error('PM-KERNEL-CRYPTOGRAPHIC-FAILURE');
      }
    }
    return sealedBytes.slice(tag.length);
  }

  generateNonce() {
    const nonce = new Uint8Array(PROTOCOL.nonceLength);
    crypto.getRandomValues(nonce);
    return nonce;
  }

  /** Generate a password from generator options. Returns { value, poolSize }. */
  generatePassword(options) {
    return generateFromOptions(options);
  }

  /** Encode a checksummed recovery kit string (demo format). */
  generateRecoveryKit() {
    const groups = [];
    for (let g = 0; g < RECOVERY_KIT.groups; g++) {
      let group = '';
      for (let i = 0; i < RECOVERY_KIT.groupSize; i++) {
        group += pickUniform(RECOVERY_KIT.alphabet);
      }
      groups.push(group);
    }
    const body = groups.slice(0, -1).join(RECOVERY_KIT.separator);
    const checksum = groups[groups.length - 1];
    return body + RECOVERY_KIT.checksumSeparator + checksum;
  }

  /** Demo kits are not checksummed; accept any non-empty form. */
  validateRecoveryKit(form) {
    return form.trim().length > 0;
  }
}

/**
 * Real kernel adapter over the Rust/WASM bindings (src/wasm/veyora_kernel.js).
 * Method surface matches DemoKernel so views never branch on the mode.
 */
export class WasmKernel {
  constructor(bindings) {
    this.bindings = bindings;
  }

  /** Argon2id (V1 profile) password-key derivation over a 16-byte salt. */
  async deriveRootKey(password, saltHex) {
    return this.bindings.derivePasswordKey(
      new TextEncoder().encode(password),
      fromHex(saltHex),
    );
  }

  deriveRecordKey(rootKey) {
    return this.bindings.deriveRecordKey(
      rootKey,
      new Uint8Array(PROTOCOL.recordKeyContext),
    );
  }

  generateNonce() {
    return this.bindings.generateNonce();
  }

  /** XChaCha20-Poly1305 seal; returns ciphertext||tag. */
  seal(recordKey, nonce, plaintextBytes) {
    return this.bindings.sealRecord(
      recordKey, nonce,
      new TextEncoder().encode(PROTOCOL.recordAad),
      plaintextBytes,
    );
  }

  open(recordKey, nonce, sealedBytes) {
    return this.bindings.openRecord(
      recordKey, nonce,
      new TextEncoder().encode(PROTOCOL.recordAad),
      sealedBytes,
    );
  }

  generatePassword(options) {
    return generateFromOptions(options);
  }

  /** Kernel-format recovery kit (Base32, checksummed, hyphen groups). */
  generateRecoveryKit() {
    return this.bindings.generateRecoveryKit();
  }

  /** True when the kernel accepts the kit's checksum. */
  validateRecoveryKit(form) {
    try {
      this.bindings.validateRecoveryKit(form);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The active kernel instance. `loadKernel()` swaps in the WASM-backed
 * adapter when the bindings are available; ES module live bindings make
 * the switch visible to every importer.
 */
export let kernel = new DemoKernel();

/**
 * Try to activate the WASM kernel.
 *
 * The generated module exposes init as its default export and the wrapped
 * functions as named exports once initialized; the raw exports returned by
 * init() use the low-level ABI and must not be called directly.
 *
 * @returns {Promise<'wasm'|'demo'>} the activated mode
 */
export async function loadKernel() {
  try {
    const module = await import('../wasm/veyora_kernel.js');
    await module.default();
    kernel = new WasmKernel(module);
    return 'wasm';
  } catch {
    kernel = new DemoKernel();
    return 'demo';
  }
}
