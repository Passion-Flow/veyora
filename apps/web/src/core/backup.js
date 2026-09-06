/**
 * Encrypted portable backup (PRD EXP-001, web scope).
 *
 * A backup is a single JSON file whose payload is the vault's entries,
 * sealed through the kernel under a key derived from the master password
 * and a salt generated for THIS backup — never the live vault salt — so the
 * file restores on any device with nothing but the master password. No
 * plaintext, no key material, and no vault identity leaves the device; the
 * envelope carries only what decryption and integrity checking need.
 */
import { kernel, toHex, fromHex, randomHex } from './kernel.js';

const FORMAT = 'veyora-backup';
const FORMAT_VERSION = 1;

/**
 * Seal every entry into a portable backup envelope. Each entry is sealed
 * on its own — the kernel's per-record plaintext limit applies to every
 * sealed document, and every stored entry already satisfies it — so the
 * backup can never hold a blob the record format itself could not carry.
 * The digest covers the concatenated plaintexts in order.
 */
export async function createEncryptedBackup(password, entries) {
  const salt = randomHex(16);
  const rootKey = await kernel.deriveRootKey(password, salt);
  const recordKey = kernel.deriveRecordKey(rootKey);
  const parts = [];
  const plaintexts = [];
  for (const entry of entries) {
    const nonce = kernel.generateNonce();
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(entry));
    if (plaintextBytes.length === 0 || plaintextBytes.length > 1024) {
      const error = new Error('backup.entryTooLarge');
      error.code = 'backup.entryTooLarge';
      throw error;
    }
    plaintexts.push(plaintextBytes);
    const sealed = kernel.seal(recordKey, nonce, plaintextBytes);
    const sealedWithNonce = new Uint8Array(nonce.length + sealed.length);
    sealedWithNonce.set(nonce, 0);
    sealedWithNonce.set(sealed, nonce.length);
    parts.push(toHex(sealedWithNonce));
  }
  const digestInput = concatBytes(plaintexts);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput));
  return {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    created_at: new Date().toISOString(),
    kdf: 'argon2id',
    salt,
    record_count: entries.length,
    entries_digest: toHex(digest),
    entries: parts,
  };
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function openEncryptedBackup(envelope, password) {
  if (!envelope || envelope.format !== FORMAT
    || envelope.format_version !== FORMAT_VERSION
    || typeof envelope.salt !== 'string'
    || !Array.isArray(envelope.entries)
    || !Number.isInteger(envelope.record_count)
    || envelope.entries.length !== envelope.record_count) {
    throw new Error('backup.format');
  }
  const rootKey = await kernel.deriveRootKey(password, envelope.salt);
  const recordKey = kernel.deriveRecordKey(rootKey);
  const plaintexts = [];
  const entries = [];
  for (const part of envelope.entries) {
    if (typeof part !== 'string') throw new Error('backup.format');
    const sealedWithNonce = fromHex(part);
    const nonce = sealedWithNonce.slice(0, 24);
    const sealed = sealedWithNonce.slice(24);
    const plaintextBytes = kernel.open(recordKey, nonce, sealed);
    plaintexts.push(plaintextBytes);
    entries.push(JSON.parse(new TextDecoder().decode(plaintextBytes)));
  }
  const digest = toHex(new Uint8Array(
    await crypto.subtle.digest('SHA-256', concatBytes(plaintexts))));
  if (digest !== envelope.entries_digest) {
    throw new Error('backup.integrity');
  }
  return entries;
}
