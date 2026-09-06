#!/usr/bin/env node
/**
 * Live Connect / Sign-in gate verification (PRD UX-ONB-003).
 *
 * Unlike the mocked gate coverage in test-browser-full.mjs, this script runs
 * against a real stack started with VEYORA_API_AUTH=token, so the 401 probe,
 * credential verification, and re-entry through boot all exercise the actual
 * API authentication path. It is run on demand (it needs the deployment
 * token), not as part of the always-on suites.
 *
 * Environment:
 *   VEYORA_WEB_URL       base URL of the web client (default :3000)
 *   VEYORA_CONNECT_TOKEN the real operator-issued deployment token
 *   VEYORA_API_URL       API base for direct envelope checks
 *                       (default `${VEYORA_WEB_URL}/api`)
 */

import assert from 'node:assert/strict';

if (!process.env.VEYORA_CONNECT_TOKEN) {
  console.error('Set VEYORA_CONNECT_TOKEN to the deployment token of the live stack.');
  process.exit(1);
}
const token = process.env.VEYORA_CONNECT_TOKEN;
const webUrl = process.env.VEYORA_WEB_URL || 'http://127.0.0.1:3000';
const apiUrl = process.env.VEYORA_API_URL || `${webUrl}/api`;

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('playwright-core')); }

const browser = await (async () => {
  const candidates = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastError;
  for (const candidate of candidates) {
    try { return await chromium.launch({ headless: true, ...candidate }); }
    catch (error) { lastError = error; }
  }
  throw lastError;
})();

const results = { passed: 0, failed: 0 };
const test = (name, fn) => Promise.resolve(fn()).then(() => {
  results.passed++;
  console.log(`  ✓ ${name}`);
}).catch((error) => {
  results.failed++;
  console.error(`  ✗ ${name}: ${error.message}`);
});

try {
  await test('the live API rejects unauthenticated and wrong-token probes with the stable envelope', async () => {
    for (const headers of [undefined, { Authorization: 'Bearer not-the-token' }]) {
      const response = await fetch(`${apiUrl}/records`, { headers });
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.error.code, 'PM-API-UNAUTHORIZED');
    }
    // The authorized probe carries a declared vault scope (DATA-004):
    // a bare listing would 400 on the missing scope, not on auth.
    const ok = await fetch(`${apiUrl}/records?vault=probe`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200);
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  await page.goto(webUrl, { waitUntil: 'networkidle' });

  await test('a fresh browser against the live token stack gates on Connect / Sign in (UX-ONB-003)', async () => {
    await page.locator('#view-connect').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#lock-routes').count(), 0,
      'no Welcome routes before a session exists');
    assert.equal(await page.locator('#lock-welcome').count(), 0,
      'no vault creation before a session exists');
    assert.equal(await page.locator('#lock-unlock').count(), 0,
      'no vault unlock before a session exists');
    const text = await page.locator('#view-connect').textContent();
    assert.match(text, /requires a connected session/, 'the gate explains why');
  });

  await test('the live service refuses a wrong connection token', async () => {
    await page.locator('#conn-url').fill(apiUrl);
    await page.locator('#conn-token').fill('definitely-not-the-token');
    await page.locator('#btn-connect').click();
    await page.waitForFunction(() =>
      document.querySelector('#conn-error')?.textContent.includes('rejected'));
    assert.equal(await page.locator('#view-connect').count(), 1, 'gate stays up');
  });

  await test('the real deployment token enters the Welcome routes (UX-ONB-002/003)', async () => {
    await page.locator('#conn-token').fill(token);
    await page.locator('#btn-connect').click();
    await page.waitForSelector('#lock-routes', { timeout: 15000 });
    assert.match(await page.locator('#wf-create').textContent(), /Create a new vault/);
    assert.equal(await page.locator('#view-connect').count(), 0, 'the gate is gone');
  });

  assert.deepEqual(problems, [], 'no unexpected page errors');
  await context.close();
} finally {
  await browser.close();
}

console.log(`token gate verification: ${results.passed} passed, ${results.failed} failed`);
process.exit(results.failed ? 1 : 0);
