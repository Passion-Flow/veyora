/**
 * Record-sync unit tests: envelope building (via a stubbed fetch), error
 * code mapping, plaintext stripping, and vault metadata persistence through
 * the safe storage layer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { recordSync } from '../src/core/records.js';
import { vault } from '../src/core/vault.js';
import { kernel, loadKernel, toHex, fromHex } from '../src/core/kernel.js';
import { pendingQueue } from '../src/core/pending-queue.js';

// Node has no localStorage; the pending queue needs one for these tests.
const map = new Map();
globalThis.localStorage = {
  getItem: key => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: key => map.delete(key),
};

// The production loader intentionally has no test adapter. Make Node's fetch
// understand the checked-in file URL, then initialize the same WASM module
// used by browsers before exercising record boundaries.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async resource => {
  const url = resource instanceof URL ? resource : new URL(resource);
  if (url.protocol === 'file:') {
    const bytes = await readFile(fileURLToPath(url));
    return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
  }
  return nativeFetch(resource);
};
await loadKernel();
globalThis.fetch = nativeFetch;

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
      headers: { get: name => (next.headers || {})[name] ?? null },
      json: async () => next.body,
    };
  };
}


/** URL without its query string (scoped calls append ?vault=). */
const path = url => String(url).split('?')[0];

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

  const canary = 'INERT-KNOWN-PLAINTEXT-CANARY';
  const entry = { id: 'acme', name: 'Acme', secret: canary, revision: 6 };
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
  assert.equal(fromHex(body.ciphertext).length >= 24 + canary.length + 16, true);
  assert.equal(
    body.ciphertext.includes(toHex(new TextEncoder().encode(canary))),
    false,
    'known plaintext must not appear in the network ciphertext envelope',
  );
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

test('vault metadata persists through the safe storage layer', () => {  vault.reset();
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
    // Call order: batch POST consumes the exact-count success shape first.
    { body: { requested: 1, committed: 1, results: [{ record_id: 'acme', revision: 1 }] } },
    { body: [] }, // embed probe: server answers summaries-only (empty here)
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
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  };

  const imported = await recordSync.importCsv(csv);
  assert.equal(imported, 1);
  const batch = calls.find(call => call.options.method === 'POST');
  assert.ok(batch.url.endsWith('/records/batch'));
  const dto = JSON.parse(batch.options.body)[0];
  assert.equal(dto.record_id, 'acme');
  assert.match(dto.ciphertext, /^[0-9a-f]+$/);

  // A batch failure aborts with the server's stable code — the
  // all-or-nothing batch (DATA-007) surfaces conflicts through the error
  // envelope with nothing applied. (Entries from the first phase are
  // cleared: re-importing the same id is rejected by design before any
  // network call.)
  vault.entries = [];
  stubFetch([{ ok: false, status: 409, body: { error: { code: 'PM-STORE-CONFLICT' } } }]);
  await assert.rejects(
    () => recordSync.importCsv(csv),
    error => error.code === 'PM-STORE-CONFLICT',
  );
});

test('changeMasterPassword re-keys the vault atomically through /vault/rekey', async () => {
  vault.reset();
  const oldSalt = '11'.repeat(16);
  vault.meta = { created: true, salt: oldSalt, vaultId: 'cd'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('old-password', oldSalt);

  const sealedOld = await recordSync.sealAsDto('acme', JSON.stringify({ name: 'Acme', secret: 's' }), 5);
  const sealedVerifier = await recordSync.sealAsDto(`veyora-verifier-v1-${oldSalt}`, '{}', 1);

  // Stubs in exact call order: verify list → verify GET → inventory list →
  // inventory GET ×2 (entry + verifier) → rekey POST → final fetchAll.
  stubFetch([
    { body: [] },                                                            // wrap probe: legacy vault
    { body: [{ record_id: `veyora-verifier-v1-${oldSalt}`, revision: 1, tombstone: false },
             { record_id: 'acme', revision: 5, tombstone: false }] },        // verify list
    { body: sealedVerifier },                                                // verify GET
    { body: [{ record_id: `veyora-verifier-v1-${oldSalt}`, revision: 1, tombstone: false },
             { record_id: 'acme', revision: 5, tombstone: false }] },        // inventory list
    { body: sealedVerifier },                                                // inventory GET 1
    { body: sealedOld },                                                     // inventory GET 2
    { body: { moved: 2 } },                                                  // rekey POST
    { body: [] },                                                            // embed probe (final fetchAll)
    { body: [] },                                                            // summaries (final)
  ]);
  calls.length = 0;
  await recordSync.changeMasterPassword('old-password', 'brand-new-password');

  const nextSalt = vault.meta.salt;
  assert.notEqual(nextSalt, oldSalt, 'the vault commits the new salt');
  assert.equal(vault.meta.pendingRekey, undefined, 'no pending marker survives adoption');

  const rekey = calls.find(call => call.options.method === 'POST');
  assert.ok(rekey.url.includes('/vault/rekey'), 'the change is one atomic rekey request');
  assert.ok(rekey.url.includes(`vault=${oldSalt}`), 'the source scope is the old salt');
  const body = JSON.parse(rekey.options.body);
  assert.equal(body.to_vault, nextSalt);
  assert.equal(body.records.length, 2);
  // Every row is sealed for the target scope with a fresh identity — the
  // verifier's id moves to the new salt's derived id.
  assert.ok(body.records.every(row => row.vault_id === nextSalt && row.revision === 1));
  assert.ok(body.records.some(row => row.record_id === `veyora-verifier-v1-${nextSalt}`));
});

test('a rekey preserves Trash state — no entry is resurrected', async () => {
  vault.reset();
  const oldSalt = '35'.repeat(16);
  vault.meta = { created: true, salt: oldSalt, vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('old-password', oldSalt);
  const verifier = await recordSync.sealAsDto(`veyora-verifier-v1-${oldSalt}`, '{}', 1);
  const live = await recordSync.sealAsDto('live-one', '{}', 2);
  const trashed = await recordSync.sealAsDto('trashed-one', '{}', 3);
  stubFetch([
    { body: [] },                                                            // wrap probe: legacy vault
    { body: [{ record_id: `veyora-verifier-v1-${oldSalt}`, revision: 1, tombstone: false }] },
    { body: verifier },
    { body: [
      { record_id: `veyora-verifier-v1-${oldSalt}`, revision: 1, tombstone: false },
      { record_id: 'live-one', revision: 2, tombstone: false },
      { record_id: 'trashed-one', revision: 3, tombstone: true },
    ] },
    { body: verifier },
    { body: live },
    { body: trashed },
    { body: { moved: 3 } },
    { body: [] },
    { body: [] },
  ]);
  calls.length = 0;
  await recordSync.changeMasterPassword('old-password', 'fresh-password-2');
  const rekey = calls.find(call => call.options.method === 'POST');
  const rows = JSON.parse(rekey.options.body).records;
  const trashedRow = rows.find(row => row.record_id === 'trashed-one');
  assert.equal(trashedRow.tombstone, true, 'a tombstoned row stays tombstoned');
  assert.ok(rows.find(row => row.record_id === 'live-one').tombstone === false);
});

test('a failed rekey keeps the old scope and password authoritative', async () => {
  vault.reset();
  const oldSalt = '22'.repeat(16);
  vault.meta = { created: true, salt: oldSalt, vaultId: 'ef'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('real-password', oldSalt);
  const sealedVerifier = await recordSync.sealAsDto(`veyora-verifier-v1-${oldSalt}`, '{}', 1);
  stubFetch([
    { body: [] },                                                            // wrap probe: legacy vault
    { body: [{ record_id: `veyora-verifier-v1-${oldSalt}`, revision: 1, tombstone: false }] },
    { body: sealedVerifier },
    { body: [{ record_id: `veyora-verifier-v1-${oldSalt}`, revision: 1, tombstone: false }] },
    { body: sealedVerifier },
    { ok: false, status: 503, body: { error: { code: 'PM-STORE-UNAVAILABLE', message: 'x' } } },
  ]);
  await assert.rejects(
    () => recordSync.changeMasterPassword('real-password', 'next-password'),
    error => error.code === 'PM-STORE-UNAVAILABLE',
  );
  assert.equal(vault.meta.salt, oldSalt, 'the device keeps the old salt');
  assert.equal(vault.meta.pendingRekey, undefined, 'the pending marker clears on failure');
});

test('resolvePendingRekey adopts a committed target scope and falls back cleanly', async () => {
  vault.reset();
  const fromSalt = '33'.repeat(16);
  const toSalt = '34'.repeat(16);
  vault.meta = { created: true, salt: fromSalt, vaultId: 'ab'.repeat(4), pendingRekey: { from: fromSalt, to: toSalt } };

  // Committed: the target scope holds a verifier row sealed under the NEW
  // password + target salt, and it decrypts.
  const newRoot = await kernel.deriveRootKey('next-password', toSalt);
  const previousKey = recordSync.rootKey;
  recordSync.rootKey = newRoot;
  const committedVerifier = await recordSync.sealForScope(`veyora-verifier-v1-${toSalt}`, '{}', 1, toSalt);
  recordSync.rootKey = previousKey;

  stubFetch([
    { body: [{ record_id: `veyora-verifier-v1-${toSalt}`, revision: 1, tombstone: false }] },
    { body: committedVerifier },
  ]);
  const adopted = await recordSync.resolvePendingRekey('next-password');
  assert.equal(adopted, toSalt, 'a committed target scope is adopted');
  assert.equal(vault.meta.salt, toSalt);
  assert.equal(vault.meta.pendingRekey, undefined);

  // Not committed: the target scope answers empty — the old salt stands.
  vault.meta = { created: true, salt: fromSalt, vaultId: 'ab'.repeat(4), pendingRekey: { from: fromSalt, to: toSalt } };
  stubFetch([{ body: [] }]);
  const kept = await recordSync.resolvePendingRekey('old-password');
  assert.equal(kept, fromSalt, 'an uncommitted rekey falls back to the old salt');
  assert.equal(vault.meta.pendingRekey, undefined, 'the stale marker clears');
});

test('changeMasterPassword rejects a wrong current password', async () => {
  vault.meta = { created: true, salt: '22'.repeat(16), vaultId: 'ef'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('real-password', vault.meta.salt);
  const dto = await recordSync.sealAsDto('acme', '{}', 1);
  stubFetch([
    { body: [] },                                                            // wrap probe: legacy vault
    { body: [{ record_id: 'acme', revision: 1, tombstone: false }] },
    { body: dto },
  ]);
  await assert.rejects(
    () => recordSync.changeMasterPassword('wrong-current', 'next-password'),
    error => /PM-KERNEL-/.test(String(error?.message ?? error)),
  );
});

test('fetchAll and fetchTrash scope to this vault on a shared store', async () => {
  const ownSalt = 'aa'.repeat(16);
  const foreignSalt = 'bb'.repeat(16);
  vault.meta = { created: true, salt: ownSalt, vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('own-password', ownSalt);

  const ownVerifier = await recordSync.sealAsDto('veyora-verifier-v1', '{}', 1);
  const ownEntry = await recordSync.sealAsDto('acme', JSON.stringify({ name: 'Acme', secret: 's' }), 1);
  const ownTrash = await recordSync.sealAsDto('old-one', JSON.stringify({ name: 'Old' }), 3);
  ownTrash.tombstone = true;

  // Foreign-vault records sealed under an unrelated key. They are listed
  // FIRST: a naive verifier lookup would decrypt the foreign verifier,
  // fail, and lock this vault out of its own store.
  vault.meta = { created: true, salt: foreignSalt, vaultId: 'cd'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('other-password', foreignSalt);
  const foreignVerifier = await recordSync.sealAsDto('veyora-verifier-v1', '{}', 1);
  const foreignEntry = await recordSync.sealAsDto('beta', '{}', 1);

  vault.meta = { created: true, salt: ownSalt, vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('own-password', ownSalt);

  stubFetch([
    { body: [foreignVerifier, foreignEntry, ownVerifier, ownEntry] }, // embed list
    { body: ownVerifier },                                            // verifier GET (legacy id)
    { body: { revision: 1 } },                                        // migration: scoped PUT
    { body: ownVerifier },                                            // migration: legacy GET
    { body: {} },                                                     // migration: legacy tombstone
  ]);
  const entries = await recordSync.fetchAll();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Acme');
  // The legacy verifier migrates onto this vault's scoped id (DATA-003).
  const migrationPut = calls.find(call =>
    call.options.method === 'PUT' && path(call.url).endsWith(`/records/veyora-verifier-v1-${ownSalt}`));
  assert.ok(migrationPut, 'the scoped verifier is written during unlock');

  stubFetch([{ body: [foreignEntry, ownTrash] }]);
  const trash = await recordSync.fetchTrash();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].name, 'Old');
});

test('summaries fallback scopes vault after full-record GETs', async () => {
  // Mirrors the real RecordSummaryDto shape: no vault_id, no ciphertext.
  const ownSalt = 'cc'.repeat(16);
  const foreignSalt = 'dd'.repeat(16);
  vault.meta = { created: true, salt: ownSalt, vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('own-password', ownSalt);

  const ownVerifier = await recordSync.sealAsDto('veyora-verifier-v1', '{}', 1);
  const ownEntry = await recordSync.sealAsDto('acme', JSON.stringify({ name: 'Acme', secret: 's' }), 1);
  vault.meta = { created: true, salt: foreignSalt, vaultId: 'cd'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('other-password', foreignSalt);
  const foreignVerifier = await recordSync.sealAsDto('veyora-verifier-v1', '{}', 1);
  const foreignEntry = await recordSync.sealAsDto('beta', '{}', 1);
  vault.meta = { created: true, salt: ownSalt, vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('own-password', ownSalt);

  const summary = record => ({ record_id: record.record_id, revision: record.revision, tombstone: false, ciphertext_hash: record.ciphertext_hash });
  stubFetch([
    { body: [summary(foreignVerifier)] },                              // embed probe: summaries-shaped
    { body: [summary(foreignVerifier), summary(ownVerifier), summary(foreignEntry), summary(ownEntry)] }, // listing
    { body: foreignVerifier },                                         // verify candidate 1 (foreign → skipped)
    { body: ownVerifier },                                             // verify candidate 2 (own → decrypt ok)
    { body: { revision: 1 } },                                         // migration: scoped PUT
    { body: ownVerifier },                                             // migration: legacy GET
    { body: {} },                                                      // migration: legacy tombstone
    { body: foreignEntry },                                            // entry GET (foreign → dropped)
    { body: ownEntry },                                                // entry GET (own → decrypted)
  ]);
  const entries = await recordSync.fetchAll();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Acme');
});

test('an offline save queues its sealed DTO and reports pending (ITEM-006)', async () => {
  map.clear();
  vault.meta = { created: true, salt: '33'.repeat(16), vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('offline-password', vault.meta.salt);
  const canary = 'OFFLINE-KNOWN-PLAINTEXT-CANARY';
  stubFetch([{ network: true }]);
  const entry = { id: 'offline-item', name: 'Offline', secret: canary, revision: 2 };
  await assert.rejects(
    () => recordSync.saveEntry(entry, 2),
    error => error.code === 'PM-NETWORK-UNREACHABLE' && error.queued === true,
  );
  assert.deepEqual(pendingQueue.pendingIds(vault.meta.salt), ['offline-item']);
  // The queue stores the sealed envelope only: no plaintext, no keys.
  const raw = map.get('veyora-pending-' + vault.meta.salt);
  assert.ok(!raw.includes(canary), 'plaintext never reaches the pending queue');
  assert.ok(!raw.includes('offline-password'));
  const queued = JSON.parse(raw)[0].dto;
  assert.equal(queued.record_id, 'offline-item');
  assert.equal(queued.expected_prior_revision, 2);
  assert.equal(queued.ciphertext_hash.length, 64);

  // Replaying online succeeds, clears the queue, and keeps the CAS metadata.
  calls.length = 0;
  stubFetch([{ body: { revision: 3 } }]);
  const result = await recordSync.flushPending();
  assert.deepEqual(result, { synced: 1, conflicts: 0, pending: 0 });
  const put = calls.find(call => call.options.method === 'PUT');
  assert.equal(JSON.parse(put.options.body).expected_prior_revision, 2);
  assert.deepEqual(pendingQueue.pendingIds(vault.meta.salt), []);
});

test('flushPending keeps the queue offline and drops entries the server rejects', async () => {
  map.clear();
  vault.meta = { created: true, salt: '44'.repeat(16), vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('offline-password', vault.meta.salt);
  stubFetch([{ network: true }, { network: true }]);
  await assert.rejects(() => recordSync.saveEntry({ id: 'a', name: 'A', revision: 1 }), error => error.queued);
  await assert.rejects(() => recordSync.saveEntry({ id: 'b', name: 'B', revision: 1 }), error => error.queued);
  assert.equal(pendingQueue.pendingIds(vault.meta.salt).length, 2);

  // Still offline: nothing is dropped, the loop stops at the first miss.
  stubFetch([{ network: true }]);
  let result = await recordSync.flushPending();
  assert.equal(result.pending, 2);

  // Online but the first record lost its compare-and-set race: the server is
  // authoritative, so that write is dropped and counted as a conflict.
  stubFetch([
    { ok: false, status: 409, body: { error: { code: 'PM-STORE-CONFLICT', message: 'x' } } },
    { body: { revision: 2 } },
  ]);
  result = await recordSync.flushPending();
  assert.deepEqual(result, { synced: 1, conflicts: 1, pending: 0 });
});

test('a newer offline edit replaces the earlier queued write for the same record', async () => {
  map.clear();
  vault.meta = { created: true, salt: '55'.repeat(16), vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('offline-password', vault.meta.salt);
  stubFetch([{ network: true }, { network: true }]);
  await assert.rejects(() => recordSync.saveEntry({ id: 'acme', name: 'Old', revision: 4 }, 4), error => error.queued);
  await assert.rejects(() => recordSync.saveEntry({ id: 'acme', name: 'New', revision: 5 }, 5), error => error.queued);
  const queued = pendingQueue.list(vault.meta.salt);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].dto.expected_prior_revision, 5);
});

test('fetchAll replays pending writes before reading the list', async () => {
  map.clear();
  vault.meta = { created: true, salt: '66'.repeat(16), vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('offline-password', vault.meta.salt);
  stubFetch([{ network: true }]);
  await assert.rejects(() => recordSync.saveEntry({ id: 'queued-one', name: 'Q', revision: 1 }), error => error.queued);

  const verifier = await recordSync.sealAsDto('veyora-verifier-v1', '{}', 1);
  stubFetch([
    { body: { revision: 2 } },                        // queued write replay (PUT)
    { body: [verifier] },                             // embed list
    { body: verifier },                               // verifier GET (legacy id)
    { body: { revision: 1 } },                        // migration: scoped PUT
    { body: verifier },                               // migration: legacy GET
    { body: {} },                                     // migration: legacy tombstone
  ]);
  calls.length = 0;
  await recordSync.fetchAll();
  assert.equal(calls[0].options.method, 'PUT', 'the offline write is replayed before the listing');
  assert.ok(calls[0].url.endsWith('/records/queued-one'));
});

test('ensureVerifier writes the per-vault scoped verifier id (DATA-003)', async () => {
  const saltA = '77'.repeat(16);
  const saltB = '76'.repeat(16);
  vault.meta = { created: true, salt: saltA, vaultId: 'aaaa' };
  recordSync.rootKey = await kernel.deriveRootKey('password-a', saltA);
  stubFetch([{ body: { revision: 1 } }]);
  calls.length = 0;
  await recordSync.ensureVerifier();
  let put = calls.find(call => call.options.method === 'PUT');
  assert.equal(JSON.parse(put.options.body).record_id, `veyora-verifier-v1-${saltA}`,
    'the verifier id is derived from this vault\'s salt');

  vault.meta = { created: true, salt: saltB, vaultId: 'bbbb' };
  recordSync.rootKey = await kernel.deriveRootKey('password-b', saltB);
  stubFetch([{ body: { revision: 1 } }]);
  await recordSync.ensureVerifier();
  put = calls.find(call => call.options.method === 'PUT' && path(call.url).endsWith(`/records/veyora-verifier-v1-${saltB}`));
  assert.equal(JSON.parse(put.options.body).record_id, `veyora-verifier-v1-${saltB}`,
    'a second vault never shares the first vault\'s verifier record id');
});

test('two vaults verify independently and an empty vault rejects a wrong password (DATA-003)', async () => {
  const saltA = 'ee'.repeat(16);
  const saltB = 'ff'.repeat(16);
  vault.meta = { created: true, salt: saltA, vaultId: 'aaaa' };
  recordSync.rootKey = await kernel.deriveRootKey('password-a', saltA);
  const verifierA = await recordSync.sealAsDto(`veyora-verifier-v1-${saltA}`, '{}', 1);
  vault.meta = { created: true, salt: saltB, vaultId: 'bbbb' };
  recordSync.rootKey = await kernel.deriveRootKey('password-b', saltB);
  const verifierB = await recordSync.sealAsDto(`veyora-verifier-v1-${saltB}`, '{}', 1);
  const entryB = await recordSync.sealAsDto('entry-b', '{}', 1);
  const summary = record => ({ record_id: record.record_id, revision: record.revision, tombstone: false });

  // Vault A is empty of entries yet still unlocks against its own scoped
  // verifier; vault B's rows in the same listing are never fetched.
  vault.meta = { created: true, salt: saltA, vaultId: 'aaaa' };
  recordSync.rootKey = await kernel.deriveRootKey('password-a', saltA);
  stubFetch([{ body: verifierA }]);
  calls.length = 0;
  await recordSync.verifyRootKey([summary(verifierB), summary(verifierA)]);
  assert.equal(calls.length, 1, 'only this vault\'s verifier is fetched');
  assert.ok(path(calls[0].url).endsWith(`/records/veyora-verifier-v1-${saltA}`));

  // A wrong master password fails against A's verifier — the empty vault
  // still rejects it because the scoped verifier cannot decrypt.
  recordSync.rootKey = await kernel.deriveRootKey('wrong-password', saltA);
  stubFetch([{ body: verifierA }]);
  await assert.rejects(() => recordSync.verifyRootKey([summary(verifierA)]));

  // The non-empty vault B verifies against its own scoped verifier.
  vault.meta = { created: true, salt: saltB, vaultId: 'bbbb' };
  recordSync.rootKey = await kernel.deriveRootKey('password-b', saltB);
  stubFetch([{ body: verifierB }]);
  await recordSync.verifyRootKey([summary(verifierA), summary(entryB), summary(verifierB)]);
});

test('a legacy global verifier migrates to the scoped id once it verifies (DATA-003)', async () => {
  const salt = '99'.repeat(16);
  vault.meta = { created: true, salt, vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('migrate-password', salt);
  const legacy = await recordSync.sealAsDto('veyora-verifier-v1', '{}', 1);
  stubFetch([
    { body: legacy },          // legacy verifier GET (decrypts under the key)
    { body: { revision: 1 } }, // migration: scoped verifier create
    { body: legacy },          // migration: legacy GET for its revision
    { body: {} },              // migration: legacy tombstone
  ]);
  calls.length = 0;
  await recordSync.verifyRootKey([{ record_id: 'veyora-verifier-v1', revision: 1, tombstone: false }]);
  const put = calls.find(call => call.options.method === 'PUT');
  assert.ok(path(put.url).endsWith(`/records/veyora-verifier-v1-${salt}`),
    'the scoped verifier id is salt-derived');
  assert.equal(JSON.parse(put.options.body).record_id, `veyora-verifier-v1-${salt}`);
  const del = calls.find(call => call.options.method === 'DELETE');
  assert.equal(JSON.parse(del.options.body).expected_prior_revision, 1,
    'the legacy verifier is tombstoned after the scoped one exists');
});

test('an already-scoped verifier never rewrites during unlock (DATA-003)', async () => {
  const salt = '88'.repeat(16);
  vault.meta = { created: true, salt, vaultId: 'ab'.repeat(4) };
  recordSync.rootKey = await kernel.deriveRootKey('scoped-password', salt);
  const scoped = await recordSync.sealAsDto(`veyora-verifier-v1-${salt}`, '{}', 1);
  stubFetch([{ body: scoped }]);
  calls.length = 0;
  await recordSync.verifyRootKey([{ record_id: scoped.record_id, revision: 1, tombstone: false }]);
  assert.ok(!calls.some(call => call.options.method === 'PUT'),
    'no migration writes for a vault already on the scoped id');
  assert.ok(!calls.some(call => call.options.method === 'DELETE'));
});
