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

test('importCsv encrypts and batch-stores every row, all-or-nothing', async () => {
  recordSync.rootKey = await kernel.deriveRootKey('import-password', '00'.repeat(16));
  vault.meta = { created: true, salt: '00'.repeat(16), vaultId: 'ab'.repeat(4) };
  vault.entries = [];
  const HEADER = 'name,website,username,password,notes,tags_json';
  const csv = `${HEADER}\nAcme,https://acme,u,pw1,,[]\n`;
  calls.length = 0;
  // Call order: batch POST → fetchAll list → fetchAll record GET, whose
  // ciphertext is taken from the batch request itself (sealed under the
  // same active root key).
  const responses = [
    { body: [{ record_id: 'acme', ok: true, revision: 1, error: null }] },
    { body: [{ record_id: 'acme', revision: 1, tombstone: false }] },
    { replayBatchCiphertext: true },
    { replayBatchCiphertext: true },
  ];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (!next) throw new TypeError('fetch failed');
    let body = next.body;
    if (next.replayBatchCiphertext) {
      const batchCall = calls.find(call => call.options.method === 'POST');
      body = { record_id: 'acme', revision: 1, ciphertext: JSON.parse(batchCall.options.body)[0].ciphertext };
    }
    return { ok: true, status: 200, json: async () => body };
  };

  const imported = await recordSync.importCsv(csv);
  assert.equal(imported, 1);
  const batch = calls.find(call => call.options.method === 'POST');
  assert.ok(batch.url.endsWith('/records/batch'));
  const dto = JSON.parse(batch.options.body)[0];
  assert.equal(dto.record_id, 'acme');
  assert.match(dto.ciphertext, /^[0-9a-f]+$/);

  // A partial batch failure aborts with the server's stable code. (Entries
  // from the first phase are cleared: re-importing the same id is rejected
  // by design before any network call.)
  vault.entries = [];
  stubFetch([{ body: [{ record_id: 'acme', ok: false, revision: null, error: 'PM-STORE-CONFLICT' }] }]);
  await assert.rejects(
    () => recordSync.importCsv(csv),
    error => error.code === 'PM-STORE-CONFLICT',
  );
});

test('changeMasterPassword re-keys everything and commits the new salt', async () => {
  vault.reset();
  vault.meta = { created: true, salt: '11'.repeat(16), vaultId: 'cd'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('old-password', vault.meta.salt);
  const entry = { id: 'acme', type: 'login', name: 'Acme', secret: 's', revision: 4 };
  vault.entries = [entry];

  const dtoUnderOldKey = await recordSync.sealAsDto('acme', JSON.stringify({ name: 'Acme', secret: 's' }), 5, 4);
  const sealedHex = dtoUnderOldKey.ciphertext;

  // fetch stubs in exact call order: verify list → verify GET → inventory
  // list → inventory GET → re-key PUT → final fetchAll list (empty, so the
  // post-change refresh needs no record GETs).
  stubFetch([
    { body: [{ record_id: 'acme', revision: 5, tombstone: false }] },
    { body: { record_id: 'acme', revision: 5, ciphertext: sealedHex } },
    { body: [{ record_id: 'acme', revision: 5, tombstone: false }] },
    { body: { record_id: 'acme', revision: 5, ciphertext: sealedHex } },
    { body: { revision: 6 } },
    { body: [] },
  ]);
  calls.length = 0;
  await recordSync.changeMasterPassword('old-password', 'brand-new-password');
  assert.notEqual(vault.meta.salt, '11'.repeat(16));
  const put = calls.find(call => call.options.method === 'PUT');
  const body = JSON.parse(put.options.body);
  assert.equal(body.revision, 6);
  assert.equal(body.expected_prior_revision, 5);
  // Re-key PUTs are sealed before the salt commit, so they carry the old
  // identity; the vault itself must end up on the new salt.
  assert.equal(body.deployment_id, '11'.repeat(16));
});

test('changeMasterPassword rejects a wrong current password', async () => {
  vault.meta = { created: true, salt: '22'.repeat(16), vaultId: 'ef'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('real-password', vault.meta.salt);
  const dto = await recordSync.sealAsDto('acme', '{}', 1);
  stubFetch([
    { body: [{ record_id: 'acme', revision: 1, tombstone: false }] },
    { body: dto },
  ]);
  await assert.rejects(
    () => recordSync.changeMasterPassword('wrong-current', 'next-password'),
    error => /PM-KERNEL-/.test(String(error.message)),
  );
});
