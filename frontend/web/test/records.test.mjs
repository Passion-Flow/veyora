/**
 * Record-sync unit tests: envelope building (via a stubbed fetch), error
 * code mapping, plaintext stripping, and vault metadata persistence through
 * the safe storage layer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSync } from '../src/core/records.js';
import { vault } from '../src/core/vault.js';
import { kernel } from '../src/core/kernel.js';
import { toHex, fromHex } from '../src/core/kernel.js';

const calls = [];

/** Fetch stub capturing requests and replaying queued responses. */
function stubFetch(responses) {
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next.network) throw new TypeError('fetch failed');
    return {
      ok: next.ok !== false,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  };
}

test('apiFetch maps network failures to a stable code', async () => {
  stubFetch([{ network: true }]);
  await assert.rejects(
    recordSync.countRecords(),
    error => error.code === 'PM-NETWORK-UNREACHABLE' && error.status === 0,
  );
});

test('apiFetch surfaces localized JSON error codes', async () => {
  stubFetch([{ ok: false, status: 409, body: { error: { code: 'PM-STORE-CONFLICT', message: 'x' } } }]);
  await assert.rejects(
    recordSync.countRecords(),
    error => error.code === 'PM-STORE-CONFLICT' && error.status === 409,
  );
});

test('saveEntry seals, hashes, and CAS-updates through the kernel', async () => {
  recordSync.rootKey = await kernel.deriveRootKey('test-password', '00'.repeat(16));
  vault.meta = { created: true, salt: '00'.repeat(16), vaultId: 'ab'.repeat(4) };
  stubFetch([{ body: { revision: 7 } }]);

  const entry = { id: 'acme', name: 'Acme', secret: 's3cret', revision: 6 };
  await recordSync.saveEntry(entry, 6);

  assert.equal(entry.revision, 7);
  const put = calls.find(call => call.options.method === 'PUT');
  assert.ok(put.url.endsWith('/records/acme'));
  const body = JSON.parse(put.options.body);
  assert.equal(body.record_id, 'acme');
  assert.equal(body.revision, 7);
  assert.equal(body.expected_prior_revision, 6);
  assert.equal(body.ciphertext_hash.length, 64);
  // Ciphertext is hex and prefixed with the 24-byte nonce.
  assert.match(body.ciphertext, /^[0-9a-f]+$/);
  assert.equal(fromHex(body.ciphertext).length >= 24 + 's3cret'.length + 16, true);
  // Round-trip: the stored plaintext decrypts back and carries no session fields.
  const sealedWithNonce = fromHex(body.ciphertext);
  const recordKey = kernel.deriveRecordKey(recordSync.rootKey);
  const opened = kernel.open(recordKey, sealedWithNonce.slice(0, 24), sealedWithNonce.slice(24));
  const plaintext = JSON.parse(new TextDecoder().decode(opened));
  assert.equal(plaintext.name, 'Acme');
  assert.ok(!('id' in plaintext) && !('revision' in plaintext));
});

test('tombstone sends the expected prior revision', async () => {
  stubFetch([{ body: { revision: 8 } }]);
  await recordSync.tombstone('acme', 7);
  const del = calls.find(call => call.options.method === 'DELETE');
  assert.equal(JSON.parse(del.options.body).expected_prior_revision, 7);
});

test('vault metadata persists through the safe storage layer', () => {
  vault.reset();
  vault.create();
  assert.ok(vault.hasVault());
  assert.equal(vault.meta.salt.length, 32);
  const round = vault.regenerateKit();
  assert.ok(round.length > 0);
  vault.reset();
  assert.ok(!vault.hasVault());
});
