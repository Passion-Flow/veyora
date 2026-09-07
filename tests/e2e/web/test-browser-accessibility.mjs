#!/usr/bin/env node
/**
 * Automated accessibility audit for the apps/web client (E2E-010 automated
 * portion; ACC-002/003/006/007/008).
 *
 * Machine-checkable checks only:
 *   - ACC-002 every visible form control has a programmatic accessible name;
 *          every data-entry form field additionally has a persistent visible
 *          <label> (placeholder alone never counts).
 *   - ACC-003 every visible button/link/role control has an accessible name.
 *   - ACC-006 text contrast >= 4.5:1 (normal) or 3:1 (large text), computed
 *          from rendered styles, in both the light and dark themes.
 *   - ACC-007 reflow at 320 CSS px: no document-level horizontal scrolling on
 *          the core screens and the primary actions remain on-screen.
 *   - ACC-008 pointer targets are at least 24 x 24 CSS px.
 *
 * Manual keyboard, screen-reader, zoom, and native-target evidence are NOT
 * covered here and remain part of E2E-010 manual scope.
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

// Injected page-side audit. Returns issue strings; empty means pass.
const AUDIT_SOURCE = () => {
  const issue = (kind, desc) => `${kind}: ${desc}`;

  const isVisible = (el) => {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    // Off-canvas layers (e.g. a translated drawer/overlay) are not user-visible.
    if (rect.right <= 0 || rect.bottom <= 0
        || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
      return false;
    }
    return true;
  };

  const isHiddenFromAT = (el) => {
    for (let node = el; node; node = node.parentElement) {
      if (node.getAttribute?.('aria-hidden') === 'true') return true;
      if (node.hasAttribute?.('hidden')) return true;
    }
    return false;
  };

  const accessibleName = (el) => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => node.textContent.trim())
        .join(' ').trim();
      if (text) return text;
    }
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return label.trim();
    if (el.labels && el.labels.length) {
      const text = [...el.labels].map((l) => l.textContent.trim()).join(' ').trim();
      if (text) return text;
    }
    const value = el.value;
    if (typeof value === 'string' && value.trim() && ['button', 'submit'].includes(el.type)) {
      return value.trim();
    }
    const text = (el.textContent || '').trim();
    if (text) return text;
    const img = el.querySelector?.('img[alt]');
    if (img) return img.getAttribute('alt').trim();
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return '';
  };

  const parseColor = (value) => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const blend = (over, under) => ({
    r: over.r * over.a + under.r * (1 - over.a),
    g: over.g * over.a + under.g * (1 - over.a),
    b: over.b * over.a + under.b * (1 - over.a),
    a: 1,
  });

  const effectiveBackground = (el) => {
    let node = el;
    let acc = null;
    while (node && node !== document.documentElement) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0) {
        acc = acc ? blend(acc, color) : color;
        if (acc.a >= 1) break;
      }
      node = node.parentElement;
    }
    if (!acc || acc.a < 1) {
      // Blend down to the page background (opaque).
      const page = parseColor(getComputedStyle(document.body).backgroundColor)
        || { r: 255, g: 255, b: 255, a: 1 };
      acc = acc ? blend(acc, page) : page;
    }
    return acc;
  };

  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  const contrastRatio = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  };

  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
  };

  const audit = () => {
    const found = [];

    // --- ACC-003 / ACC-002: accessible names for every visible control ---
    const controlSelector = [
      'button', 'a[href]', 'input', 'select', 'textarea',
      '[role="button"]', '[role="checkbox"]', '[role="switch"]', '[role="tab"]',
    ].join(',');
    for (const el of document.querySelectorAll(controlSelector)) {
      if (!isVisible(el) || isHiddenFromAT(el)) continue;
      const name = accessibleName(el);
      if (!name) {
        found.push(issue('name', `${describe(el)} has no accessible name`));
      }
    }

    // --- ACC-002: persistent visible <label> for data-entry form fields ---
    // Placeholder-only identification is not accepted for fields that collect
    // user data. View controls (search box, sort order) are covered by the
    // accessible-name check above; they hold no user data.
    const fieldSelector = 'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"]):not([type="file"]):not([type="range"]):not([type="checkbox"]):not([type="radio"]), select, textarea';
    for (const el of document.querySelectorAll(fieldSelector)) {
      if (!isVisible(el) || isHiddenFromAT(el)) continue;
      if (el.closest('.searchwrap') || el.id === 'sort') continue;
      if (el.id && document.querySelector(`label[for="${el.id}"]`)) continue;
      // Wrapped <label> (no for attribute, contains the control).
      let wrapped = false;
      for (const label of document.querySelectorAll('label')) {
        if (label.contains(el) && (label.textContent || '').trim()) wrapped = true;
      }
      if (wrapped) continue;
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby && labelledby.split(/\s+/).every((id) => {
        const target = document.getElementById(id);
        return target && isVisible(target) && target.textContent.trim();
      })) continue;
      found.push(issue('label', `${describe(el)} has no persistent visible label`));
    }

    // --- ACC-006: text contrast ---
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el) || isHiddenFromAT(el)) continue;
      const ownText = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()).length;
      if (!ownText) continue;
      const style = getComputedStyle(el);
      const fg = parseColor(style.color);
      if (!fg) continue;
      const bg = effectiveBackground(el);
      // Element opacity (e.g. de-emphasized selected-row text) is part of the
      // rendered foreground; blend it down to the background before measuring.
      const effAlpha = fg.a * parseFloat(style.opacity || '1');
      const fgOpaque = effAlpha < 1
        ? blend({ ...fg, a: effAlpha }, bg) : fg;
      const ratio = contrastRatio(fgOpaque, bg);
      const size = parseFloat(style.fontSize);
      const bold = parseInt(style.fontWeight, 10) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const required = large ? 3 : 4.5;
      if (ratio < required) {
        found.push(issue('contrast',
          `${describe(el)} text "${(el.textContent || '').trim().slice(0, 30)}" `
          + `${ratio.toFixed(2)}:1 < ${required}:1 (fg ${style.color} on `
          + `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}))`));
      }
    }

    // --- ACC-008: pointer target size >= 24x24 CSS px ---
    for (const el of document.querySelectorAll(controlSelector)) {
      if (!isVisible(el) || el.disabled) continue;
      if (el.hasAttribute('data-a11y-size-exempt')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) {
        found.push(issue('target',
          `${describe(el)} target is ${Math.round(rect.width)}x${Math.round(rect.height)} < 24x24`));
      }
    }

    return found;
  };
  return audit();
};

async function auditView(label) {
  const found = await page.evaluate(AUDIT_SOURCE);
  assert.deepEqual(found, [], `${label}: ${found.length} issue(s)\n  ${found.join('\n  ')}`);
  return found.length;
}

async function closeDrawer() {
  if (!(await page.locator('#drawer.on').count())) return;
  try {
    await page.locator('#drawer-close').click({ timeout: 3000, force: true });
  } catch {
    // Some CI geometries misclassify the in-viewport close button; the DOM
    // click exercises the same handler, and Escape is the keyboard path.
    await page.evaluate(() => document.querySelector('#drawer-close')?.click());
  }
  await page.locator('#drawer.on').waitFor({ state: 'detached', timeout: 5000 });
}

async function setTheme(theme) {
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  // Color transitions run ~0.2s; let them settle before measuring contrast.
  await page.waitForTimeout(400);
}

try {
  const separator = webUrl.includes('?') ? '&' : '?';
  await page.goto(`${webUrl}${separator}e2e=${Date.now()}`, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });

  // === Welcome route screen ===
  await page.locator('#lock-routes').waitFor({ timeout: 15000 });
  await test('welcome routes: names, labels, contrast, targets (ACC-002/003/006/008, light)', () =>
    auditView('welcome routes'));
  await setTheme('dark');
  await test('welcome routes: dark-theme contrast (ACC-006)', () =>
    auditView('welcome routes (dark)'));
  await setTheme('light');

  // === Connect / Sign-in gate (mocked 401 service) ===
  {
    const gateContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const gatePage = await gateContext.newPage();
    await gatePage.route('**/api/records*', route => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'PM-API-UNAUTHORIZED' } }),
    }));
    await gatePage.goto(webUrl, { waitUntil: 'load' });
    await gatePage.locator('#view-connect').waitFor({ timeout: 15000 });
    await test('connect gate: names, labels, contrast, targets (ACC-002/003/006/008)', async () => {
      const found = await gatePage.evaluate(AUDIT_SOURCE);
      assert.deepEqual(found, [], `connect gate: ${found.length} issue(s)\n  ${found.join('\n  ')}`);
    });
    await gateContext.close();
  }

  // === Create-vault form (import route keeps the note visible) ===
  await page.locator('#wf-import').click();
  await page.locator('#lock-welcome').waitFor();
  await test('create form: names, labels, contrast, targets (ACC-002/003/006/008)', () =>
    auditView('create form'));
  await setTheme('dark');
  await test('create form: dark-theme contrast (ACC-006)', () =>
    auditView('create form (dark)'));
  await setTheme('light');

  // === Unlock a vault with content ===
  await page.locator('#new-pw').fill('e2e-a11y-password');
  await page.locator('#new-pw2').fill('e2e-a11y-password');
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
  await page.locator('#f-name').fill('E2E A11Y Item');
  await page.locator('#f-secret').fill('e2e-a11y-secret');
  await page.locator('#more-fields').click();
  await page.locator('#btn-save-entry').click();
  await page.locator('.saved-panel').waitFor();
  await page.locator('#saved-back').click();
  await page.locator('.trow').filter({ hasText: 'E2E A11Y Item' }).waitFor();

  await test('dashboard with items: names, labels, contrast, targets (ACC-002/003/006/008)', () =>
    auditView('dashboard'));
  await setTheme('dark');
  await test('dashboard: dark-theme contrast (ACC-006)', () =>
    auditView('dashboard (dark)'));
  await setTheme('light');

  // === Entry modal ===
  await page.locator('#btn-new').click();
  await page.locator('#ov-entry.on').waitFor();
  await page.locator('#more-fields').click();
  await test('entry form modal: names, labels, contrast, targets (ACC-002/003/006/008)', () =>
    auditView('entry modal'));

  // === Password generator overlay (opened from the field Generate action) ===
  await page.locator('#fgen-secret').click();
  await page.locator('#ov-gen.on').waitFor();
  await test('generator overlay: names, labels, contrast, targets (ACC-002/003/006/008)', () =>
    auditView('generator overlay'));
  await page.locator('#ov-gen [data-close]').first().click();
  await page.locator('#ov-gen.on').waitFor({ state: 'detached' });
  const entryStillOpen = await page.locator('#ov-entry.on').count();
  if (entryStillOpen) {
    await page.locator('#ov-entry [data-close]').first().click();
    await page.locator('#ov-entry.on').waitFor({ state: 'detached' });
  }

  // === Item drawer + Settings drawer ===
  await page.locator('.trow').filter({ hasText: 'E2E A11Y Item' }).click();
  await page.locator('#drawer.on').waitFor();
  await test('item drawer: names, labels, contrast, targets (ACC-002/003/006/008)', () =>
    auditView('item drawer'));
  await closeDrawer();
  await page.locator('#tb-settings').click();
  await page.locator('#set-import').waitFor();
  await test('settings drawer: names, labels, contrast, targets (ACC-002/003/006/008)', () =>
    auditView('settings drawer'));
  await setTheme('dark');
  await test('settings drawer: dark-theme contrast (ACC-006)', () =>
    auditView('settings drawer (dark)'));
  await setTheme('light');
  await closeDrawer();

  // === Help overlay ===
  await page.locator('#tb-help').click();
  await page.locator('#ov-help').waitFor();
  await test('help overlay: names, labels, contrast, targets (ACC-002/003/006/008)', () =>
    auditView('help overlay'));
  await page.keyboard.press('Escape');
  await page.locator('#ov-help').waitFor({ state: 'detached' });
  await closeDrawer();

  // === ACC-007: reflow at 320 CSS px ===
  const reflowChecks = async (label, selectors) => {
    await test(`reflow at 320px: ${label} keeps content on one axis (ACC-007)`, async () => {
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      assert.ok(overflow.scroll <= overflow.client + 1,
        `${label}: document scrolls horizontally ${overflow.scroll} > ${overflow.client}`);
      for (const selector of selectors) {
        const box = await page.locator(selector).first().boundingBox();
        assert.ok(box, `${label}: ${selector} present`);
        assert.ok(box.x >= -1 && box.x + box.width <= 320 + 1,
          `${label}: ${selector} is clipped (${JSON.stringify(box)})`);
      }
    });
  };

  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(200);
  await reflowChecks('dashboard', ['#search', '#btn-new', '#tb-settings', '#tb-help']);

  await page.locator('#btn-new').click();
  await page.locator('#ov-entry.on').waitFor();
  await page.waitForTimeout(400);
  await reflowChecks('entry modal', ['#f-name', '#btn-save-entry', '#ov-entry [data-close]']);
  await page.locator('#ov-entry [data-close]').first().click();
  await page.locator('#ov-entry.on').waitFor({ state: 'detached' });

  await page.locator('#tb-settings').click();
  await page.locator('#set-import').waitFor();
  await page.waitForTimeout(400);
  await reflowChecks('settings drawer', ['#set-import', '#drawer-close']);
  // Narrow-viewport re-renders can keep the drawer button "unstable" for
  // Playwright's actionability loop; the close intent is unaffected.
  await closeDrawer();

  await page.locator('#tb-help').click();
  await page.locator('#ov-help').waitFor();
  await page.waitForTimeout(400);
  await reflowChecks('help overlay', ['#ov-help [data-help-close]']);
  await page.keyboard.press('Escape');

  // Reduced-motion preference: the progressive-enhancement block collapses
  // every animation/transition duration to effectively zero (ACC).
  await test('prefers-reduced-motion collapses animations and transitions', async () => {
    const motionContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    const motionPage = await motionContext.newPage();
    await motionPage.goto(webUrl, { waitUntil: 'load' });
    await motionPage.locator('#wf-create').waitFor();
    assert.equal(
      await motionPage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      true, 'the reduced-motion emulation is active');
    const durations = await motionPage.evaluate(() => {
      const styles = getComputedStyle(document.querySelector('button'));
      return { transition: styles.transitionDuration, animation: styles.animationDuration };
    });
    const seconds = value => parseFloat(value) || 0;
    assert.ok(seconds(durations.transition) <= 0.001,
      `transition collapses under reduced motion (got ${durations.transition})`);
    assert.ok(seconds(durations.animation) <= 0.001,
      `animation collapses under reduced motion (got ${durations.animation})`);
    await motionContext.close();
  });

  // Final: no console errors
  await test('no console errors or warnings', () => {
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  console.log(`\nA11Y audit: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
} catch (error) {
  console.error('A11Y audit setup failed:', error.message);
  process.exit(1);
} finally {
  await page.close();
  await browser.close();
}
