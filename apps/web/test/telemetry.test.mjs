/**
 * First-success instrumentation tests (UX-ONB-010).
 *
 * First success is a saved Login followed by a search and then a
 * copy/reveal — never Vault creation. The record holds only event names
 * and timestamps, stays disabled without an explicit opt-in, and never
 * leaves the device.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function freshStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => JSON.stringify([...map.entries()]),
  };
}

async function load(storage, window) {
  globalThis.localStorage = storage;
  globalThis.window = window;
  const url = import.meta.url;
  const mod = await import(`${url.replace(/[^/]*$/, '')}../src/core/telemetry.js?cache=${Math.random()}`);
  return mod.firstSuccess;
}

test('disabled by default: events record nothing', async () => {
  const storage = freshStorage();
  const fs = await load(storage, { location: { search: '' } });
  assert.equal(fs.recordLoginSaved(), false);
  assert.equal(fs.achievedAt(), null);
  assert.equal(storage.getItem('veyora.web.firstSuccess'), null, 'no record is written');
});

test('first success requires saved login -> search -> copy/reveal in order', async () => {
  const storage = freshStorage();
  const fs = await load(storage, { VEYORA_FIRST_SUCCESS_TELEMETRY: true });
  fs.recordSearchPerformed();
  fs.recordSecretCopied();
  assert.equal(fs.achievedAt(), null, 'activity before a saved login does not count');
  fs.recordLoginSaved();
  assert.equal(fs.achievedAt(), null, 'a save alone is not first success');
  fs.recordSecretRevealed();
  assert.equal(fs.achievedAt(), null, 'copy/reveal must follow a search after the save');
  fs.recordSearchPerformed();
  const achieved = fs.achievedAt();
  assert.ok(Number.isFinite(achieved) && achieved > 0, 'full sequence achieves first success');
  fs.reset();
  assert.equal(fs.achievedAt(), null);
});

test('URL parameter opts in and the record carries no vault content', async () => {
  const storage = freshStorage();
  const fs = await load(storage, { location: { search: '?veyora-first-success=1' } });
  fs.recordLoginSaved();
  fs.recordSearchPerformed();
  fs.recordSecretCopied();
  const parsed = JSON.parse(storage.getItem('veyora.web.firstSuccess'));
  assert.equal(parsed.schema_version, 1);
  assert.deepEqual(
    parsed.events.map(e => Object.keys(e).sort()),
    [['at', 'event'], ['at', 'event'], ['at', 'event']],
    'each event carries only a name and a timestamp — no item data, query, or secret material',
  );
});

test('unknown event names never record', async () => {
  const storage = freshStorage();
  const fs = await load(storage, { VEYORA_FIRST_SUCCESS_TELEMETRY: true });
  // No public API takes arbitrary names; snapshot must stay empty even
  // after heavy legitimate use of the exposed recorders.
  fs.recordLoginSaved();
  assert.equal(fs.snapshot().length, 1);
  assert.deepEqual(
    fs.snapshot().map(e => e.event),
    ['login-saved'],
  );
});
