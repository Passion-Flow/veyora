/**
 * Encrypted-backup ceremony (PRD EXP-001, web scope): master-password
 * re-authentication, an explicit statement of what the file contains and
 * what unlocks it, then an all-or-nothing download. The completion stage
 * names the entry count and repeats that only the master password — not
 * any vendor or service — can open the file.
 */
import { t } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $, toast, downloadText, captureFocusReturn, restoreFocusReturn } from '../core/ui.js';
import { vault } from '../core/vault.js';
import { recordSync } from '../core/records.js';
import { createEncryptedBackup, openEncryptedBackup } from '../core/backup.js';
import { kernel } from '../core/kernel.js';
import { checklist } from '../core/checklist.js';

// Late-bound to avoid a module cycle with the dashboard (it mounts this
// overlay's markup; this module re-renders its tables after a restore).
let renderTabs = () => {};
let renderTable = () => {};
export function bindBackupRenderers(tabs, table) {
  renderTabs = tabs;
  renderTable = table;
}
import { slugify } from '../data/schema.js';

const BACKUP_KIND = 'application/json';

function backupFilename() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `veyora-backup-${stamp}.json`;
}

/** Markup for the backup overlay, mounted by the dashboard shell. */
export function backupOverlayHtml() {
  return `
    <div class="modal modal-sm">
      <div class="modal-head">
        <h2 id="backup-title">${t('backup.title')}</h2>
        <button class="btn-icon" data-close title="${t('common.close')}"
                aria-label="${t('common.close')}">${icon('x', 15)}</button>
      </div>
      <div class="modal-body" id="backup-confirm">
        <p class="micro">${t('backup.body')}</p>
        <label class="micro" for="backup-pw">${t('backup.passwordLabel')}</label>
        <input class="field-input" id="backup-pw" type="password"
               autocomplete="current-password" aria-describedby="backup-error">
        <p class="micro">${t('backup.passwordHelp')}</p>
        <div class="lock-error" id="backup-error" role="alert" aria-live="assertive" aria-atomic="true"></div>
      </div>
      <div class="modal-body hidden" id="backup-restore">
        <p class="micro">${t('backup.restoreBody', { count: 0 })}</p>
        <label class="micro" for="backup-restore-pw">${t('backup.passwordLabel')}</label>
        <input class="field-input" id="backup-restore-pw" type="password"
               autocomplete="current-password" aria-describedby="backup-restore-error">
        <p class="micro">${t('backup.restoreHelp')}</p>
        <div class="lock-error" id="backup-restore-error" role="alert" aria-live="assertive" aria-atomic="true"></div>
      </div>
      <div class="modal-body hidden" id="backup-done">
        <div class="backup-done-panel" role="status" aria-live="polite" aria-atomic="true">
          <span class="tile tile-lg">${icon('shield', 20)}</span>
          <div class="saved-title">${t('backup.doneTitle')}</div>
          <div class="saved-body">${t('backup.doneBody', { count: vault.entries.length })}</div>
          <div class="saved-body">${t('backup.doneLocked')}</div>
        </div>
      </div>
      <div class="modal-foot" id="backup-foot">
        <button class="btn" data-close>${t('common.cancel')}</button>
        <button class="btn btn-primary" id="btn-backup-create">${icon('download', 14)}${t('backup.btn')}</button>
      </div>
    </div>`;
}

/**
 * Open the encrypted-backup overlay (idempotent, resets prior state).
 * `mode` is 'create' (re-authenticate, then download) or 'restore' (a
 * picked file whose entries will merge into this vault).
 */
export function openBackupCeremony(mode = 'create', pendingFile = null) {
  const overlay = $('#ov-backup');
  if (!overlay) return;
  overlay.dataset.mode = mode;
  overlay.dataset.pendingFile = '';
  if (mode === 'restore' && pendingFile) {
    overlay.dataset.pendingFile = pendingFile;
    $('#backup-confirm').classList.add('hidden');
    const body = $('#backup-restore');
    body.classList.remove('hidden');
    const count = pendingFileCount(pendingFile);
    body.querySelector('.micro').textContent = t('backup.restoreBody', { count });
    $('#btn-backup-create').innerHTML = `${icon('upload', 14)}${t('backup.restoreBtn')}`;
  } else {
    $('#backup-confirm').classList.remove('hidden');
    $('#backup-restore').classList.add('hidden');
    $('#btn-backup-create').innerHTML = `${icon('download', 14)}${t('backup.btn')}`;
  }
  $('#backup-done').classList.add('hidden');
  $('#backup-foot').classList.remove('hidden');
  $('#backup-pw').value = '';
  $('#backup-restore-pw').value = '';
  for (const id of ['#backup-error', '#backup-restore-error']) {
    $(id).textContent = '';
    $(id).classList.remove('on');
  }
  captureFocusReturn(overlay);
  overlay.classList.add('on');
  (mode === 'restore' ? $('#backup-restore-pw') : $('#backup-pw')).focus();
}

/** The record count advertised by a picked backup file (before decrypt). */
function pendingFileCount(text) {
  try {
    const envelope = JSON.parse(text);
    return Number.isInteger(envelope.record_count) ? envelope.record_count : 0;
  } catch {
    return 0;
  }
}

/** Markup for the Recovery Key ceremony (UX-ONB-007). */
export function kitOverlayHtml() {
  return `
    <div class="modal modal-sm">
      <div class="modal-head">
        <h2 id="kit-title">${t('kit.title')}</h2>
        <button class="btn-icon" data-close title="${t('common.close')}"
                aria-label="${t('common.close')}">${icon('x', 15)}</button>
      </div>
      <div class="modal-body">
        <p class="micro">${t('kit.sub')}</p>
        <label class="micro" for="kit-out">${t('kit.label')}</label>
        <textarea class="field-input" id="kit-out" rows="3" readonly
                  aria-describedby="kit-help"></textarea>
        <p class="micro" id="kit-help">${t('kit.help')}</p>
        <div class="empty-actions">
          <button class="btn" id="kit-copy">${icon('copy', 14)}${t('kit.copy')}</button>
        </div>
        <label class="micro" for="kit-verify">${t('kit.verifyLabel')}</label>
        <textarea class="field-input" id="kit-verify" rows="3" spellcheck="false"
                  autocomplete="off" aria-describedby="kit-error"></textarea>
        <div class="lock-error" id="kit-error" role="alert" aria-live="assertive" aria-atomic="true"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close>${t('kit.later')}</button>
        <button class="btn btn-primary" id="btn-kit-verify">${icon('shield', 14)}${t('kit.verifyBtn')}</button>
      </div>
    </div>`;
}

/** Open the Recovery Key ceremony (idempotent, shows the current kit). */
export function openKitCeremony() {
  const overlay = $('#ov-kit');
  if (!overlay) return;
  const kit = vault.meta && vault.meta.kit;
  if (!kit) return;
  $('#kit-out').value = kit;
  $('#kit-verify').value = '';
  const error = $('#kit-error');
  error.textContent = '';
  delete error.dataset.errorKey;
  error.classList.remove('on');
  captureFocusReturn(overlay);
  overlay.classList.add('on');
  $('#kit-verify').focus();
}

/** Wire the ceremony once per dashboard render (UX-ONB-007). */
export function wireKitOverlay() {
  const overlay = $('#ov-kit');
  if (!overlay || overlay.dataset.wired) return;
  overlay.dataset.wired = '1';
  overlay.addEventListener('veyora:close', () => restoreFocusReturn(overlay));
  $('#kit-copy').onclick = async () => {
    await navigator.clipboard.writeText($('#kit-out').value).catch(() => {});
    toast(t('kit.copied'), 'check');
  };
  $('#btn-kit-verify').onclick = () => {
    const supplied = $('#kit-verify').value.trim();
    const error = $('#kit-error');
    const fail = (message, key = '') => {
      error.textContent = message;
      error.dataset.errorKey = key;
      error.classList.add('on');
    };
    error.textContent = '';
    delete error.dataset.errorKey;
    error.classList.remove('on');
    if (!kernel.validateRecoveryKit(supplied) || supplied !== vault.meta.kit) {
      return fail(t('kit.errMismatch'), 'kit.errMismatch');
    }
    // Verified: record it and complete the onboarding step (UX-ONB-007).
    vault.meta.kitVerifiedAt = new Date().toISOString();
    vault.persist();
    checklist.markDone('recovery');
    // Refresh the checklist card so the completed step is visible at once.
    import('./start-here.js').then(module => module.renderStartHere()).catch(() => {});
    overlay.classList.remove('on');
    restoreFocusReturn(overlay);
    toast(t('kit.verified'), 'check');
  };
}

/** Markup for the regeneration overlay (REC-006), mounted with the backup overlay's host conventions. */
export function regenerateOverlayHtml() {
  return `
    <div class="modal modal-sm">
      <div class="modal-head">
        <h2 id="regen-title">${t('regen.title')}</h2>
        <button class="btn-icon" data-close title="${t('common.close')}"
                aria-label="${t('common.close')}">${icon('x', 15)}</button>
      </div>
      <div class="modal-body" id="regen-confirm">
        <p class="micro">${t('regen.sub')}</p>
        <label class="micro" for="regen-pw">${t('backup.passwordLabel')}</label>
        <input class="field-input" id="regen-pw" type="password"
               autocomplete="current-password" aria-describedby="regen-error">
        <div class="lock-error" id="regen-error" role="alert" aria-live="assertive" aria-atomic="true"></div>
      </div>
      <div class="modal-body hidden" id="regen-done">
        <div class="backup-done-panel" role="status" aria-live="polite" aria-atomic="true">
          <span class="tile tile-lg">${icon('shield', 20)}</span>
          <div class="saved-title">${t('regen.doneTitle')}</div>
          <div class="saved-body">${t('regen.doneConsequence')}</div>
          <label class="micro" for="regen-kit-out">${t('regen.kitLabel')}</label>
          <textarea class="field-input" id="regen-kit-out" rows="3" readonly
                    aria-describedby="regen-verified"></textarea>
          <p class="micro" id="regen-verified">${t('regen.verified')}</p>
        </div>
      </div>
      <div class="modal-foot" id="regen-foot">
        <button class="btn" data-close>${t('common.cancel')}</button>
        <button class="btn btn-primary" id="btn-regen-go">${icon('shield', 14)}${t('regen.btn')}</button>
      </div>
    </div>`;
}

/** Open the regeneration ceremony (idempotent). */
export function openRegenerateCeremony() {
  const overlay = $('#ov-regen');
  if (!overlay) return;
  $('#regen-confirm').classList.remove('hidden');
  $('#regen-done').classList.add('hidden');
  $('#regen-foot').classList.remove('hidden');
  $('#regen-pw').value = '';
  const error = $('#regen-error');
  error.textContent = '';
  delete error.dataset.errorKey;
  error.classList.remove('on');
  captureFocusReturn(overlay);
  overlay.classList.add('on');
  $('#regen-pw').focus();
}

/** Wire regeneration once per dashboard render (REC-006). */
export function wireRegenerateOverlay() {
  const overlay = $('#ov-regen');
  if (!overlay || overlay.dataset.wired) return;
  overlay.dataset.wired = '1';
  overlay.addEventListener('veyora:close', () => restoreFocusReturn(overlay));
  $('#btn-regen-go').onclick = async () => {
    const password = $('#regen-pw').value;
    const error = $('#regen-error');
    error.textContent = '';
    delete error.dataset.errorKey;
    error.classList.remove('on');
    const fail = (message, key = '') => {
      error.textContent = message;
      error.dataset.errorKey = key;
      error.classList.add('on');
    };
    if (!password) return fail(t('backup.errEmpty'), 'backup.errEmpty');
    const button = $('#btn-regen-go');
    button.disabled = true;
    try {
      const newKit = await recordSync.regenerateRecoveryKey(password);
      // REC-006: a verified backup accompanies the change — the envelope is
      // created and immediately opened back before anything is reported.
      const envelope = await createEncryptedBackup(password, vault.entries);
      await openEncryptedBackup(envelope, password);
      downloadText(`veyora-backup-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.json`,
        JSON.stringify(envelope, null, 2), 'application/json');
      $('#regen-kit-out').value = newKit;
      $('#regen-confirm').classList.add('hidden');
      $('#regen-foot').classList.add('hidden');
      $('#regen-done').classList.remove('hidden');
    } catch (thrown) {
      const text = String((thrown && thrown.message) || thrown || '');
      fail(/PM-KERNEL-/.test(text) ? t('backup.errWrong') : t('backup.errFailed'),
        /PM-KERNEL-/.test(text) ? 'backup.errWrong' : 'backup.errFailed');
    } finally {
      button.disabled = false;
    }
  };
}

/** Wire the overlay's controls once per dashboard render. */
export function wireBackupOverlay() {
  const overlay = $('#ov-backup');
  if (!overlay || overlay.dataset.wired) return;
  overlay.dataset.wired = '1';
  overlay.addEventListener('veyora:close', () => restoreFocusReturn(overlay));
  $('#btn-backup-create').onclick = async () => {
    const overlay = $('#ov-backup');
    const mode = overlay.dataset.mode || 'create';
    const field = mode === 'restore' ? $('#backup-restore-pw') : $('#backup-pw');
    const error = mode === 'restore' ? $('#backup-restore-error') : $('#backup-error');
    const password = field.value;
    error.textContent = '';
    delete error.dataset.errorKey;
    error.classList.remove('on');
    const fail = (message, key = '') => {
      error.textContent = message;
      error.dataset.errorKey = key;
      error.classList.add('on');
    };
    if (!password) {
      fail(t('backup.errEmpty'), 'backup.errEmpty');
      field.focus();
      return;
    }
    const button = $('#btn-backup-create');
    button.disabled = true;
    try {
      if (mode === 'restore') {
        const restored = await restoreEncryptedBackupFile(overlay.dataset.pendingFile, password);
        overlay.classList.remove('on');
        restoreFocusReturn(overlay);
        toast(t('backup.restoreDone', { count: restored }), 'check', null, 'backup.restoreDone');
        renderTabs();
        renderTable();
        return;
      }
      // Create mode: re-authenticate first; the password must open the
      // live vault before it is trusted to seal the backup.
      await recordSync.verifyPassword(password);
      const envelope = await createEncryptedBackup(password, vault.entries);
      downloadText(backupFilename(), JSON.stringify(envelope, null, 2), BACKUP_KIND);
      checklist.markDone('backup');
      $('#backup-confirm').classList.add('hidden');
      $('#backup-foot').classList.add('hidden');
      $('#backup-done').classList.remove('hidden');
    } catch (thrown) {
      const text = String((thrown && thrown.message) || thrown || '');
      if (/^backup\./.test(text)) {
        fail(t('backup.errFormat'), 'backup.errFormat');
      } else if (/PM-KERNEL-/.test(text)) {
        fail(t('backup.errWrong'), 'backup.errWrong');
      } else {
        fail(t('backup.errFailed'), 'backup.errFailed');
      }
    } finally {
      button.disabled = false;
    }
  };
}

/**
 * Restore an encrypted backup (merge ceremony): decrypt with the backup's
 * master password, then stage and commit every entry through the atomic
 * batch endpoint with id de-duplication — an id that already exists in
 * this vault imports under a suffixed id, never over it.
 */
export async function restoreEncryptedBackupFile(text, password) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error('backup.format');
  }
  const entries = await openEncryptedBackup(envelope, password);
  const existing = new Set(vault.entries.map(entry => entry.id));
  const staged = entries.map((entry, index) => {
    let id = slugify(entry.name || entry.id || `restored-${index}`);
    let suffix = 2;
    while (existing.has(id)) id = `${slugify(entry.name || entry.id || `restored-${index}`)}-${suffix++}`;
    existing.add(id);
    return { ...entry, id, revision: 1 };
  });
  if (staged.length > 0) {
    await recordSync.importEntries(staged);
  }
  return staged.length;
}
