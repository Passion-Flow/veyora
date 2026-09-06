#!/usr/bin/env node
/**
 * Keyboard and focus audit for the apps/web client (ACC-004 automated
 * portion, ACC-005, and the 200% zoom reflow check).
 *
 *   - ACC-004 focus containment: while a dialog (modal overlay or drawer) is
 *          open, Tab and Shift+Tab stay inside it (WAI-ARIA dialog pattern),
 *          and focus moves into the dialog when it opens.
 *   - ACC-004 focus return: closing a dialog with Escape or its close/cancel
 *          control returns focus to the control that opened it.
 *   - ACC-005 focus not obscured: every visible focusable control, once
 *          focused, is not fully covered by another element (e.g. a sticky
 *          bar) at its interaction point.
 *   - 200% zoom reflow: at 640 CSS px — half of the 1280 px base viewport,
 *          the equivalent of 200% browser zoom — the core screens keep
 *          content on one axis and primary actions on-screen.
 *
 * Manual screen-reader and native-target evidence is NOT covered here and
 * remains part of E2E-010 manual scope.
 *
 * Environment:
 *   VEYORA_WEB_URL  base URL of the web client (default :3000)
 */

import assert from 'node:assert/strict';

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
const context = await browser.newContext({
  permissions: ['clipboard-read', 'clipboard-write'],
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'warning' || message.type() === 'error') {
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

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]),'
  + ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Assert the Tab / Shift+Tab cycle never leaves the open dialog. */
async function assertFocusTrap(label, containerSelector) {
  // Playwright serializes the function source only: every value the page-side
  // helper needs must travel as an argument, not as a closure reference.
  const moveFocusTo = (args) => {
    const container = document.querySelector(args.selector);
    const focusables = [...container.querySelectorAll(args.focusable)]
      .filter(el => el.offsetParent !== null);
    if (!focusables.length) return;
    focusables[args.edge === 'first' ? 0 : focusables.length - 1].focus();
  };
  const insideContainer = (args) =>
    !!(document.activeElement && document.activeElement.closest(args.selector));
  const args = (edge) => ({ selector: containerSelector, focusable: FOCUSABLE, edge });

  await page.evaluate(moveFocusTo, args('first'));
  let inside = await page.evaluate(insideContainer, { selector: containerSelector });
  assert.ok(inside, `${label}: initial focus is not inside ${containerSelector}`);
  await page.keyboard.press('Shift+Tab');
  inside = await page.evaluate(insideContainer, { selector: containerSelector });
  assert.ok(inside, `${label}: Shift+Tab from the first control left ${containerSelector}`);
  await page.evaluate(moveFocusTo, args('last'));
  await page.keyboard.press('Tab');
  inside = await page.evaluate(insideContainer, { selector: containerSelector });
  assert.ok(inside, `${label}: Tab from the last control left ${containerSelector}`);
}

/** Injected page-side ACC-005 check: focus every control that can actually
 *  receive focus in the current context and prove the element at its
 *  interaction point is the control or its own content.
 *
 *  When a dialog is open, only controls inside it are checked: the dialog
 *  pattern makes the page behind it inert (focus trap + aria-modal), so those
 *  controls cannot receive author-focusable focus while it is open. */
const OBSCURED_SOURCE = () => {
  const issues = [];
  const openDialog = document.querySelector('#drawer.on')
    || [...document.querySelectorAll('.overlay.on')].pop();
  const scope = openDialog || document;
  const onScreen = (box) => box.width > 0 && box.height > 0
    && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
  const controls = scope.querySelectorAll(
    'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])');
  for (const el of controls) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (!onScreen(el.getBoundingClientRect())) continue;
    el.focus();
    // Re-measure: focusing can scroll the control into view.
    const box = el.getBoundingClientRect();
    if (!onScreen(box)) {
      issues.push(`${el.id || el.tagName.toLowerCase()} focused off-screen`);
      continue;
    }
    const point = { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 12) };
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit !== el && !el.contains(hit)) {
      const label = el.id || el.getAttribute('aria-label') || el.tagName.toLowerCase();
      const hitLabel = hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}`
        + (hit.parentElement ? ` in ${hit.parentElement.tagName.toLowerCase()}`
          + (hit.parentElement.id ? `#${hit.parentElement.id}` : '') : '')
        : 'nothing';
      issues.push(`${label} is covered by ${hitLabel} when focused`);
    }
  }
  return issues;
};

/** Reflow gate shared by the 320 px (a11y suite) and 640 px checks here. */
async function assertNoHorizontalScroll(label, selectors, width) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(overflow.scroll <= overflow.client + 1,
    `${label}: document scrolls horizontally ${overflow.scroll} > ${overflow.client}`);
  for (const selector of selectors) {
    const box = await page.locator(selector).first().boundingBox();
    assert.ok(box, `${label}: ${selector} present`);
    assert.ok(box.x >= -1 && box.x + box.width <= width + 1,
      `${label}: ${selector} is clipped (${JSON.stringify(box)})`);
  }
}

async function closeDrawer() {
  if (!(await page.locator('#drawer.on').count())) return;
  try {
    await page.locator('#drawer-close').click({ timeout: 3000, force: true });
  } catch {
    await page.evaluate(() => document.querySelector('#drawer-close')?.click());
  }
  await page.locator('#drawer.on').waitFor({ state: 'detached', timeout: 5000 });
}

try {
  const separator = webUrl.includes('?') ? '&' : '?';
  await page.goto(`${webUrl}${separator}e2e=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  // Create a vault with one item so the dashboard has real content.
  await page.locator('#lock-routes').waitFor({ timeout: 15000 });
  await page.locator('#wf-import').click();
  await page.locator('#lock-welcome').waitFor();
  await page.locator('#new-pw').fill('e2e-kbd-password');
  await page.locator('#new-pw2').fill('e2e-kbd-password');
  await page.locator('#btn-create').click();
  await page.locator('#view-app').waitFor({ timeout: 15000 });

  // UX-ONB-007: complete the Recovery Key ceremony after creation.
  const kitOverlay = page.locator('#ov-kit.on');
  await kitOverlay.waitFor({ timeout: 15000 });
  const kit = await page.locator('#kit-out').inputValue();
  await page.locator('#kit-verify').fill(kit);
  await page.locator('#btn-kit-verify').click();
  await page.locator('#ov-kit').waitFor({ state: 'hidden' });
  await closeDrawer();
  await page.locator('#btn-new').click();
  await page.locator('#ov-entry.on').waitFor();
  await page.locator('#f-name').fill('E2E KBD Item');
  await page.locator('#f-secret').fill('e2e-kbd-secret');
  await page.locator('#btn-save-entry').click();
  await page.locator('.saved-panel').waitFor();
  await page.locator('#saved-back').click();
  await page.locator('.trow').filter({ hasText: 'E2E KBD Item' }).waitFor();

  // === ACC-004: entry modal — focus moves in, trap holds, focus returns ===
  await page.locator('#btn-new').click();
  await page.locator('#ov-entry.on').waitFor();
  await page.waitForTimeout(150); // the form focuses its first field on open
  await test('entry modal: focus starts inside the dialog (ACC-004)', async () => {
    const inside = await page.evaluate(() =>
      !!document.activeElement.closest('#ov-entry'));
    assert.ok(inside, `focus is on <${await page.evaluate(() => document.activeElement.tagName)}#` +
      `${await page.evaluate(() => document.activeElement.id)}> outside the modal`);
  });
  await test('entry modal: Tab cycle stays inside the dialog (ACC-004)', () =>
    assertFocusTrap('entry modal', '#ov-entry'));
  await test('entry modal: Escape closes and focus returns to New item (ACC-004)', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#ov-entry.on').waitFor({ state: 'detached' });
    const focused = await page.evaluate(() => document.activeElement?.id);
    assert.equal(focused, 'btn-new', `focus landed on #${focused}`);
  });

  // === ACC-004: generator opened from the field action, layered on entry ===
  await page.locator('#btn-new').click();
  await page.locator('#ov-entry.on').waitFor();
  await page.locator('#fgen-secret').click();
  await page.locator('#ov-gen.on').waitFor();
  await page.waitForTimeout(150);
  await test('generator: focus starts inside the dialog (ACC-004)', async () => {
    const inside = await page.evaluate(() => !!document.activeElement.closest('#ov-gen'));
    assert.ok(inside, 'focus stays behind the generator overlay');
  });
  await test('generator: Tab cycle stays inside the dialog (ACC-004)', () =>
    assertFocusTrap('generator', '#ov-gen'));
  await test('generator: Escape closes both layers and focus returns to the app (ACC-004)', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#ov-gen.on').waitFor({ state: 'detached' });
    await page.locator('#ov-entry.on').waitFor({ state: 'detached' });
    const focused = await page.evaluate(() => document.activeElement?.id);
    assert.equal(focused, 'btn-new', `focus landed on #${focused}`);
  });

  // === ACC-004: settings drawer ===
  await page.locator('#tb-settings').click();
  await page.locator('#set-import').waitFor();
  await page.waitForTimeout(150);
  await test('settings drawer: focus starts inside the drawer (ACC-004)', async () => {
    const inside = await page.evaluate(() => !!document.activeElement.closest('#drawer'));
    assert.ok(inside, 'focus stays behind the settings drawer');
  });
  await test('settings drawer: Tab cycle stays inside the drawer (ACC-004)', () =>
    assertFocusTrap('settings drawer', '#drawer'));
  await test('settings drawer: Escape closes and focus returns to Settings (ACC-004)', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#drawer.on').waitFor({ state: 'detached' });
    const focused = await page.evaluate(() => document.activeElement?.id);
    assert.equal(focused, 'tb-settings', `focus landed on #${focused}`);
  });

  // === ACC-004: help overlay ===
  await page.locator('#tb-help').click();
  await page.locator('#ov-help').waitFor();
  await page.waitForTimeout(150);
  await test('help overlay: Tab cycle stays inside the dialog (ACC-004)', () =>
    assertFocusTrap('help overlay', '#ov-help'));
  await test('help overlay: Escape closes and focus returns to Help (ACC-004)', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#ov-help').waitFor({ state: 'detached' });
    const focused = await page.evaluate(() => document.activeElement?.id);
    assert.equal(focused, 'tb-help', `focus landed on #${focused}`);
  });

  // === ACC-004: shortcuts overlay closes with focus return ===
  await page.locator('#tb-shortcuts').click();
  await page.locator('#ov-shortcuts.on').waitFor();
  await test('shortcuts overlay: Tab cycle stays inside the dialog (ACC-004)', () =>
    assertFocusTrap('shortcuts overlay', '#ov-shortcuts'));
  await test('shortcuts overlay: close button returns focus to the opener (ACC-004)', async () => {
    await page.locator('#ov-shortcuts [data-close]').click();
    await page.locator('#ov-shortcuts.on').waitFor({ state: 'detached' });
    const focused = await page.evaluate(() => document.activeElement?.id);
    assert.equal(focused, 'tb-shortcuts', `focus landed on #${focused}`);
  });

  // === ACC-005: focused controls are not obscured ===
  await test('dashboard: no visible control is covered when focused (ACC-005)', async () => {
    const issues = await page.evaluate(OBSCURED_SOURCE);
    assert.deepEqual(issues, [], issues.join('\n  '));
  });
  await page.locator('#btn-new').click();
  await page.locator('#ov-entry.on').waitFor();
  await test('entry modal: no visible control is covered when focused (ACC-005)', async () => {
    const issues = await page.evaluate(OBSCURED_SOURCE);
    assert.deepEqual(issues, [], issues.join('\n  '));
  });
  await page.keyboard.press('Escape');
  await page.locator('#ov-entry.on').waitFor({ state: 'detached' });
  await page.locator('#tb-settings').click();
  await page.locator('#set-import').waitFor();
  await test('settings drawer: no visible control is covered when focused (ACC-005)', async () => {
    const issues = await page.evaluate(OBSCURED_SOURCE);
    assert.deepEqual(issues, [], issues.join('\n  '));
  });
  await closeDrawer();

  // === 200% zoom reflow: 640 CSS px = half of the 1280 px base viewport ===
  await page.setViewportSize({ width: 640, height: 640 });
  // Let the reflow, the drawer slide-out transition, and the wrapped topbar
  // settle before asserting geometry or driving the UI.
  await page.waitForTimeout(600);
  await test('200% zoom (640px): dashboard keeps content on one axis', () =>
    assertNoHorizontalScroll('dashboard', ['#search', '#btn-new', '#tb-settings', '#tb-help'], 640));
  // Open the modal through the documented keyboard path: right after the
  // viewport change a coordinate click can race the wrapping layout.
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Control+n');
  await page.locator('#ov-entry.on').waitFor();
  await page.waitForTimeout(400);
  await test('200% zoom (640px): entry modal keeps primary actions on-screen', () =>
    assertNoHorizontalScroll('entry modal', ['#f-name', '#btn-save-entry'], 640));
  await page.keyboard.press('Escape');
  await page.locator('#ov-entry.on').waitFor({ state: 'detached' });
  // Coordinate clicks on the wrapped topbar race the reflow in headless
  // Chromium right after a viewport change; the DOM click exercises the same
  // handler (the keyboard suite covers the keyboard paths separately).
  await page.evaluate(() => document.getElementById('tb-settings')?.click());
  await page.locator('#set-import').waitFor();
  await page.waitForTimeout(400);
  await test('200% zoom (640px): settings drawer keeps primary actions on-screen', () =>
    assertNoHorizontalScroll('settings drawer', ['#set-import', '#drawer-close'], 640));
  await closeDrawer();

  // Final: no console errors
  await test('no console errors or warnings', () => {
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  console.log(`\nKeyboard/focus audit: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
} catch (error) {
  console.error('Keyboard/focus audit setup failed:', error.message);
  process.exit(1);
} finally {
  await page.close();
  await browser.close();
}
