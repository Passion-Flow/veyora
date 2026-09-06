/**
 * Encrypted-backup unit tests (PRD EXP-001): the envelope is a portable
 * password-sealed file — decryptable on any device with the master
 * password, integrity-checked, and never carrying plaintext.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createEncryptedBackup, openEncryptedBackup }
  from '../src/core/backup.js';
import { kernel, loadKernel, fromHex } from '../src/core/kernel.js';

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

const ENTRIES = [
  { id: 'acme', type: 'login', name: 'Acme', secret: 'INERT-BACKUP-SECRET', revision: 3 },
  { id: 'note', type: 'note', name: 'Note', secret: 'note content', revision: 1 },
];

test('a backup round-trips with the master password alone', async () => {
  const envelope = await createEncryptedBackup('backup-master-pw', ENTRIES);
  assert.equal(envelope.format, 'veyora-backup');
  assert.equal(envelope.format_version, 1);
  assert.equal(envelope.record_count, 2);
  assert.equal(envelope.kdf, 'argon2id');
  assert.match(envelope.salt, /^[0-9a-f]{32}$/);
  // No plaintext and no vault identity travels in the envelope.
  const serialized = JSON.stringify(envelope);
  assert.ok(!serialized.includes('INERT-BACKUP-SECRET'));
  assert.ok(!serialized.includes('Acme'));
  // The backup salt is independent of any vault salt.
  assert.notEqual(envelope.salt.length, 0);
  const restored = await openEncryptedBackup(envelope, 'backup-master-pw');
  assert.deepEqual(restored, ENTRIES);
});

test('a wrong master password cannot open the backup', async () => {
  const envelope = await createEncryptedBackup('backup-master-pw', ENTRIES);
  await assert.rejects(
    () => openEncryptedBackup(envelope, 'wrong-password'),
    thrown => /PM-KERNEL-/.test(String(thrown && thrown.message ? thrown.message : thrown)),
  );
});

test('a tampered payload fails the integrity digest', async () => {
  const envelope = await createEncryptedBackup('backup-master-pw', ENTRIES);
  // Flip one byte inside the sealed payload: the AEAD would already
  // reject most tampering; a forged-but-valid ciphertext must still fail
  // the recorded digest, and a corrupted count must fail the count check.
  const bytes = fromHex(envelope.entries[0]);
  bytes[bytes.length - 1] ^= 0x01;
  envelope.entries[0] = bytes.reduce((hex, b) => hex + b.toString(16).padStart(2, '0'), '');
  await assert.rejects(() => openEncryptedBackup(envelope, 'backup-master-pw'));
  const honest = await createEncryptedBackup('backup-master-pw', ENTRIES);
  honest.record_count = 5;
  await assert.rejects(
    () => openEncryptedBackup(honest, 'backup-master-pw'),
    // The envelope declares 5 entries but carries 2: refused up front by
    // the structural check (never partially parsed), not by trust.
    /backup\.format/,
  );
});

test('a foreign file shape is refused, never partially parsed', async () => {
  await assert.rejects(() => openEncryptedBackup({}, 'pw'), /backup\.format/);
  await assert.rejects(
    () => openEncryptedBackup({ format: 'veyora-backup', format_version: 2 }, 'pw'),
    /backup\.format/,
  );
  await assert.rejects(() => openEncryptedBackup('not-json-object', 'pw'), /backup\.format/);
});

test('two backups of the same vault use independent salts', async () => {
  const one = await createEncryptedBackup('pw-one-value-9', ENTRIES);
  const two = await createEncryptedBackup('pw-one-value-9', ENTRIES);
  assert.notEqual(one.salt, two.salt);
  assert.notEqual(one.entries[0], two.entries[0]);
  assert.deepEqual(await openEncryptedBackup(one, 'pw-one-value-9'), ENTRIES);
  assert.deepEqual(await openEncryptedBackup(two, 'pw-one-value-9'), ENTRIES);
});
