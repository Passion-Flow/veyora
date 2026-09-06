/**
 * Drawer view — record detail and settings panels.
 * The drawer is the single overlay surface for record-level actions;
 * it renders into the shell created by dashboard.js.
 */
import { t, formatDate, setLocale, getLocale, apiErrorMessage } from '../i18n/index.js';
import { LOCALES } from '../i18n/registry.js';
import { icon } from '../core/icons.js';
import { $, esc, toast, copyWithTimeout, guardRender, captureFocusReturn, restoreFocusReturn } from '../core/ui.js';
import { state } from '../core/state.js';
import { vault } from '../core/vault.js';
import { TYPES, detailFields } from '../data/schema.js';
import { isCommonPassword } from '../data/blocklist.js';
import { analyzePasswordHealth, ageLabel } from '../data/health.js';
import { buildCommit, serviceHost, serviceHealth, lastSyncIso, isDesktopRuntime } from '../data/diagnostics.js';
import { generateTotp, totpSecondsRemaining } from '../data/totp.js';
import { formatNumber } from '../i18n/index.js';
import { STORAGE_KEYS, SECURITY, TIMING, APP } from '../config.js';
import { recordSync } from '../core/records.js';
import { clearLocalMetadata, clearConnectedCache, removeLocalVault, deleteVaultEverywhere } from '../core/reset.js';
import { storage } from '../core/storage.js';
import { checklist } from '../core/checklist.js';
import { firstSuccess } from '../core/telemetry.js';
import { renderStartHere } from './start-here.js';
import { renderTabs, renderTable, deleteEntryWithUndo } from './dashboard.js';

/** Visual masking glyph — a symbol, not localized text. */
const SECRET_MASK = '••••••••••••';

/** Event fired after a locale switch so main.js can re-render surfaces. */
export const LOCALE_CHANGED_EVENT = 'veyora:locale-changed';

/** Open the drawer, optionally forcing a content view. */
export function openDrawer(view) {
  guardRender('drawer', () => openDrawerInner(view));
}

function openDrawerInner(view) {
  if (view) {
    state.detailView = view;
    state.selectedId = null;
  }
  captureFocusReturn($('#drawer'));
  $('#drawer').classList.add('on');
  $('#backdrop').classList.add('on');
  $('#drawer-title').textContent = drawerTitle();
  renderDetail();
  setTimeout(() => { const button = $('#drawer-close'); if (button) button.focus(); }, 50);
}

/** Close the drawer and clear its selection state. */
export function closeDrawer() {
  restoreFocusReturn($('#drawer'));
  $('#drawer').classList.remove('on');
  $('#backdrop').classList.remove('on');
  state.detailView = null;
  state.selectedId = null;
  state.revealed = {};
  renderTabs();
  renderTable();
}

function drawerTitle() {
  if (state.detailView === 'settings') return t('drawer.title.settings');
  return t('drawer.title.entry');
}

/** Render the active drawer content. */
export function renderDetail() {
  const host = $('#detail-inner');
  if (!host) return;
  if (state.detailView === 'settings') {
    host.innerHTML = settingsHtml();
    wireSettings();
    return;
  }
  const entry = vault.entries.find(item => item.id === state.selectedId);
  if (!entry) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = entryHtml(entry);
  wireEntryDetail(entry);
}

/* ------------------------------------------------------------------ */
/* Record detail                                                       */
/* ------------------------------------------------------------------ */

/** Password-health badge for the detail header (reuse + age). */
function healthBadge(entry) {
  const health = analyzePasswordHealth(vault.entries);
  const parts = [];
  if (health.reusedIds.has(entry.id)) parts.push(t('health.reused'));
  const age = health.ageDays.get(entry.id);
  if (age !== undefined && age >= 0) {
    const label = ageLabel(age, formatNumber);
    if (label) parts.push(label);
  }
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function entryHtml(entry) {
  const type = TYPES[entry.type];
  const revealed = Boolean(state.revealed[entry.id]);
  const fields = detailFields(entry).map(field => {
    if (field.notes) {
      return `<div class="d-row"><div class="d-label">${t('field.notes')}</div>
        <div class="d-val"><div class="d-notes">${esc(field.value)}</div></div></div>`;
    }
    let value;
    if (field.secret && !revealed) value = `<span class="masked">${SECRET_MASK}</span>`;
    else if (field.pre) value = `<div class="d-pre">${esc(field.value)}</div>`;
    else value = esc(field.value);
    const copyButton = field.copy
      ? `<button class="btn-icon d-copy" data-dcopy="${esc(field.value)}" title="${t('common.copy')}">${icon('copy', 13)}</button>`
      : '';
    return `<div class="d-row"><div class="d-label">${t(field.labelKey)}</div>
      <div class="d-val${field.mono ? ' mono' : ''}">${value}${copyButton}</div></div>`;
  }).join('');

  return `
    <div class="detail-head">
      <span class="tile tile-lg">${icon(type.icon, 20)}</span>
      <div>
        <div class="d-title">${esc(entry.name)}</div>
        <div class="d-meta">${t(`type.${entry.type}`)} · ${t('drawer.meta', {
          date: formatDate(entry.updated), revision: entry.revision,
        })}${entry.favorite ? ' · ' + t('drawer.favoriteMark') : ''}${healthBadge(entry)}</div>
      </div>
    </div>
    <div class="d-actions">
      <button class="btn btn-primary" id="d-copy">${icon('copy', 14)}${
        entry.type === 'login' ? t('drawer.copyPassword') : t('drawer.copySecret')}</button>
      <button class="btn" id="d-reveal">${icon(revealed ? 'eyeOff' : 'eye', 14)}${
        revealed ? t('common.hide') : t('drawer.reveal')}</button>
      <button class="btn" id="d-edit">${icon('pencil', 14)}${t('common.edit')}</button>
      <button class="btn" id="d-fav">${icon(entry.favorite ? 'starFill' : 'star', 14)}${
        entry.favorite ? t('drawer.unfavorite') : t('drawer.favorite')}</button>
      <button class="btn" id="d-del" style="margin-left:auto">${icon('trash', 14)}${t('common.delete')}</button>
    </div>
${entry.totpSecret ? totpHtml(entry) : ''}
    <div class="d-sec">${fields}</div>
    <div class="d-foot">${t('drawer.foot', { id: entry.id.toUpperCase() })}</div>`;
}

/** Live TOTP display with countdown (RFC 6238). */
let totpTimer = null;
function totpHtml(entry) {
  return `<div class="d-sec" id="totp-section">
    <div class="micro" style="margin-bottom:var(--space-2)">${t('drawer.totp')}</div>
    <div style="display:flex;align-items:center;gap:var(--space-4)">
      <span class="totp-code" id="totp-code" style="font-family:var(--font-mono);font-size:var(--type-scale-0);font-weight:600;letter-spacing:.1em">·</span>
      <div style="flex:1;height:3px;background:var(--line)">
        <div id="totp-progress" style="height:100%;background:var(--fill);transition:width 1s linear"></div>
      </div>
      <span class="totp-remaining micro" id="totp-remaining"></span>
    </div>
  </div>`;
}

function startTotpTicker(entry) {
  clearInterval(totpTimer);
  const codeEl = document.getElementById('totp-code');
  if (!codeEl || !entry.totpSecret) return;
  const update = async () => {
    try {
      const code = await generateTotp(entry.totpSecret);
      codeEl.textContent = code.slice(0, 3) + ' ' + code.slice(3);
      const remaining = totpSecondsRemaining();
      const progress = document.getElementById('totp-progress');
      const remEl = document.getElementById('totp-remaining');
      if (progress) progress.style.width = `${(remaining / 30) * 100}%`;
      if (remEl) remEl.textContent = `${remaining}s`;
    } catch { /* invalid base32 secret: show dashes */ }
  };
  update();
  totpTimer = setInterval(update, 1000);
}

function wireEntryDetail(entry) {
  $('#d-copy').onclick = () => copyWithTimeout(entry.secret);
  startTotpTicker(entry);
  $('#d-reveal').onclick = () => {
    state.revealed[entry.id] = !state.revealed[entry.id];
    if (state.revealed[entry.id]) {
      checklist.markDone('copy-reveal');
      firstSuccess.recordSecretRevealed(); // UX-ONB-010 test-build event
      renderStartHere();
    }
    renderDetail();
    scheduleRevealRehide(entry.id);
  };
  $('#d-edit').onclick = () => {
    import('./modals.js').then(module => module.openEntryModal(entry.id));
  };
  $('#d-fav').onclick = () => syncFavorite(entry);
  wireDeleteButton(entry);
}

/** Auto-hide revealed secrets after the configured clipboard window. */
let revealTimer = null;
function scheduleRevealRehide(entryId) {
  clearTimeout(revealTimer);
  if (!state.revealed[entryId]) return;
  revealTimer = setTimeout(() => {
    state.revealed[entryId] = false;
    if ($('#drawer') && $('#drawer').classList.contains('on')) renderDetail();
  }, state.settings.clipboardSec * 1000);
}

/** Toggle a favorite: optimistic update, rolled back on CAS/network failure. */
async function syncFavorite(entry) {
  const priorRevision = entry.revision;
  entry.favorite = !entry.favorite;
  entry.updated = new Date().toISOString();
  renderTabs();
  renderTable();
  renderDetail();
  try {
    await recordSync.saveEntry(entry, priorRevision);
  } catch (error) {
    entry.favorite = !entry.favorite;
    entry.revision = priorRevision;
    renderTabs();
    renderTable();
    renderDetail();
    toast(apiErrorMessage(error.code), 'alert');
  }
}

function wireDeleteButton(entry) {
  const button = $('#d-del');
  button.onclick = async () => {
    if (!button.dataset.armed) {
      button.dataset.armed = '1';
      button.classList.add('btn-danger-confirm');
      button.innerHTML = `${icon('alert', 14)}${t('drawer.confirmDelete')}`;
      setTimeout(() => {
        if (button.isConnected) {
          delete button.dataset.armed;
          button.classList.remove('btn-danger-confirm');
          button.innerHTML = `${icon('trash', 14)}${t('common.delete')}`;
        }
      }, TIMING.deleteArmMs);
      return;
    }
    const deleted = await deleteEntryWithUndo(entry);
    if (!deleted) return;
    const next = vault.entries[0];
    if (next) {
      state.selectedId = next.id;
      renderTabs();
      renderTable();
      renderDetail();
    } else {
      closeDrawer();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function settingsHtml() {
  const settings = state.settings;
  const localeOptions = LOCALES.map(locale =>
    `<option value="${locale.tag}"${locale.tag === getLocale() ? ' selected' : ''}>${locale.name}</option>`).join('');
  return `
    <div class="detail-head">
      <span class="tile tile-lg">${icon('sliders', 20)}</span>
      <div>
        <div class="d-title">${t('settings.title')}</div>
        <div class="d-meta">${t('settings.sub')}</div>
      </div>
    </div>
    <div class="d-sec set-sec">
      <div class="micro" style="margin-bottom:var(--space-3)">${t('settings.appearance')}</div>
      <div class="set-row">
        <div><div class="t">${t('settings.theme')}</div><div class="s">${t('settings.themeSub')}</div></div>
        <div class="seg">
          <button id="th-light" class="${settings.theme !== 'dark' ? 'on' : ''}">${t('settings.light')}</button>
          <button id="th-dark" class="${settings.theme === 'dark' ? 'on' : ''}">${t('settings.dark')}</button>
        </div>
      </div>
      <div class="set-row">
        <div><div class="t" id="set-locale-label">${t('settings.language')}</div><div class="s">${t('settings.languageSub')}</div></div>
        <select class="select" id="set-locale" aria-labelledby="set-locale-label">${localeOptions}</select>
      </div>
    </div>
    <div class="d-sec set-sec">
      <div class="micro" style="margin-bottom:var(--space-3)">${t('settings.security')}</div>
      <div class="set-row">
        <div><div class="t" id="set-autolock-label">${t('settings.autolock')}</div><div class="s">${t('settings.autolockSub')}</div></div>
        <select class="select" id="set-autolock" aria-labelledby="set-autolock-label">${optionList(SECURITY.autoLock.optionsMinutes, settings.autoLockMin, 'settings.minutes')}</select>
      </div>
      <div class="set-row">
        <div><div class="t" id="set-clip-label">${t('settings.clipboard')}</div><div class="s">${t('settings.clipboardSub')}</div></div>
        <select class="select" id="set-clip" aria-labelledby="set-clip-label">${optionList(SECURITY.clipboard.optionsSeconds, settings.clipboardSec, 'settings.seconds')}</select>
      </div>
      <div class="set-row" style="flex-direction:column;align-items:stretch;gap:var(--space-2)">
        <div><div class="t">${t('settings.changePw')}</div><div class="s">${t('settings.changePwSub')}</div></div>
        <div class="error-summary hidden" id="cp-error" role="alert" tabindex="-1"></div>
        <label class="micro" for="set-cp-current">${t('settings.changePwCurrent')}</label>
        <input class="lock-input" id="set-cp-current" type="password" autocomplete="current-password">
        <label class="micro" for="set-cp-new">${t('settings.changePwNew')}</label>
        <input class="lock-input" id="set-cp-new" type="password" autocomplete="new-password">
        <label class="micro" for="set-cp-confirm">${t('settings.changePwConfirm')}</label>
        <input class="lock-input" id="set-cp-confirm" type="password" autocomplete="new-password">
        <div><button class="btn btn-primary" id="set-cp-btn">${icon('lock', 14)}${t('settings.changePwBtn')}</button></div>
      </div>
      <div class="set-row">
        <div><div class="t">${t('settings.regenTitle')}</div><div class="s">${t('settings.regenSub')}</div></div>
        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
          <button class="btn" id="set-kit">${icon('eye', 14)}${t('settings.kitBtn')}</button>
          <button class="btn" id="set-regen">${icon('shield', 14)}${t('settings.regenBtn')}</button>
        </div>
      </div>
    </div>
    <div class="d-sec set-sec">
      <div class="micro" style="margin-bottom:var(--space-3)">${t('settings.data')}</div>
      <div class="set-row">
        <div><div class="t">${t('settings.backup')}</div><div class="s">${t('settings.backupSub')}</div></div>
        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
          <button class="btn" id="set-backup">${icon('shield', 14)}${t('settings.backupBtn')}</button>
          <button class="btn" id="set-restore">${icon('upload', 14)}${t('settings.restoreBtn')}</button>
        </div>
        <input type="file" id="restore-file" accept=".json,application/json" class="hidden">
      </div>
      <div class="set-row">
        <div><div class="t">${t('settings.export')}</div><div class="s">${t('settings.exportSub')}</div></div>
        <button class="btn" id="set-export">${icon('download', 14)}${t('settings.exportBtn')}</button>
      </div>
      <div class="set-row">
        <div><div class="t">${t('settings.import')}</div><div class="s">${t('settings.importSub')}</div></div>
        <button class="btn" id="set-import">${icon('upload', 14)}${t('settings.importBtn')}</button>
        <input type="file" id="import-file" accept=".csv,text/csv" class="hidden">
      </div>
      <div class="set-row">
        <div><div class="t" id="set-trash-label">${t('settings.trashRetention')}</div><div class="s">${t('settings.trashRetentionSub')}</div></div>
        <select class="select" id="set-trash" aria-labelledby="set-trash-label">${optionList(SECURITY.trash.optionsDays, settings.trashRetentionDays, 'settings.days')}</select>
      </div>
      <div class="set-row" style="flex-direction:column;align-items:stretch;gap:var(--space-2)">
        <div><div class="t">${t('resetMatrix.title')}</div></div>
        <div class="set-row">
          <div><div class="t">${t('resetMatrix.prefsTitle')}</div><div class="s">${t('resetMatrix.prefsSub')}</div></div>
          <button class="btn" id="reset-prefs" data-reset-label="resetMatrix.prefsBtn">${t('resetMatrix.prefsBtn')}</button>
        </div>
        <div class="set-row">
          <div><div class="t">${t('resetMatrix.disconnectTitle')}</div><div class="s">${t('resetMatrix.disconnectSub')}</div></div>
          <button class="btn" id="reset-disconnect" data-reset-label="resetMatrix.disconnectBtn">${t('resetMatrix.disconnectBtn')}</button>
        </div>
        <div class="set-row">
          <div><div class="t">${t('resetMatrix.localTitle')}</div><div class="s">${t('resetMatrix.localSub')}</div></div>
          <button class="btn" id="reset-local" data-reset-label="resetMatrix.localBtn">${t('resetMatrix.localBtn')}</button>
        </div>
        <div class="set-row">
          <div><div class="t">${t('resetMatrix.everywhereTitle')}</div><div class="s">${t('resetMatrix.everywhereSub')}</div></div>
          <button class="btn" id="reset-everywhere" data-reset-label="resetMatrix.everywhereBtn">${t('resetMatrix.everywhereBtn')}</button>
        </div>
      </div>
    </div>
    <div class="d-sec set-sec">
      <div class="micro" style="margin-bottom:var(--space-3)">${t('settings.diagnostics')}</div>
      <div class="about-grid" id="diag-grid">
        <div class="about-cell"><div class="k micro">${t('diag.version')}</div><div class="v">${APP.version}</div></div>
        <div class="about-cell"><div class="k micro">${t('diag.build')}</div><div class="v">${
          buildCommit() || t('diag.buildNotStamped')}</div></div>
        <div class="about-cell"><div class="k micro">${t('diag.mode')}</div><div class="v">${
          isDesktopRuntime() ? t('diag.modeValueDesktop') : t('diag.modeValue')}</div></div>
        <div class="about-cell"><div class="k micro">${t('diag.storage')}</div><div class="v">${
          isDesktopRuntime()
            ? t('diag.storageValueDesktop')
            : serviceHost()
              ? t('diag.storageValue', { host: serviceHost() })
              : t('diag.storageUnknown')}</div></div>
        <div class="about-cell"><div class="k micro">${t('diag.health')}</div><div class="v" id="diag-health">${t('diag.healthChecking')}</div></div>
        <div class="about-cell"><div class="k micro">${isDesktopRuntime() ? t('diag.lastSyncDesktop') : t('diag.lastSync')}</div><div class="v">${
          lastSyncIso()
            ? formatDate(lastSyncIso())
            : (isDesktopRuntime() ? t('diag.syncNoneDesktop') : t('diag.syncNone'))}</div></div>
        <div class="about-cell"><div class="k micro">${t('diag.backup')}</div><div class="v">${t('diag.backupNone')}</div></div>
      </div>
      <div class="set-row">
        <div><div class="t">${t('diag.bundle')}</div><div class="s">${t('diag.bundleSub')}</div></div>
        <button class="btn" id="set-bundle">${icon('copy', 14)}${t('diag.bundleBtn')}</button>
      </div>
    </div>
    <div class="d-sec set-sec">
      <div class="micro" style="margin-bottom:var(--space-3)">${t('settings.about')}</div>
      <div class="about-grid">
        <div class="about-cell"><div class="k micro">${t('about.version')}</div><div class="v">${APP.version}</div></div>
        <div class="about-cell"><div class="k micro">${t('about.kernel')}</div><div class="v">${t('about.kernelValue')}</div></div>
        <div class="about-cell"><div class="k micro">${t('about.kdf')}</div><div class="v">${t('about.kdfValue')}</div></div>
        <div class="about-cell"><div class="k micro">${t('about.cipher')}</div><div class="v">${t('about.cipherValue')}</div></div>
        <div class="about-cell"><div class="k micro">${t('about.signatures')}</div><div class="v">${t('about.signaturesValue')}</div></div>
        <div class="about-cell"><div class="k micro">${t('about.serverSees')}</div><div class="v">${t('about.serverSeesValue')}</div></div>
      </div>
      <p style="margin-top:var(--space-4);font-size:var(--type-scale-5);color:var(--ink-3)">${t('settings.note')}</p>
    </div>`;
}

function optionList(values, selected, unitKey) {
  return values.map(value =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${t(unitKey, { n: value })}</option>`).join('');
}

function wireSettings() {
  $('#th-light').onclick = () => applyTheme('light');
  $('#th-dark').onclick = () => applyTheme('dark');
  $('#set-locale').onchange = async (event) => {
    const tag = event.target.value;
    state.settings.locale = tag;
    storage.set(STORAGE_KEYS.locale, tag);
    await setLocale(tag);
    window.dispatchEvent(new CustomEvent(LOCALE_CHANGED_EVENT, { detail: { locale: tag } }));
  };
  $('#set-autolock').onchange = (event) => {
    state.settings.autoLockMin = Number(event.target.value);
    window.dispatchEvent(new CustomEvent('veyora:autolock-changed'));
    toast(t('toast.autolockSet', { n: state.settings.autoLockMin }), 'clock');
  };
  $('#set-clip').onchange = (event) => {
    state.settings.clipboardSec = Number(event.target.value);
    toast(t('toast.clipSet', { n: state.settings.clipboardSec }), 'clock');
  };
  $('#set-trash').onchange = (event) => {
    state.settings.trashRetentionDays = Number(event.target.value);
    storage.set(STORAGE_KEYS.trashRetention, String(state.settings.trashRetentionDays));
    toast(t('toast.trashSet', { n: state.settings.trashRetentionDays }), 'trash');
  };
  $('#set-regen').onclick = () => {
    import('./backup.js').then(module => module.openRegenerateCeremony());
  };
  $('#set-kit').onclick = () => {
    import('./backup.js').then(module => module.openKitCeremony());
  };
  $('#set-backup').onclick = () => {
    import('./backup.js').then(module => module.openBackupCeremony('create'));
  };
  const restoreInput = $('#restore-file');
  $('#set-restore').onclick = () => {
    restoreInput.value = '';
    restoreInput.click();
  };
  restoreInput.onchange = async () => {
    const file = restoreInput.files && restoreInput.files[0];
    restoreInput.value = '';
    if (!file) return;
    const text = await file.text();
    import('./backup.js').then(module => module.openBackupCeremony('restore', text));
  };
  $('#set-export').onclick = () => {
    import('./export.js').then(module => module.openPlaintextExport());
  };
  // Opt-in support bundle (DIAG-002): built only on request, previewed in
  // full, copied only explicitly; no automatic upload path exists.
  $('#set-bundle').onclick = () => {
    import('./support-bundle.js').then(module => module.openSupportBundle());
  };
  // Diagnostics health probe: async so the drawer opens instantly; the
  // result is a word, never service data (DIAG-001).
  const healthCell = document.getElementById('diag-health');
  if (healthCell) {
    serviceHealth().then(result => {
      const key = result === 'ok'
        ? 'diag.healthOk' : result === 'unhealthy' ? 'diag.healthUnhealthy' : 'diag.healthUnreachable';
      healthCell.textContent = t(key);
    });
  }
  wireImport();
  wireChangePassword();
  wireResetMatrix();
}

/** CSV import: parse, encrypt, batch-store, refresh. */
function wireImport() {
  const fileInput = document.getElementById('import-file');
  $('#set-import').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const count = await recordSync.importCsv(await file.text());
      toast(t('toast.imported', { count }), 'upload', null, 'toast.imported');
      renderTabs();
      renderTable();
    } catch (error) {
      const badCsv = error && error.code && error.code.startsWith('csv.');
      toast(badCsv ? t('toast.importBadCsv') : t('toast.syncFailed'), 'alert');
    }
  };
}

/**
 * Change-master-password ceremony: the same composition-free rules as vault
 * creation (length floor + local common-material screening), the current
 * password verified by the atomic rekey itself, and every failure class
 * surfaced inline without losing the typed input.
 */
function wireChangePassword() {
  const button = $('#set-cp-btn');
  const errorHost = $('#cp-error');
  const fields = ['set-cp-current', 'set-cp-new', 'set-cp-confirm'];
  const show = (message, key = '') => {
    errorHost.textContent = message;
    errorHost.dataset.errorKey = key;
    errorHost.classList.remove('hidden');
    errorHost.focus();
  };
  const clear = () => {
    errorHost.classList.add('hidden');
    delete errorHost.dataset.errorKey;
  };
  fields.forEach(id => $(`#${id}`).addEventListener('input', clear));
  button.onclick = async () => {
    clear();
    const current = $('#set-cp-current').value;
    const next = $('#set-cp-new').value;
    const confirm = $('#set-cp-confirm').value;
    if (next.length < SECURITY.password.minLength) {
      return show(t('settings.changePwErrLength', { min: SECURITY.password.minLength }),
        'settings.changePwErrLength');
    }
    if (isCommonPassword(next)) return show(t('settings.changePwErrCommon'), 'settings.changePwErrCommon');
    if (next !== confirm) return show(t('settings.changePwErrMismatch'), 'settings.changePwErrMismatch');
    if (!current) return show(t('settings.changePwErrWrong'), 'settings.changePwErrWrong');
    button.disabled = true;
    try {
      await recordSync.changeMasterPassword(current, next);
      clear();
      fields.forEach(id => ($(`#${id}`).value = ''));
      toast(t('settings.changePwDone'), 'check', null, 'settings.changePwDone');
      renderTabs();
      renderTable();
    } catch (thrown) {
      // The kernel rejects with raw `PM-KERNEL-*` strings, not Error
      // objects; stringify whatever arrives before classifying it.
      const text = String((thrown && thrown.message) || thrown || '');
      if (thrown && thrown.code === 'PM-CLIENT-PENDING-WRITES') {
        show(t('settings.changePwErrPending'), 'settings.changePwErrPending');
      } else if (/PM-KERNEL-/.test(text)) {
        show(t('settings.changePwErrWrong'), 'settings.changePwErrWrong');
      } else {
        show(apiErrorMessage((thrown && thrown.code) || 'PM-NETWORK-UNREACHABLE'));
      }
    } finally {
      button.disabled = false;
    }
  };
}

/**
 * The Reset matrix (DATA-009): each action names exactly one scope and its
 * consequence; every destructive button uses the same two-step arm/confirm
 * pattern that disarms itself after a beat.
 */
function wireResetMatrix() {
  /** Two-step arm/confirm wrapper for one destructive matrix button. */
  const armable = (id, confirmKey, onConfirm) => {
    const button = $(id);
    const labelKey = button.dataset.resetLabel;
    const restyle = text => {
      button.innerHTML = `${icon('alert', 14)}${text}`;
    };
    button.onclick = async () => {
      if (!button.dataset.armed) {
        button.dataset.armed = '1';
        button.classList.add('btn-danger-confirm');
        restyle(t(confirmKey));
        setTimeout(() => {
          if (button.isConnected) {
            delete button.dataset.armed;
            button.classList.remove('btn-danger-confirm');
            button.innerHTML = `${icon('trash', 14)}${t(labelKey)}`;
          }
        }, TIMING.deleteArmMs);
        return;
      }
      delete button.dataset.armed;
      button.classList.remove('btn-danger-confirm');
      button.innerHTML = `${icon('trash', 14)}${t(labelKey)}`;
      await onConfirm();
    };
  };

  armable('#reset-prefs', 'resetMatrix.prefsConfirm', () => {
    clearLocalMetadata();
    toast(t('resetMatrix.prefsDone'), 'check');
  });

  armable('#reset-disconnect', 'resetMatrix.disconnectConfirm', () => {
    clearConnectedCache();
    toast(t('resetMatrix.disconnectDone'), 'check');
  });

  armable('#reset-local', 'resetMatrix.localConfirm', () => {
    removeLocalVault();
    window.dispatchEvent(new CustomEvent('veyora:reset-vault'));
  });

  armable('#reset-everywhere', 'resetMatrix.everywhereConfirm', async () => {
    try {
      const { tombstoned } = await deleteVaultEverywhere();
      toast(t('resetMatrix.everywhereDone', { count: tombstoned }), 'check');
      window.dispatchEvent(new CustomEvent('veyora:reset-vault'));
    } catch {
      // The service deletion failed; nothing was removed locally, so the
      // vault stays reachable and no orphan was created (DATA-009).
      toast(t('resetMatrix.everywhereFailed'), 'alert');
    }
  });
}

function applyTheme(theme) {
  state.settings.theme = theme;
  storage.set(STORAGE_KEYS.theme, theme);
  document.documentElement.dataset.theme = theme;
  renderDetail();
  const topbarButton = $('#tb-theme');
  if (topbarButton) topbarButton.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 16);
}

/* Document-level copy affordance for field values. */
document.addEventListener('click', event => {
  const button = event.target.closest('[data-dcopy]');
  if (button) copyWithTimeout(button.dataset.dcopy);
});
