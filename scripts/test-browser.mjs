#!/usr/bin/env node

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

if (cdpUrl) {
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
}

page.on('console', (message) => {
  if (message.type() === 'warning' || message.type() === 'error') {
    browserProblems.push(`console ${message.type()}: ${message.text()}`);
  }
});
page.on('pageerror', (error) => browserProblems.push(`page error: ${error.message}`));
page.on('requestfailed', (request) => {
  const failure = request.failure()?.errorText;
  if (request.url().endsWith('/api/healthz') && failure === 'net::ERR_ABORTED') return;
  browserProblems.push(`request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`);
});

try {
  const separator = webUrl.includes('?') ? '&' : '?';
  await page.goto(`${webUrl}${separator}e2e=${Date.now()}`, { waitUntil: 'networkidle' });
  assert.equal(await page.title(), 'Veyora — Your private digital space');
  await page.locator('#conn-badge').filter({ hasText: 'API' }).waitFor();

  await page.locator('#master-password').fill('inert-browser-password');
  await page.locator('#salt-input').fill('00112233445566778899aabbccddeeff');
  await page.locator('#unlock-btn').click();
  await page.locator('#lock-badge').filter({ hasText: 'Unlocked' }).waitFor();

  const name = `Browser Smoke ${Date.now()}`;
  await page.locator('#new-name').fill(name);
  await page.locator('#generate-btn').click();
  await page.waitForFunction(() => document.querySelector('#new-secret')?.value.length === 20);
  await page.locator('#add-btn').click();

  let row = page.locator('.entry').filter({ hasText: name });
  await row.waitFor();
  assert.match(await page.locator('#vault-status').textContent(), /encrypted and stored/i);

  page.once('dialog', (dialog) => dialog.accept('updated-browser-secret'));
  await row.getByTitle('Edit secret').click();
  await page.waitForFunction(() => document.querySelector('#vault-status')?.textContent.includes('Updated'));

  row = page.locator('.entry').filter({ hasText: name });
  await row.locator('.entry-secret').click();
  assert.equal(await row.locator('.entry-secret').textContent(), 'updated-browser-secret');

  page.once('dialog', (dialog) => dialog.accept());
  await row.locator('button.danger').click();
  await row.waitFor({ state: 'detached' });
  assert.match(await page.locator('#vault-status').textContent(), /Deleted/i);

  await page.locator('#lock-btn').click();
  await page.locator('#lock-badge').filter({ hasText: 'Locked' }).waitFor();

  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.waitForTimeout(250);
  assert.deepEqual(browserProblems, [], browserProblems.join('\n'));
  console.log('Browser smoke test passed (load, API, WASM, create, decrypt, update, delete, and lock).');
} finally {
  await page.close();
  await browser.close();
}
