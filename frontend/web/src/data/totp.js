/**
 * TOTP (Time-based One-Time Password) generation — RFC 6238.
 *
 * TOTP(K, T) = HOTP(K, C) where C = floor((UnixTime − T0) / TimeStep)
 * HOTP(K, C) = (Truncate(HMAC-SHA-1(K, C)) & 0x7FFFFFFF) mod 10^Digit
 *
 * Basis:
 * - RFC 4226 (HOTP): §5.3 defines the dynamic truncation algorithm
 * - RFC 6238 (TOTP): §4 defines the time step and recommended parameters
 *   (SHA-1, 30-second step, 6 digits — the de facto industry standard
 *   used by Google Authenticator, Microsoft Authenticator, and 1Password)
 *
 * The shared secret is stored as a Base32 string inside the encrypted
 * entry; generation happens entirely in the browser via WebCrypto —
 * no secret ever leaves the client.
 */

const TIME_STEP_SECONDS = 30;
const DIGITS = 6;
const EPOCH_OFFSET = 0; // T0 = 0 per RFC 6238 §4.1

/** RFC 4648 Base32 decode (no padding). */
export function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[=\s]/g, '');
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

/** RFC 4226 §5.3: dynamic truncation of a 20-byte HMAC-SHA-1 digest. */
function dynamicTruncate(hash) {
  const offset = hash[hash.length - 1] & 0x0f;
  return ((hash[offset] & 0x7f) << 24)
    | ((hash[offset + 1] & 0xff) << 16)
    | ((hash[offset + 2] & 0xff) << 8)
    | (hash[offset + 3] & 0xff);
}

/** Compute a TOTP code for the given Base32 secret at a specific time. */
export async function generateTotp(secretBase32, timestampMs = Date.now()) {
  const counter = Math.floor(timestampMs / 1000 / TIME_STEP_SECONDS);
  const keyBytes = base32Decode(secretBase32);

  const counterBytes = new Uint8Array(8);
  let remaining = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, counterBytes);
  const hash = new Uint8Array(signature);
  const binary = dynamicTruncate(hash) % (10 ** DIGITS);
  return String(binary).padStart(DIGITS, '0');
}

/** Seconds remaining in the current TOTP window. */
export function totpSecondsRemaining(timestampMs = Date.now()) {
  const seconds = Math.floor(timestampMs / 1000);
  return TIME_STEP_SECONDS - (seconds % TIME_STEP_SECONDS);
}

/** RFC 6238 Appendix B test vectors (SHA-1, 8 digits → we test 6). */
export const RFC_TEST_VECTORS = Object.freeze([
  { time: 59, secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
  { time: 1111111109, secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
  { time: 1234567890, secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
  { time: 2000000000, secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
]);
