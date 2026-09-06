/**
 * Help overlay — task-routed assistance reachable from every surface
 * (Welcome, Locked, and the unlocked dashboard) per HELP-001/002.
 *
 * The overlay is created on demand and appended to the document body so a
 * single implementation serves both the lock screen and the dashboard shell.
 * Vault-dependent actions appear only while a vault is unlocked.
 */
import { t } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { esc } from '../core/ui.js';
import { state } from '../core/state.js';
import { PUBLIC_LINKS } from '../config.js';

/** Task catalog: [key prefix, requires an unlocked vault, action id]. */
const HELP_TASKS = Object.freeze([
  Object.freeze(['getStart', true, 'new-item']),
  Object.freeze(['startHere', true, 'start-here']),
  Object.freeze(['shortcuts', true, 'shortcuts']),
  Object.freeze(['recovery', false, null]),
  Object.freeze(['backup', false, null]),
  Object.freeze(['restore', false, null]),
  Object.freeze(['connect', false, null]),
  Object.freeze(['troubleshoot', true, 'settings']),
  Object.freeze(['report', false, 'security-report']),
]);

let overlay = null;
let returnFocus = null;

/** Open the Help overlay (idempotent). */
export function openHelp() {
  // A stray overlay can outlive the global Escape handler (which only
  // removes `.on`); drop it so Help always reopens cleanly.
  if (overlay) {
    if (overlay.isConnected) return;
    closeHelp();
  }
  returnFocus = document.activeElement;
  overlay = document.createElement('div');
  overlay.className = 'overlay on';
  overlay.id = 'ov-help';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('help.title'));
  overlay.innerHTML = `
    <div class="modal modal-sm">
      <div class="modal-head">
        <h2>${t('help.title')}</h2>
        <button class="btn-icon" data-help-close title="${t('common.close')}"
                aria-label="${t('common.close')}">${icon('x', 15)}</button>
      </div>
      <div class="modal-body">
        <p class="help-sub">${t('help.sub')}</p>
        ${HELP_TASKS.map(([key, needsVault, action]) => {
          const actionable = action && (!needsVault || state.unlocked);
          const actionHtml = !actionable ? ''
            : action === 'security-report'
              ? `<a class="btn" data-help-link href="${PUBLIC_LINKS.securityReport}"
                   target="_blank" rel="noopener noreferrer">${t('help.openAction')}</a>`
              : `<button class="btn" data-help-action="${action}">${t('help.openAction')}</button>`;
          return `<div class="help-task">
            <div>
              <div class="help-t">${esc(t(`help.${key}`))}</div>
              <div class="help-s">${esc(t(`help.${key}Sub`))}</div>
            </div>
            ${actionHtml}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', onOverlayClick);
  document.addEventListener('keydown', onHelpKeydown, true);
  const close = overlay.querySelector('[data-help-close]');
  if (close) close.focus();
}

/** Capture-phase Escape so the overlay element itself is removed. */
function onHelpKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeHelp();
  }
}

/** Close and remove the Help overlay. */
export function closeHelp({ restoreFocus = true } = {}) {
  if (!overlay) return;
  document.removeEventListener('keydown', onHelpKeydown, true);
  overlay.remove();
  overlay = null;
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
}

function onOverlayClick(event) {
  if (event.target === overlay) return closeHelp();
  const close = event.target.closest('[data-help-close]');
  if (close) return closeHelp();
  const action = event.target.closest('[data-help-action]')?.dataset.helpAction;
  if (!action) return;
  closeHelp({ restoreFocus: false });
  if (action === 'settings') {
    import('./drawer.js').then(module => module.openDrawer('settings'));
  } else if (action === 'new-item') {
    import('./modals.js').then(module => module.openEntryModal());
  } else if (action === 'shortcuts') {
    import('./shortcuts.js').then(module => module.openShortcuts());
  } else if (action === 'start-here') {
    // UX-ONB-009: the checklist stays reopenable from Help.
    import('../core/checklist.js').then(({ checklist }) => {
      checklist.unhide();
      import('./start-here.js').then(module => module.renderStartHere());
    });
  }
}
