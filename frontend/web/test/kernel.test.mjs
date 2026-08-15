/**
 * Real-kernel tests: drives the checked-in WASM bindings in Node exactly the
 * way the browser does (module-level wrapped exports after init).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const wasmDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wasm');

test('wasm kernel seal/open round-trip and tamper detection', { timeout: 30000 }, async t => {
  if (!existsSync(join(wasmDir, 'veyora_kernel.js'))) {
    t.skip('generated kernel bindings not present');
    return;
  }
  const mod = await import('../src/wasm/veyora_kernel.js');
  const wasmBytes = await readFile(join(wasmDir, 'veyora_kernel_bg.wasm'));
  await mod.default(new Response(wasmBytes, { headers: { 'content-type': 'application/wasm' } }));

  const enc = new TextEncoder();
  const root = mod.derivePasswordKey(enc.encode('unit-test-password'), new Uint8Array(16).fill(0x11));
  assert.equal(root.length, 32);

  const key = mod.deriveRecordKey(root, new Uint8Array([0x82, 0x40, 0x40]));
  const nonce = mod.generateNonce();
  assert.equal(nonce.length, 24);

  const aad = enc.encode('pm-v1/record-aad');
  const message = enc.encode('enterprise-grade round trip');
  const sealed = mod.sealRecord(key, nonce, aad, message);
  assert.equal(sealed.length, message.length + 16, 'ciphertext plus 16-byte tag');
  assert.deepEqual([...mod.openRecord(key, nonce, aad, sealed)], [...message]);

  sealed[0] ^= 0x01;
  assert.throws(() => mod.openRecord(key, nonce, aad, sealed), /PM-KERNEL-/);
});

test('wasm recovery kits are checksummed', { timeout: 30000 }, async t => {
  if (!existsSync(join(wasmDir, 'veyora_kernel.js'))) {
    t.skip('generated kernel bindings not present');
    return;
  }
  const mod = await import('../src/wasm/veyora_kernel.js');
  const wasmBytes = await readFile(join(wasmDir, 'veyora_kernel_bg.wasm'));
  await mod.default(new Response(wasmBytes, { headers: { 'content-type': 'application/wasm' } }));

  const kit = mod.generateRecoveryKit();
  assert.equal(kit.length, 71);
  assert.equal(kit.split('-').length, 12);
  mod.validateRecoveryKit(kit); // must not throw
  assert.throws(() => mod.validateRecoveryKit(`${kit.slice(0, -1)}A`), /PM-KERNEL-/);
});
