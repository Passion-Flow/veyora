#!/usr/bin/env node
/**
 * Fault-injection browser suite: real service 429 and 5xx answers driven
 * into the web client's save-failure surfaces (ITEM-006), each followed by
 * a genuine recovery.
 *
 * This suite runs against its own stack (`make test-browser-faults`):
 *   - VEYORA_API_RATE_LIMIT is small (25/min) so a burst of real requests
 *     trips the live rate limiter (PM-API-RATE-LIMITED) instead of a mock.
 *   - The postgres container (VEYORA_DB_CONTAINER, default
 *     veyora-postgres-1) is stopped mid-run so the API answers a genuine
 *     503 PM-STORE-UNAVAILABLE from the store layer.
 *
 * Environment:
 *   VEYORA_WEB_URL        base URL of the web client (default :3000)
 *   VEYORA_DB_CONTAINER   postgres container name (default veyora-postgres-1)
 *   VEYORA_SCREENSHOT_PATH  optional screenshot output path
 */

import assert from 'node:assert/strict';
import { execFile as execFileRaw } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';

const execFile = promisify(execFileRaw);

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('playwright-core'));
}

const webUrl = process.env.VEYORA_WEB_URL || 'http://127.0.0.1:3000';
const dbContainer = process.env.VEYORA_DB_CONTAINER || 'veyora-postgres-1';
const screenshotPath = process.env.VEYORA_SCREENSHOT_PATH;
const masterPassword = 'fault-suite-master-password';

const browser = await (async () => {
  const candidates = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastError;
  for (const candidate of candidates) {
    try {
      return await chromium.launch({ headless: true, ...candidate });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
})();
const context = await browser.newContext({
  permissions: ['clipboard-read', 'clipboard-write'],
  viewport: { width: 1440, height: 1100 },
});
const page = await context.newPage();

// The suite intentionally drives 429/503 resources; those console lines are
// the expected symptom, everything else is a real problem.
const problems = [];
page.on('console', (message) => {
  if (message.type() !== 'error' && message.type() !== 'warning') return;
  const text = message.text();
  if (text.includes('status of 429')) return;
  if (text.includes('status of 503')) return;
  if (text.includes('CSP')) return;
  if (text.includes('favicon')) return;
  problems.push(`console ${message.type()}: ${text}`);
});
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));

const results = { passed: 0, failed: 0 };
const test = (name, fn) => Promise.resolve(fn()).then(() => {
  results.passed++;
  console.log(`  ✓ ${name}`);
}).catch((error) => {
  results.failed++;
  console.error(`  ✗ ${name}: ${error.message}`);
});

/** Resolve as soon as any selector becomes visible; returns its index. */
async function waitFirst(selectors, timeout = 30000) {
  const outcome = await Promise.allSettled(selectors.map((selector, index) =>
    page.locator(selector).waitFor({ timeout }).then(() => index)));
  const hit = outcome.map(entry => entry.status === 'fulfilled' ? entry.value : -1);
  const first = hit.find(index => index >= 0);
  if (first === undefined) throw new Error(`none of ${selectors.join(', ')} appeared`);
  return first;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Fire real requests from the page until the live limiter answers 429. */
async function burstUntilRateLimited() {
  return page.evaluate(async () => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const response = await fetch('/api/healthz', { cache: 'no-store' });
      if (response.status === 429) {
        const body = await response.json().catch(() => null);
        return {
          status: response.status,
          retryAfter: response.headers.get('retry-after'),
          code: body && body.error ? body.error.code : null,
          attempts: attempt + 1,
        };
      }
    }
    return null;
  });
}

async function saveNewEntry(name, secret) {
  await page.locator('#btn-new').click();
  await page.locator('#ov-entry.on').waitFor();
  await page.locator('#f-name').fill(name);
  await page.locator('#f-secret').fill(secret);
  await page.locator('#btn-save-entry').click();
}

try {
  await page.goto(webUrl, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  // === 0. Vault bootstrap on the rate-limited stack ===
  await page.locator('#wf-create').click();
  await page.locator('#new-pw').fill(masterPassword);
  await page.locator('#new-pw2').fill(masterPassword);
  await page.locator('#btn-create').click();
  await page.locator('#btn-new').waitFor({ timeout: 15000 });

  // UX-ONB-007: complete the Recovery Key ceremony after creation.
  const kitOverlay = page.locator('#ov-kit.on');
  await kitOverlay.waitFor({ timeout: 15000 });
  const kit = await page.locator('#kit-out').inputValue();
  await page.locator('#kit-verify').fill(kit);
  await page.locator('#btn-kit-verify').click();
  await page.locator('#ov-kit').waitFor({ state: 'hidden' });

  // === 2. Real 5xx from the store layer into the save surface ===
  await test('a genuine 503 (store down) surfaces in the save banner and recovers', async () => {
    await execFile('docker', ['stop', dbContainer]);
    await sleep(2000);

    // Prove the service itself answers 503 PM-STORE-UNAVAILABLE.
    const probe = await page.evaluate(async () => {
      const response = await fetch('/api/records?vault=probe', { cache: 'no-store' });
      const body = await response.json().catch(() => null);
      return { status: response.status, code: body && body.error ? body.error.code : null };
    });
    assert.equal(probe.status, 503, 'the live API answers 503 while the store is down');
    assert.equal(probe.code, 'PM-STORE-UNAVAILABLE', 'the 503 carries the stable code');

    const stamp = Date.now();
    await saveNewEntry(`E2E Store Down ${stamp}`, 'store-down-secret-123456');
    await page.locator('#entry-save-status').waitFor({ timeout: 30000 });
    const text = await page.locator('#entry-save-status').textContent();
    assert.match(text, /Not saved yet/, 'the banner names the failure');
    assert.match(text, /service could not be reached/,
      'the banner explains the unreachable store');
    assert.equal(await page.locator('#f-name').inputValue(), `E2E Store Down ${stamp}`,
      'the typed input is preserved (ITEM-006)');

    // Bring the store back and prove readiness flips before retrying.
    await execFile('docker', ['start', dbContainer]);
    let healthy = 'starting';
    for (let i = 0; i < 30 && healthy !== 'healthy'; i++) {
      await sleep(2000);
      ({ stdout: healthy } = await execFile('docker',
        ['inspect', '--format', '{{.State.Health.Status}}', dbContainer]));
      healthy = healthy.trim();
    }
    assert.equal(healthy, 'healthy', 'postgres returns to healthy');
    let ready = 0;
    for (let i = 0; i < 15 && ready !== 200; i++) {
      await sleep(2000);
      ready = await page.evaluate(async () => (await fetch('/api/readyz', { cache: 'no-store' })).status);
    }
    assert.equal(ready, 200, 'the API reports ready again (API-006)');

    // The pool may need a moment after recovery; retry until it commits.
    let saved = false;
    for (let i = 0; i < 10 && !saved; i++) {
      await page.locator('#save-retry').click();
      const which = await waitFirst(['.saved-panel', '#entry-save-status'], 20000);
      if (which === 0) saved = true;
    }
    assert.ok(saved, 'the retried save commits after the store recovers');
    await page.locator('#saved-back').click();
    await page.locator('#ov-entry').waitFor({ state: 'hidden' });
    await page.locator('.trow').filter({ hasText: `E2E Store Down ${stamp}` }).waitFor();
  });

  // === 3. Slow save stays single-flight (gateway-injected latency) ===
  await test('a deliberately slow save disables the button, fires once, and still commits', async () => {
    const stamp = Date.now();
    // The stack's gateway injects real latency on /api/records
    // (VEYORA_GATEWAY_DELAY_MS in `make test-browser-faults`), so the save
    // request is observably in flight while the assertions run.
    const saves = [];
    const onSave = req => { if (req.url().includes('/api/records')) saves.push(req.url()); };
    page.on('request', onSave);
    await page.locator('#btn-new').click();
    await page.locator('#ov-entry.on').waitFor();
    await page.locator('#f-name').fill(`E2E Slow Save ${stamp}`);
    await page.locator('#f-secret').fill('slow-save-secret-123456');
    await page.locator('#btn-save-entry').click();
    // The async seal+PUT window: the control must be inert immediately,
    // and hammering it must not issue a second write.
    assert.equal(await page.locator('#btn-save-entry').isDisabled(), true,
      'the save button is disabled while the request is in flight');
    for (let i = 0; i < 3; i++) {
      await page.locator('#btn-save-entry').click({ force: true }).catch(() => {});
    }
    await page.locator('.saved-panel').waitFor({ timeout: 30000 });
    page.off('request', onSave);
    assert.equal(saves.length, 1,
      `exactly one record write was sent (got ${saves.length})`);
    await page.locator('#saved-back').click();
    await page.locator('#ov-entry').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.trow').filter({ hasText: `E2E Slow Save ${stamp}` }).count(),
      1, 'the slow save produced exactly one entry');
  });

  // === 4. Atomic password change under store failure (E2E-004) ===
  await test('a password change that hits a dead store leaves the old password and every record usable', async () => {
    const stamp = Date.now();
    // Populate 100 items through the real import path.
    const rows = Array.from({ length: 100 }, (_, i) =>
      `E2E 004 Item ${String(i).padStart(3, '0')} ${stamp},e2e004.example,u${i},pass-${i},,`);
    const csv = `name,website,username,password,notes,tags_json\n${rows.join('\n')}\n`;
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#set-import').click();
    (await chooser).setFiles({
      name: 'e2e-004.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8'),
    });
    await page.locator('#toast[data-toast-key="toast.imported"]').waitFor({ timeout: 60000 });
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
    const rowsAfterImport = await page.locator('.trow').count();
    assert.ok(rowsAfterImport >= 100,
      `the import committed one hundred items on top of earlier legs (got ${rowsAfterImport})`);

    // Kill the store mid-flight and attempt the change through the UI.
    await execFile('docker', ['stop', dbContainer]);
    await sleep(2000);
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#set-cp-current').fill('fault-suite-master-password');
    await page.locator('#set-cp-new').fill('fault-suite-next-password');
    await page.locator('#set-cp-confirm').fill('fault-suite-next-password');
    // The drawer re-renders on import completion; re-assert the typed
    // values survived and re-type if the re-render cleared them.
    const readBack = async () => ({
      current: await page.locator('#set-cp-current').inputValue(),
      next: await page.locator('#set-cp-new').inputValue(),
      confirm: await page.locator('#set-cp-confirm').inputValue(),
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      const values = await readBack();
      if (values.current && values.next.length >= 15 && values.confirm === values.next) break;
      await sleep(400);
      await page.locator('#set-cp-current').fill('fault-suite-master-password');
      await page.locator('#set-cp-new').fill('fault-suite-next-password');
      await page.locator('#set-cp-confirm').fill('fault-suite-next-password');
    }
    await page.locator('#set-cp-btn').click();
    // Depending on where the dying connection breaks, the surfaced class is
    // either the store's 503 or an unreachable-service failure — both mean
    // the change refused and nothing was re-keyed.
    const errorShown = page.locator('#cp-error')
      .filter({ hasText: /Storage backend unavailable|Cannot reach the server/ });
    try {
      await errorShown.waitFor({ timeout: 30000 });
    } catch {
      const text = await page.locator('#cp-error').textContent().catch(() => '?');
      const drawerOpen = await page.locator('#drawer.on').count();
      throw new Error(`cp-error mismatch; text=${JSON.stringify(text)} drawerOn=${drawerOpen}`);
    }
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });

    // Bring the store back: every record and the OLD password still work.
    await execFile('docker', ['start', dbContainer]);
    let healthy = 'starting';
    for (let i = 0; i < 30 && healthy !== 'healthy'; i++) {
      await sleep(2000);
      ({ stdout: healthy } = await execFile('docker',
        ['inspect', '--format', '{{.State.Health.Status}}', dbContainer]));
      healthy = healthy.trim();
    }
    assert.equal(healthy, 'healthy', 'postgres returns to healthy');
    await page.locator('#btn-lock').click();
    await page.locator('#lock-unlock').waitFor();
    await page.locator('#master-pw').fill('fault-suite-master-password');
    await page.locator('#btn-unlock').click();
    await page.locator('#view-app').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.trow').count(), rowsAfterImport,
      'the failed change left every record readable under the old password');
  });

  // === 1. Real 429 from the live rate limiter into the save surface ===
  await test('a genuine 429 surfaces in the save banner and recovers after the window resets', async () => {
    const limited = await burstUntilRateLimited();
    assert.ok(limited, 'the live service rate-limits under a burst');
    assert.equal(limited.code, 'PM-API-RATE-LIMITED', 'the 429 carries the stable code');
    assert.equal(limited.retryAfter, '60', 'the 429 advertises Retry-After');

    const stamp = Date.now();
    // The burst may land near a minute boundary; a save that slips into a
    // fresh window succeeds instead — retry the whole leg until the banner
    // is genuinely the rate limit answer (max 3 attempts).
    let bannerSeen = false;
    let bannerAttempt = 0;
    for (let attempt = 0; attempt < 3 && !bannerSeen; attempt++) {
      await burstUntilRateLimited();
      // A unique name per attempt: a save that slips into a fresh window
      // commits (and closes) instead of colliding with the retry's row.
      await saveNewEntry(`E2E Rate Limited ${stamp}-${attempt}`, 'rate-limited-secret-123456');
      const which = await waitFirst(['#entry-save-status', '.saved-panel'], 30000);
      if (which === 1) {
        // Wrong leg: the save slipped through a fresh window. Close and redo.
        await page.locator('#saved-back').click();
        await page.locator('#ov-entry').waitFor({ state: 'hidden' });
        await sleep(1000);
        continue;
      }
      bannerSeen = true;
      bannerAttempt = attempt;
      const banner = page.locator('#entry-save-status');
      const text = await banner.textContent();
      assert.match(text, /Not saved yet/, 'the banner names the failure');
      assert.match(text, /Too many requests; retry later/,
        'the banner carries the localized rate-limit message');
      assert.equal(await page.locator('#f-name').inputValue(), `E2E Rate Limited ${stamp}-${attempt}`,
        'the typed input is preserved (ITEM-006)');
    }
    assert.ok(bannerSeen, 'the save was refused by a real 429');

    // The limiter works in fixed wall-clock minute windows; wait for the
    // next boundary so the retry genuinely passes the live limiter.
    const secondsToBoundary = 60 - (Math.floor(Date.now() / 1000) % 60) + 2;
    await sleep(secondsToBoundary * 1000);

    await page.locator('#save-retry').click();
    await page.locator('.saved-panel').waitFor({ timeout: 30000 });
    await page.locator('#saved-back').click();
    await page.locator('#ov-entry').waitFor({ state: 'hidden' });
    await page.locator(`[data-id="e2e-rate-limited-${stamp}-${bannerAttempt}"]`).waitFor();
  });

  if (problems.length > 0) {
    console.error('\nUnexpected console problems:');
    problems.forEach(problem => console.error(`  - ${problem}`));
  }

  console.log(`\nFault suite: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0 || problems.length > 0) process.exit(1);
} catch (error) {
  console.error('Fault suite setup failed:', error.message);
  if (screenshotPath) {
    await writeFile(screenshotPath, await page.screenshot({ fullPage: true }));
    console.error(`screenshot: ${screenshotPath}`);
  }
  process.exit(1);
} finally {
  await browser.close();
}
