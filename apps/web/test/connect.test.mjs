/**
 * Connect / Sign-in gate tests (UX-ONB-003).
 *
 * The gate is decided solely by the service: an explicit 401 from an
 * unauthenticated records probe means a session is required; any other
 * outcome defers to the existing unlock error paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbeStatus, SESSION_GATE, readStoredToken } from '../src/views/connect.js';
import { STORAGE_KEYS } from '../src/config.js';

test('only an explicit 401 gates the client behind Connect / Sign in', () => {
  assert.equal(classifyProbeStatus(401), SESSION_GATE.authRequired);
  for (const status of [200, 204, 400, 403, 404, 429, 500, 503, 0]) {
    assert.equal(classifyProbeStatus(status), SESSION_GATE.open,
      `status ${status} defers to the unlock error paths`);
  }
});

test('the stored connection token comes from the shared storage key', () => {
  assert.equal(STORAGE_KEYS.apiToken, 'veyora-api-token');
  assert.equal(STORAGE_KEYS.apiUrl, 'veyora-api-url');
  globalThis.localStorage = {
    getItem: (key) => (key === STORAGE_KEYS.apiToken ? 'stored-token' : null),
  };
  assert.equal(readStoredToken(), 'stored-token');
  delete globalThis.localStorage;
  assert.equal(readStoredToken(), null, 'no storage means no stored token');
});
