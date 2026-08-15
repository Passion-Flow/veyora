/**
 * Password-health analysis tests.
 *
 * Basis: NIST SP 800-63B §5.1.1.2 — password reuse detection must happen
 * client-side in a zero-knowledge vault because the server never sees
 * plaintext secrets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePasswordHealth, ageLabel, STALE_AFTER_DAYS } from '../src/data/health.js';

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

test('flags entries that share the same secret', () => {
  const entries = [
    { id: 'a', secret: 'shared' },
    { id: 'b', secret: 'shared' },
    { id: 'c', secret: 'unique' },
  ];
  const { reusedIds } = analyzePasswordHealth(entries);
  assert.ok(reusedIds.has('a'));
  assert.ok(reusedIds.has('b'));
  assert.ok(!reusedIds.has('c'));
});

test('flags entries whose password has not been changed recently', () => {
  const entries = [
    { id: 'fresh', secret: 'x', updated: daysAgo(10) },
    { id: 'old', secret: 'y', updated: daysAgo(STALE_AFTER_DAYS + 10) },
    { id: 'no-date', secret: 'z' },
  ];
  const { staleIds, ageDays } = analyzePasswordHealth(entries);
  assert.ok(!staleIds.has('fresh'));
  assert.ok(staleIds.has('old'));
  assert.ok(!staleIds.has('no-date'));
  assert.equal(ageDays.get('fresh'), 10);
});

test('empty vault yields empty sets', () => {
  const { reusedIds, staleIds } = analyzePasswordHealth([]);
  assert.equal(reusedIds.size, 0);
  assert.equal(staleIds.size, 0);
});

test('age labels render compact human units', () => {
  const fmt = (n) => String(n);
  assert.equal(ageLabel(0, fmt), null);
  assert.equal(ageLabel(5, fmt), '5d');
  assert.equal(ageLabel(45, fmt), '1mo');
  assert.equal(ageLabel(400, fmt), '1y');
});
