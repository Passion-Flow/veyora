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
 * The application has no JavaScript cryptography fallback. If the generated
 * module cannot be loaded, validated, and self-tested, boot stops before any
 * Vault operation becomes available.
 */
import { GENERATOR, KERNEL_ASSETS, PROTOCOL } from '../config.js';

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

/**
 * Real kernel adapter over the Rust/WASM bindings (src/wasm/veyora_kernel.js).
 * Views use only this adapter and never branch to an alternate crypto mode.
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

const REQUIRED_BINDINGS = Object.freeze([
  'derivePasswordKey',
  'deriveRecordKey',
  'generateNonce',
  'sealRecord',
  'openRecord',
  'generateRecoveryKit',
  'validateRecoveryKit',
]);

const REQUIRED_RAW_EXPORTS = Object.freeze(['memory', ...REQUIRED_BINDINGS]);

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function containsBytes(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
    for (let index = 0; index < needle.length; index++) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function validateBindings(bindings) {
  for (const name of REQUIRED_BINDINGS) {
    if (typeof bindings[name] !== 'function') {
      throw new Error(`KERNEL_EXPORT_MISSING:${name}`);
    }
  }
}

function validateWasmModule(wasmModule) {
  if (!(wasmModule instanceof WebAssembly.Module)) {
    throw new Error('KERNEL_WASM_MODULE_INVALID');
  }
  const exports = new Map(
    WebAssembly.Module.exports(wasmModule).map(item => [item.name, item.kind]),
  );
  for (const name of REQUIRED_RAW_EXPORTS) {
    const expectedKind = name === 'memory' ? 'memory' : 'function';
    if (exports.get(name) !== expectedKind) {
      throw new Error(`KERNEL_WASM_EXPORT_MISSING:${name}`);
    }
  }
}

function validateRawExports(rawExports) {
  if (!(rawExports?.memory instanceof WebAssembly.Memory)) {
    throw new Error('KERNEL_WASM_INSTANCE_MISSING');
  }
  for (const name of REQUIRED_BINDINGS) {
    if (typeof rawExports[name] !== 'function') {
      throw new Error(`KERNEL_WASM_INSTANCE_EXPORT_MISSING:${name}`);
    }
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

async function fetchVerifiedAsset(url, expectedSha256, label) {
  const response = await fetch(url, { cache: 'reload' });
  if (!response.ok) throw new Error(`KERNEL_ASSET_FETCH:${label}:${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`KERNEL_ASSET_DIGEST:${label}`);
  }
  return bytes;
}

/** Exercise the real adapter before exposing it to Vault code. */
async function selfTest(candidate) {
  const password = `kernel-self-test-${randomHex(16)}`;
  const rootKey = await candidate.deriveRootKey(password, randomHex(16));
  if (!(rootKey instanceof Uint8Array) || rootKey.length !== 32) {
    throw new Error('KERNEL_SELF_TEST_PASSWORD_KDF');
  }
  const recordKey = candidate.deriveRecordKey(rootKey);
  const nonce = candidate.generateNonce();
  const secondNonce = candidate.generateNonce();
  if (!(nonce instanceof Uint8Array) || nonce.length !== PROTOCOL.nonceLength) {
    throw new Error('KERNEL_SELF_TEST_NONCE');
  }
  if (!(secondNonce instanceof Uint8Array)
      || secondNonce.length !== PROTOCOL.nonceLength
      || equalBytes(nonce, secondNonce)) {
    throw new Error('KERNEL_SELF_TEST_NONCE_UNIQUENESS');
  }

  const plaintext = new Uint8Array(73);
  crypto.getRandomValues(plaintext);
  const sealed = candidate.seal(recordKey, nonce, plaintext);
  if (!(sealed instanceof Uint8Array) || sealed.length <= plaintext.length) {
    throw new Error('KERNEL_SELF_TEST_SEAL');
  }
  if (containsBytes(sealed, plaintext)) {
    throw new Error('KERNEL_SELF_TEST_PLAINTEXT');
  }
  const opened = candidate.open(recordKey, nonce, sealed);
  if (!equalBytes(opened, plaintext)) {
    throw new Error('KERNEL_SELF_TEST_ROUND_TRIP');
  }

  const tampered = sealed.slice();
  tampered[0] ^= 1;
  let rejected = false;
  try {
    candidate.open(recordKey, nonce, tampered);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('KERNEL_SELF_TEST_AUTHENTICATION');

  const wrongRootKey = rootKey.slice();
  wrongRootKey[0] ^= 1;
  const wrongRecordKey = candidate.deriveRecordKey(wrongRootKey);
  rejected = false;
  try {
    candidate.open(wrongRecordKey, nonce, sealed);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('KERNEL_SELF_TEST_WRONG_KEY');

  const recoveryKit = candidate.generateRecoveryKit();
  if (typeof recoveryKit !== 'string' || !candidate.validateRecoveryKit(recoveryKit)) {
    throw new Error('KERNEL_SELF_TEST_RECOVERY_ENCODING');
  }
}

export class KernelUnavailableError extends Error {
  constructor(cause) {
    super('KERNEL_UNAVAILABLE', { cause });
    this.name = 'KernelUnavailableError';
    this.code = 'KERNEL_UNAVAILABLE';
  }
}

/**
 * The active kernel instance remains unavailable until the real bindings pass
 * validation and self-test. ES module live bindings expose the selected
 * instance to callers only after successful boot.
 */
export let kernel = null;

/**
 * Activate the WASM kernel or reject without installing any fallback.
 *
 * The generated module exposes init as its default export and the wrapped
 * functions as named exports once initialized; the raw exports returned by
 * init() use the low-level ABI and must not be called directly.
 *
 * @returns {Promise<'wasm'>} the activated mode
 */
export async function loadKernel() {
  kernel = null;
  try {
    const bindingUrl = new URL('../wasm/veyora_kernel.js', import.meta.url);
    bindingUrl.searchParams.set('sha256', KERNEL_ASSETS.bindingSha256);
    const wasmUrl = new URL('../wasm/veyora_kernel_bg.wasm', import.meta.url);
    wasmUrl.searchParams.set('sha256', KERNEL_ASSETS.wasmSha256);

    // Verify both generated artifacts before importing or exposing a binding.
    // The digest query gives the module loader a versioned cache key; explicit
    // reload semantics keep a stale HTTP-cache entry out of the decision.
    await fetchVerifiedAsset(bindingUrl, KERNEL_ASSETS.bindingSha256, 'binding');
    const wasmBytes = await fetchVerifiedAsset(wasmUrl, KERNEL_ASSETS.wasmSha256, 'wasm');
    const wasmModule = await WebAssembly.compile(wasmBytes);
    validateWasmModule(wasmModule);

    const module = await import(bindingUrl.href);
    validateBindings(module);
    const rawExports = await module.default({ module_or_path: wasmModule });
    validateRawExports(rawExports);
    const candidate = new WasmKernel(module);
    await selfTest(candidate);
    kernel = candidate;
    return 'wasm';
  } catch (cause) {
    const error = cause instanceof KernelUnavailableError
      ? cause
      : new KernelUnavailableError(cause);
    renderFatalKernelError();
    throw error;
  }
}

/**
 * Replace the page with an unmissable error screen when the WASM kernel
 * cannot be activated. The Vault must never appear to work without its real
 * cryptography.
 */
function renderFatalKernelError() {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderFatalKernelError, { once: true });
    return;
  }
  document.title = 'Veyora — kernel unavailable';
  const screen = document.createElement('div');
  screen.setAttribute('role', 'alert');
  screen.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
    'justify-content:center;background:#1a0f13;color:#ffd9d9;' +
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;';
  const card = document.createElement('div');
  card.style.cssText = 'max-width:520px;padding:32px;';
  const heading = document.createElement('h1');
  heading.textContent = 'Security kernel unavailable';
  heading.style.cssText = 'font-size:20px;margin:0 0 12px;';
  const body = document.createElement('p');
  body.textContent =
    'The Veyora cryptography kernel failed to load, so the vault cannot be ' +
    'opened. No Vault data was changed. Reload from a verified deployment or ' +
    'reinstall the verified desktop package, then try again.';
  body.style.cssText = 'font-size:14px;line-height:1.6;margin:0;';
  card.appendChild(heading);
  card.appendChild(body);
  screen.appendChild(card);
  document.body.replaceChildren(screen);
}
