/**
 * Shared UI primitives: HTML escaping, toast notifications, clipboard with
 * timed clear, and lightweight element accessors.
 */
import { icon } from './icons.js';
import { TIMING } from '../config.js';
import { state } from './state.js';
import { t } from '../i18n/index.js';

export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => [...document.querySelectorAll(selector)];

/** Escape a value for safe interpolation into HTML strings. */
export function esc(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

let toastTimer = null;

/** Show a transient toast; replaces any previous one. */
export function toast(message, iconName = 'check') {
  const host = $('#toast');
  if (!host) return;
  host.innerHTML = `${icon(iconName, 14)}<span>${message}</span>`;
  host.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('on'), TIMING.toastMs);
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
  setTimeout(() => {
    navigator.clipboard.writeText('').catch(() => {});
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
