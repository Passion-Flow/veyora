/**
 * Real-kernel tests: drives the checked-in WASM bindings in Node exactly the
 * way the browser does (module-level wrapped exports after init).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { kernel, loadKernel } from '../src/core/kernel.js';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(webRoot, 'src');
const wasmDir = join(sourceDir, 'wasm');

async function withFileFetch(callback) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async resource => {
    const url = resource instanceof URL ? resource : new URL(resource);
    if (url.protocol === 'file:') {
      const bytes = await readFile(fileURLToPath(url));
      return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
    }
    return previousFetch(resource);
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function isolatedLoader(
  moduleSource = null,
  copyRealBindings = false,
  authorizeTestBinding = true,
) {
  const root = await mkdtemp(join(tmpdir(), 'veyora-kernel-loader-'));
  await mkdir(join(root, 'src', 'core'), { recursive: true });
  await cp(join(sourceDir, 'core', 'kernel.js'), join(root, 'src', 'core', 'kernel.js'));
  let configSource = await readFile(join(sourceDir, 'config.js'), 'utf8');
  if (moduleSource !== null && authorizeTestBinding) {
    const bindingSha256 = createHash('sha256').update(moduleSource).digest('hex');
    configSource = configSource.replace(
      /bindingSha256: '[0-9a-f]{64}'/,
      `bindingSha256: '${bindingSha256}'`,
    );
  }
  await writeFile(join(root, 'src', 'config.js'), configSource);
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  if (moduleSource !== null || copyRealBindings) {
    await mkdir(join(root, 'src', 'wasm'), { recursive: true });
  }
  if (copyRealBindings) {
    await cp(
      join(wasmDir, 'veyora_kernel.js'),
      join(root, 'src', 'wasm', 'veyora_kernel.js'),
    );
    await writeFile(
      join(root, 'src', 'wasm', 'veyora_kernel_bg.wasm'),
      new Uint8Array([0x00, 0x61, 0x73]),
    );
  } else if (moduleSource !== null) {
    await writeFile(join(root, 'src', 'wasm', 'veyora_kernel.js'), moduleSource);
    await cp(
      join(wasmDir, 'veyora_kernel_bg.wasm'),
      join(root, 'src', 'wasm', 'veyora_kernel_bg.wasm'),
    );
  }
  return import(pathToFileURL(join(root, 'src', 'core', 'kernel.js')).href);
}

test('production loader activates only the self-tested WASM adapter', async () => {
  const mode = await withFileFetch(() => loadKernel());
  assert.equal(mode, 'wasm');
  assert.ok(kernel);
  assert.equal(kernel.constructor.name, 'WasmKernel');
});

test('wasm kernel seal/open round-trip and tamper detection', { timeout: 30000 }, async () => {
  const mod = await import('../src/wasm/veyora_kernel.js');
  const wasmBytes = await readFile(join(wasmDir, 'veyora_kernel_bg.wasm'));
  await mod.default({
    module_or_path: new Response(wasmBytes, { headers: { 'content-type': 'application/wasm' } }),
  });

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

test('wasm recovery kits are checksummed', { timeout: 30000 }, async () => {
  const mod = await import('../src/wasm/veyora_kernel.js');
  const wasmBytes = await readFile(join(wasmDir, 'veyora_kernel_bg.wasm'));
  await mod.default({
    module_or_path: new Response(wasmBytes, { headers: { 'content-type': 'application/wasm' } }),
  });

  const kit = mod.generateRecoveryKit();
  assert.equal(kit.length, 71);
  assert.equal(kit.split('-').length, 12);
  mod.validateRecoveryKit(kit); // must not throw
  assert.throws(() => mod.validateRecoveryKit(`${kit.slice(0, -1)}A`), /PM-KERNEL-/);
});

test('loader fails closed when the generated binding is missing', async () => {
  const isolated = await isolatedLoader();
  await assert.rejects(
    isolated.loadKernel(),
    error => error.code === 'KERNEL_UNAVAILABLE',
  );
  assert.equal(isolated.kernel, null);
});

test('loader fails closed when WASM bytes are corrupt', async () => {
  const isolated = await isolatedLoader(null, true);
  await assert.rejects(
    withFileFetch(() => isolated.loadKernel()),
    error => error.code === 'KERNEL_UNAVAILABLE',
  );
  assert.equal(isolated.kernel, null);
});

test('loader rejects missing exports and policy-blocked initialization', async () => {
  const missingExports = await isolatedLoader('export default async function init() {}\n');
  await assert.rejects(
    withFileFetch(() => missingExports.loadKernel()),
    error => error.code === 'KERNEL_UNAVAILABLE'
      && /KERNEL_EXPORT_MISSING/.test(String(error.cause)),
  );

  const policyBlocked = await isolatedLoader(
    `
      export function derivePasswordKey() {}
      export function deriveRecordKey() {}
      export function generateNonce() {}
      export function sealRecord() {}
      export function openRecord() {}
      export function generateRecoveryKit() {}
      export function validateRecoveryKit() {}
      export default async function init() { throw new Error('WASM policy blocked'); }
    `,
  );
  await assert.rejects(
    withFileFetch(() => policyBlocked.loadKernel()),
    error => error.code === 'KERNEL_UNAVAILABLE'
      && /policy blocked/.test(String(error.cause)),
  );
});

test('loader rejects a binding whose seal operation exposes plaintext', async () => {
  const passthrough = await isolatedLoader(`
    const raw = {
      memory: new WebAssembly.Memory({ initial: 1 }),
      derivePasswordKey() {}, deriveRecordKey() {}, generateNonce() {},
      sealRecord() {}, openRecord() {}, generateRecoveryKit() {}, validateRecoveryKit() {},
    };
    export default async function init() { return raw; }
    export function derivePasswordKey() { return new Uint8Array(32); }
    export function deriveRecordKey(root) { return root; }
    export function generateNonce() { return crypto.getRandomValues(new Uint8Array(24)); }
    export function sealRecord(_key, _nonce, _aad, data) { return data; }
    export function openRecord(_key, _nonce, _aad, data) { return data; }
    export function generateRecoveryKit() { return 'TEST-RECOVERY-KIT'; }
    export function validateRecoveryKit() {}
  `);
  await assert.rejects(
    withFileFetch(() => passthrough.loadKernel()),
    error => error.code === 'KERNEL_UNAVAILABLE'
      && /KERNEL_SELF_TEST_SEAL|KERNEL_SELF_TEST_PLAINTEXT/.test(String(error.cause)),
  );
  assert.equal(passthrough.kernel, null);
});

test('loader rejects a JavaScript impostor before it can special-case self-test', async () => {
  const impostor = await isolatedLoader(`
    const raw = {
      memory: new WebAssembly.Memory({ initial: 1 }),
      derivePasswordKey() {}, deriveRecordKey() {}, generateNonce() {},
      sealRecord() {}, openRecord() {}, generateRecoveryKit() {}, validateRecoveryKit() {},
    };
    export default async function init() { return raw; }
    export function derivePasswordKey() { return new Uint8Array(32); }
    export function deriveRecordKey(root) { return root; }
    export function generateNonce() { return crypto.getRandomValues(new Uint8Array(24)); }
    export function sealRecord(_key, _nonce, _aad, data) {
      const out = new Uint8Array(data.length + 16); out.set(data); return out;
    }
    export function openRecord(_key, _nonce, _aad, data) { return data.slice(0, -16); }
    export function generateRecoveryKit() { return 'TEST-RECOVERY-KIT'; }
    export function validateRecoveryKit() {}
  `, false, false);
  await assert.rejects(
    withFileFetch(() => impostor.loadKernel()),
    error => error.code === 'KERNEL_UNAVAILABLE'
      && /KERNEL_ASSET_DIGEST:binding/.test(String(error.cause)),
  );
  assert.equal(impostor.kernel, null);
});

test('distributable web source contains no demonstration kernel fallback', async () => {
  const source = await readFile(join(sourceDir, 'core', 'kernel.js'), 'utf8');
  assert.doesNotMatch(source, /DemoKernel|return ['"]demo['"]|symmetric passthrough/);
});

test('service worker revokes legacy kernel caches and reloads old clients', async () => {
  const source = await readFile(join(webRoot, 'sw.js'), 'utf8');
  const bootSource = await readFile(join(sourceDir, 'boot.js'), 'utf8');
  const nginxSource = await readFile(join(webRoot, '..', '..', 'deploy', 'web', 'nginx.conf'), 'utf8');
  assert.match(source, /const CACHE_NAME = ['"]veyora-v5['"]/);
  assert.match(source, /self\.skipWaiting\(\)/);
  assert.match(source, /self\.clients\.claim\(\)/);
  assert.match(source, /key\.startsWith\(['"]veyora-['"]\)/);
  assert.match(source, /client\.navigate\(client\.url\)/);
  assert.match(source, /new Request\(path, \{ cache: ['"]reload['"] \}\)/);
  assert.match(source, /new Request\(request, \{ cache: ['"]reload['"] \}\)/);
  assert.match(bootSource, /updateViaCache: ['"]none['"]/);
  assert.match(nginxSource, /location ~ \\\.wasm\$ \{[\s\S]*?expires -1;/);
  assert.match(nginxSource, /location ~ \\\.js\$ \{[\s\S]*?expires -1;/);
});
