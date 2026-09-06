/**
 * Offline pending-queue unit tests (ITEM-006): per-vault scoping,
 * newest-write-wins replacement, and removal after replay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingQueue } from '../src/core/pending-queue.js';

// Node has no localStorage; back it with a Map like the browser API.
const map = new Map();
globalThis.localStorage = {
  getItem: key => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: key => map.delete(key),
};

const dto = (id, revision = 1) => ({
  record_id: id, revision, ciphertext: 'ab'.repeat(24), ciphertext_hash: '00'.repeat(32),
});

test('enqueue lists and removes per vault salt', () => {
  map.clear();
  pendingQueue.enqueue('salt-a', dto('acme'));
  pendingQueue.enqueue('salt-a', dto('beta'));
  pendingQueue.enqueue('salt-b', dto('other'));
  assert.deepEqual(pendingQueue.pendingIds('salt-a'), ['acme', 'beta']);
  assert.deepEqual(pendingQueue.pendingIds('salt-b'), ['other']);
  assert.deepEqual(pendingQueue.pendingIds('salt-c'), []);
  pendingQueue.remove('salt-a', 'acme');
  assert.deepEqual(pendingQueue.pendingIds('salt-a'), ['beta']);
  assert.deepEqual(pendingQueue.pendingIds('salt-b'), ['other']);
});

test('a newer queued write replaces the earlier one for the same record', () => {
  map.clear();
  pendingQueue.enqueue('salt-a', dto('acme', 2));
  pendingQueue.enqueue('salt-a', dto('acme', 3));
  const items = pendingQueue.list('salt-a');
  assert.equal(items.length, 1, 'no duplicate queue entries per record');
  assert.equal(items[0].dto.revision, 3, 'the newest sealed write wins');
  assert.match(items[0].enqueued_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('invalid payloads are ignored and corrupt storage degrades to empty', () => {
  map.clear();
  pendingQueue.enqueue('salt-a', { record_id: 42, ciphertext: 'x' }); // non-string id
  pendingQueue.enqueue('salt-a', null);
  assert.deepEqual(pendingQueue.pendingIds('salt-a'), []);
  map.set('veyora-pending-salt-a', '{"not":"an array"}');
  assert.deepEqual(pendingQueue.pendingIds('salt-a'), []);
  map.set('veyora-pending-salt-a', '[{"record_id":"x"},{"dto":{}}]'); // partial junk
  assert.deepEqual(pendingQueue.pendingIds('salt-a'), []);
});

test('queued payloads carry ciphertext only, never plaintext fields', () => {
  map.clear();
  pendingQueue.enqueue('salt-a', dto('acme'));
  const raw = map.get('veyora-pending-salt-a');
  assert.ok(!raw.includes('secret') && !raw.includes('password'),
    'the persisted queue stores sealed DTOs only');
});
