#!/usr/bin/env node
/**
 * Browser smoke test for the frontend/web client.
 *
 * Exercises the full zero-knowledge flow against a live stack: create a
 * vault (Argon2id derivation in WASM), read the one-time recovery kit,
 * create an entry (client-side XChaCha20-Poly1305 sealing, server stores
 * ciphertext only), reload and decrypt with the master password, reject a
 * wrong password, reveal, tombstone-delete, and lock.
 *
 * Environment:
 *   VEYORA_WEB_URL          base URL of the web client (default :3000)
 *   VEYORA_SCREENSHOT_PATH  optional screenshot output path
 *   VEYORA_CDP_URL          connect to an existing Chrome over CDP
 */

import assert from 'node:assert/strict';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('playwright-core'));
}

const webUrl = process.env.VEYORA_WEB_URL || 'http://127.0.0.1:3000';
const screenshotPath = process.env.VEYORA_SCREENSHOT_PATH;
const cdpUrl = process.env.VEYORA_CDP_URL;
const masterPassword = 'inert-browser-password';
const browser = cdpUrl
  ? await chromium.connectOverCDP(cdpUrl, {
      headers: process.env.VEYORA_CDP_HOST ? { Host: process.env.VEYORA_CDP_HOST } : undefined,
    })
  : await chromium.launch({ headless: true });
const context = cdpUrl
  ? browser.contexts()[0]
  : await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
      viewport: { width: 1440, height: 1100 },
    });
const page = await context.newPage();
const browserProblems = [];

page.on('console', (message) => {
  if (message.type() === 'warning' || message.type() === 'error') {
    browserProblems.push(`console ${message.type()}: ${message.text()}`);
  }
});
page.on('pageerror', (error) => browserProblems.push(`page error: ${error.message}`));
page.on('requestfailed', (request) => {
  const failure = request.failure()?.errorText;
  if (request.url().endsWith('/api/healthz') && failure === 'net::ERR_ABORTED') return;
  browserProblems.push(`request failed: ${request.method()} ${request.url()} (${failure})`);
});

try {
  const separator = webUrl.includes('?') ? '&' : '?';
  await page.goto(`${webUrl}${separator}e2e=${Date.now()}`, { waitUntil: 'networkidle' });
  // Always start from a clean device state.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  // The WASM module must be live: recovery kits carry its 71-char format.
  await page.locator('#lock-welcome').waitFor();
  await page.locator('#new-pw').fill(masterPassword);
  await page.locator('#new-pw2').fill(masterPassword);
  await page.locator('#ack-row').click();
  await page.locator('#btn-create').click();
  await page.locator('#lock-kit').waitFor();
  assert.equal((await page.locator('#kit-code').textContent()).length, 71);

  await page.locator('#btn-kit-done').click();
  await page.locator('#view-app').waitFor();
  await page.locator('#empty-cta').waitFor();

  // Create an entry; the server must only ever see ciphertext.
  const name = `Browser Smoke ${Date.now()}`;
  const secret = 'browser-smoke-secret-1';
  await page.locator('#btn-new').click();
  await page.locator('#f-name').fill(name);
  await page.locator('#f-username').fill('browser@veyora.dev');
  await page.locator('#f-secret').fill(secret);
  await page.locator('#btn-save-entry').click();
  let row = page.locator('.trow').filter({ hasText: name });
  await row.waitFor();

  // Reload: the wrong master password must fail real decryption.
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#lock-unlock').waitFor();
  await page.locator('#master-pw').fill('definitely-wrong');
  await page.locator('#btn-unlock').click();
  await page.locator('#unlock-error').waitFor();

  // The right password restores the entry from server ciphertext.
  await page.locator('#master-pw').fill(masterPassword);
  await page.locator('#btn-unlock').click();
  row = page.locator('.trow').filter({ hasText: name });
  await row.waitFor();

  // Drawer reveal shows the decrypted secret.
  await row.click();
  await page.locator('#drawer').waitFor();
  await page.locator('#d-reveal').click();
  assert.equal(await page.locator('.d-val.mono').filter({ hasText: secret }).count(), 1);

  // Two-step delete, then lock.
  await page.locator('#d-del').click();
  await page.locator('#d-del').click();
  await row.waitFor({ state: 'detached' });
  await page.locator('#btn-lock').click();
  await page.locator('#lock-unlock').waitFor();

  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.waitForTimeout(250);
  assert.deepEqual(browserProblems, [], browserProblems.join('\n'));
  console.log('Browser smoke test passed (kernel derivation, kit, seal, store, decrypt, reveal, delete, lock).');
} catch (error) {
  const diagnostics = [...browserProblems].join('\n');
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  await page.close();
  await browser.close();
}
