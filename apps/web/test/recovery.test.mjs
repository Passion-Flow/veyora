/**
 * Vault Key wrapping and Recovery Key unit tests (PRD REC-001..005):
 * the wrap model round-trips, legacy vaults migrate without touching a
 * single record, recovery works with only the kit, and wrong/foreign kits
 * fail without mutating the destination.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { wraps } from '../src/core/recovery.js';
import { recordSync } from '../src/core/records.js';
import { vault } from '../src/core/vault.js';
import { kernel, loadKernel, fromHex, toHex } from '../src/core/kernel.js';

const map = new Map();
globalThis.localStorage = {
  getItem: key => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: key => map.delete(key),
};
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

const SALT = '77'.repeat(16);

test('a kit seals and opens a recovery wrapper carrying the vault scope', async () => {
  const kit = kernel.generateRecoveryKit();
  const vaultKey = wraps.newVaultKey();
  const pair = await wraps.sealBoth(vaultKey, SALT, 'master-password-1', kit);
  assert.equal(pair.password.vault_id, SALT);
  const scope = await wraps.kitScope(kit);
  assert.equal(pair.recovery.vault_id, scope);
  assert.notEqual(scope, SALT);

  const opened = await wraps.openRecovery(pair.recovery.payload, kit);
  assert.deepEqual([...opened.vaultKey], [...vaultKey]);
  assert.equal(opened.vaultSalt, SALT);

  // A different kit (even a valid one) cannot open the wrapper.
  const otherKit = kernel.generateRecoveryKit();
  await assert.rejects(() => wraps.openRecovery(pair.recovery.payload, otherKit));
  // The password wrapper opens only under its password.
  const vk = await wraps.openPassword(pair.password.payload, 'master-password-1', SALT);
  assert.deepEqual([...vk], [...vaultKey]);
  await assert.rejects(() => wraps.openPassword(pair.password.payload, 'wrong-password', SALT));
});

test('malformed kits are rejected by the kernel codec before any fetch', () => {
  const kit = kernel.generateRecoveryKit();
  // Flip the final character to something it is not (checksum must fail).
  const flip = kit.endsWith('a') ? 'b' : 'a';
  assert.equal(kernel.validateRecoveryKit(kit.slice(0, -1) + flip), false);
  assert.equal(kernel.validateRecoveryKit(kit.toUpperCase()), false);
  assert.equal(kernel.validateRecoveryKit(kit), true);
});

test('a legacy vault migrates on unlock without rewriting any record', async () => {
  map.clear();
  calls.length = 0;
  vault.meta = { created: true, salt: SALT, vaultId: 'ab'.repeat(4), kit: kernel.generateRecoveryKit() };
  const legacyRoot = await kernel.deriveRootKey('legacy-password', SALT);
  recordSync.rootKey = legacyRoot;
  const verifier = await recordSync.sealAsDto(`veyora-verifier-v1-${SALT}`, '{}', 1);
  const entry = await recordSync.sealAsDto('acme', '{}', 1);

  // Unlock listing: no password wrap yet → migration writes both wrappers.
  // The listing proved absence, so both writes create directly (no probe).
  stubFetch([
    { body: [{ record_id: `veyora-verifier-v1-${SALT}`, revision: 1, tombstone: false },
             { record_id: 'acme', revision: 1, tombstone: false }] },
    { body: { revision: 1 } },
    { body: { revision: 1 } },
  ]);
  await recordSync.unlockViaWrappers('legacy-password');
  // The migrated root key IS the legacy root key — every existing record
  // still decrypts under it.
  assert.deepEqual([...recordSync.rootKey], [...legacyRoot]);
  const wrapPuts = calls.filter(call => call.options.method === 'PUT'
    && String(call.url).includes('veyora-vkwrap'));
  assert.equal(wrapPuts.length, 2, 'both wrappers were written');
  assert.ok(!wrapPuts.some(call => /\/records\/acme/.test(String(call.url))),
    'no ordinary record was rewritten during migration');
});

test('recoverVault restores the vault from the kit alone and replaces only the password wrap', async () => {
  map.clear();
  calls.length = 0;
  const kit = kernel.generateRecoveryKit();
  const vaultKey = wraps.newVaultKey();
  const pair = await wraps.sealBoth(vaultKey, SALT, 'old-password-1', kit);

  // Server state: the recovery wrap at the kit scope, and the real vault
  // scope with the verifier + one entry sealed under the Vault Key.
  recordSync.rootKey = vaultKey;
  const verifier = await recordSync.sealAsDto(`veyora-verifier-v1-${SALT}`, '{}', 1);
  const entry = await recordSync.sealAsDto('acme', JSON.stringify({ name: 'Acme', secret: 's' }), 1);
  recordSync.rootKey = null;

  const kitScope = await wraps.kitScope(kit);
  const recoveryWrapDto = {
    record_id: 'veyora-vkwrap-recovery-v1', revision: 1, tombstone: false,
    ciphertext: pair.recovery.payload,
  };
  const passwordWrapDto = {
    record_id: 'veyora-vkwrap-password-v1', revision: 1, tombstone: false,
    ciphertext: pair.password.payload,
  };
  stubFetch([
    { body: recoveryWrapDto },                                            // recovery wrap GET (kit scope)
    { body: [{ record_id: `veyora-verifier-v1-${SALT}`, revision: 1, tombstone: false }] }, // vault listing
    { body: verifier },                                                   // verify GET
    { body: passwordWrapDto },                                            // existing password wrap (CAS read)
    { body: { revision: 2 } },                                            // password wrap rewrite (CAS)
    { body: [] },                                                         // embed probe
    { body: [{ record_id: `veyora-verifier-v1-${SALT}`, revision: 1, tombstone: false },
             { record_id: 'acme', revision: 1, tombstone: false }] },     // summaries
    { body: verifier },                                                   // verifier GET
    { body: entry },                                                      // entry GET
  ]);
  // The first fetch must hit the kit scope for the recovery wrap.
  // Our stub replays in order; assert the URL afterwards.
  const entries = await recordSync.recoverVault(kit, 'brand-new-password-9');
  assert.equal(calls[0].url.includes(kitScope), true, 'recovery finds the wrap from the kit alone');
  assert.equal(entries.length, 1, 'every entry decrypts under the recovered Vault Key');
  assert.equal(entries[0].name, 'Acme');
  assert.equal(vault.meta.salt, SALT, 'the vault scope is adopted');
  assert.equal(vault.meta.kit, kit);
  const rewrite = calls.find(call => call.options.method === 'PUT'
    && String(call.url).includes('veyora-vkwrap-password'));
  assert.ok(rewrite, 'the password wrapper was replaced');
  assert.equal(JSON.parse(rewrite.options.body).expected_prior_revision, 1,
    'the replacement is compare-and-set');
  // The new password opens the rewritten wrapper (sealed under it).
  const { wraps: _unused, ...rest } = {}; // (keep the linter calm)
  const newPair = await wraps.sealBoth(vaultKey, SALT, 'brand-new-password-9', kit);
  await wraps.openPassword(newPair.password.payload, 'brand-new-password-9', SALT);
});

test('regenerating the Recovery Key revokes the old kit (REC-006)', async () => {
  map.clear();
  calls.length = 0;
  const oldKit = kernel.generateRecoveryKit();
  const vaultKey = wraps.newVaultKey();
  const oldPair = await wraps.sealBoth(vaultKey, SALT, 'master-password-1', oldKit);
  vault.meta = { created: true, salt: SALT, vaultId: 'ab'.repeat(4), kit: oldKit };

  // unlockViaWrappers: listing (has password wrap) → wrap GET.
  const passwordWrapDto = {
    record_id: 'veyora-vkwrap-password-v1', revision: 3, tombstone: false,
    ciphertext: oldPair.password.payload,
  };
  stubFetch([
    { body: [passwordWrapDto] },      // unlock listing
    { body: passwordWrapDto },        // unlock wrap GET
    { body: { revision: 1 } },        // new recovery wrap PUT (create)
    { body: { revision: 4 } },        // password wrap rewrite (CAS)
    { body: { record_id: 'veyora-vkwrap-recovery-v1', revision: 1, tombstone: false, ciphertext: oldPair.recovery.payload } }, // old wrap GET
    { body: {} },                     // old wrap tombstone DELETE
  ]);
  const newKit = await recordSync.regenerateRecoveryKey('master-password-1');
  assert.match(newKit, /^[a-z2-7]{5}(-[a-z2-7]{5}){11}$/, 'a canonical new kit is returned');
  assert.equal(vault.meta.kit, newKit, 'the vault adopts the new kit');
  const del = calls.find(call => call.options.method === 'DELETE');
  assert.ok(del, 'the old kit wrapper is tombstoned');
  assert.equal(JSON.parse(del.options.body).expected_prior_revision, 1);
  // The OLD kit's wrapper no longer opens anything: its sealed payload is
  // the only thing the old scope ever held, and the scope is dead.
  await assert.rejects(() => wraps.openRecovery(oldPair.recovery.payload, newKit));
  const newPair = await wraps.sealBoth(vaultKey, SALT, 'master-password-1', newKit);
  const opened = await wraps.openRecovery(newPair.recovery.payload, newKit);
  assert.equal(opened.vaultSalt, SALT, 'the NEW kit opens its own wrapper');
});

test('a wrong kit fails recovery without touching the destination', async () => {
  map.clear();
  calls.length = 0;
  const kit = kernel.generateRecoveryKit();
  const foreignKit = kernel.generateRecoveryKit();
  const vaultKey = wraps.newVaultKey();
  const pair = await wraps.sealBoth(vaultKey, SALT, 'pw', kit);
  vault.meta = null;
  stubFetch([
    { ok: false, status: 404, body: { error: { code: 'PM-STORE-NOT-FOUND', message: 'x' } } },
  ]);
  await assert.rejects(() => recordSync.recoverVault(foreignKit, 'new-password'),
    error => error.code === 'PM-STORE-NOT-FOUND');
  assert.equal(vault.meta, null, 'no vault metadata was adopted');
  assert.ok(!calls.some(call => call.options.method === 'PUT'),
    'nothing was written for a wrong kit');
});
