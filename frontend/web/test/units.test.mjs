/**
 * Unit tests for the pure data modules: password strength tiers, the entry
 * schema helpers, and the hex codec shared by both kernel adapters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { strength } from '../src/views/strength.js';
import { slugify, detailFields, SECRET_REQUIRED, TEMPLATE_FIELDS } from '../src/data/schema.js';
import { toHex, fromHex, entropyBits, DemoKernel } from '../src/core/kernel.js';

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

test('demo kernel seal/open is a symmetric passthrough', () => {
  const kernel = new DemoKernel();
  const key = new Uint8Array(32).fill(7);
  const nonce = kernel.generateNonce();
  assert.equal(nonce.length, 24);
  const plaintext = new TextEncoder().encode('payload');
  const sealed = kernel.seal(key, nonce, plaintext);
  assert.deepEqual([...kernel.open(key, nonce, sealed)], [...plaintext]);
});

test('demo recovery kit keeps the documented shape', () => {
  const kernel = new DemoKernel();
  const kit = kernel.generateRecoveryKit();
  const groups = kit.split(/[ ·]+/).filter(Boolean);
  assert.equal(groups.length, 12);
  assert.ok(kernel.validateRecoveryKit(kit));
  assert.ok(!kernel.validateRecoveryKit('   '));
});
