#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(repository, 'deployment', 'web');
const htmlPath = path.join(webRoot, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const failures = [];
const requireCondition = (condition, message) => {
  if (!condition) failures.push(message);
};

requireCondition(/<meta\s+charset=["']UTF-8["']/i.test(html), 'index.html must declare UTF-8');
requireCondition(/<meta\s+name=["']viewport["']/i.test(html), 'index.html must declare a viewport');
requireCondition(/<title>[^<]+<\/title>/i.test(html), 'index.html must have a title');
requireCondition(!/(?:src|href)=["']https?:\/\//i.test(html), 'remote runtime assets are not allowed');

const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
requireCondition(duplicateIds.length === 0, `duplicate element IDs: ${[...new Set(duplicateIds)].join(', ')}`);

const referencedIds = [...html.matchAll(/\$\(["']([^"']+)["']\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds.filter((id) => !ids.includes(id)))];
requireCondition(missingIds.length === 0, `JavaScript references missing element IDs: ${missingIds.join(', ')}`);

const moduleMatches = [...html.matchAll(/<script\s+type=["']module["']>([\s\S]*?)<\/script>/gi)];
requireCondition(moduleMatches.length === 1, 'index.html must contain exactly one inline module');

const parseModule = (source, identifier) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'veyora-web-check-'));
  const modulePath = path.join(temporaryDirectory, 'module.mjs');
  try {
    fs.writeFileSync(modulePath, source);
    execFileSync(process.execPath, ['--check', modulePath], { stdio: 'pipe' });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    failures.push(`${identifier} is not valid JavaScript: ${detail}`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};

if (moduleMatches.length === 1) {
  const source = moduleMatches[0][1];
  parseModule(source, 'index.html inline module');
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const target = path.resolve(webRoot, match[1]);
    requireCondition(target.startsWith(`${webRoot}${path.sep}`), `module import escapes web root: ${match[1]}`);
    requireCondition(fs.existsSync(target), `module import does not exist: ${match[1]}`);
  }
}

const bindingPath = path.join(webRoot, 'wasm', 'veyora_kernel.js');
const binaryPath = path.join(webRoot, 'wasm', 'veyora_kernel_bg.wasm');
requireCondition(fs.existsSync(bindingPath), 'checked-in WASM JavaScript binding is missing');
requireCondition(fs.existsSync(binaryPath), 'checked-in WASM binary is missing');

if (fs.existsSync(bindingPath)) parseModule(fs.readFileSync(bindingPath, 'utf8'), 'veyora_kernel.js');
if (fs.existsSync(binaryPath)) {
  const binary = fs.readFileSync(binaryPath);
  requireCondition(binary.length > 8, 'WASM binary is empty');
  requireCondition(binary.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])), 'WASM magic header is invalid');
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exit(1);
}

console.log(`Web integrity check passed (${ids.length} unique elements, valid JavaScript and WASM assets).`);
