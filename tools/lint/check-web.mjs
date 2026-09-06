#!/usr/bin/env node
/**
 * Web client integrity check.
 *
 * Validates the apps/web client that ships in the container image:
 *   1. The HTML shell exists and references the stylesheet and entrypoint.
 *   2. Every JavaScript module parses (node --check semantics).
 *   3. The WASM kernel artifact is present and carries the wasm magic bytes.
 *   4. Locale catalogs parse as JSON with the contract envelope.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'web');
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const html = await readFile(join(webRoot, 'index.html'), 'utf-8');
check(html.includes('src/main.js'), 'index.html must reference src/main.js');
check(html.includes('tokens.css'), 'index.html must load the design tokens');

const modules = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.js')) modules.push(full);
    else if (entry.isDirectory()) walk(full);
  }
})(join(webRoot, 'src'));

for (const module of modules) {
  try {
    execFileSync(process.execPath, ['--check', module], { stdio: 'pipe' });
  } catch {
    failures.push(`module does not parse: ${module}`);
  }
}

const wasmPath = join(webRoot, 'src', 'wasm', 'veyora_kernel_bg.wasm');
if (!existsSync(wasmPath)) {
  failures.push('WASM kernel artifact missing: src/wasm/veyora_kernel_bg.wasm');
} else {
  const wasm = await readFile(wasmPath);
  check(wasm[0] === 0x00 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d,
    'WASM artifact does not start with the wasm magic bytes');
}

const kernelAssetManifestPath = join(webRoot, '..', '..', 'release', 'kernel-assets.json');
try {
  const manifest = JSON.parse(await readFile(kernelAssetManifestPath, 'utf8'));
  check(manifest.schema_version === 1, 'kernel asset manifest schema_version must be 1');
  for (const asset of manifest.assets || []) {
    const assetPath = join(webRoot, '..', '..', asset.path);
    const bytes = await readFile(assetPath);
    const actual = createHash('sha256').update(bytes).digest('hex');
    check(actual === asset.sha256, `kernel asset digest drift: ${asset.path}`);
  }
  check(manifest.assets?.length === 2, 'kernel asset manifest must contain two assets');
} catch (error) {
  failures.push(`kernel asset manifest invalid: ${error.message}`);
}

const localeDir = join(webRoot, 'locales');
const catalogs = (await readdir(localeDir)).filter(name => name.endsWith('.json'));
for (const file of catalogs) {
  try {
    const catalog = JSON.parse(await readFile(join(localeDir, file), 'utf-8'));
    check(catalog.schema_version === 1, `${file} lacks schema_version`);
    check(typeof catalog.locale === 'string', `${file} lacks locale`);
    check(['ltr', 'rtl'].includes(catalog.direction), `${file} lacks direction`);
    check(catalog.messages && Object.keys(catalog.messages).length > 0, `${file} has no messages`);
  } catch {
    failures.push(`locale catalog does not parse: ${file}`);
  }
}

if (failures.length > 0) {
  console.error(`Web integrity check FAILED (${failures.length}):`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`Web integrity check passed (${modules.length} modules, wasm kernel, ${catalogs.length} catalogs).`);
