/**
 * Drawer view — record detail, settings, and recovery kit panels.
 * The drawer is the single overlay surface for record-level actions;
 * it renders into the shell created by dashboard.js.
 */
import { t, formatDate, setLocale, getLocale } from '../i18n/index.js';
import { LOCALES } from '../i18n/registry.js';
import { icon } from '../core/icons.js';
import { $, esc, toast, copyWithTimeout, downloadText, guardRender } from '../core/ui.js';
import { state } from '../core/state.js';
import { vault } from '../core/vault.js';
import { TYPES, detailFields } from '../data/schema.js';
import { exportLoginCsv } from '../data/csv.js';
import { STORAGE_KEYS, SECURITY, TIMING, DATA_EXPORT, APP } from '../config.js';
import { recordSync } from '../core/records.js';
import { storage } from '../core/storage.js';
import { renderTabs, renderTable } from './dashboard.js';

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
  $('#drawer').classList.add('on');
  $('#backdrop').classList.add('on');
  $('#drawer-title').textContent = drawerTitle();
  renderDetail();
  setTimeout(() => { const button = $('#drawer-close'); if (button) button.focus(); }, 50);
}

/** Close the drawer and clear its selection state. */
export function closeDrawer() {
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
  if (state.detailView === 'recovery') return t('drawer.title.recovery');
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
  if (state.detailView === 'recovery') {
    host.innerHTML = recoveryHtml();
    wireRecovery();
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
        })}${entry.favorite ? ' · ' + t('drawer.favoriteMark') : ''}</div>
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
    <div class="d-sec">${fields}</div>
    <div class="d-foot">${t('drawer.foot', { id: entry.id.toUpperCase() })}</div>`;
}

function wireEntryDetail(entry) {
  $('#d-copy').onclick = () => copyWithTimeout(entry.secret);
  $('#d-reveal').onclick = () => {
    state.revealed[entry.id] = !state.revealed[entry.id];
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
    toast(error.code === 'PM-STORE-CONFLICT' ? t('toast.conflict') : t('toast.syncFailed'), 'alert');
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
    try {
      await recordSync.tombstone(entry.id, entry.revision);
    } catch (error) {
      toast(error.code === 'PM-STORE-CONFLICT' ? t('toast.conflict') : t('toast.syncFailed'), 'alert');
      return;
    }
    vault.entries = vault.entries.filter(item => item.id !== entry.id);
    toast(t('toast.deleted'), 'trash');
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
        <div><div class="t">${t('settings.language')}</div><div class="s">${t('settings.languageSub')}</div></div>
        <select class="select" id="set-locale">${localeOptions}</select>
      </div>
    </div>
    <div class="d-sec set-sec">
      <div class="micro" style="margin-bottom:var(--space-3)">${t('settings.security')}</div>
      <div class="set-row hidden" id="change-pw-form" style="align-items:stretch">
        <div style="flex:1;display:grid;gap:10px">
          <input class="field-input" id="cp-current" type="password" autocomplete="current-password"
                 placeholder="${t('settings.changePwCurrent')}">
          <input class="field-input" id="cp-new" type="password" autocomplete="new-password"
                 placeholder="${t('entry.create.passwordPh', { min: SECURITY.password.minLength })}">
          <input class="field-input" id="cp-confirm" type="password" autocomplete="new-password"
                 placeholder="${t('entry.create.confirmPh')}">
          <div style="display:flex;gap:var(--space-2)">
            <button class="btn" id="cp-cancel">${t('common.cancel')}</button>
            <button class="btn btn-primary" id="cp-save">${t('modal.save')}</button>
          </div>
        </div>
      </div>
      <div class="set-row">
        <div><div class="t">${t('settings.autolock')}</div><div class="s">${t('settings.autolockSub')}</div></div>
        <select class="select" id="set-autolock">${optionList(SECURITY.autoLock.optionsMinutes, settings.autoLockMin, 'settings.minutes')}</select>
      </div>
      <div class="set-row">
        <div><div class="t">${t('settings.clipboard')}</div><div class="s">${t('settings.clipboardSub')}</div></div>
        <select class="select" id="set-clip">${optionList(SECURITY.clipboard.optionsSeconds, settings.clipboardSec, 'settings.seconds')}</select>
      </div>
      <div class="set-row" id="change-pw-row">
        <div><div class="t">${t('settings.changePw')}</div><div class="s">${t('settings.changePwSub')}</div></div>
        <button class="btn" id="set-change-pw">${icon('key', 14)}${t('settings.changePwBtn')}</button>
      </div>
    </div>
    <div class="d-sec set-sec">
      <div class="micro" style="margin-bottom:var(--space-3)">${t('settings.data')}</div>
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
        <div><div class="t">${t('settings.resetVault')}</div><div class="s">${t('settings.resetVaultSub')}</div></div>
        <button class="btn" id="set-reset">${icon('trash', 14)}${t('settings.resetVaultBtn')}</button>
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
  $('#set-export').onclick = exportCsv;
  wireImport();
  wireChangePassword();
  wireResetButton();
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
      toast(t('toast.imported', { count }), 'upload');
      renderTabs();
      renderTable();
    } catch (error) {
      const badCsv = error && error.code && error.code.startsWith('csv.');
      toast(badCsv ? t('toast.importBadCsv') : t('toast.syncFailed'), 'alert');
    }
  };
}

/** Change master password: verify current, re-key everything, keep session. */
function wireChangePassword() {
  const showForm = (visible) => {
    document.getElementById('change-pw-form').classList.toggle('hidden', !visible);
    document.getElementById('change-pw-row').classList.toggle('hidden', visible);
  };
  $('#set-change-pw').onclick = () => {
    showForm(true);
    const first = document.getElementById('cp-current');
    if (first) first.focus();
  };
  $('#cp-cancel').onclick = () => showForm(false);
  $('#cp-save').onclick = async () => {
    const current = document.getElementById('cp-current').value;
    const next = document.getElementById('cp-new').value;
    const confirm = document.getElementById('cp-confirm').value;
    if (next.length < SECURITY.password.minLength) {
      return toast(t('entry.create.errLength', { min: SECURITY.password.minLength }), 'alert');
    }
    if (next !== confirm) return toast(t('entry.create.errMismatch'), 'alert');
    const button = $('#cp-save');
    button.disabled = true;
    try {
      await recordSync.changeMasterPassword(current, next);
      toast(t('toast.passwordChanged'), 'key');
      showForm(false);
    } catch (error) {
      const wrongPassword = error && /PM-KERNEL-/.test(String(error.message));
      toast(wrongPassword ? t('entry.unlock.errWrong') : t('toast.syncFailed'), 'alert');
    } finally {
      button.disabled = false;
    }
  };
}

/** Two-step confirmation for the destructive local vault reset. */
function wireResetButton() {
  const button = $('#set-reset');
  button.onclick = () => {
    if (!button.dataset.armed) {
      button.dataset.armed = '1';
      button.classList.add('btn-danger-confirm');
      button.innerHTML = `${icon('alert', 14)}${t('settings.resetVaultConfirm')}`;
      setTimeout(() => {
        if (button.isConnected) {
          delete button.dataset.armed;
          button.classList.remove('btn-danger-confirm');
          button.innerHTML = `${icon('trash', 14)}${t('settings.resetVaultBtn')}`;
        }
      }, TIMING.deleteArmMs);
      return;
    }
    vault.reset();
    window.dispatchEvent(new CustomEvent('veyora:reset-vault'));
  };
}

function applyTheme(theme) {
  state.settings.theme = theme;
  storage.set(STORAGE_KEYS.theme, theme);
  document.documentElement.dataset.theme = theme;
  renderDetail();
  const topbarButton = $('#tb-theme');
  if (topbarButton) topbarButton.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 16);
}

function exportCsv() {
  // Contract format (generic-login-csv-v1): exports re-import losslessly,
  // with the entry type riding in tags_json.
  const csv = exportLoginCsv(vault.entries);
  downloadText(DATA_EXPORT.filename, csv, 'text/csv');
  toast(t('toast.exported', { count: vault.entries.length }), 'download');
}

/* ------------------------------------------------------------------ */
/* Recovery kit                                                        */
/* ------------------------------------------------------------------ */

function recoveryHtml() {
  return `
    <div class="detail-head">
      <span class="tile tile-lg">${icon('shield', 20)}</span>
      <div>
        <div class="d-title">${t('recovery.title')}</div>
        <div class="d-meta">${t('recovery.sub')}</div>
      </div>
    </div>
    <div class="d-sec">
      <div class="rec-warn">
        <div class="rec-warn-head">${icon('alert', 13)}${t('recovery.warnHead')}</div>
        <div class="rec-warn-body">${t('recovery.warnBody')}</div>
      </div>
      <div class="rec-code">${esc(vault.meta ? vault.meta.kit : '')}</div>
      <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
        <button class="btn btn-primary" id="rec-copy">${icon('copy', 14)}${t('recovery.copyKit')}</button>
        <button class="btn" id="rec-regen">${icon('refresh', 14)}${t('recovery.regenerate')}</button>
        <button class="btn" id="rec-download">${icon('download', 14)}${t('entry.kit.download')}</button>
      </div>
      <p style="margin-top:18px;font-size:var(--type-scale-5);color:var(--ink-3)">${t('recovery.note')}</p>
    </div>`;
}

function wireRecovery() {
  $('#rec-copy').onclick = () => vault.meta && copyWithTimeout(vault.meta.kit);
  $('#rec-regen').onclick = () => {
    vault.regenerateKit();
    renderDetail();
    toast(t('toast.kitRegen'), 'refresh');
  };
  $('#rec-download').onclick = () => vault.meta && downloadText(
    'veyora-recovery-kit.txt',
    `${t('entry.kit.fileHead')}\n\n${vault.meta.kit}\n\n${t('entry.kit.fileTail')}\n`);
}

/* Document-level copy affordance for field values. */
document.addEventListener('click', event => {
  const button = event.target.closest('[data-dcopy]');
  if (button) copyWithTimeout(button.dataset.dcopy);
});
