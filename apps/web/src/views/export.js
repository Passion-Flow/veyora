/**
 * Plaintext export ceremony (EXP-002/003).
 *
 * Plain CSV is an interoperability escape hatch, not a backup. The overlay
 * shows an always-visible warning, requires an explicit acknowledgement and
 * master-password re-authentication before the file is produced, and the
 * completion view repeats that the file is not encrypted, what it contains,
 * and how to dispose of it safely.
 *
 * Web downloads are inherently all-or-nothing: the CSV string is fully
 * serialized before the Blob is created, so a serialization failure leaves
 * no partial file (the desktop temp-file + atomic-rename path in EXP-004
 * lands with the desktop work).
 */
import { t } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $, toast, downloadText, captureFocusReturn, restoreFocusReturn } from '../core/ui.js';
import { vault } from '../core/vault.js';
import { exportLoginCsv } from '../data/csv.js';
import { DATA_EXPORT } from '../config.js';
import { recordSync } from '../core/records.js';

/** Markup for the export overlay, mounted by the dashboard shell so locale
 *  re-renders rebuild it with the rest of the surface. Both ceremony stages
 *  exist in the markup; only their visibility toggles. */
export function exportOverlayHtml() {
  return `
    <div class="modal modal-sm">
      <div class="modal-head">
        <h2 id="export-title">${t('export.title')}</h2>
        <button class="btn-icon" data-close title="${t('common.close')}"
                aria-label="${t('common.close')}">${icon('x', 15)}</button>
      </div>
      <div class="modal-body" id="export-confirm">
        <div class="export-warn" role="note">
          <div class="export-warn-head">${icon('alert', 15)}${t('export.notEncrypted')}</div>
          <p>${t('export.warning')}</p>
        </div>
        <label class="micro" for="export-pw">${t('export.passwordLabel')}</label>
        <input class="field-input" id="export-pw" type="password"
               autocomplete="current-password" aria-describedby="export-error">
        <p class="micro">${t('export.passwordHelp')}</p>
        <label class="export-ack">
          <input type="checkbox" id="export-ack">
          <span>${t('export.ack')}</span>
        </label>
        <div class="lock-error" id="export-error" role="alert" aria-live="assertive" aria-atomic="true"></div>
      </div>
      <div class="modal-body hidden" id="export-done"></div>
      <div class="modal-foot" id="export-foot">
        <button class="btn" data-close>${t('common.cancel')}</button>
        <button class="btn btn-primary" id="btn-export-plain">${icon('download', 14)}${t('export.btn')}</button>
      </div>
    </div>`;
}

/** Open the plaintext-export overlay (idempotent, resets prior state). */
export function openPlaintextExport() {
  const overlay = $('#ov-export');
  if (!overlay) return;
  resetCeremony();
  captureFocusReturn(overlay);
  overlay.classList.add('on');
  setTimeout(() => $('#export-pw').focus(), 60);
}

/** Back to a clean confirmation stage after a completion or close. */
function resetCeremony() {
  $('#export-error').textContent = '';
  $('#export-error').classList.remove('on');
  $('#export-pw').value = '';
  $('#export-ack').checked = false;
  $('#export-confirm').classList.remove('hidden');
  $('#export-done').classList.add('hidden');
  $('#export-done').innerHTML = '';
  $('#export-foot').classList.remove('hidden');
}

/**
 * Install document-level delegation for the export ceremony. Delegation
 * survives dashboard re-renders (theme, locale) without rebinding.
 */
export function installExportDelegation() {
  document.addEventListener('click', async event => {
    if (event.target.closest('#btn-export-plain')) return runExport();
    if (event.target.closest('#export-done-close')) return closeFromDone();
    if (event.target.closest('#ov-export [data-close]')) {
      // Drop the typed password as soon as the overlay is dismissed.
      $('#export-pw').value = '';
    }
  });
}

/** Confirm step: acknowledgement + re-authentication, then the export. */
async function runExport() {
  const error = $('#export-error');
  const ack = $('#export-ack');
  const button = $('#btn-export-plain');
  error.textContent = '';
  error.classList.remove('on');
  if (!ack.checked) {
    error.textContent = t('export.needAck');
    error.classList.add('on');
    ack.focus();
    return;
  }
  const password = $('#export-pw').value;
  if (!password) {
    error.textContent = t('export.needPassword');
    error.classList.add('on');
    $('#export-pw').focus();
    return;
  }
  button.disabled = true;
  try {
    await recordSync.verifyPassword(password);
  } catch {
    button.disabled = false;
    error.textContent = t('export.wrongPassword');
    error.classList.add('on');
    $('#export-pw').focus();
    $('#export-pw').select();
    return;
  }
  button.disabled = false;
  // Password verified: serialize everything first; a failure here leaves
  // the confirmation stage with an error and no download.
  let csv;
  try {
    csv = exportLoginCsv(vault.entries);
  } catch {
    error.textContent = t('export.failed');
    error.classList.add('on');
    return;
  }
  downloadText(DATA_EXPORT.filename, csv, 'text/csv');
  showDone(vault.entries.length);
}

/** Completion view (EXP-003): not encrypted, contents, disposal guidance. */
function showDone(count) {
  const overlay = $('#ov-export');
  $('#export-confirm').classList.add('hidden');
  $('#export-foot').classList.add('hidden');
  const done = $('#export-done');
  done.innerHTML = `
    <div class="saved-panel" role="status" aria-live="polite" aria-atomic="true">
      <span class="tile tile-lg">${icon('check', 20)}</span>
      <div class="saved-title">${t('export.doneTitle')}
        <span class="export-badge">${t('export.notEncrypted')}</span></div>
      <div class="saved-body">${t('export.doneBody', {
        file: DATA_EXPORT.filename, count,
      })}</div>
      <dl class="export-facts">
        <div><dt class="micro">${t('export.includes')}</dt><dd>${t('export.includesList')}</dd></div>
        <div><dt class="micro">${t('export.omitted')}</dt><dd>${t('export.omittedList')}</dd></div>
      </dl>
      <p class="micro">${t('export.guidance')}</p>
      <div class="saved-actions">
        <button class="btn btn-primary" id="export-done-close">${t('export.doneClose')}</button>
      </div>
    </div>`;
  done.classList.remove('hidden');
  const close = $('#export-done-close');
  setTimeout(() => close.focus(), 50);
  toast(t('toast.exported', { count }), 'download');
}

function closeFromDone() {
  restoreFocusReturn($('#ov-export'));
  $('#ov-export').classList.remove('on');
  resetCeremony();
}
