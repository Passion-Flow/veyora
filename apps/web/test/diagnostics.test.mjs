/**
 * Diagnostics unit tests (DIAG-001): the safe-summary sources never leak
 * secrets, full URLs, or connection tokens, and the sync stamp round-trips.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The diagnostics module reads localStorage through the storage helper;
// provide a minimal host before importing.
const store = new Map();
globalThis.localStorage = {
  getItem: k => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, v),
  removeItem: k => store.delete(k),
};
globalThis.window = {
  location: { host: 'vault.example', hostname: 'vault.example', port: '', origin: 'https://vault.example' },
};

const diagnostics = await import('../src/data/diagnostics.js');

test('markSynced records a bare ISO timestamp and nothing else (DIAG-001)', () => {
  diagnostics.markSynced();
  const iso = diagnostics.lastSyncIso();
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(iso), 'stored value is a plain timestamp');
  assert.equal(store.size, 1, 'exactly one diagnostics value is stored');
  assert.ok(JSON.stringify([...store.values()]).indexOf('secret') === -1,
    'no secret-like material in stored diagnostics values');
});

test('serviceHost returns only the origin host, never a path or token', () => {
  // The relative default base resolves to the page host.
  assert.equal(diagnostics.serviceHost(), 'vault.example');
  assert.equal(String(diagnostics.serviceHost()).includes('/'), false,
    'the summary never contains a path');
});

test('buildCommit is null when the image was not stamped', () => {
  assert.equal(diagnostics.buildCommit(), null, 'no window stamp in tests');
});

test('serviceHealth classifies a failing endpoint as unreachable', async () => {
  globalThis.fetch = async () => { throw new Error('down'); };
  assert.equal(await diagnostics.serviceHealth(), 'unreachable');
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  assert.equal(await diagnostics.serviceHealth(), 'unhealthy');
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  assert.equal(await diagnostics.serviceHealth(), 'ok');
});

test('desktop runtime reports an honest local-vault mode and storage (DIAG-001)', () => {
  globalThis.window.VEYORA_DESKTOP = true;
  try {
    assert.equal(diagnostics.isDesktopRuntime(), true);
    // The desktop loopback host must never surface as a storage summary.
    const bundle = diagnostics.buildSupportBundle('ok');
    assert.match(bundle, /mode: desktop-local-vault/);
    assert.match(bundle, /storage: local vault on this device/);
    assert.ok(!bundle.includes('service-host:'), 'no service-host line on desktop');
    assert.ok(!bundle.includes('127.0.0.1'), 'no loopback host in the desktop bundle');
  } finally {
    delete globalThis.window.VEYORA_DESKTOP;
  }
  assert.equal(diagnostics.isDesktopRuntime(), false);
  assert.match(diagnostics.buildSupportBundle('ok'), /mode: connected-vault/);
});

test('support bundle reports safe facts only (DIAG-002 canary)', () => {
  // Seed every secret-bearing store the app persists, then prove none of
  // it can reach the bundle: connection overrides, a credential-looking
  // sync stamp, and a stamped build id are all present in this session.
  store.set('veyora-api-url', 'https://vault.example/api?token=topsecret-token-value');
  store.set('veyora-api-token', 'topsecret-token-value');
  store.set('veyora.web.lastSync', '2026-09-04T12:00:00.000Z');
  globalThis.window.VEYORA_BUILD_COMMIT = 'deadbeefcafe';

  const bundle = diagnostics.buildSupportBundle('ok');
  assert.match(bundle, /Veyora support bundle/);
  assert.match(bundle, /version: /);
  assert.match(bundle, /build: deadbeefcafe/);
  assert.match(bundle, /mode: connected-vault/);
  assert.match(bundle, /service-host: vault\.example/);
  assert.match(bundle, /service-health: ok/);
  assert.match(bundle, /last-sync: 2026-09-04T12:00:00\.000Z/);
  assert.match(bundle, /last-verified-backup: not-available/);
  // Canary: no token, no full URL, no query string, no credential store
  // values anywhere in the bundle text.
  assert.ok(!bundle.includes('topsecret-token-value'), 'connection token is absent');
  assert.ok(!bundle.includes('https://'), 'full URLs are absent');
  assert.ok(!bundle.includes('?'), 'query strings are absent');
  assert.ok(!bundle.includes('/api'), 'paths are absent');
});

test('vaultIdentity reports the device on desktop, the origin host only when connected (PRD 6.3)', () => {
  globalThis.window.VEYORA_DESKTOP = true;
  try {
    const desktop = diagnostics.vaultIdentity();
    assert.equal(desktop.kind, 'desktop');
    assert.equal(desktop.host, null, 'no host on desktop — loopback is meaningless');
  } finally {
    delete globalThis.window.VEYORA_DESKTOP;
  }
  const connected = diagnostics.vaultIdentity();
  assert.equal(connected.kind, 'connected');
  assert.equal(connected.host, 'vault.example');
  assert.ok(!String(connected.host).includes('/'), 'identity carries a host, never a URL or path');
});
