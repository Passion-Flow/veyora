/**
 * Reset-matrix unit tests (PRD DATA-009): every destructive action deletes
 * exactly its own scope, and a failed service deletion never removes the
 * local vault (no unreachable orphan can be created by accident).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { clearLocalMetadata, clearConnectedCache, removeLocalVault, deleteVaultEverywhere }
  from '../src/core/reset.js';
import { STORAGE_KEYS } from '../src/config.js';
import { vault } from '../src/core/vault.js';
import { recordSync } from '../src/core/records.js';
import { pendingQueue } from '../src/core/pending-queue.js';
import { kernel, loadKernel } from '../src/core/kernel.js';

// Node has no localStorage; vault storage and the pending queue need one.
const map = new Map();
globalThis.localStorage = {
  getItem: key => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: key => map.delete(key),
};

// The production loader fetches the checked-in wasm module by file URL.
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
    return {
      ok: next.ok !== false,
      status: next.status ?? 200,
      headers: { get: name => (next.headers || {})[name] ?? null },
      json: async () => next.body,
    };
  };
}

const SALT = '55'.repeat(16);

function seedVault() {
  map.clear();
  calls.length = 0;
  vault.meta = { created: true, salt: SALT, vaultId: 'ab'.repeat(4) };
  map.set(STORAGE_KEYS.vault, JSON.stringify(vault.meta));
}

test('local metadata clear removes only preference keys (DATA-009)', () => {
  seedVault();
  for (const key of [
    STORAGE_KEYS.theme, STORAGE_KEYS.locale, STORAGE_KEYS.trashRetention,
    STORAGE_KEYS.startHere, STORAGE_KEYS.firstSuccess, STORAGE_KEYS.lastSync,
    'veyora.web.sort', 'veyora.web.nav', STORAGE_KEYS.apiUrl, STORAGE_KEYS.apiToken,
  ]) {
    map.set(key, 'x');
  }
  clearLocalMetadata();
  for (const key of [
    STORAGE_KEYS.theme, STORAGE_KEYS.locale, STORAGE_KEYS.trashRetention,
    STORAGE_KEYS.startHere, STORAGE_KEYS.firstSuccess, STORAGE_KEYS.lastSync,
    'veyora.web.sort', 'veyora.web.nav',
  ]) {
    assert.ok(!map.has(key), `${key} cleared`);
  }
  // Vault material and the connection override are OTHER scopes.
  assert.ok(map.has(STORAGE_KEYS.vault), 'the vault record survives');
  assert.ok(map.has(STORAGE_KEYS.apiUrl), 'the saved connection survives');
});

test('connected cache clear removes only the saved connection (DATA-009)', () => {
  seedVault();
  map.set(STORAGE_KEYS.apiUrl, 'https://veyora.example');
  map.set(STORAGE_KEYS.apiToken, 'tok');
  clearConnectedCache();
  assert.ok(!map.has(STORAGE_KEYS.apiUrl) && !map.has(STORAGE_KEYS.apiToken));
  assert.ok(map.has(STORAGE_KEYS.vault), 'the vault record survives');
});

test('local vault removal drops queued writes with the vault record', async () => {
  seedVault();
  recordSync.rootKey = await kernel.deriveRootKey('reset-password', SALT);
  pendingQueue.enqueue(SALT, { record_id: 'queued', revision: 1 });
  assert.equal(pendingQueue.pendingIds(SALT).length, 1);
  removeLocalVault();
  assert.ok(!map.has(STORAGE_KEYS.vault), 'the vault record is gone');
  assert.equal(pendingQueue.pendingIds(SALT).length, 0, 'queued writes are dropped');
});

test('delete-everywhere tombstones every live row (verifier included) then purges', async () => {
  seedVault();
  recordSync.rootKey = await kernel.deriveRootKey('reset-password', SALT);
  stubFetch([
    { body: [                                        // listing: verifier + one entry
      { record_id: `veyora-verifier-v1-${SALT}`, revision: 1, tombstone: false },
      { record_id: 'acme', revision: 4, tombstone: false },
    ] },
    { body: { revision: 2 } },                       // verifier tombstone
    { body: { revision: 5 } },                       // entry tombstone
    { body: { purged: 2 } },                         // vault purge
  ]);
  const result = await deleteVaultEverywhere();
  assert.deepEqual(result, { tombstoned: 2, purged: 2 });
  const deletes = calls.filter(call => call.options.method === 'DELETE');
  assert.equal(deletes.length, 2, 'both live rows are tombstoned');
  assert.ok(deletes.some(call => call.url.includes(`veyora-verifier-v1-${SALT}`)),
    'the reserved verifier row is deleted too — no silent orphan');
  const purge = calls.find(call => call.url.includes('/vault/purge'));
  assert.ok(purge, 'the vault scope is purged');
  assert.ok(!map.has(STORAGE_KEYS.vault), 'the local vault is removed after the service');
});

test('a failed service deletion leaves the local vault untouched (DATA-009)', async () => {
  seedVault();
  recordSync.rootKey = await kernel.deriveRootKey('reset-password', SALT);
  stubFetch([
    { body: [{ record_id: 'acme', revision: 1, tombstone: false }] },
    { ok: false, status: 409, body: { error: { code: 'PM-STORE-CONFLICT', message: 'x' } } },
  ]);
  await assert.rejects(() => deleteVaultEverywhere());
  assert.ok(map.has(STORAGE_KEYS.vault),
    'the local vault survives a failed service deletion');
  const purge = calls.find(call => call.url.includes('/vault/purge'));
  assert.ok(!purge, 'the purge never runs after a failed tombstone');
});
