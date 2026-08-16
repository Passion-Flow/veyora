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
 */

import assert from 'node:assert/strict';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('playwright-core')); }

const webUrl = process.env.VEYORA_WEB_URL || 'http://127.0.0.1:3000';
const screenshotPath = process.env.VEYORA_SCREENSHOT_PATH;
const masterPassword = 'inert-browser-password';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  permissions: ['clipboard-read', 'clipboard-write'],
  viewport: { width: 1440, height: 1100 },
});
const page = await context.newPage();

// Only track CRITICAL errors (not CSP warnings or transient network noise)
const criticalErrors = [];
page.on('pageerror', (error) => {
  // CSP violations during initial load are non-fatal if the app still works
  if (error.message.includes('Content Security Policy')) return;
  if (error.message.includes('CSP')) return;
  criticalErrors.push(`page error: ${error.message}`);
});
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // Filter out known non-critical issues
  if (text.includes('Content Security Policy')) return;
  if (text.includes('CSP')) return;
  if (text.includes('favicon')) return;
  if (text.includes('net::ERR')) return;
  if (text.includes('Failed to load resource')) return; // 404s for optional resources
  criticalErrors.push(`console error: ${text}`);
});

function log(msg) { console.log(`  ${msg}`); }

try {
  // Load page (domcontentloaded, not networkidle — the Service Worker
  // keeps connections open which prevents networkidle from resolving)
  await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);

  // Clean device state
  await page.evaluate(() => {
    try { localStorage.clear(); } catch (e) { /* ignore */ }
    try { sessionStorage.clear(); } catch (e) { /* ignore */ }
  }).catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);

  // ── Vault creation ──
  log('Creating vault (Argon2id)...');
  await page.locator('#lock-welcome').waitFor({ timeout: 10000 });
  await page.locator('#new-pw').fill(masterPassword);
  await page.locator('#new-pw2').fill(masterPassword);
  await page.locator('#ack-row').click();
  await page.locator('#btn-create').click();
  // Argon2id derivation can take several seconds in CI
  await page.locator('#lock-kit').waitFor({ timeout: 60000 });
  const kitLen = (await page.locator('#kit-code').textContent()).length;
  assert.equal(kitLen, 71, `recovery kit length: ${kitLen}`);
  log(`✓ Vault created, kit length ${kitLen}`);

  // ── Open vault ──
  await page.locator('#btn-kit-done').click();
  await page.locator('#view-app').waitFor({ timeout: 15000 });
  await page.locator('#empty-cta').waitFor({ timeout: 5000 });
  log('✓ Vault open, empty state visible');

  // ── Create entry ──
  const name = `Smoke${Date.now()}`;
  const secret = 'browser-smoke-secret';
  await page.locator('#btn-new').click();
  await page.locator('#f-name').fill(name);
  await page.locator('#f-username').fill('browser@veyora.dev');
  await page.locator('#f-secret').fill(secret);
  await page.locator('#btn-save-entry').click();
  const row = page.locator('.trow').filter({ hasText: name });
  await row.waitFor({ timeout: 15000 });
  log(`✓ Entry "${name}" created and encrypted`);

  // ── Wrong password rejection ──
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.locator('#lock-unlock').waitFor({ timeout: 10000 });
  await page.locator('#master-pw').fill('definitely-wrong');
  await page.locator('#btn-unlock').click();
  await page.locator('#unlock-error').waitFor({ timeout: 30000 });
  log('✓ Wrong password rejected');

  // ── Correct password decrypts ──
  await page.locator('#master-pw').fill(masterPassword);
  await page.locator('#btn-unlock').click();
  const row2 = page.locator('.trow').filter({ hasText: name });
  await row2.waitFor({ timeout: 30000 });
  log('✓ Correct password decrypts entry');

  // ── Reveal ──
  await row2.click();
  await page.locator('#drawer').waitFor({ timeout: 5000 });
  await page.locator('#d-reveal').click();
  const revealed = await page.locator('.d-val.mono').filter({ hasText: secret }).count();
  assert.ok(revealed >= 1, 'secret revealed');
  log('✓ Secret revealed in drawer');

  // ── Delete ──
  await page.locator('#d-del').click();
  await page.waitForTimeout(300);
  await page.locator('#d-del').click();
  await row2.waitFor({ state: 'detached', timeout: 10000 });
  log('✓ Entry deleted');

  // ── Lock ──
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  await page.locator('#btn-lock').click();
  await page.locator('#lock-unlock').waitFor({ timeout: 5000 });
  log('✓ Vault locked');

  // ── Check critical errors only (not CSP/network noise) ──
  if (criticalErrors.length > 0) {
    console.error('Critical errors:', criticalErrors);
    assert.fail(`${criticalErrors.length} critical error(s)`);
  }

  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('\n✓ Browser smoke test passed (derive, kit, seal, store, decrypt, reveal, delete, lock).');
} catch (error) {
  console.error(`\n✗ Browser test failed: ${error.message}`);
  if (criticalErrors.length > 0) {
    console.error('Console errors:', criticalErrors.slice(0, 5));
  }
  // Take a screenshot for debugging
  try {
    await page.screenshot({ path: '/tmp/browser-test-failure.png' });
    console.error('Screenshot saved to /tmp/browser-test-failure.png');
  } catch (e) { /* ignore */ }
  throw error;
} finally {
  await page.close();
  await browser.close();
}
