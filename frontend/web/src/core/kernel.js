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
import { GENERATOR, RECOVERY_KIT } from '../config.js';

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

export function randomHex(byteCount) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Estimated entropy in bits for a password of `length` over `poolSize`. */
export function entropyBits(length, poolSize) {
  return Math.round(length * Math.log2(poolSize || 1));
}

export class DemoKernel {
  /** Derive a root key from password material (demo: digest reference). */
  async deriveRootKey(password, saltHex) {
    const bytes = new TextEncoder().encode(`${password}:${saltHex}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }

  /** Generate a password from generator options. Returns { value, poolSize }. */
  generatePassword(options) {
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

  /** Encode a checksummed recovery kit string. */
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
}

/**
 * The active kernel instance. main.js replaces this with the WASM-backed
 * adapter once bindings load; views import `kernel` only.
 */
export const kernel = new DemoKernel();
