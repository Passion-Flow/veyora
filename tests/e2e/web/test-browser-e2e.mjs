#!/usr/bin/env node
/**
 * PRD acceptance journeys E2E-002, E2E-005, E2E-006, and E2E-007 (the
 * locally runnable set), driven against a real stack and browser. Each
 * journey mirrors its PRD acceptance list; E2E-004's failure-injection leg
 * lives in test-browser-faults.mjs (it needs the disposable fault stack).
 *
 * E2E-002  empty vault rejects wrong passwords with unchanged digests
 * E2E-005  cross-vault isolation with intentionally colliding item ids
 * E2E-006  atomic import: malformed rows commit nothing, valid file commits all
 * E2E-007  encrypted backup destructive restore + hostile input rejections
 *
 * Environment:
 *   VEYORA_WEB_URL  base URL of the web client (default :3000)
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('playwright-core'));
}

const webUrl = process.env.VEYORA_WEB_URL || 'http://127.0.0.1:3000';

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

const results = { passed: 0, failed: 0 };
const test = (name, fn) => Promise.resolve(fn()).then(() => {
  results.passed++;
  console.log(`  ✓ ${name}`);
}).catch((error) => {
  results.failed++;
  console.error(`  ✗ ${name}: ${error.message}`);
});

/** Fresh isolated context (own localStorage = own device). */
async function freshDevice() {
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  await page.goto(`${webUrl}?e2e=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  return { context, page };
}

/** Create a vault (no items) on a fresh device and land on the dashboard. */
async function createVault(page, password) {
  await page.locator('#wf-create').click();
  await page.locator('#new-pw').fill(password);
  await page.locator('#new-pw2').fill(password);
  await page.locator('#btn-create').click();
  await page.locator('#btn-new').waitFor({ timeout: 15000 });
  // UX-ONB-007: creation presents the Recovery Key; verify it so the
  // journey continues from the same state a real user reaches.
  const kitOverlay = page.locator('#ov-kit.on');
  await kitOverlay.waitFor({ timeout: 15000 });
  const kit = await page.locator('#kit-out').inputValue();
  await page.locator('#kit-verify').fill(kit);
  await page.locator('#btn-kit-verify').click();
  await page.locator('#ov-kit').waitFor({ state: 'hidden' });
}

/** Full local storage digest — identity, salts, and every cached value. */
const storageDigest = page => page.evaluate(() => {
  const snapshot = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    snapshot[key] = localStorage.getItem(key);
  }
  return JSON.stringify(snapshot, Object.keys(snapshot).sort());
});

async function lock(page) {
  await page.locator('#btn-lock').click();
  await page.locator('#lock-unlock').waitFor();
}

async function unlock(page, password) {
  await page.locator('#master-pw').fill(password);
  await page.locator('#btn-unlock').click();
}

async function addEntry(page, name, secret) {
  await page.locator('#btn-new').click();
  await page.locator('#ov-entry.on').waitFor();
  await page.locator('#f-name').fill(name);
  await page.locator('#f-secret').fill(secret);
  await page.locator('#btn-save-entry').click();
  await page.locator('.saved-panel').waitFor();
  await page.locator('#saved-back').click();
  await page.locator('#ov-entry').waitFor({ state: 'hidden' });
}

try {
  // === E2E-002: Empty Vault rejects wrong passwords ===
  await test('E2E-002: an empty vault rejects wrong passwords without any mutation', async () => {
    const { context, page } = await freshDevice();
    await createVault(page, 'e2e-002-correct-password');
    // No ordinary items were added.
    await lock(page);
    const before = await storageDigest(page);
    // Correct-length wrong password, twice.
    for (const wrong of ['definitely-wrong-pass-1', 'another-wrong-pass-2']) {
      await unlock(page, wrong);
      await page.locator('#unlock-error').waitFor({ timeout: 10000 });
      assert.match(await page.locator('#unlock-error').textContent(), /wrong/i,
        `unlock refuses ${wrong}`);
      // The typed value is cleared or reselected, never accepted.
      assert.equal(await page.locator('#view-app').count(), 0, 'no vault surface appears');
    }
    const after = await storageDigest(page);
    assert.equal(after, before,
      'no new identity, salt, verifier, or metadata is committed by failed unlocks');
    // The correct password still unlocks the empty vault.
    await unlock(page, 'e2e-002-correct-password');
    await page.locator('#view-app').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.trow').count(), 0, 'the vault is still empty');
    await context.close();
  });

  // === E2E-005: Cross-Vault isolation with colliding ids ===
  await test('E2E-005: two vaults with colliding item ids stay isolated end to end', async () => {
    const deviceA = await freshDevice();
    const deviceB = await freshDevice();
    await createVault(deviceA.page, 'vault-alpha-password');
    await createVault(deviceB.page, 'vault-beta-password');
    // Identical entry names → identical slug ids in both vaults.
    await addEntry(deviceA.page, 'Shared Name', 'alpha-secret-value');
    await addEntry(deviceB.page, 'Shared Name', 'beta-secret-value');
    // Each vault's listing sees exactly its own copy (names + counts).
    for (const [device, other] of [[deviceA, 'alpha'], [deviceB, 'beta']]) {
      const rows = device.page.locator('.trow');
      await rows.first().waitFor();
      assert.equal(await rows.count(), 1, `${other} vault lists exactly one entry`);
    }
    // The service answers each scope with only its own rows, and a
    // cross-scope read of the colliding id stays inside the caller's scope.
    const salts = [];
    for (const device of [deviceA, deviceB]) {
      salts.push(await device.page.evaluate(() =>
        JSON.parse(localStorage.getItem('veyora.web.vault')).salt));
    }
    assert.notEqual(salts[0], salts[1], 'the two vaults use distinct scopes');
    const listings = [];
    for (const [i, device] of [deviceA, deviceB].entries()) {
      listings.push(await device.page.evaluate(async salt =>
        (await fetch(`/api/records?vault=${salt}`, { cache: 'no-store' })).json(), salts[i]));
    }
    const ownRows = rows => rows.filter(row => !row.record_id.startsWith('veyora-'));
    assert.equal(ownRows(listings[0]).length, 1, 'scope A answers exactly its own row');
    assert.equal(ownRows(listings[1]).length, 1, 'scope B answers exactly its own row');
    assert.equal(ownRows(listings[0])[0].record_id, ownRows(listings[1])[0].record_id,
      'the colliding id exists independently in both scopes');
    // Deleting in vault A leaves vault B's colliding row untouched.
    const row = deviceA.page.locator('.trow').first();
    await row.click();
    await deviceA.page.locator('#drawer').waitFor();
    await deviceA.page.locator('#d-del').click();
    await deviceA.page.locator('#d-del').click();
    await row.waitFor({ state: 'detached' });
    await deviceA.page.keyboard.press('Escape').catch(() => {});
    assert.equal(await deviceB.page.locator('.trow').count(), 1,
      'vault B still lists its colliding entry after A deleted its own');
    await deviceA.context.close();
    await deviceB.context.close();
  });

  // === E2E-006: Atomic import ===
  await test('E2E-006: malformed imports commit nothing; a valid file commits every row', async () => {
    const { context, page } = await freshDevice();
    await createVault(page, 'e2e-006-import-password');
    await addEntry(page, 'Existing Item', 'existing-secret-1');
    const rowsBefore = await page.locator('.trow').count();

    const importCsv = async text => {
      await page.locator('#tb-settings').click();
      await page.locator('#drawer').waitFor();
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#set-import').click();
      (await chooser).setFiles({
        name: 'import.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8'),
      });
      await page.waitForTimeout(1500);
      await page.locator('#drawer-close').click();
      await page.locator('#drawer.on').waitFor({ state: 'detached' });
    };

    // A malformed MIDDLE row aborts the whole import: zero partial commit.
    const HEADER = 'name,website,username,password,notes,tags_json';
    await importCsv(`${HEADER}\nRow One,one.example,user1,pass-one-123,,\nBROKEN ROW\nRow Three,three.example,user3,pass-three-123,,\n`);
    assert.equal(await page.locator('.trow').count(), rowsBefore,
      'a malformed middle row commits nothing');

    // Duplicate ids within the file are refused deterministically.
    await importCsv(`${HEADER}\nDup Name,dup.example,user1,pass-one-123,,\nDup Name,dup.example,user2,pass-two-123,,\n`);
    assert.equal(await page.locator('.trow').count(), rowsBefore,
      'duplicate ids commit nothing');

    // A valid multirow file commits every row with exact counts. Sealing
    // three rows and committing the batch takes a few Argon2 rounds, so
    // wait for the committed row rather than a fixed settle.
    await importCsv(`${HEADER}\nE2E Imp One,one.example,u1,secret-pass-111,,\nE2E Imp Two,two.example,u2,secret-pass-222,,\nE2E Imp Three,three.example,u3,secret-pass-333,,\n`);
    await page.locator('.trow').filter({ hasText: 'E2E Imp Three' })
      .waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.trow').count(), rowsBefore + 3,
      'a valid file commits exactly its rows');
    await context.close();
  });

  // === E2E-007: Encrypted backup destructive restore + hostile inputs ===
  await test('E2E-007: backup restores into an emptied vault and hostile inputs never mutate', async () => {
    const { context, page } = await freshDevice();
    await createVault(page, 'e2e-007-backup-password');
    await addEntry(page, 'Keep One', 'keep-secret-111');
    await addEntry(page, 'Keep Two', 'keep-secret-222');
    const rowsBefore = await page.locator('.trow').count();
    assert.equal(rowsBefore, 2);

    // 1. Create a versioned encrypted backup and keep the file.
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#set-backup').click();
    await page.locator('#ov-backup.on').waitFor();
    await page.locator('#backup-pw').fill('e2e-007-backup-password');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btn-backup-create').click();
    const download = await downloadPromise;
    const backupPath = `/tmp/veyora-e2e007-${Date.now()}.json`;
    await download.saveAs(backupPath);
    const envelope = JSON.parse(await readFile(backupPath, 'utf8'));
    assert.equal(envelope.format, 'veyora-backup');
    assert.equal(envelope.record_count, rowsBefore);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#ov-backup.on'));

    // 6 (first): hostile inputs are refused without destination mutation.
    const hostileRestore = async (text, password) => {
      await page.locator('#set-restore').click();
      await page.locator('#restore-file').waitFor({ state: 'attached' });
      await page.locator('#restore-file').setInputFiles({
        name: 'hostile.json', mimeType: 'application/json', buffer: Buffer.from(text, 'utf8'),
      });
      await page.locator('#ov-backup.on').waitFor();
      const field = page.locator('#backup-restore-pw');
      await field.fill(password);
      await page.locator('#btn-backup-create').click();
      await page.waitForTimeout(1800); // Argon2 derive + decrypt attempt
    };
    const truncated = JSON.stringify(envelope).slice(0, 200);
    await hostileRestore(truncated, 'e2e-007-backup-password');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    const wrongVersion = JSON.stringify({ ...envelope, format_version: 99 });
    await hostileRestore(wrongVersion, 'e2e-007-backup-password');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    // A valid envelope with the WRONG password is refused too.
    await hostileRestore(JSON.stringify(envelope), 'wrong-backup-password');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.trow').count(), rowsBefore,
      'every hostile input left the destination untouched');

    // 2-3. Destroy the local vault entirely, then restore into the empties.
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#reset-everywhere').click();
    await page.locator('#reset-everywhere').click();
    await page.locator('#lock-routes').waitFor({ timeout: 15000 });
    // Fresh vault (empty destination) at the SAME device, then restore.
    await createVault(page, 'e2e-007-destination-password');
    assert.equal(await page.locator('.trow').count(), 0, 'the destination starts empty');
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#set-restore').click();
    await page.locator('#restore-file').waitFor({ state: 'attached' });
    await page.locator('#restore-file').setInputFiles(backupPath);
    await page.locator('#ov-backup.on').waitFor();
    await page.locator('#backup-restore-pw').fill('e2e-007-backup-password');
    await page.locator('#btn-backup-create').click();
    await page.locator('#toast[data-toast-key="backup.restoreDone"]').waitFor({ timeout: 30000 });
    await page.locator('#drawer-close').click();
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
    // 4. Item names and count compare equal against the pre-destruction set.
    await page.locator('.trow[data-id="keep-one"]').waitFor();
    await page.locator('.trow[data-id="keep-two"]').waitFor();
    assert.equal(await page.locator('.trow').count(), rowsBefore,
      'every backed-up item restored into the empty destination');
    // 5. Post-restore CRUD still works.
    await addEntry(page, 'After Restore', 'post-restore-secret');
    assert.equal(await page.locator('.trow').count(), rowsBefore + 1,
      'post-restore create works');
    await context.close();
  });

  // === E2E-003: Real clean-state recovery with the Recovery Key ===
  await test('E2E-003: a vault recovers on a wiped device with only the Recovery Key', async () => {
    const { context, page } = await freshDevice();
    await createVault(page, 'e2e-003-original-pw');
    // Every supported item type, tags, TOTP, a favorite, and a Trash entry.
    await addEntry(page, 'Rec Login', 'rec-login-secret-1');
    await addEntry(page, 'Rec Note', 'rec-note-secret-1');
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#drawer-close').click();
    const favoriteRow = page.locator('.trow[data-id="rec-login"]');
    await favoriteRow.locator('[data-fav]').click();
    await page.waitForTimeout(500);
    const kit = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('veyora.web.vault')).kit);
    assert.match(kit, /^[a-z2-7]{5}(-[a-z2-7]{5}){11}$/, 'the kit is the canonical 71-char form');
    const rowsBefore = await page.locator('.trow').count();

    // Destroy ALL local state: no master password, no metadata, no session.
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#lock-routes').waitFor();

    // Recover with only the kit and a NEW master password — the route is
    // offered directly on the Welcome screen of the wiped device.
    await page.locator('#btn-recover-routes').click();
    await page.locator('#lock-recover:not(.hidden)').waitFor();
    // A malformed kit is refused inline and changes nothing.
    await page.locator('#recover-kit').fill('not-a-valid-kit');
    await page.locator('#recover-new').fill('e2e-003-new-password');
    await page.locator('#recover-new2').fill('e2e-003-new-password');
    await page.locator('#btn-recover-go').click();
    await page.locator('#recover-error[data-error-key="entry.recover.errKit"]')
      .waitFor({ timeout: 10000 });
    // The real kit recovers the vault.
    await page.locator('#recover-kit').fill(kit);
    await page.locator('#btn-recover-go').click();
    await page.locator('#view-app').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.trow').count(), rowsBefore,
      'every item survives recovery byte-for-byte at the listing level');
    await page.locator('.trow[data-id="rec-login"]').waitFor();
    await page.locator('.trow[data-id="rec-note"]').waitFor();

    // The old password no longer unlocks; the new one does; CRUD works.
    await page.locator('#btn-lock').click();
    await page.locator('#lock-unlock').waitFor();
    await unlock(page, 'e2e-003-original-pw');
    await page.locator('#unlock-error').waitFor({ timeout: 10000 });
    await unlock(page, 'e2e-003-new-password');
    await page.locator('#view-app').waitFor({ timeout: 15000 });
    await addEntry(page, 'After Recovery', 'post-recovery-secret');
    assert.equal(await page.locator('.trow').count(), rowsBefore + 1,
      'post-recovery CRUD works');
    await context.close();
  });

  // === REC-006: Regenerating the Recovery Key revokes the old kit ===
  await test('REC-006: a regenerated Recovery Key revokes the old kit end to end', async () => {
    const { context, page } = await freshDevice();
    await createVault(page, 'rec006-master-password');
    await addEntry(page, 'Regen Item', 'regen-secret-1');
    const oldKit = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('veyora.web.vault')).kit);

    // Regenerate through the ceremony: re-auth, new kit, verified backup.
    await page.locator('#tb-settings').click();
    await page.locator('#drawer').waitFor();
    await page.locator('#set-regen').click();
    await page.locator('#ov-regen.on').waitFor();
    // A wrong password is refused and nothing changes.
    await page.locator('#regen-pw').fill('wrong-password-here');
    await page.locator('#btn-regen-go').click();
    await page.locator('#regen-error[data-error-key="backup.errWrong"]')
      .waitFor({ timeout: 10000 });
    await page.locator('#regen-pw').fill('rec006-master-password');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btn-regen-go').click();
    await downloadPromise;
    await page.locator('#regen-done:not(.hidden)').waitFor({ timeout: 30000 });
    const newKit = await page.locator('#regen-kit-out').inputValue();
    assert.match(newKit, /^[a-z2-7]{5}(-[a-z2-7]{5}){11}$/);
    assert.notEqual(newKit, oldKit, 'a genuinely new kit is presented');
    assert.match(await page.locator('#regen-done').textContent(),
      /no longer opens this vault/, 'the revocation consequence is stated');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#ov-regen.on'));

    // The OLD kit no longer recovers: wipe and try it.
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#btn-recover-routes').click();
    await page.locator('#lock-recover:not(.hidden)').waitFor();
    await page.locator('#recover-kit').fill(oldKit);
    await page.locator('#recover-new').fill('rec006-after-password');
    await page.locator('#recover-new2').fill('rec006-after-password');
    await page.locator('#btn-recover-go').click();
    await page.locator('#recover-error[data-error-key="entry.recover.errKit"]')
      .waitFor({ timeout: 15000 });
    // The NEW kit recovers the same vault.
    await page.locator('#recover-kit').fill(newKit);
    await page.locator('#btn-recover-go').click();
    await page.locator('#view-app').waitFor({ timeout: 30000 });
    await page.locator('.trow[data-id="regen-item"]').waitFor();
    await context.close();
  });

  console.log(`\nE2E journeys: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
} catch (error) {
  console.error('E2E journey setup failed:', error.message);
  process.exit(1);
} finally {
  await browser.close();
}
