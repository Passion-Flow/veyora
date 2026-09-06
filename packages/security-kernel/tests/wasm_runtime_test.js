/**
 * Veyora WASM kernel runtime test.
 *
 * Proves the compiled 89KB WASM binary executes correctly in a JavaScript
 * runtime by loading it through Node.js and exercising every exported function.
 *
 * Prerequisites:
 *   cd security-kernel
 *   cargo build --target wasm32-unknown-unknown --lib -p kernel-wasm --release
 *   wasm-bindgen --target nodejs --out-dir tests/wasm-out \
 *     --out-name veyora_kernel \
 *     target/wasm32-unknown-unknown/release/kernel_wasm.wasm
 *
 * Run: node tests/wasm_runtime_test.js
 */

const crypto = require('crypto');
const path = require('path');
globalThis.crypto = crypto;
const outputDirectory = process.env.VEYORA_WASM_OUT || path.join(__dirname, 'wasm-out');
const vk = require(path.join(outputDirectory, 'veyora_kernel.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch(e) { console.log(`  ✗ ${name}: ${e.message || e}`); fail++; }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const salt = new Uint8Array(16).fill(0xaa);
const root = vk.derivePasswordKey(new TextEncoder().encode('test'), salt);
const ctx = new Uint8Array([0x82, 0x40, 0x40]);
const rk = vk.deriveRecordKey(root, ctx);

console.log('Veyora WASM Kernel Runtime Test');
console.log('================================');

test('derivePasswordKey returns 32 bytes', () => assert(root.length === 32));

test('deriveRecordKey returns 32 bytes', () => assert(rk.length === 32));

test('generateNonce returns 24 bytes', () => {
  const n = vk.generateNonce();
  assert(n.length === 24);
});

test('generatePassword returns 20 chars', () => {
  const pw = new TextDecoder().decode(vk.generatePassword());
  assert(pw.length === 20, `got ${pw.length}`);
});

test('sealRecord + openRecord round-trip', () => {
  const n = vk.generateNonce();
  const aad = new TextEncoder().encode('pm-v1/record-aad');
  const pt = new TextEncoder().encode('my-secret');
  const sealed = vk.sealRecord(rk, n, aad, pt);
  assert(sealed.length === pt.length + 16, 'ciphertext length');
  const opened = new TextDecoder().decode(vk.openRecord(rk, n, aad, sealed));
  assert(opened === 'my-secret', `got "${opened}"`);
});

test('wrong key fails to decrypt', () => {
  const wrongRoot = vk.derivePasswordKey(new TextEncoder().encode('wrong'), salt);
  const wrongKey = vk.deriveRecordKey(wrongRoot, ctx);
  const n = vk.generateNonce();
  const aad = new TextEncoder().encode('aad');
  const sealed = vk.sealRecord(rk, n, aad, new TextEncoder().encode('x'));
  let threw = false;
  try { vk.openRecord(wrongKey, n, aad, sealed); } catch { threw = true; }
  assert(threw, 'should have thrown');
});

test('tampered ciphertext fails', () => {
  const n = vk.generateNonce();
  const aad = new TextEncoder().encode('aad');
  const sealed = vk.sealRecord(rk, n, aad, new TextEncoder().encode('detect-me'));
  sealed[0] ^= 1;
  let threw = false;
  try { vk.openRecord(rk, n, aad, sealed); } catch { threw = true; }
  assert(threw, 'should have thrown');
});

test('generateRecoveryKit returns 71 chars with 11 hyphens', () => {
  const kit = vk.generateRecoveryKit();
  assert(kit.length === 71, `got ${kit.length}`);
  assert((kit.match(/-/g) || []).length === 11, 'hyphen count');
});

test('validateRecoveryKit decodes a kit', () => {
  const kit = vk.generateRecoveryKit();
  const entropy = vk.validateRecoveryKit(kit);
  assert(entropy.length === 32, `got ${entropy.length}`);
});

test('validateProtocolCbor round-trips', () => {
  const input = new Uint8Array([0x82, 0x01, 0x02]);
  const output = Array.from(vk.validateProtocolCbor(input));
  assert(output[0] === 0x82 && output[1] === 1 && output[2] === 2, `got ${output}`);
});

test('validateProtocolCbor rejects non-canonical', () => {
  let threw = false;
  try { vk.validateProtocolCbor(new Uint8Array([0x18, 0x01])); } catch { threw = true; }
  assert(threw, 'should have thrown');
});

console.log('');
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
