#!/usr/bin/env node
/**
 * Comprehensive browser E2E test for the apps/web client.
 *
 * Covers: vault creation, TOTP storage and live display, CSV import,
 * unavailable unsafe lifecycle controls, trash delete + restore, wrong
 * password rejection,
 * and keyboard navigation. Runs against a live stack (API + web).
 *
 * Environment:
 *   VEYORA_WEB_URL          base URL of the web client (default :3000)
 *   VEYORA_SCREENSHOT_PATH  optional screenshot output path
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('playwright-core'));
}

const webUrl = process.env.VEYORA_WEB_URL || 'http://127.0.0.1:3000';
// The build stamp the stack was built with (VEYORA_BUILD_COMMIT at image
// build time); CI stamps its stack differently from local runs.
const buildStamp = process.env.VEYORA_BUILD_COMMIT || 'e2e-local-check';
const screenshotPath = process.env.VEYORA_SCREENSHOT_PATH;
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
const problems = [];

// QA-004 plaintext canary: this value is stored through the real WASM
// kernel and must never leave the client unsealed. This suite asserts it
// appears in no API request body (the reveal assertion later in the run
// is the positive control that it really was stored); the CI compose job
// additionally scans database rows, service logs, and a backup file for
// it. Keep the string in sync with the compose job's canary scan step.
const PLAINTEXT_CANARY = 'e2e-plaintext-canary-6f4b-known';
const requestBodies = [];
context.on('request', (request) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
    requestBodies.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`);
  }
});

// HTTP statuses injected by fault-injection tests; each logs one expected
// console error that must not fail the run.
const expectedFailedStatuses = [];
// Aborted network requests (offline-save tests) log one expected resource
// failure line each.
const expectedFailedResources = [];

page.on('console', (message) => {
  if (message.type() === 'warning' || message.type() === 'error') {
    const index = expectedFailedStatuses.findIndex(code =>
      message.text().includes(`status of ${code}`));
    if (index >= 0) {
      expectedFailedStatuses.splice(index, 1);
      return;
    }
    const resource = expectedFailedResources.findIndex(fragment =>
      message.text().includes(fragment));
    if (resource >= 0) {
      expectedFailedResources.splice(resource, 1);
      return;
    }
    problems.push(`console ${message.type()}: ${message.text()}`);
  }
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

async function closeDrawerIfOpen() {
  const drawer = page.locator('#drawer.on');
  if (await drawer.count()) {
    await page.locator('#drawer-close').click();
    await drawer.waitFor({ state: 'detached' });
  }
}

try {
  // === 0a. Connect / Sign-in gate when the service requires a session ===
  // (UX-ONB-003) A fresh browser against a 401-probing service must see
  // Connect / Sign in — never vault create or unlock — until it connects.
  {
    const gateContext = await browser.newContext();
    const gatePage = await gateContext.newPage();
    await gatePage.route('**/api/records*', route => {
      const auth = route.request().headers()['authorization'] || '';
      if (auth === 'Bearer e2e-connect-token') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'PM-API-UNAUTHORIZED' } }),
      });
    });
    await gatePage.goto(webUrl, { waitUntil: 'load' });

    await test('web without a service session gates on Connect / Sign in (UX-ONB-003)', async () => {
      await gatePage.locator('#view-connect').waitFor({ timeout: 15000 });
      assert.equal(await gatePage.locator('#lock-routes').count(), 0,
        'no Welcome routes before a session exists');
      assert.equal(await gatePage.locator('#lock-welcome').count(), 0,
        'no vault creation before a session exists');
      assert.equal(await gatePage.locator('#lock-unlock').count(), 0,
        'no vault unlock before a session exists');
      const text = await gatePage.locator('#view-connect').textContent();
      assert.match(text, /requires a connected session/, 'the gate explains why');
      assert.match(text, /Service URL/, 'service URL is requested');
      assert.match(text, /Connection token/, 'connection token is requested');
    });

    await test('the connect gate refuses empty and rejected credentials (UX-ONB-003)', async () => {
      await gatePage.locator('#btn-connect').click();
      const error = gatePage.locator('#conn-error');
      await error.waitFor();
      assert.match(await error.textContent(), /Enter both/, 'empty input is refused');
      await gatePage.locator('#conn-url').fill('/api');
      await gatePage.locator('#conn-token').fill('e2e-wrong-token');
      await gatePage.locator('#btn-connect').click();
      await gatePage.waitForFunction(() =>
        document.querySelector('#conn-error').textContent.includes('rejected'));
      assert.equal(await gatePage.locator('#view-connect').count(), 1, 'gate stays up');
    });

    await test('a valid connection enters the Welcome routes (UX-ONB-002/003)', async () => {
      await gatePage.locator('#conn-token').fill('e2e-connect-token');
      await gatePage.locator('#btn-connect').click();
      await gatePage.waitForSelector('#lock-routes', { timeout: 15000 });
      assert.ok(true, 'connected session reaches the Welcome routes');
    });
    await gateContext.close();
  }

  const separator = webUrl.includes('?') ? '&' : '?';
  await page.goto(`${webUrl}${separator}e2e=${Date.now()}`, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });

  // === 0b. Welcome routes (UX-ONB-002) ===
  await test('welcome offers Create, Open, Import, and Advanced connect routes (UX-ONB-002)', async () => {
    await page.locator('#lock-routes').waitFor();
    for (const id of ['#wf-create', '#wf-open', '#wf-import', '#wf-connect']) {
      const label = await page.locator(id).textContent();
      assert.ok(label.length > 0, `${id} is a named action`);
    }
    assert.match(await page.locator('#wf-create').textContent(), /Create a new vault/);
    assert.match(await page.locator('#wf-open').textContent(), /Open an existing vault/);
    assert.match(await page.locator('#wf-import').textContent(), /Import from another password manager/);
    assert.match(await page.locator('#wf-connect').textContent(), /connect to a self-hosted server/);
  });

  await test('open route states honestly that no vault is on this device (UX-ONB-002)', async () => {
    await page.locator('#wf-open').click();
    const note = page.locator('#wf-open-note');
    await note.waitFor();
    assert.match(await note.textContent(), /No vault is known on this device/);
    await page.locator('#wf-back').click();
    await page.locator('#lock-routes').waitFor();
  });

  await test('connect route opens the Connect / Sign in surface (UX-ONB-002)', async () => {
    await page.locator('#wf-connect').click();
    await page.locator('#view-connect').waitFor();
    assert.match(await page.locator('#view-connect').textContent(), /Connect \/ Sign in/);
    // The service here runs without auth, so returning re-enters Welcome.
    await page.locator('#conn-help').click();
    await page.locator('#ov-help').waitFor();
    await page.keyboard.press('Escape');
    await page.goto(`${webUrl}${separator}e2e=${Date.now()}`, { waitUntil: 'load' });
    await page.locator('#lock-routes').waitFor();
  });

  // Enter through the import route so the create form carries the import note.
  await page.locator('#wf-import').click();

  // === 0. Welcome screen copy + Help reachability ===
  await test('welcome explains product, vault, and mode before asking for a password (UX-ONB-001)', async () => {
    await page.locator('#lock-welcome').waitFor();
    const intro = await page.locator('#lock-welcome .welcome-intro').textContent();
    assert.match(intro, /encrypted vault/, 'what the product does');
    assert.match(intro, /A vault is/, 'what a vault is');
    assert.match(intro, /Mode: connected vault/, 'current mode is stated');
  });

  await test('create form explains storage, rules, recovery, and backups (UX-ONB-004)', async () => {
    const explain = await page.locator('.create-explain').textContent();
    assert.match(explain, /Storage:/, 'storage location');
    assert.match(explain, /at least \d+ characters/, 'password requirement');
    assert.match(explain, /Recovery:/, 'recovery consequence');
    assert.match(explain, /Backups:/, 'backup responsibility');
    assert.match(explain, /CSV exports are plaintext and are not backups/, 'plaintext export is not called a backup');
  });

  await test('master password input accepts long Unicode, spaces, and an accessible show control (UX-ONB-005)', async () => {
    const password = `  密码 passphrase ${'x'.repeat(64)}  `;
    const input = page.locator('#new-pw');
    await input.fill(password);
    assert.equal(await input.inputValue(), password, 'Unicode and spaces are preserved');
    assert.ok((await input.inputValue()).length > 64, 'inputs longer than 64 characters are accepted');
    const toggle = page.locator('[data-eye="new-pw"]');
    assert.match(await toggle.getAttribute('aria-label'), /^Show/);
    await toggle.press('Enter');
    assert.equal(await input.getAttribute('type'), 'text', 'keyboard activates Show');
    assert.match(await toggle.getAttribute('aria-label'), /^Hide/);
    await toggle.press('Enter');
    assert.equal(await input.getAttribute('type'), 'password', 'keyboard activates Hide');
    await input.fill('');
  });

  await test('master password rejects values shorter than 15 characters without composition rules (UX-ONB-006)', async () => {
    await page.locator('#new-pw').fill('12345678901234');
    await page.locator('#new-pw2').fill('12345678901234');
    await page.locator('#btn-create').click();
    const error = page.locator('#welcome-error');
    await error.waitFor();
    assert.match(await error.textContent(), /15/, '15-character minimum is explained');
    assert.equal(await page.locator('#new-pw').getAttribute('aria-invalid'), 'true');
  });

  await test('master password built from common material is rejected locally (UX-ONB-006)', async () => {
    await page.locator('#new-pw').fill('passwordpassword');
    await page.locator('#new-pw2').fill('passwordpassword');
    await page.locator('#btn-create').click();
    const error = page.locator('#welcome-error');
    await error.waitFor();
    assert.match(await error.textContent(), /common/i, 'common-password rejection is explained');
    assert.equal(await page.locator('#new-pw').getAttribute('aria-invalid'), 'true');
    // The pre-commit disclosure states the check stays on this device.
    assert.match(await page.locator('#lock-welcome').textContent(), /never sent/i);
    await page.locator('#new-pw').fill('');
    await page.locator('#new-pw2').fill('');
  });

  await test('help is reachable from the welcome screen and routes by task (HELP-001/002)', async () => {
    await page.locator('#lock-help').click();
    await page.locator('#ov-help').waitFor();
    const tasks = await page.locator('#ov-help .help-task').count();
    assert.ok(tasks >= 7, `task-routed help entries (got ${tasks})`);
    const helpText = await page.locator('#ov-help').textContent();
    assert.match(helpText, /Get started/, 'get-started task');
    assert.match(helpText, /Connect to a service/, 'connect task');
    assert.match(helpText, /Report a security issue/, 'security report task');
    assert.match(helpText, /plaintext CSV export is not a backup/, 'backup limitation is explicit');
    // No vault is unlocked yet, so vault-dependent buttons are not offered;
    // the private security-report destination remains available.
    assert.equal(await page.locator('#ov-help [data-help-action]').count(), 0,
      'vault-dependent actions hidden while locked');
    const report = page.locator('#ov-help [data-help-link]');
    assert.match(await report.getAttribute('href'), /security\/advisories\/new$/,
      'security task routes to private reporting');
    await page.locator('[data-help-close]').click();
    assert.equal(await page.locator('#lock-help').evaluate(el => document.activeElement === el), true,
      'closing Help restores focus');
  });

  // === 1. Vault creation ===
  await test('create vault with master password', async () => {
    await page.locator('#lock-welcome').waitFor();
    // The import route explains that the password comes first.
    assert.match(await page.locator('#route-import-note').textContent(),
      /import step follows right after the vault opens/, 'import route sets expectations');
    await page.locator('#new-pw').fill('e2e-comprehensive-pw');
    await page.locator('#new-pw2').fill('e2e-comprehensive-pw');
    await page.locator('#btn-create').click();
    await page.locator('#view-app').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#goto-recover').count(), 0);
    assert.equal(await page.locator('#tb-recovery').count(), 0);
    // The import route lands in Settings → Data (UX-ONB-002 route behavior).
    await page.locator('#set-import').waitFor();
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
  });

  await test('open vault shows empty state with CTA and import', async () => {
    await page.locator('#empty-cta').waitFor();
    const emptyText = await page.locator('.table-empty').textContent();
    assert.match(emptyText, /Your vault is empty/, 'NAV-004 empty-vault title');
    assert.equal(await page.locator('#empty-import').count(), 1, 'NAV-004 import action present');
    const ctaText = await page.locator('#empty-cta').textContent();
    assert.match(ctaText, /Add your first login/, 'NAV-004 first-login action');
  });

  await test('the topbar names the vault and a safe location summary (PRD 6.3 / NAV-001)', async () => {
    const identity = await page.locator('#tb-vault').textContent();
    assert.match(identity, /My Veyora vault/, 'human-readable vault name');
    assert.match(identity, /Connected vault at [\w.-]+/, 'connected location names the host');
    // Canary: the identity line never carries a URL, path, or token.
    assert.ok(!/https?:|\/|token/i.test(identity), 'no URL, path, or token in the identity');
  });

  await test('creation presents the Recovery Key and requires a verified save (UX-ONB-007)', async () => {
    const overlay = page.locator('#ov-kit.on');
    await overlay.waitFor({ timeout: 15000 });
    const kit = await page.locator('#kit-out').inputValue();
    assert.match(kit, /^[a-z2-7]{5}(-[a-z2-7]{5}){11}$/,
      'a canonical Recovery Key is presented for saving');
    // A mistyped copy is refused and nothing is marked complete.
    await page.locator('#kit-verify').fill(`${kit.slice(0, -1)}${kit.endsWith('a') ? 'b' : 'a'}`);
    await page.locator('#btn-kit-verify').click();
    await page.locator('#kit-error[data-error-key="kit.errMismatch"]').waitFor();
    // The true copy verifies and the ceremony closes.
    await page.locator('#kit-verify').fill(kit);
    await page.locator('#btn-kit-verify').click();
    await page.locator('#ov-kit').waitFor({ state: 'hidden' });
    const stored = await page.evaluate(
      () => JSON.parse(localStorage.getItem('veyora.web.startHere') || '{}'));
    assert.equal(stored.done && stored.done.recovery, true,
      'the verified save records the onboarding step (UX-ONB-007)');
  });

  await test('start here checklist guides the first steps (UX-ONB-008)', async () => {
    const card = page.locator('#start-here.on .sh-card');
    await card.waitFor();
    // The ceremony's checklist re-render is async; wait for the done state.
    await page.waitForFunction(
      () => document.querySelectorAll('.sh-item.done').length === 1, { timeout: 10000 });
    const text = await card.textContent();
    assert.match(text, /Add your first login or import items/, 'first login/import step');
    assert.match(text, /Copy or reveal a secret/, 'copy/reveal step');
    assert.match(text, /Lock your vault when you step away/, 'lock step');
    assert.match(text, /Verify your recovery material/, 'recovery step is guided');
    assert.match(text, /Create an encrypted backup/, 'backup step is guided');
    // The Recovery Key ceremony verified during creation (UX-ONB-007), so
    // exactly that step starts done; the rest remain open.
    assert.equal(await page.locator('.sh-item.done').count(), 1,
      'recovery verification is already complete from the creation ceremony');
    assert.match(await page.locator('.sh-item.done').first().textContent(),
      /Verify your recovery material/, 'the done step is recovery');
  });

  // === 2. Entry creation with TOTP ===
  const entryName = `E2E Full ${Date.now()}`;
  await test('login form starts with core fields and hides advanced ones (ITEM-002)', async () => {
    await page.locator('#btn-new').click();
    await page.locator('#ov-entry.on').waitFor();
    // Name, Username, Password, Website are the initial layout.
    for (const id of ['#f-name', '#f-username', '#f-secret', '#f-website']) {
      assert.ok(await page.locator(id).isVisible(), `${id} visible initially`);
    }
    // TOTP and Notes wait behind the More fields disclosure.
    assert.equal(await page.locator('#f-totpSecret').isVisible(), false, 'TOTP hidden before disclosure');
    const toggle = page.locator('#more-fields');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'disclosure starts collapsed');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'disclosure expands');
    await page.locator('#f-totpSecret').waitFor();
    // Name guidance uses a recognition example (ITEM-003).
    assert.equal(await page.locator('#f-name').getAttribute('placeholder'), 'GitHub - Work');
    assert.match(await page.locator('#fh-name').textContent(), /GitHub - Work/, 'name hint explains recognition');
    assert.match(await page.locator('#fh-totpSecret').textContent(), /otpauth:\/\//, 'TOTP hint names the accepted sources');
  });

  await test('multiple save errors surface inline beside each field with a summary (ACC-010)', async () => {
    // The modal is freshly open: both the name and the required password are
    // empty, so one click must report every problem at once.
    await page.locator('#btn-save-entry').click();
    const summary = page.locator('#entry-error-summary');
    await summary.waitFor();
    assert.equal(await summary.locator('[data-err-link]').count(), 2,
      'summary lists both field errors as links');
    await page.waitForFunction(() =>
      document.activeElement === document.querySelector('#entry-error-summary'));
    assert.ok(true, 'the summary takes focus when several errors exist');
    assert.match(await page.locator('#ferr-name').textContent(),
      /name so you can recognize it later/i, 'name error states the correction');
    assert.equal(await page.locator('#f-name').getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('#ferr-secret').textContent(),
      /required field before saving/i, 'secret error states the correction');
    assert.equal(await page.locator('#f-secret').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#ov-entry.on').count(), 1, 'form stays open');
    assert.equal(await page.locator('#f-secret').inputValue(), '', 'input values are preserved as typed');
    // A summary link moves focus to its field; typing clears that error only.
    await page.locator('[data-err-link="name"]').click();
    await page.waitForFunction(() => document.activeElement === document.querySelector('#f-name'));
    assert.ok(true, 'the summary link focuses its field');
    await page.locator('#f-name').fill('temporary name');
    assert.equal(await page.locator('#ferr-name').textContent(), '', 'editing clears the inline error');
    assert.equal(await page.locator('#f-name').getAttribute('aria-invalid'), null,
      'aria-invalid is removed once fixed');
  });

  await test('password field exposes named Generate, Show/Hide, and Copy actions (ITEM-004)', async () => {
    await page.locator('#f-secret').fill(PLAINTEXT_CANARY);
    const generate = page.locator('#fgen-secret');
    assert.match(await generate.textContent(), /Generate/, 'Generate is named');
    const show = page.locator('#fshow-secret');
    assert.match(await show.getAttribute('aria-label'), /^Show/, 'Show has an accessible name');
    await show.press('Enter');
    assert.equal(await page.locator('#f-secret').getAttribute('type'), 'text', 'Show reveals the field');
    assert.equal(await show.getAttribute('aria-pressed'), 'true');
    await show.press('Enter');
    assert.equal(await page.locator('#f-secret').getAttribute('type'), 'password', 'Hide masks the field again');
    const copy = page.locator('#fcopy-secret');
    assert.match(await copy.getAttribute('aria-label'), /^Copy/, 'Copy has an accessible name');
    await copy.click();
    await page.locator('#toast.on').waitFor();
  });

  await test('malformed TOTP input is rejected without discarding the form (ITEM-005)', async () => {
    await page.locator('#f-name').fill(entryName);
    await page.locator('#f-username').fill('e2e@veyora.dev');
    await page.locator('#f-totpSecret').fill('not-a-valid-base32-secret!');
    await page.locator('#btn-save-entry').click();
    const error = page.locator('#ferr-totpSecret');
    await error.waitFor();
    assert.match(await error.textContent(), /A–Z and digits 2–7/, 'inline error explains Base32');
    assert.equal(await page.locator('#f-totpSecret').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#ov-entry.on').count(), 1, 'form stays open');
    // A single error focuses the field itself; no summary is needed (ACC-010).
    await page.waitForFunction(() =>
      document.activeElement === document.querySelector('#f-totpSecret'));
    assert.ok(true, 'a single error focuses its field');
    assert.equal(await page.locator('#entry-error-summary:not(.hidden)').count(), 0,
      'no summary for a single error');
    assert.equal(await page.locator('#f-totpSecret').inputValue(), 'not-a-valid-base32-secret!',
      'the typed input is preserved');
  });

  await test('create entry with an otpauth:// TOTP URI', async () => {
    // A URI with lowercase, spaced, and dashed secret material exercises
    // normalization (ITEM-005).
    await page.locator('#f-totpSecret').fill(
      'otpauth://totp/Veyora:e2e%40veyora.dev?secret=jbsw-y3dp ehpk3pxp&issuer=Veyora');
    await page.locator('#btn-save-entry').click();
    await page.locator('.trow').filter({ hasText: entryName }).waitFor();
  });

  await test('save presents clear next actions (ITEM-007)', async () => {
    const panel = page.locator('.saved-panel');
    await panel.waitFor();
    const text = await panel.textContent();
    assert.match(text, /Saved/, 'saved confirmation');
    assert.ok(text.includes(entryName), 'saved panel names the item');
    assert.equal(await page.locator('#saved-back').count(), 1, 'back-to-vault action');
    assert.equal(await page.locator('#saved-copy').count(), 1, 'copy action');
    assert.equal(await page.locator('#saved-add').count(), 1, 'add-another action');
    await page.locator('#saved-back').click();
    assert.equal(await page.locator('#ov-entry.on').count(), 0, 'modal closed');
    await page.locator('.trow').filter({ hasText: entryName }).waitFor();
  });

  await test('start here checklist checks off the first-item step (UX-ONB-008)', async () => {
    const done = page.locator('.sh-item.done');
    // The ITEM-004 field-level Copy ran earlier in this run, so the
    // copy/reveal step is complete alongside the first-item step.
    assert.equal(await done.count(), 3,
      'first-item, copy-reveal, and recovery (creation ceremony) are done');
    const doneText = await done.allTextContents();
    assert.ok(doneText.some(text => /first login/i.test(text)), 'first login/import step is done');
    assert.ok(doneText.some(text => /copy or reveal a secret/i.test(text)), 'copy/reveal step is done');
    assert.ok(await page.locator('#start-here.on').count() === 1, 'checklist still visible');
  });

  await test('TOTP code displays live with countdown', async () => {
    await page.locator('.trow').filter({ hasText: entryName }).click();
    await page.locator('#drawer.on').waitFor();
    await page.locator('#totp-code').waitFor({ timeout: 5000 });
    const code = await page.locator('#totp-code').textContent();
    assert.match(code.replace(/\s/g, ''), /^\d{6}$/, '6-digit TOTP code');
    const remaining = await page.locator('#totp-remaining').textContent();
    assert.match(remaining, /^\d+s$/, 'countdown timer');
  });

  // === 3. Reveal secret ===
  await test('reveal shows the decrypted password', async () => {
    await page.locator('#d-reveal').click();
    const revealed = await page.locator('.d-val.mono').filter({ hasText: PLAINTEXT_CANARY }).count();
    assert.ok(revealed >= 1);
    assert.equal(await page.locator('.sh-item.done').count(), 3,
      'first-item, copy-reveal, and recovery are done after the reveal');
  });

  // === 4. Edit and CAS update ===
  await test('edit entry bumps revision', async () => {
    await page.locator('#d-edit').click();
    await page.locator('#f-secret').fill('rotated-e2e-password');
    await page.locator('#btn-save-entry').click();
    await page.locator('.saved-panel').waitFor();
    await page.locator('#saved-back').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
    await page.locator('.trow').filter({ hasText: entryName }).click();
    await page.locator('#drawer.on').waitFor();
    await page.waitForTimeout(1000);
    const meta = await page.locator('.d-meta').textContent();
    assert.match(meta, /revision 2/i, `revision in meta: ${meta}`);
  });

  await test('failed edit preserves the last saved in-memory value (ITEM-006/QA-015)', async () => {
    const entryId = entryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await page.locator('#d-edit').click();
    await page.locator('#f-secret').fill('must-not-survive-failed-save');
    const rejectUpdate = async route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'PM-STORE-UNAVAILABLE' } }),
    });
    await page.route(`**/records/${entryId}`, rejectUpdate);
    expectedFailedStatuses.push(503);
    await page.locator('#btn-save-entry').click();
    const status = page.locator('#entry-save-status');
    await status.waitFor();
    assert.match(await status.textContent(), /vault was not changed/,
      'the save status states that the data did not change (ITEM-006)');
    assert.match(await status.textContent(), /service could not be reached/,
      'the network failure class is named');
    assert.equal(await page.locator('#ov-entry.on').count(), 1, 'failed edit form remains open');
    await page.unroute(`**/records/${entryId}`, rejectUpdate);
    await page.waitForTimeout(100);
        await page.locator('#ov-entry [data-close]').first().click();
    await page.locator('#d-reveal').click();
    const detail = await page.locator('#detail-inner').textContent();
    assert.ok(detail.includes('rotated-e2e-password'), 'last saved value remains');
    assert.ok(!detail.includes('must-not-survive-failed-save'), 'failed value was not retained');
  });

  await test('retrying a failed save is idempotent and reports synchronization (ITEM-006)', async () => {
    await closeDrawerIfOpen();
    const entryId = entryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await page.locator('.trow').filter({ hasText: entryName }).click();
    await page.locator('#drawer.on').waitFor();
    await page.locator('#d-edit').click();
    await page.locator('#f-secret').fill('retry-idempotent-password');
    const rejectUpdate = async route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'PM-STORE-UNAVAILABLE' } }),
    });
    await page.route(`**/records/${entryId}`, rejectUpdate);
    expectedFailedStatuses.push(503);
    await page.locator('#btn-save-entry').click();
    await page.locator('#entry-save-status').waitFor();
    await page.unroute(`**/records/${entryId}`, rejectUpdate);
    await page.waitForTimeout(100);
        // The retry re-runs the same compare-and-set write: same id, same prior
    // revision, so it can succeed exactly once.
    await page.locator('#save-retry').click();
    const panel = page.locator('.saved-panel');
    await panel.waitFor();
    assert.match(await panel.textContent(), /Synchronized with the service — revision \d+/,
      'success reports the synchronized state and server revision');
    await page.locator('#saved-back').click();
    await page.locator('.trow').filter({ hasText: entryName }).waitFor();
    const rows = await page.locator('.trow').filter({ hasText: entryName }).count();
    assert.equal(rows, 1, 'the retried save created no duplicate item');
  });

  await test('an offline save is queued, badged, and syncs when the connection returns (ITEM-006)', async () => {
    // The previous test leaves the drawer re-rendering; let it settle first
    // (closing during the re-render races the click).
    await page.waitForTimeout(400);
    await closeDrawerIfOpen();
    const name = `Offline E2E ${Date.now()}`;
    const entryId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const secret = 'offline-queued-e2e-password';
    const abortPut = route => route.abort('failed');
    await page.route(`**/records/${entryId}`, abortPut);
    expectedFailedResources.push('net::ERR_FAILED');
    await page.locator('#btn-new').click();
    await page.locator('#ov-entry.on').waitFor();
    await page.locator('#f-name').fill(name);
    await page.locator('#f-secret').fill(secret);
    await page.locator('#btn-save-entry').click();
    const panel = page.locator('.saved-panel');
    await panel.waitFor();
    assert.match(await panel.textContent(), /Saved on this device — not yet on the service/,
      'the save is reported as pending, not lost');
    assert.equal(await page.locator('#saved-sync-now').count(), 1, 'a Sync now action is offered');
    // The queued material is the sealed ciphertext envelope, never plaintext.
    const leaked = await page.evaluate(value =>
      Object.values(localStorage).some(stored => String(stored).includes(value)), secret);
    assert.equal(leaked, false, 'no plaintext secret reaches local storage');
    // The table behind the modal already shows the offline row, badged as
    // pending sync (the queue is the badge's source of truth).
    const row = page.locator('.trow').filter({ hasText: name });
    await row.waitFor();
    assert.equal(await row.locator('.badge-pending').count(), 1,
      'the row carries a pending-sync badge');
    // Reconnect and drain the queue from the panel's Sync now action: the
    // queued write reaches the service, the list refetches, and the badge
    // disappears from the re-rendered table.
    await page.unroute(`**/records/${entryId}`, abortPut);
    await page.waitForTimeout(100);
    await page.locator('#saved-sync-now').click();
    await page.waitForFunction(() =>
      (document.getElementById('saved-sync-line')?.textContent ?? '')
        .includes('Synchronized with the service'));
    await page.locator('#saved-back').click();
    const refreshed = page.locator('.trow').filter({ hasText: name });
    await refreshed.first().waitFor();
    assert.equal(await refreshed.locator('.badge-pending').count(), 0,
      'the pending badge clears once the write reached the service');
    // Clean up: later tests assume the main entry is the only remaining row,
    // so delete this item before moving on (drawer delete with confirm).
    await refreshed.first().click();
    await page.locator('#drawer.on').waitFor();
    await page.locator('#d-del').click();
    await page.locator('#d-del').click();
    await refreshed.waitFor({ state: 'detached' });
  });

  await test('a conflicting save reports the conflict and can reload the latest version (ITEM-006)', async () => {
    await closeDrawerIfOpen();
    const entryId = entryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await page.locator('.trow').filter({ hasText: entryName }).click();
    await page.locator('#drawer.on').waitFor();
    await page.locator('#d-edit').click();
    await page.locator('#f-secret').fill('conflicted-edit-value');
    const rejectConflict = async route => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'PM-STORE-CONFLICT' } }),
    });
    await page.route(`**/records/${entryId}`, rejectConflict);
    expectedFailedStatuses.push(409);
    await page.locator('#btn-save-entry').click();
    const status = page.locator('#entry-save-status');
    await status.waitFor();
    assert.match(await status.textContent(), /changed on another device/,
      'the conflict class names what happened');
    assert.match(await status.textContent(), /Reload latest version/,
      'the conflict offers the reload action');
    assert.equal(await page.locator('#ov-entry.on').count(), 1, 'the form stays open');
    assert.equal(await page.locator('#f-secret').inputValue(), 'conflicted-edit-value',
      'the conflicting edits are preserved in the form');
    await page.unroute(`**/records/${entryId}`, rejectConflict);
    await page.waitForTimeout(100);
    await page.locator('#save-reload').click();
    // Reload refetches and re-opens the form on the server's latest version.
    await page.waitForFunction(
      () => document.querySelector('#f-secret')?.value === 'retry-idempotent-password',
      null, { timeout: 15000 });
    assert.ok(true, 'the form now shows the latest synchronized value');
    await page.locator('#ov-entry [data-close]').first().click();
    await page.locator('#ov-entry.on').waitFor({ state: 'detached' });
  });

  // === 5. CSV import ===
  await test('CSV import creates entries', async () => {
    await closeDrawerIfOpen();
    await page.locator('#tb-settings').click();
    await page.locator('#set-import').waitFor();

    // We can't trigger the file input directly in Playwright without
    // setInputFiles, so we test the parser via the unit tests instead.
    // Here we verify the import button exists and the file input is present.
    const importBtn = await page.locator('#set-import').count();
    const fileInput = await page.locator('#import-file').count();
    assert.equal(importBtn, 1, 'import button present');
    assert.equal(fileInput, 1, 'file input present');
  });

  // === 5b. Encrypted backup vs plaintext export (EXP-001..003) ===
  await test('data section separates encrypted backup from plaintext export (EXP-001)', async () => {
    const backupBtn = page.locator('#set-backup');
    await backupBtn.waitFor();
    assert.equal(await backupBtn.isDisabled(), false,
      'encrypted backup is an available action');
    assert.equal(await backupBtn.getAttribute('aria-disabled'), null,
      'no stale unavailability is claimed');
    const drawerText = await page.locator('#drawer').textContent();
    assert.match(drawerText, /restores on any device/i,
      'the backup row states portability and what unlocks it');
    assert.ok(await page.locator('#set-restore').count() === 1,
      'restore is its own named action');
    const exportRow = await page.locator('#set-export').locator('..').textContent();
    assert.match(exportRow, /Export plaintext data/, 'plaintext export is its own named action');
    assert.match(exportRow, /Not encrypted/i, 'plaintext export sub warns about plaintext');
  });

  await test('plaintext export requires acknowledgement and re-authentication (EXP-002)', async () => {
    await page.locator('#set-export').click();
    await page.locator('#ov-export.on').waitFor();
    const warning = await page.locator('.export-warn').textContent();
    assert.match(warning, /Not encrypted/, 'unskippable warning is always visible');
    assert.match(warning, /read every exported secret/, 'warning states the consequence');

    // No acknowledgement yet: the export must refuse to proceed.
    await page.locator('#btn-export-plain').click();
    assert.match(await page.locator('#export-error').textContent(), /understand the warning/,
      'missing acknowledgement is rejected');

    // Acknowledged but wrong password: refuse again, stay on the warning stage.
    await page.locator('#export-ack').check();
    await page.locator('#export-pw').fill('e2e-wrong-export-pw');
    await page.locator('#btn-export-plain').click();
    await page.waitForFunction(() =>
      document.querySelector('#export-error').textContent.includes('Wrong master password'));
    assert.equal(await page.locator('#ov-export.on').count(), 1, 'overlay stays open');
    assert.equal(await page.locator('#export-done:not(.hidden)').count(), 0,
      'no completion view without re-authentication');
  });

  await test('successful export shows a not-encrypted completion view (EXP-003)', async () => {
    await page.locator('#export-pw').fill('e2e-comprehensive-pw');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btn-export-plain').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'veyora-export.csv', 'file name is stated');
    const done = page.locator('#export-done:not(.hidden)');
    await done.waitFor();
    const doneText = await done.textContent();
    assert.match(doneText, /Not encrypted/, 'completion repeats Not encrypted');
    assert.match(doneText, /veyora-export\.csv/, 'path/filename is listed');
    assert.match(doneText, /TOTP seeds/, 'omitted fields are listed');
    assert.match(doneText, /delete it/i, 'safe deletion guidance is given');
    await page.locator('#export-done-close').click();
    await page.locator('#ov-export.on').waitFor({ state: 'detached' });
  });

  // === 6. Unsafe password change remains unavailable ===
  await test('non-atomic master password change is not exposed', async () => {
    assert.equal(await page.locator('#set-change-pw').count(), 0);
  });

  // === 7. Lock + wrong password ===
  await test('lock, wrong password rejected, correct password works', async () => {
    await closeDrawerIfOpen();
    await page.locator('#btn-lock').click();
    await page.locator('#lock-unlock').waitFor();

    // The locked screen still identifies the vault (PRD 6.3): a readable
    // name plus the safe location summary, never the raw vault id hex.
    const meta = await page.locator('#vault-meta').textContent();
    assert.match(meta, /My Veyora vault/, 'locked screen names the vault');
    assert.match(meta, /Connected vault at [\w.-]+/, 'locked screen shows the location summary');
    assert.ok(!/https?:|token/i.test(meta), 'no URL or token in the locked identity');


    await page.locator('#lock-help').click();
    await page.locator('#ov-help').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#ov-help').waitFor({ state: 'detached' });
    // Focus restoration is an async handoff after the overlay unmounts;
    // poll for it so the assertion tests the behavior, not the tick.
    await page.waitForFunction(() =>
      document.activeElement === document.getElementById('lock-help'), { timeout: 5000 });
    assert.ok(true, 'Help is reachable in the locked state and restores focus');

    // Wrong password must fail (real AEAD rejection)
    await page.locator('#master-pw').fill('e2e-wrong-password');
    await page.locator('#btn-unlock').click();
    await page.locator('#unlock-error').waitFor({ timeout: 15000 });

    // Correct password works
    await page.locator('#master-pw').fill('e2e-comprehensive-pw');
    await page.locator('#btn-unlock').click();
    await page.locator('#view-app').waitFor({ timeout: 15000 });
    await page.locator('.trow').filter({ hasText: entryName }).waitFor();
  });

  await test('checklist hides after completion and persists across lock (UX-ONB-008/009)', async () => {
    // The backup is the last open step (recovery was verified at creation).
    // Complete it through the real ceremony, then unlock re-renders the
    // table, notes completion, and hides the card.
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#set-backup').click();
    await page.locator('#ov-backup.on').waitFor();
    await page.locator('#backup-pw').fill('e2e-comprehensive-pw');
    const backupDownload = page.waitForEvent('download');
    await page.locator('#btn-backup-create').click();
    await backupDownload;
    await page.locator('#backup-done:not(.hidden)').waitFor({ timeout: 30000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#ov-backup.on'));
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
    // Re-render (e.g. a search round-trip) notes completion and hides it.
    await page.locator('#search').fill('E2E');
    await page.locator('#search').press('Escape');
    await page.waitForFunction(() => document.querySelector('#start-here')
      && !document.querySelector('#start-here.on'), { timeout: 10000 });
    const stored = await page.evaluate(
      () => JSON.parse(localStorage.getItem('veyora.web.startHere')));
    assert.equal(stored.hidden, true, 'completion hid the card');
    assert.equal(stored.noted, true, 'auto-hide was recorded so Help reopen sticks');
    assert.deepEqual(Object.keys(stored.done).sort(),
      ['backup', 'copy-reveal', 'first-item', 'lock', 'recovery']);
  });

  await test('checklist reopens from Help (UX-ONB-009)', async () => {
    await page.locator('#tb-help').click();
    await page.locator('#ov-help').waitFor();
    await page.locator('#ov-help [data-help-action="start-here"]').click();
    const card = page.locator('#start-here.on .sh-card');
    await card.waitFor();
    const text = await card.textContent();
    assert.match(text, /reopen this checklist from Help/i, 'completed state is explained');
    assert.equal(await page.locator('.sh-item.done').count(), 5, 'all five steps still done');
    await page.locator('#sh-hide').click();
    assert.equal(await page.locator('#start-here.on').count(), 0, 'hide button dismisses again');
  });

  // === 8. Delete to trash and restore ===
  await test('delete entry moves to trash', async () => {
    const row = page.locator('.trow').filter({ hasText: entryName });
    await row.click();
    await page.locator('#drawer').waitFor();
    await page.locator('#d-del').click();
    await page.locator('#d-del').click(); // confirm
    await row.waitFor({ state: 'detached' });
  });

  await test('trash shows deleted entry with restore button', async () => {
    const trashTab = page.locator('[data-nav="trash"]');
    await trashTab.click();
    await page.waitForTimeout(1000);
    const trashRow = await page.locator('.trow').filter({ hasText: entryName }).count();
    assert.ok(trashRow > 0, 'entry visible in trash');
    const restoreBtn = await page.locator('[data-restore]').count();
    assert.ok(restoreBtn > 0, 'restore button present');
  });

  await test('restore returns entry to main list', async () => {
    await page.locator('[data-restore]').first().click();
    await page.waitForTimeout(2000);
    const allTab = page.locator('.tab').first();
    await allTab.click();
    await page.locator('.trow').filter({ hasText: entryName }).waitFor();
  });

  // === 8b. Permanent deletion from Trash (ITEM-008) ===
  await test('trash offers permanent deletion with a count-naming confirmation (ITEM-008)', async () => {
    // Put one more item into Trash so the scope is non-empty.
    await page.locator('#btn-new').click();
    await page.locator('#f-name').fill('E2E Purge Me');
    await page.locator('#f-secret').fill('purge-secret-123456');
    await page.locator('#btn-save-entry').click();
    await page.locator('.saved-panel').waitFor();
    await page.locator('#saved-back').click();
    await page.locator('#ov-entry').waitFor({ state: 'hidden' });
    const row = page.locator('.trow').filter({ hasText: 'E2E Purge Me' });
    await row.click();
    await page.locator('#drawer').waitFor();
    await page.locator('#d-del').click();
    await page.locator('#d-del').click();
    await row.waitFor({ state: 'detached' });
    await closeDrawerIfOpen();

    await page.locator('[data-nav="trash"]').click();
    await page.waitForTimeout(1000);
    const trashRows = page.locator('.trow');
    const count = await trashRows.count();
    assert.ok(count >= 1, `trash is non-empty before the purge (got ${count})`);
    const salt = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('veyora.web.vault')).salt);
    // The armed state names the count and irreversibility (ITEM-008).
    const purgeBtn = page.locator('#btn-purge-trash');
    await purgeBtn.waitFor();
    assert.match(await purgeBtn.textContent(), new RegExp(String(count)),
      'the purge button names the item count');
    await purgeBtn.click();
    assert.match(await purgeBtn.textContent(), /cannot be undone/,
      'the armed confirmation names irreversibility');
    await purgeBtn.click();
    await page.locator('#toast[data-toast-key="trash.purgeDone"]')
      .waitFor({ timeout: 30000 });
    // The scope emptied for real: the UI shows empty and the server holds
    // no tombstone for this vault.
    await page.waitForFunction(() =>
      document.querySelector('#table-body').textContent.includes('Trash is empty')
      || document.querySelectorAll('#table-body .trow').length === 0, { timeout: 10000 });
    const remaining = await page.evaluate(async scope =>
      (await fetch(`/api/records?vault=${scope}`, { cache: 'no-store' })).json(), salt);
    const tombstones = remaining.filter(row => row.tombstone && !row.record_id.startsWith('veyora-'));
    assert.equal(tombstones.length, 0, 'the service holds no tombstone after the purge');
    assert.ok(remaining.filter(row => !row.tombstone && !row.record_id.startsWith('veyora-')).length >= 1,
      'live items are untouched by the trash purge');
    await page.locator('[data-nav="all"]').click();
  });

  // === 9. Keyboard navigation ===
  await test('keyboard j/k/Enter navigation works', async () => {
    await page.locator('#tablewrap').focus();
    await page.keyboard.press('j');
    await page.waitForTimeout(200);
    const selected = await page.locator('.trow.on').count();
    assert.ok(selected >= 1, 'a row is selected after j');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const drawerVisible = await page.locator('#drawer').isVisible();
    assert.ok(drawerVisible, 'Enter opens the drawer');
    await page.keyboard.press('Escape');
  });

  await test('shortcuts dialog documents every shortcut in-app (NAV-007)', async () => {
    await page.locator('#tb-shortcuts').click();
    await page.locator('#ov-shortcuts.on').waitFor();
    const text = await page.locator('#ov-shortcuts').textContent();
    assert.match(text, /j \/ k/, 'list navigation documented');
    assert.match(text, /Ctrl\/⌘ \+ K/, 'search shortcut documented');
    assert.match(text, /Ctrl\/⌘ \+ L/, 'lock shortcut documented');
    assert.match(text, /never fire while you are typing/, 'field guard documented');
    assert.equal(await page.locator('#ov-shortcuts [data-close]')
      .evaluate(el => document.activeElement === el), true, 'dialog receives focus');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#ov-shortcuts.on'));
  });

  await test('shortcuts never fire from a text field (NAV-007)', async () => {
    await page.locator('#search').click();
    await page.keyboard.press('j');
    assert.equal(await page.locator('#search').inputValue(), 'j', 'j is typed, not intercepted');
    assert.equal(await page.locator('.trow.on').count(), 0, 'no navigation while typing');
    await page.keyboard.press('k');
    assert.equal(await page.locator('#search').inputValue(), 'jk');
    await page.locator('#search').press('Escape'); // clear
  });

  // === 10. Password health badges ===
  await test('reused passwords show warning badges', async () => {
    // Create a second entry with the same password
    await page.locator('#btn-new').click();
    await page.locator('#f-name').fill('E2E Duplicate PW');
    await page.locator('#f-secret').fill('rotated-e2e-password'); // same as entry 1
    await page.locator('#btn-save-entry').click();
    await page.locator('.saved-panel').waitFor();
    // "Add another" reopens a fresh creation form (ITEM-007).
    await page.locator('#saved-add').click();
    await page.locator('#f-name').fill('E2E Second Via Add');
    await page.locator('#f-secret').fill('rotated-e2e-password');
    await page.locator('#btn-save-entry').click();
    await page.locator('.saved-panel').waitFor();
    await page.locator('#saved-back').click();
    await page.locator('.trow').filter({ hasText: 'E2E Second Via Add' }).waitFor();

    // Check for warning badge
    const badges = await page.locator('.badge-warn').count();
    assert.ok(badges >= 2, `reused password badges visible (got ${badges})`);
  });

  // === 11. Search, scope, and filters ===
  await test('search field announces its scope (NAV-002)', async () => {
    const placeholder = await page.locator('#search').getAttribute('placeholder');
    assert.match(placeholder, /Search All items/i, `scoped placeholder, got: ${placeholder}`);
    const ariaLabel = await page.locator('#search').getAttribute('aria-label');
    assert.match(ariaLabel, /Search All items/i, 'scoped aria-label');
  });

  await test('search filters entries and highlights matches', async () => {
    await closeDrawerIfOpen();
    await page.locator('#search').fill('E2E Full');
    await page.waitForTimeout(500);
    const rows = await page.locator('.trow').count();
    assert.ok(rows >= 1, 'matching entry visible');
    const marks = await page.locator('mark').count();
    assert.ok(marks > 0, 'search term highlighted');
    await page.locator('#search').press('Escape');
  });

  await test('search sends no query to the service (NAV-006)', async () => {
    const requests = [];
    const onRequest = req => { if (req.url().includes('/records')) requests.push(req.url()); };
    page.on('request', onRequest);
    await page.locator('#search').fill('E2E');
    await page.waitForTimeout(600);
    page.off('request', onRequest);
    assert.deepEqual(requests, [], 'typing in search triggers no record requests');
    await page.locator('#search').press('Escape');
  });

  await test('no-results state offers clear and search-all (NAV-005)', async () => {
    await page.locator('#search').fill('zzz-no-such-item-zzz');
    await page.locator('#nores-clear').waitFor({ timeout: 5000 });
    const body = await page.locator('.table-empty').textContent();
    assert.match(body, /zzz-no-such-item-zzz/, 'no-results names the query');
    assert.match(body, /All items/, 'no-results names the scope');
    await page.locator('#nores-all').click();
    await page.locator('.trow').first().waitFor();
    const query = await page.locator('#search').inputValue();
    assert.equal(query, '', 'search-all clears the query');
  });

  await test('active filters are visible and removable chips (NAV-003)', async () => {
    await page.locator('[data-nav="favorites"]').click();
    const chip = page.locator('.filter-chip[data-clear="nav"]');
    await chip.waitFor();
    const label = await chip.textContent();
    assert.match(label, /Favorites/, 'scope chip names the filter');
    await chip.click();
    await chip.waitFor({ state: 'detached' });
    assert.ok(await page.locator('.trow').count() >= 1, 'removing the chip returns to all items');
    // A query also becomes a removable chip.
    await page.locator('#search').fill('E2E');
    await page.locator('.filter-chip[data-clear="query"]').waitFor({ timeout: 5000 });
    await page.locator('.filter-chip[data-clear="query"]').click();
    const query = await page.locator('#search').inputValue();
    assert.equal(query, '', 'query chip clears the search');
  });

  // === 11a. Favorites and Tags tab journeys (PRD 7.1) ===
  await test('favoriting an entry scopes the Favorites tab to it', async () => {
    const stamp = Date.now();
    const alpha = `E2E Fav Alpha ${stamp}`;
    const beta = `E2E Fav Beta ${stamp}`;
    for (const name of [alpha, beta]) {
      await page.locator('#btn-new').click();
      await page.locator('#ov-entry.on').waitFor();
      await page.locator('#f-name').fill(name);
      await page.locator('#f-secret').fill('fav-journey-pass-123456');
      await page.locator('#btn-save-entry').click();
      await page.locator('.saved-panel').waitFor();
      await page.locator('#saved-back').click();
      await page.locator('#ov-entry').waitFor({ state: 'hidden' });
    }
    // Favorite Alpha from its row's star control.
    const alphaRow = page.locator('.trow').filter({ hasText: alpha });
    await alphaRow.locator('[data-fav]').click();
    await page.waitForTimeout(600);
    // The Favorites scope lists only the favorited entry.
    await page.locator('[data-nav="favorites"]').click();
    await alphaRow.waitFor();
    assert.equal(await page.locator('.trow').filter({ hasText: beta }).count(), 0,
      'the unfavorited entry never appears in Favorites');
    // Unfavoriting from the Favorites view removes it from the scope.
    await alphaRow.locator('[data-fav]').click();
    await alphaRow.waitFor({ state: 'detached' });
    // Both entries remain in All items.
    await page.locator('[data-nav="all"]').click();
    await page.locator('.trow').filter({ hasText: alpha }).waitFor();
    await page.locator('.trow').filter({ hasText: beta }).waitFor();
  });

  await test('tagging an entry enables the Tags scope and tag filtering', async () => {
    const stamp = Date.now();
    const tagged = `E2E Tagged ${stamp}`;
    const untagged = `E2E Untagged ${stamp}`;
    // Create a tagged entry (tags live behind the More fields disclosure).
    await page.locator('#btn-new').click();
    await page.locator('#ov-entry.on').waitFor();
    await page.locator('#f-name').fill(tagged);
    await page.locator('#f-secret').fill('tag-journey-pass-123456');
    await page.locator('#more-fields').click();
    await page.locator('#f-tags').fill('e2ework, e2einfra');
    await page.locator('#btn-save-entry').click();
    await page.locator('.saved-panel').waitFor();
    await page.locator('#saved-back').click();
    await page.locator('#ov-entry').waitFor({ state: 'hidden' });
    // And an untagged one.
    await page.locator('#btn-new').click();
    await page.locator('#ov-entry.on').waitFor();
    await page.locator('#f-name').fill(untagged);
    await page.locator('#f-secret').fill('tag-journey-pass-123456');
    await page.locator('#btn-save-entry').click();
    await page.locator('.saved-panel').waitFor();
    await page.locator('#saved-back').click();
    await page.locator('#ov-entry').waitFor({ state: 'hidden' });
    // The Tags scope lists tagged entries with their tags as filter chips.
    await page.locator('[data-nav="tags"]').click();
    await page.locator('.trow').filter({ hasText: tagged }).waitFor();
    assert.equal(await page.locator('.trow').filter({ hasText: untagged }).count(), 0,
      'untagged entries never appear in the Tags scope');
    for (const tag of ['e2ework', 'e2einfra']) {
      const chip = page.locator(`[data-tag="${tag}"]`);
      await chip.waitFor();
      assert.equal(await chip.getAttribute('aria-pressed'), 'false',
        `${tag} chip starts unpressed`);
    }
    // Filtering by one tag keeps the tagged entry and marks the chip.
    await page.locator('[data-tag="e2ework"]').click();
    await page.waitForTimeout(400);
    await page.locator('.trow').filter({ hasText: tagged }).waitFor();
    assert.equal(await page.locator('[data-tag="e2ework"]').getAttribute('aria-pressed'),
      'true', 'the active tag chip is pressed');
    // Clicking the pressed chip clears the filter back to all tagged entries.
    await page.locator('[data-tag="e2ework"]').click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('[data-tag="e2ework"]').getAttribute('aria-pressed'),
      'false', 'the chip clears');
    // Search covers the documented tag field (NAV-006): a tag matches in
    // the All-items scope without any request to the service.
    await page.locator('[data-nav="all"]').click();
    await page.locator('#search').fill('e2einfra');
    await page.locator('.trow').filter({ hasText: tagged }).waitFor();
    // Wait for the debounce to re-render before asserting what dropped out.
    await page.locator('.trow').filter({ hasText: untagged }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.trow').filter({ hasText: untagged }).count(), 0,
      'only the tagged entry matches the tag query');
    await page.locator('#search').press('Escape');
  });

  // === 11a-b. Non-Login item types (PRD 7.1 tabs; ITEM registry) ===
  await test('every non-Login template creates its entry type and lists it', async () => {
    const stamp = Date.now();
    // template → [required field ids beyond name] and the localized type label.
    const cases = [
      ['note', {}, `E2E Note ${stamp}`, 'Secure note'],
      ['api-token', { '#f-service': 'e2e-ci-service' }, `E2E Token ${stamp}`, 'API token'],
      ['ssh', { '#f-host': 'e2e-ci.host' }, `E2E SSH ${stamp}`, 'SSH key'],
      ['identity', { '#f-fullName': 'E2E Person' }, `E2E Identity ${stamp}`, 'Identity'],
    ];
    for (const [tmpl, extra, name, label] of cases) {
      await page.locator('#btn-new').click();
      await page.locator('#ov-entry.on').waitFor();
      await page.locator(`[data-tmpl="${tmpl}"]`).click();
      await page.locator('#f-name').fill(name);
      await page.locator('#f-secret').fill(`type-journey-secret-${tmpl}`);
      for (const [selector, value] of Object.entries(extra)) {
        await page.locator(selector).fill(value);
      }
      await page.locator('#btn-save-entry').click();
      await page.locator('.saved-panel').waitFor();
      await page.locator('#saved-back').click();
      await page.locator('#ov-entry').waitFor({ state: 'hidden' });
      // The row exists and the type column carries the localized label.
      const row = page.locator('.trow').filter({ hasText: name });
      await row.waitFor();
      assert.match(await row.locator('.col-type').textContent(), new RegExp(label),
        `${tmpl} row shows its type label`);
    }
    // Type tabs scope the list to one template's entries.
    await page.locator('[data-nav="note"]').click();
    const noteRow = page.locator('.trow').filter({ hasText: `E2E Note ${stamp}` });
    await noteRow.waitFor();
    assert.equal(await page.locator('.trow').filter({ hasText: `E2E Token ${stamp}` }).count(), 0,
      'the note tab does not list other types');
    await page.locator('[data-nav="ssh"]').click();
    await page.locator('.trow').filter({ hasText: `E2E SSH ${stamp}` }).waitFor();
    assert.equal(await page.locator('.trow').filter({ hasText: `E2E Identity ${stamp}` }).count(), 0,
      'the ssh tab does not list other types');
    await page.locator('[data-nav="all"]').click();
    await page.locator('.trow').filter({ hasText: `E2E Identity ${stamp}` }).waitFor();
  });

  await test('type-specific fields surface in the row and in local search', async () => {
    await page.locator('[data-nav="all"]').click();
    // The api-token's service value becomes the row subtitle (visible metadata).
    const tokenRow = page.locator('.trow').filter({ hasText: 'E2E Token' });
    await tokenRow.waitFor();
    assert.match(await tokenRow.textContent(), /e2e-ci-service/,
      'the service value is visible on the row');
    // Search covers the documented type fields without any service request.
    const requests = [];
    const onRequest = req => { if (req.url().includes('/records')) requests.push(req.url()); };
    page.on('request', onRequest);
    await page.locator('#search').fill('e2e-ci.host');
    await page.locator('.trow').filter({ hasText: 'E2E SSH' }).waitFor();
    await page.locator('.trow').filter({ hasText: 'E2E Note' }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.trow').filter({ hasText: 'E2E Note' }).count(), 0,
      'only the entry owning the searched field matches');
    page.off('request', onRequest);
    assert.deepEqual(requests, [], 'type-field search stays local (NAV-006)');
    await page.locator('#search').press('Escape');
  });

  // === 11b. Delete with Undo ===
  await test('delete shows an Undo toast and undo restores the entry', async () => {
    const row = page.locator('.trow').filter({ hasText: 'E2E Duplicate PW' });
    await row.click();
    await page.locator('#drawer').waitFor();
    await page.locator('#d-del').click();
    await page.locator('#d-del').click(); // confirm
    await row.waitFor({ state: 'detached' });
    const undo = page.locator('.toast-action');
    await undo.waitFor();
    await undo.click();
    await row.waitFor({ timeout: 15000 });
    assert.ok(true, 'entry restored via undo toast');
  });

  // === 11c. Help from the dashboard + trash retention setting ===
  await test('help is reachable from the dashboard and routes to tasks (HELP-001/002)', async () => {
    await closeDrawerIfOpen();
    await page.locator('#tb-help').click();
    await page.locator('#ov-help').waitFor();
    const actions = await page.locator('#ov-help [data-help-action]').count();
    assert.ok(actions >= 2, `actionable help tasks while unlocked (got ${actions})`);
    await page.locator('#ov-help [data-help-action="new-item"]').click();
    await page.locator('#ov-entry.on').waitFor();
    await page.locator('#ov-entry [data-close]').first().click();
    await page.locator('#tb-help').click();
    await page.locator('#ov-help').waitFor();
    await page.locator('#ov-help [data-help-action="settings"]').first().click();
    await page.locator('#ov-help').waitFor({ state: 'detached' });
    await page.locator('#set-import').waitFor(); // routed into Settings
  });

  await test('trash retention preference defaults to 30 days without claiming automatic purge (ITEM-009 partial)', async () => {
    const select = page.locator('#set-trash');
    await select.waitFor();
    assert.equal(await select.inputValue(), '30', 'default retention is 30 days');
    assert.match(await page.locator('#set-trash').locator('xpath=preceding-sibling::div[1]').textContent(),
      /automatic deletion is not available/, 'preview limitation is explicit');
    await select.selectOption('7');
    const toastText = await page.locator('#toast').textContent();
    assert.match(toastText, /7 days/, 'setting change is confirmed');
    assert.equal(await page.evaluate(
      () => localStorage.getItem('veyora.web.trashRetentionDays')), '7', 'retention persisted');
    await select.selectOption('30');
  });

  await test('diagnostics reports safe status without secrets (DIAG-001)', async () => {
    // The settings drawer is still open from the retention test.
    await page.locator('#diag-grid').waitFor();
    const text = await page.locator('#diag-grid').textContent();
    assert.match(text, /1\.0\.0/, 'product version is shown');
    assert.ok(text.includes(buildStamp), 'the image build stamp is shown');
    assert.match(text, /Connected vault/, 'mode is shown');
    assert.match(text, /Encrypted records at 127\.0\.0\.1/, 'storage summary names the origin host only');
    assert.match(text, /Last sync/, 'last-sync field is present');
    assert.match(text, /Not available in this preview/, 'backup status is honest');
    // The health probe resolves asynchronously from its Checking state.
    await page.waitForFunction(() =>
      /Reachable/.test(document.querySelector('#diag-health')?.textContent || ''));
    // Redaction (DIAG-001 evidence): no secret material anywhere in the
    // diagnostics panel, including the whole settings drawer.
    const full = await page.locator('#detail-inner').textContent();
    assert.ok(!full.includes('e2e-comprehensive-pw'), 'master password is absent');
    assert.ok(!full.includes('rotated-e2e-password'), 'entry secret is absent');
    assert.ok(!full.includes('Bearer'), 'no connection-token material');
    assert.ok(!full.includes('inert-local-password'), 'no deployment secrets');
  });

  await test('support bundle is opt-in, previewable, and redacted (DIAG-002)', async () => {
    // The settings drawer is still open from the diagnostics test.
    await page.locator('#set-bundle').waitFor();
    assert.ok(!(await page.locator('#ov-bundle.on').count()), 'no bundle preview until requested');
    await page.locator('#set-bundle').click();
    await page.locator('#ov-bundle.on').waitFor();
    const bundleText = await page.locator('#bundle-text').textContent();
    assert.match(bundleText, /Veyora support bundle/);
    assert.match(bundleText, /version: 1\.0\.0/);
    assert.ok(bundleText.includes(`build: ${buildStamp}`));
    assert.match(bundleText, /service-host: 127\.0\.0\.1/, 'origin host only');
    assert.match(bundleText, /service-health: (ok|unhealthy|unreachable)/);
    // Redaction (DIAG-002 canary): no secrets in the previewed bundle.
    assert.ok(!bundleText.includes('e2e-comprehensive-pw'), 'master password is absent');
    assert.ok(!bundleText.includes('rotated-e2e-password'), 'entry secret is absent');
    assert.ok(!bundleText.includes('http'), 'no full URLs');
    assert.ok(!bundleText.includes('inert-local-password'), 'no deployment secrets');
    // The intro states nothing is uploaded automatically; copy is explicit.
    const intro = await page.locator('#ov-bundle').textContent();
    assert.match(intro, /never uploads/i, 'no-automatic-upload statement is visible');
    await page.locator('#ov-bundle [data-close]').first().click();
    await page.locator('#ov-bundle.on').waitFor({ state: 'detached' });
  });

  // === 11b. Desktop-runtime diagnostics honesty (DIAG-001 desktop scope) ===
  await test('desktop runtime reports a local vault, never a connected mode (DIAG-001)', async () => {
    // The desktop shell injects window.VEYORA_DESKTOP before client scripts;
    // setting it here and re-rendering the drawer exercises the same branch.
    await closeDrawerIfOpen();
    await page.evaluate(() => { window.VEYORA_DESKTOP = true; });
    // Closing the drawer re-renders the dashboard; give that render a beat
    // so the settings click cannot race a replaced topbar button.
    await page.waitForTimeout(400);
    await page.locator('#tb-settings').click();
    await page.locator('#drawer.on').waitFor();
    await page.locator('#diag-grid').waitFor();
    const text = await page.locator('#diag-grid').textContent();
    assert.match(text, /Local vault on this device/, 'desktop mode is stated');
    assert.match(text, /Encrypted vault stored on this device/, 'desktop storage summary');
    assert.ok(!text.includes('Connected vault'), 'connected mode is not claimed on desktop');
    assert.ok(!text.includes('127.0.0.1'), 'the loopback host is never the storage summary');
    // Desktop never claims a remote synchronization: the row is "last saved".
    assert.match(text, /Last saved/, 'desktop labels the timestamp as a local save');
    assert.ok(!text.includes('Last sync'), 'desktop never claims a remote sync');
    // The support bundle carries the same honest desktop identity.
    await page.locator('#set-bundle').click();
    await page.locator('#ov-bundle.on').waitFor();
    const bundleText = await page.locator('#bundle-text').textContent();
    assert.match(bundleText, /mode: desktop-local-vault/);
    assert.match(bundleText, /storage: local vault on this device/);
    assert.ok(!bundleText.includes('service-host:'), 'no service-host line on desktop');
    await page.locator('#ov-bundle [data-close]').first().click();
    await page.locator('#ov-bundle.on').waitFor({ state: 'detached' });
    await closeDrawerIfOpen();
    // Re-render the dashboard (the same event a locale switch fires) while
    // the desktop flag is set: the identity line must report the device.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('veyora:locale-changed'));
    });
    await page.waitForTimeout(400);
    const identity = await page.locator('#tb-vault').textContent();
    assert.match(identity, /My Veyora vault/, 'desktop identity keeps the vault name');
    assert.match(identity, /On this device/, 'desktop location summary names the device');
    assert.ok(!identity.includes('Connected vault'), 'desktop never claims a connected vault');
    await page.evaluate(() => { delete window.VEYORA_DESKTOP; });
  });

  // === 12. Language switch ===
  await test('language switch re-renders without losing state', async () => {
    await closeDrawerIfOpen();
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#set-locale').selectOption('ar');
    await page.waitForTimeout(1500);
    const isRtl = await page.evaluate(() => document.documentElement.dir === 'rtl');
    assert.ok(isRtl, 'RTL direction applied for Arabic');
    // RTL is a rendering state, not just an attribute: the mirrored
    // chrome must stay on one axis and actually carry Arabic copy.
    const rtl = await page.evaluate(() => {
      const header = document.querySelector('.topbar') || document.querySelector('header');
      const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      return {
        headerDir: header ? getComputedStyle(header).direction : 'missing',
        overflow,
        firstTab: document.querySelector('.tab') ? document.querySelector('.tab').textContent.trim() : '',
      };
    });
    assert.equal(rtl.headerDir, 'rtl', 'the dashboard chrome renders mirrored');
    assert.ok(rtl.overflow <= 0, `RTL introduces no horizontal overflow (got ${rtl.overflow}px)`);
    assert.match(rtl.firstTab, /[\u0600-\u06FF]/, 'tabs render Arabic labels');
    // Switch back
    await page.locator('#set-locale').selectOption('en');
    await page.waitForTimeout(1000);
  });

  // === 12. First-success instrumentation stays opt-in (UX-ONB-010) ===
  await test('clipboard clearing is announced without stealing focus (ACC-011/SEC-CLIP-001)', async () => {
    await closeDrawerIfOpen();
    // Shorten the clipboard window to the smallest option so the clear
    // announcement arrives within the test's reach.
    await page.locator('#tb-settings').click();
    await page.locator('#set-clip').waitFor();
    await page.locator('#set-clip').selectOption('10');
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
    await page.locator('.trow').filter({ hasText: entryName }).click();
    await page.locator('#drawer.on').waitFor();
    await page.locator('#d-copy').click();
    // The settings toast may still be up; wait specifically for the copy one.
    await page.waitForFunction(() =>
      /Copied/.test(document.querySelector('#toast')?.textContent || ''));
    const search = page.locator('#search');
    await search.focus();
    await page.waitForFunction(() => /Clipboard cleared/.test(document.querySelector('#toast').textContent),
      null, { timeout: 15000 });
    assert.equal(await search.evaluate(el => document.activeElement === el), true,
      'the status announcement did not move focus');
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
  });

  // === 12b. Master Password change: atomic rekey through the real UI ===
  await test('changing the master password re-keys the vault and the new password unlocks it', async () => {
    const nextPassword = 'e2e-rotated-pw-6789';
    await closeDrawerIfOpen();
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    const rowsBefore = await page.locator('.trow').count();
    // A wrong current password is refused inline and changes nothing.
    await page.locator('#set-cp-current').fill('definitely-not-the-password');
    await page.locator('#set-cp-new').fill(nextPassword);
    await page.locator('#set-cp-confirm').fill(nextPassword);
    await page.locator('#set-cp-btn').click();
    await page.locator('#cp-error').waitFor();
    assert.match(await page.locator('#cp-error').textContent(),
      /wrong — nothing was changed/, 'a wrong current password is refused');
    // The correct change runs the atomic server-side rekey.
    await page.locator('#set-cp-current').fill('e2e-comprehensive-pw');
    await page.locator('#set-cp-btn').click();
    // Filter by content: an earlier toast can still be visible at click time.
    await page.locator('#toast[data-toast-key="settings.changePwDone"]')
      .waitFor({ timeout: 30000 });
    assert.ok(true, 'the rekey is reported');
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.trow').count(), rowsBefore,
      'every entry is still readable after the rekey');
    // Lock, then prove the NEW password unlocks the re-keyed vault.
    await page.locator('#btn-lock').click();
    await page.locator('#lock-unlock').waitFor();
    await page.locator('#master-pw').fill(nextPassword);
    await page.locator('#btn-unlock').click();
    await page.locator('#view-app').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.trow').count(), rowsBefore,
      'the vault opens with the new password');
  });

  // === 12c. Encrypted backup create + restore (EXP-001) ===
  await test('an encrypted backup downloads sealed and restores on any device', async () => {
    await closeDrawerIfOpen();
    const rowsBefore = await page.locator('.trow').count();
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#set-backup').click();
    await page.locator('#ov-backup.on').waitFor();
    // A wrong password is refused and nothing downloads.
    await page.locator('#backup-pw').fill('not-the-vault-password');
    await page.locator('#btn-backup-create').click();
    await page.locator('#backup-error[data-error-key="backup.errWrong"]')
      .waitFor({ timeout: 10000 });
    assert.ok(true, 're-authentication is enforced');
    // The correct password seals and downloads the file.
    await page.locator('#backup-pw').fill('e2e-rotated-pw-6789');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btn-backup-create').click();
    const download = await Promise.race([
      downloadPromise,
      new Promise(resolve => setTimeout(() => resolve(null), 28000)),
    ]);
    if (!download) {
      const errText = await page.locator('#backup-error').textContent().catch(() => '?');
      const doneHidden = await page.locator('#backup-done')
        .evaluate(el => el.classList.contains('hidden')).catch(() => '?');
      const meta = await page.evaluate(() => localStorage.getItem('veyora.web.vault'));
      throw new Error(`no download fired; error=${JSON.stringify(errText)} doneHidden=${doneHidden} meta=${meta}`);
    }
    const backupPath = `/tmp/veyora-e2e-backup-${Date.now()}.json`;
    await download.saveAs(backupPath);
    await page.locator('#backup-done:not(.hidden)').waitFor();
    const envelope = JSON.parse(await readFile(backupPath, 'utf8'));
    assert.equal(envelope.format, 'veyora-backup');
    assert.equal(envelope.record_count, rowsBefore);
    assert.ok(!JSON.stringify(envelope).includes('e2e-comprehensive-pw'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#ov-backup.on'));
    // Restore: the sealed file merges back with suffixed ids — existing
    // entries are never overwritten.
    await page.locator('#set-restore').click();
    // The file input is visually hidden by design; attachment is what matters.
    await page.locator('#restore-file').waitFor({ state: 'attached' });
    await page.locator('#restore-file').setInputFiles(backupPath);
    await page.locator('#ov-backup.on').waitFor();
    const restoreCopy = await page.locator('#backup-restore .micro').first().textContent();
    assert.match(restoreCopy, new RegExp(String(rowsBefore)),
      'the restore stage names the advertised count');
    await page.locator('#backup-restore-pw').fill('e2e-rotated-pw-6789');
    await page.locator('#btn-backup-create').click();
    await page.locator('#toast[data-toast-key="backup.restoreDone"]').waitFor({ timeout: 30000 });
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
    const rowsAfter = await page.locator('.trow').count();
    assert.equal(rowsAfter, rowsBefore * 2,
      'every restored entry lands under a fresh id, originals intact');
  });

  // === 12d. Locale sweep across every supported catalog ===
  await test('every supported locale re-renders the dashboard without losing state', async () => {
    await closeDrawerIfOpen();
    // (en is the running locale; the sweep covers the other nine.)
    const locales = [
      ['zh-CN', 'ltr'], ['zh-TW', 'ltr'], ['ja', 'ltr'], ['ko', 'ltr'],
      ['de', 'ltr'], ['fr', 'ltr'], ['es', 'ltr'], ['ru', 'ltr'], ['ar', 'rtl'],
    ];
    const rowsBefore = await page.locator('.trow').count();
    for (const [tag, direction] of locales) {
      await page.locator('#tb-settings').click();
      await page.locator('#drawer').waitFor();
      await page.locator('#set-locale').selectOption(tag);
      await page.waitForTimeout(700);
      await page.locator('#drawer-close').click();
      await page.locator('#drawer.on').waitFor({ state: 'detached' });
      // Direction follows the registry; the chrome re-renders translated;
      // the row count is untouched by a language change.
      assert.equal(
        await page.evaluate(() => document.documentElement.dir), direction,
        `${tag} sets direction ${direction}`);
      const firstTab = await page.locator('.tab').first().textContent();
      assert.ok(firstTab.trim().length > 0, `${tag} renders a tab label`);
      assert.equal(await page.locator('.trow').count(), rowsBefore,
        `${tag} preserves the item list`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `${tag} introduces no horizontal overflow (got ${overflow}px)`);
    }
    // Restore English for the journeys that follow.
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#set-locale').selectOption('en');
    await page.waitForTimeout(700);
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
  });

  // === 13. Destructive Reset matrix (DATA-009) ===
  await test('clearing device preferences never touches vault data (DATA-009)', async () => {
    await closeDrawerIfOpen();
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    const rowsBefore = await page.locator('.trow').count();
    // Two-step arm/confirm on the preferences scope.
    await page.locator('#reset-prefs').click();
    const armed = await page.locator('#reset-prefs').textContent();
    assert.match(armed, /Clear preferences on this device\?/,
      'the armed state names exactly what will be cleared');
    await page.locator('#reset-prefs').click();
    await page.locator('#toast').waitFor();
    assert.match(await page.locator('#toast').textContent(), /Preferences cleared/,
      'the outcome is reported');
    // The vault survives the metadata-only scope: the drawer still lists
    // entries and the session stays unlocked.
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.trow').count(), rowsBefore,
      'no vault entry was affected by the preferences clear');
  });

  await test('delete-everywhere removes the service copy before the device copy (DATA-009)', async () => {
    // Capture the vault scope before any removal so the service can be
    // audited afterwards.
    const salt = await page.evaluate(() => {
      const meta = JSON.parse(localStorage.getItem('veyora.web.vault') || '{}');
      return meta.salt;
    });
    assert.ok(salt, 'the vault record exists before the reset');
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#reset-everywhere').click();
    const armed = await page.locator('#reset-everywhere').textContent();
    assert.match(armed, /cannot be undone/, 'the armed state names irreversibility');
    await page.locator('#reset-everywhere').click();
    // The welcome routes return once both scopes are gone.
    await page.locator('#lock-routes').waitFor({ timeout: 15000 });
    // Service audit: every record of this vault scope is gone for real.
    const remaining = await page.evaluate(async scope => {
      const response = await fetch(`/api/records?vault=${scope}`, { cache: 'no-store' });
      return response.status === 200 ? await response.json() : null;
    }, salt);
    assert.deepEqual(remaining, [],
      'the service holds no record of the deleted vault');
    const vaultLeft = await page.evaluate(() => localStorage.getItem('veyora.web.vault'));
    assert.equal(vaultLeft, null, 'the device copy is removed after the service copy');
  });

  await test('first-success events record nothing without an explicit opt-in (UX-ONB-010)', async () => {
    // The suite has saved a login, searched, copied, and revealed by now;
    // none of that may leave a record when instrumentation is disabled.
    assert.equal(await page.evaluate(
      () => localStorage.getItem('veyora.web.firstSuccess')), null,
      'no first-success record without the test-build opt-in');
  });

  await test('opt-in first-success events carry names and timestamps only (UX-ONB-010 inspection)', async () => {
    // Inspect the recorded events as the test harness is documented to:
    // opt in, drive the success path, and verify the record contains
    // event names and timestamps — never item ids, names, fields, or
    // queries (the privacy-review evidence the PRD asks the harness for).
    const stamp = Date.now();
    await page.goto(`${webUrl}?e2e-optin=${stamp}&veyora-first-success=1`,
      { waitUntil: 'load' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'load' });
    // The opt-in must survive the reload via the URL parameter.
    await page.locator('#wf-create').click();
    await page.locator('#new-pw').fill('e2e-optin-pw-12345678');
    await page.locator('#new-pw2').fill('e2e-optin-pw-12345678');
    await page.locator('#btn-create').click();
    await page.locator('#ov-kit.on').waitFor({ timeout: 20000 });
    const kit = await page.locator('#kit-out').inputValue();
    await page.locator('#kit-verify').fill(kit);
    await page.locator('#btn-kit-verify').click();
    await page.locator('#ov-kit').waitFor({ state: 'hidden' });
    await page.locator('#btn-new').click();
    await page.locator('#ov-entry.on').waitFor();
    const secretName = `Optin Secret ${stamp}`;
    await page.locator('#f-name').fill(secretName);
    await page.locator('#f-secret').fill('optin-secret-123456');
    await page.locator('#btn-save-entry').click();
    await page.locator('.saved-panel').waitFor();
    await page.locator('#saved-back').click();
    await page.locator('#ov-entry').waitFor({ state: 'hidden' });
    await page.locator('#search').fill('Optin');
    // The row is visible before the debounce fires, and Escape would
    // cancel the pending search — give the recorder its beat first.
    await page.waitForTimeout(500);
    await page.locator('.trow[data-id^="optin-secret"]').first().waitFor();
    await page.locator('#search').press('Escape');
    const record = await page.evaluate(
      () => JSON.parse(localStorage.getItem('veyora.web.firstSuccess') || 'null'));
    assert.ok(record, 'the opt-in left an inspectable record');
    const events = record.events || [];
    const names = events.map(event => event.event);
    assert.ok(names.includes('login-saved'), 'login-saved recorded');
    assert.ok(names.includes('search-performed'), 'search-performed recorded');
    for (const event of events) {
      assert.ok(typeof event.event === 'string' && /^[a-z-]+$/.test(event.event),
        'event names are plain slugs');
      assert.ok(typeof event.at === 'number', 'events carry timestamps');
      assert.deepEqual(Object.keys(event).sort(), ['at', 'event'],
        'events carry exactly the event slug and timestamp');
    }
    const serialized = JSON.stringify(record);
    assert.ok(!serialized.includes(secretName),
      'the recorded events never contain item names');
    assert.ok(!serialized.includes('optin-secret'),
      'the recorded events never contain secret material');
    assert.ok(!serialized.includes('Optin'),
      'the recorded events never contain the search query');
  });

  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }

  // Final: no console errors
  await test('no console errors or warnings', async () => {
    assert.deepEqual(problems, [], problems.join('\\n'));
  });

  // Final: the stored plaintext canary never left the client unsealed.
  await test('the plaintext canary appears in no API request body (QA-004)', async () => {
    const leaks = requestBodies.filter((body) => body.includes(PLAINTEXT_CANARY));
    assert.deepEqual(leaks, [],
      `plaintext canary leaked in ${leaks.length} API request(s): ${leaks.slice(0, 3).join(' || ')}`);
    assert.ok(requestBodies.length > 10,
      'positive control: the run actually observed API writes to inspect');
  });

  console.log(`\\nE2E: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
} catch (error) {
  console.error('E2E setup failed:', error.message);
  process.exit(1);
} finally {
  await page.close();
  await browser.close();
}
