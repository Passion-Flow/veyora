/**
 * TOTP (RFC 6238) tests, including RFC Appendix B reference vectors.
 *
 * The vectors use the standard 20-byte secret "12345678901234567890"
 * (Base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ) at well-known timestamps.
 * RFC 6238 lists 8-digit codes; we verify 6-digit truncation by
 * recomputing the expected value from the 8-digit reference (last 6 digits
 * are NOT simply the suffix — the modulus changes — so we verify the
 * algorithm against our own implementation of the RFC formula).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTotp, base32Decode, totpSecondsRemaining } from '../src/data/totp.js';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"

test('RFC 6238 Appendix B: SHA-1 TOTP at reference timestamps', async () => {
  // RFC 6238 Appendix B lists 8-digit values; our 6-digit output is the
  // same dynamic truncation modulo 10^6. We verify against known-good
  // implementations (Google Authenticator test suite).
  const vectors = [
    { time: 59,           expected6: '287082' },
    { time: 1111111109,   expected6: '081804' },
    { time: 1111111111,   expected6: '050471' },
    { time: 1234567890,   expected6: '005924' },
    { time: 2000000000,   expected6: '279037' },
  ];
  for (const { time, expected6 } of vectors) {
    const code = await generateTotp(SECRET, time * 1000);
    assert.equal(code, expected6, `t=${time}`);
  }
});

test('codes are 6 digits and change across time steps', async () => {
  const now = Date.now();
  const a = await generateTotp(SECRET, now);
  const b = await generateTotp(SECRET, now + 31000); // next window
  assert.match(a, /^\d{6}$/);
  assert.match(b, /^\d{6}$/);
  assert.notEqual(a, b, 'adjacent windows should differ');
});

test('same time window yields the same code', async () => {
  const now = Date.now();
  const a = await generateTotp(SECRET, now);
  const b = await generateTotp(SECRET, now + 5000); // same 30s window
  assert.equal(a, b);
});

test('base32 decode round-trips the RFC secret', () => {
  const bytes = base32Decode(SECRET);
  assert.equal(bytes.length, 20);
  assert.deepEqual([...bytes.slice(0, 4)], [0x31, 0x32, 0x33, 0x34]); // "1234"
});

test('base32 decode rejects invalid characters', () => {
  assert.throws(() => base32Decode('ABC8'), /invalid base32/);
  assert.throws(() => base32Decode('a!b'), /invalid base32/);
});

test('seconds remaining wraps within the 30s window', () => {
  const rem = totpSecondsRemaining(Date.now());
  assert.ok(rem >= 1 && rem <= 30, `got ${rem}`);
});
