/**
 * Shared UI primitives: HTML escaping, toast notifications, clipboard with
 * timed clear, and lightweight element accessors.
 */
import { icon } from './icons.js';
import { TIMING } from '../config.js';
import { state } from './state.js';
import { checklist } from './checklist.js';
import { t } from '../i18n/index.js';
import { firstSuccess } from './telemetry.js';

export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => [...document.querySelectorAll(selector)];

/** Escape a value for safe interpolation into HTML strings. */
export function esc(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

let toastTimer = null;

/**
 * Show a transient toast; replaces any previous one. An optional action
 * renders as a button inside the toast (e.g. Undo after delete-to-trash)
 * and gets its own longer lifetime so it stays clickable.
 */
export function toast(message, iconName = 'check', action = null, key = '') {
  const host = $('#toast');
  if (!host) return;
  // Locale-independent identity for business-flow selectors (QA-013).
  host.dataset.toastKey = key;
  const actionHtml = action
    ? `<button type="button" class="toast-action">${esc(action.label)}</button>`
    : '';
  host.innerHTML = `${icon(iconName, 14)}<span>${message}</span>${actionHtml}`;
  host.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('on'),
    action ? (action.durationMs || TIMING.toastMs) : TIMING.toastMs);
  const button = host.querySelector('.toast-action');
  if (button) button.onclick = () => {
    clearTimeout(toastTimer);
    host.classList.remove('on');
    action.onAction();
  };
}

/* ------------------------------------------------------------------ */
/* Focus return (ACC-004): a dialog returns focus to its opener.        */
/* ------------------------------------------------------------------ */

const focusReturnHosts = new Map();

/** Remember the element that opened a dialog so close can hand focus back. */
export function captureFocusReturn(host) {
  if (!host || host.classList.contains('on')) return;
  for (const key of focusReturnHosts.keys()) {
    if (!key.isConnected) focusReturnHosts.delete(key);
  }
  focusReturnHosts.set(host, document.activeElement);
}

/** Move focus back to the opener of a closing dialog, when it survives. */
export function restoreFocusReturn(host) {
  if (!host) return;
  const opener = focusReturnHosts.get(host);
  focusReturnHosts.delete(host);
  if (opener && opener.isConnected) opener.focus();
}

/**
 * Render error boundary: a throwing render leaves the last good DOM in
 * place, surfaces a toast instead of a white screen, and keeps the cause
 * in the console for diagnosis.
 */
export function guardRender(label, fn) {
  try {
    return fn();
  } catch (error) {
    console.error(`[veyora] render failed: ${label}`, error);
    try { toast(t('toast.renderError'), 'alert'); } catch { /* i18n unavailable */ }
    return undefined;
  }
}

/** Copy text, then clear the clipboard after the configured delay. */
export async function copyWithTimeout(text, label) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = legacyCopy(text);
  }
  if (!ok) {
    toast(t('toast.copyFail'), 'alert');
    return;
  }
  checklist.markDone('copy-reveal'); // Start-here progress (UX-ONB-008)
  firstSuccess.recordSecretCopied(); // UX-ONB-010 test-build event
  // Clear only what Veyora wrote, and announce the result so assistive
  // technology hears that the clipboard is (or is not) clean (SEC-CLIP-001,
  // ACC-011).
  setTimeout(async () => {
    let cleared = false;
    try {
      await navigator.clipboard.writeText('');
      cleared = true;
    } catch { /* clipboard held by another app; leave it untouched */ }
    toast(cleared ? t('toast.clipboardCleared') : t('toast.clipboardClearFailed'), 'lock');
  }, state.settings.clipboardSec * 1000);
  toast(t('toast.copied', { seconds: state.settings.clipboardSec }), 'copy');
}

function legacyCopy(text) {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    return true;
  } catch {
    return false;
  }
}

/** Trigger a browser download for text content. */
export function downloadText(filename, text, mimeType = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
