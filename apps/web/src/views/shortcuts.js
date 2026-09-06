/**
 * Keyboard shortcuts dialog (NAV-007).
 *
 * Every supported shortcut is documented in one in-app dialog. Shortcuts
 * are guarded so they never fire while focus is in a text field; the same
 * guarantee is spelled out to the user here.
 */
import { t } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $, captureFocusReturn } from '../core/ui.js';

/** Rows: [key cap (protocol, not localized), i18n description]. */
const SHORTCUT_ROWS = Object.freeze([
  Object.freeze(['Ctrl/⌘ + K', 'shortcuts.search']),
  Object.freeze(['Ctrl/⌘ + N', 'shortcuts.newItem']),
  Object.freeze(['Ctrl/⌘ + G', 'shortcuts.generator']),
  Object.freeze(['Ctrl/⌘ + L', 'shortcuts.lockAction']),
  Object.freeze(['j / k  ·  ↑ / ↓', 'shortcuts.nav']),
  Object.freeze(['Enter', 'shortcuts.open']),
  Object.freeze(['Esc', 'shortcuts.escape']),
]);

/** Markup for the shortcuts overlay, mounted by the dashboard shell so
 *  locale re-renders rebuild it with the rest of the surface. */
export function shortcutsHtml() {
  return `
    <div class="modal modal-sm">
      <div class="modal-head">
        <h2 id="shortcuts-title">${t('shortcuts.title')}</h2>
        <button class="btn-icon" data-close title="${t('common.close')}"
                aria-label="${t('common.close')}">${icon('x', 15)}</button>
      </div>
      <div class="modal-body">
        <p class="help-sub">${t('shortcuts.sub')}</p>
        <dl class="sc-list">
          ${SHORTCUT_ROWS.map(([keys, key]) =>
            `<div class="sc-row"><dt><kbd>${keys}</kbd></dt><dd>${esc(t(key))}</dd></div>`).join('')}
        </dl>
        <p class="sc-note">${t('shortcuts.searchNote')}</p>
      </div>
    </div>`;
}

/** Open the shortcuts overlay (idempotent). */
export function openShortcuts() {
  const overlay = $('#ov-shortcuts');
  if (!overlay) return;
  captureFocusReturn(overlay);
  overlay.classList.add('on');
  const close = overlay.querySelector('[data-close]');
  if (close) close.focus();
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
