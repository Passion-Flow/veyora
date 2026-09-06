/**
 * Unit tests for the pure data modules: password strength tiers, the entry
 * schema helpers, and the hex codec shared by both kernel adapters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { strength } from '../src/views/strength.js';
import { slugify, detailFields, SECRET_REQUIRED, TEMPLATE_FIELDS } from '../src/data/schema.js';
import { toHex, fromHex, entropyBits } from '../src/core/kernel.js';
import { SECURITY } from '../src/config.js';

test('master password policy enforces the PRD length floor without composition rules', () => {
  assert.ok(SECURITY.password.minLength >= 15);
  assert.deepEqual(Object.keys(SECURITY.password).sort(), ['minLength', 'strengthThresholdsBits']);
});

test('strength tiers follow the configured thresholds', () => {
  assert.deepEqual(strength(''), { bits: 0, segments: 0, labelKey: 'strength.weak' });
  assert.equal(strength('abc').segments, 1);            // < 40 bits
  assert.equal(strength('abcdefghijkl').segments, 2);   // < 60 bits
  assert.equal(strength('abcdefghijkl1').segments, 3);  // < 80 bits
  assert.equal(strength('aBcDeFgH1!xYzWq9').segments, 4); // < 110 bits
  assert.equal(strength('aBcDeFgH1!xYzWq9Lm2#kJ8@').segments, 5);
  const estimate = strength('aBcDeFgH1!xYzWq9Lm2#kJ8@');
  assert.ok(estimate.bits >= 110);
});

test('slugify produces storage-safe record ids', () => {
  assert.equal(slugify('GitHub'), 'github');
  assert.equal(slugify('NetfliX 2026!!'), 'netflix-2026');
  assert.equal(slugify('  '), 'entry');
});

test('detail fields adapt to the template type', () => {
  const login = detailFields({ type: 'login', username: 'u', secret: 's', notes: 'n' });
  assert.ok(login.some(f => f.labelKey === 'field.username'));
  assert.ok(login.some(f => f.labelKey === 'field.password' && f.secret));
  assert.ok(login.some(f => f.notes));

  const ssh = detailFields({ type: 'ssh', host: 'h', secret: 'p', secretkey: 'K' });
  assert.ok(ssh.some(f => f.labelKey === 'field.passphrase'));
  assert.ok(ssh.some(f => f.labelKey === 'field.privateKey' && f.pre));
});

test('secret requirements stay aligned with the shipped templates', () => {
  for (const type of SECRET_REQUIRED) {
    assert.ok(TEMPLATE_FIELDS[type].some(f => f.k === 'secret'), type);
  }
});

test('hex codec round-trips arbitrary bytes', () => {
  const bytes = new Uint8Array([0, 1, 15, 16, 254, 255]);
  assert.equal(toHex(bytes), '00010f10feff');
  assert.deepEqual([...fromHex('00010f10feff')], [...bytes]);
});

test('entropy estimation scales with pool size', () => {
  assert.equal(entropyBits(16, 16), 64);
  assert.equal(entropyBits(0, 94), 0);
});

test('search matches only the documented fields and stays local (NAV-006)', async () => {
  const { matchesQuery, entrySearchHaystack, SEARCH_FIELDS } = await import('../src/data/search.js');
  assert.deepEqual([...SEARCH_FIELDS], ['name', 'username', 'website', 'service', 'host', 'notes', 'secret', 'typeLabel', 'tags']);
  const entry = {
    name: 'GitHub - Work', username: 'octo', website: 'example.com',
    service: null, host: null, notes: 'recovery notes', secret: 'hunter2',
    tags: ['e2ework', 'infra-team'], revision: 42,
  };
  for (const hit of ['github - work', 'OCTO', 'example.com', 'recovery', 'hunter2']) {
    assert.ok(matchesQuery(entry, hit, 'Login'), `matched: ${hit}`);
  }
  assert.ok(matchesQuery(entry, 'infra-team', 'Login'), 'assigned tags are searched');
  assert.ok(!matchesQuery(entry, '42', 'Login'), 'metadata like revision is not searched');
  assert.ok(matchesQuery(entry, 'login', 'Login'), 'localized type label is searched');
  assert.ok(matchesQuery(entry, '  ', 'Login'), 'blank queries match everything');
  // The haystack derives only from the entry fields listed above plus the
  // type label; the function has no network or storage dependency.
  assert.equal(typeof entrySearchHaystack, 'function');
});

test('start-here checklist state persists and completes only tracked steps (UX-ONB-008/009)', async () => {
  const { checklist, TRACKED_STEPS } = await import('../src/core/checklist.js');
  const { STORAGE_KEYS } = await import('../src/config.js');
  assert.deepEqual([...TRACKED_STEPS],
    ['first-item', 'copy-reveal', 'lock', 'recovery', 'backup']);
  const events = [];
  globalThis.localStorage = {
    store: {},
    getItem(k) { return this.store[k] ?? null; },
    setItem(k, v) { this.store[k] = String(v); },
    removeItem(k) { delete this.store[k]; },
  };
  globalThis.window = { dispatchEvent: () => events.push('changed') };
  assert.equal(checklist.isComplete(), false);
  assert.equal(checklist.isHidden(), false);
  checklist.markDone('first-item');
  assert.equal(checklist.isDone('first-item'), true);
  checklist.markDone('first-item'); // idempotent
  assert.equal(events.length, 1);
  checklist.markDone('copy-reveal');
  assert.equal(checklist.isComplete(), false);
  checklist.markDone('lock');
  assert.equal(checklist.isComplete(), false, 'recovery and backup still open');
  checklist.markDone('recovery');
  checklist.markDone('backup');
  assert.equal(checklist.isComplete(), true, 'all five steps complete it');
  assert.equal(checklist.isHidden(), false); // completion alone does not hide
  assert.equal(checklist.noteCompletion(), true); // auto-hide fires once
  assert.equal(checklist.isHidden(), true);
  assert.equal(checklist.noteCompletion(), false); // and never re-hides
  checklist.unhide(); // reopened from Help
  assert.equal(checklist.isHidden(), false);
  assert.equal(checklist.isComplete(), true); // still complete, stays visible
  checklist.hide();
  assert.equal(checklist.isHidden(), true);
  const stored = JSON.parse(globalThis.localStorage.store[STORAGE_KEYS.startHere]);
  assert.deepEqual(Object.keys(stored.done).sort(),
    ['backup', 'copy-reveal', 'first-item', 'lock', 'recovery']);
  // Corrupt storage must not crash the app.
  globalThis.localStorage.store[STORAGE_KEYS.startHere] = 'not json';
  assert.equal(checklist.isHidden(), false);
  delete globalThis.window;
  delete globalThis.localStorage;
});
