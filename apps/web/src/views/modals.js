/**
 * Modal views — the entry create/edit form and the password generator.
 * Both mount into overlay containers rendered by dashboard.js.
 */
import { t, apiErrorMessage } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $, esc, toast, copyWithTimeout, guardRender, captureFocusReturn } from '../core/ui.js';
import { state } from '../core/state.js';
import { vault } from '../core/vault.js';
import { kernel, entropyBits } from '../core/kernel.js';
import { TYPES, TEMPLATE_FIELDS, SECRET_REQUIRED, slugify } from '../data/schema.js';
import { normalizeTotpSecret } from '../data/totp.js';
import { GENERATOR } from '../config.js';
import { recordSync } from '../core/records.js';
import { pendingQueue } from '../core/pending-queue.js';
import { isDesktopRuntime } from '../data/diagnostics.js';
import { strength } from './strength.js';
import { firstSuccess } from '../core/telemetry.js';
import { renderTabs, renderTable, closeOverlays } from './dashboard.js';

/** Target field for "use this password", or null when opened standalone. */
let generatorTarget = null;

/* ------------------------------------------------------------------ */
/* Entry create / edit                                                 */
/* ------------------------------------------------------------------ */

/** Comma-separated tags: "work, infra" -> ['work', 'infra'] (trimmed,
 * lower-cased for stable filtering, empties dropped). */
export function parseTags(raw) {
  return String(raw ?? '')
    .split(',')
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean);
}

/** Render a stored field value back into the form (tags join by comma). */
function formatFieldValue(key, value) {
  if (value === undefined || value === null) return '';
  return key === 'tags' ? (Array.isArray(value) ? value.join(', ') : String(value)) : String(value);
}

/** Open the entry modal; pass an id to edit an existing record. */
export function openEntryModal(editId) {
  guardRender('entry-modal', () => openEntryModalInner(editId));
}

function openEntryModalInner(editId) {
  state.editingId = editId || null;
  const entry = editId ? vault.entries.find(item => item.id === editId) : null;
  state.entryTmpl = entry ? entry.type : 'login';
  $('#entry-modal-title').textContent = entry ? t('modal.editTitle') : t('modal.newTitle');
  const saveButton = $('#btn-save-entry');
  saveButton.textContent = entry ? t('modal.save') : t('modal.create');
  saveButton.classList.remove('hidden');
  $('#tmpl-grid').classList.remove('hidden');
  $('#entry-form-foot')?.classList.remove('hidden');
  renderTemplateGrid();
  renderEntryFields(entry);
  captureFocusReturn($('#ov-entry'));
  $('#ov-entry').classList.add('on');
  const first = document.querySelector('#entry-fields input, #entry-fields textarea');
  if (first) setTimeout(() => first.focus(), 60);
}

function renderTemplateGrid() {
  $('#tmpl-grid').innerHTML = Object.entries(TYPES).map(([key, type]) =>
    `<button class="tmpl${key === state.entryTmpl ? ' on' : ''}" data-tmpl="${key}">${
      icon(type.icon, 17)}<span class="t-label">${t(`type.${key}`)}</span><span class="t-code">${type.code}</span></button>`).join('');
  document.querySelectorAll('[data-tmpl]').forEach(button => {
    button.onclick = () => {
      state.entryTmpl = button.dataset.tmpl;
      renderTemplateGrid();
      renderEntryFields();
    };
  });
}

/** Describedby chain for a field: its inline error plus any hint (ACC-010). */
function describedBy(def) {
  return [ `ferr-${def.k}`, def.hintKey ? `fh-${def.k}` : '' ].filter(Boolean).join(' ');
}

function fieldHtml(def, value) {
  const spanClass = def.span ? ' span2' : '';
  const hint = def.hintKey
    ? `<div class="field-hint micro" id="fh-${def.k}">${t(def.hintKey)}</div>` : '';
  // Every field carries an inline error slot so a failed save can point at
  // the exact input instead of a generic toast (ACC-010).
  const error = `<div class="field-error micro" id="ferr-${def.k}" role="alert"></div>`;
  if (def.textarea) {
    return `<div class="fld${spanClass}"><label class="micro" for="f-${def.k}">${t(def.labelKey)}</label>
      <textarea class="field-textarea${def.mono ? ' mono' : ''}" id="f-${def.k}"
                aria-describedby="${describedBy(def)}"
                placeholder="${def.phKey ? t(def.phKey) : ''}">${esc(value)}</textarea>${error}${hint}</div>`;
  }
  if (def.secret) {
    return `<div class="fld${spanClass}"><label class="micro" for="f-${def.k}">${t(def.labelKey)}</label>
      <div class="pw-wrap">
        <input class="field-input" id="f-${def.k}" type="password" value="${esc(value)}"
               aria-describedby="${describedBy(def)}"
               placeholder="${t('ph.generate')}" autocomplete="off">
        ${def.gen ? `<button class="pw-gen" id="fgen-${def.k}" type="button">${t('modal.generate')}</button>` : ''}
        <button class="pw-field-btn" id="fshow-${def.k}" type="button" aria-pressed="false"
                aria-label="${t('common.show')}">${icon('eye', 12)}${t('common.show')}</button>
        <button class="pw-field-btn" id="fcopy-${def.k}" type="button"
                aria-label="${t('common.copy')}">${icon('copy', 12)}${t('common.copy')}</button>
      </div>
      <div class="meter" id="m-${def.k}"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="meter-note" id="mn-${def.k}"></div>${error}</div>`;
  }
  return `<div class="fld${spanClass}"><label class="micro" for="f-${def.k}">${t(def.labelKey)}</label>
    <input class="field-input" id="f-${def.k}" type="text" value="${esc(value)}"
           aria-describedby="${describedBy(def)}"
           placeholder="${def.phKey ? t(def.phKey) : ''}" autocomplete="off">${error}${hint}</div>`;
}

/* ------------------------------------------------------------------ */
/* Field-level validation and the multi-error summary (ACC-010)         */
/* ------------------------------------------------------------------ */

/** Show one inline field error and flag the input as invalid. */
function setFieldError(key, message) {
  const input = document.getElementById(`f-${key}`);
  const error = document.getElementById(`ferr-${key}`);
  if (error) error.textContent = message;
  if (input) input.setAttribute('aria-invalid', 'true');
}

/** Clear one field's inline error once the user edits the input. */
function clearFieldError(key) {
  const input = document.getElementById(`f-${key}`);
  const error = document.getElementById(`ferr-${key}`);
  if (error) error.textContent = '';
  if (input) input.removeAttribute('aria-invalid');
}

/**
 * Render the error summary. With several errors the summary lists each one
 * as a link to its field and takes focus; with a single error focus goes to
 * the field itself. Passing an empty list hides the summary.
 */
function renderErrorSummary(errors) {
  const summary = document.getElementById('entry-error-summary');
  if (!summary) return;
  if (!errors.length) {
    summary.innerHTML = '';
    summary.classList.add('hidden');
    return;
  }
  summary.innerHTML = `
    <strong>${t('modal.errSummaryTitle')}</strong>
    <ul>${errors.map(err => `
      <li><a href="#" data-err-link="${err.key}">${esc(err.message)}</a></li>`).join('')}</ul>`;
  summary.classList.remove('hidden');
  summary.querySelectorAll('[data-err-link]').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      const field = document.getElementById(`f-${link.dataset.errLink}`);
      if (field) field.focus();
    });
  });
  if (errors.length < 2) {
    // The summary exists for multiple errors; a single error is reported
    // inline beside its field (ACC-010).
    summary.innerHTML = '';
    summary.classList.add('hidden');
    document.getElementById(`f-${errors[0].key}`)?.focus();
    return;
  }
  summary.focus();
}

function renderEntryFields(entry) {
  const defs = TEMPLATE_FIELDS[state.entryTmpl];
  const primary = defs.filter(def => !def.more);
  const more = defs.filter(def => def.more);
  // Editing an entry that already uses advanced fields expands the section
  // so existing values are never silently hidden (ITEM-002).
  const expanded = entry ? more.some(def => entry[def.k]) : false;
  $('#entry-fields').innerHTML = `
      <div class="error-summary hidden" id="entry-error-summary" role="alert"
           tabindex="-1"></div>`
    + primary.map(def =>
      fieldHtml(def, entry ? formatFieldValue(def.k, entry[def.k]) : '')).join('')
    + (more.length ? `
      <button type="button" class="more-toggle" id="more-fields" aria-expanded="${expanded}"
              aria-controls="more-fields-wrap">${t(expanded ? 'modal.fewerFields' : 'modal.moreFields')}</button>
      <div id="more-fields-wrap" class="fgrid${expanded ? '' : ' hidden'}">
        ${more.map(def => fieldHtml(def, entry ? formatFieldValue(def.k, entry[def.k]) : '')).join('')}
      </div>` : '');
  if (more.length) wireMoreFields(expanded);
  // Editing a field clears its own inline error; input values are never
  // discarded on a failed save (ACC-010).
  defs.forEach(def => {
    const input = document.getElementById(`f-${def.k}`);
    if (input) input.addEventListener('input', () => clearFieldError(def.k));
  });
  defs.filter(def => def.secret && !def.textarea).forEach(def => {
    const input = document.getElementById(`f-${def.k}`);
    input.addEventListener('input', () => updateMeter(def.k, input.value));
    const generate = document.getElementById(`fgen-${def.k}`);
    if (generate) generate.addEventListener('click', () => openGenerator(def.k));
    const show = document.getElementById(`fshow-${def.k}`);
    show.addEventListener('click', () => {
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      show.setAttribute('aria-pressed', String(!visible));
      show.setAttribute('aria-label', t(visible ? 'common.show' : 'common.hide'));
      show.innerHTML = `${icon(visible ? 'eye' : 'eyeOff', 12)}${t(visible ? 'common.show' : 'common.hide')}`;
    });
    const copy = document.getElementById(`fcopy-${def.k}`);
    copy.addEventListener('click', () => { if (input.value) copyWithTimeout(input.value); });
    updateMeter(def.k, input.value);
  });
  if (defs.some(def => def.k === 'totpSecret')) wireTotpValidation();
}

function wireMoreFields(expanded) {
  const button = document.getElementById('more-fields');
  const wrap = document.getElementById('more-fields-wrap');
  button.addEventListener('click', () => {
    const open = wrap.classList.toggle('hidden') === false;
    button.setAttribute('aria-expanded', String(open));
    button.textContent = t(open ? 'modal.fewerFields' : 'modal.moreFields');
    if (open) document.getElementById('f-totpSecret')?.focus();
  });
  if (expanded) wrap.classList.remove('hidden');
}

/** Inline TOTP validation (ITEM-005): normalize on input, never discard. */
function wireTotpValidation() {
  const input = document.getElementById('f-totpSecret');
  const error = document.getElementById('ferr-totpSecret');
  if (!input || !error) return;
  input.addEventListener('input', () => {
    const result = normalizeTotpSecret(input.value);
    if (!input.value.trim() || result.ok) {
      error.textContent = '';
      input.removeAttribute('aria-invalid');
    } else {
      error.textContent = t(totpErrorKey(result.reason));
      input.setAttribute('aria-invalid', 'true');
    }
  });
}

/** Map a validation failure reason to its catalog key. */
function totpErrorKey(reason) {
  if (reason === 'base32') return 'field.totpErrBase32';
  if (reason === 'type') return 'field.totpErrType';
  return 'field.totpErrUri';
}

function updateMeter(key, password) {
  const bars = document.getElementById(`m-${key}`);
  const note = document.getElementById(`mn-${key}`);
  if (!bars) return;
  const result = strength(password);
  [...bars.children].forEach((bar, index) => bar.classList.toggle('on', result.segments > index));
  note.textContent = password
    ? t('strength.readout', { bits: result.bits, label: t(result.labelKey) })
    : '';
}

/**
 * Save-failure status banner (ITEM-006): a dedicated state that names the
 * failure class, states whether the data changed, and offers the safe next
 * action. The form and the typed input always stay in place.
 */
function renderSaveStatus(html) {
  let host = document.getElementById('entry-save-status');
  if (!host) {
    $('#entry-fields').insertAdjacentHTML('afterbegin',
      `<div class="error-summary" id="entry-save-status" role="alert" tabindex="-1"></div>`);
    host = document.getElementById('entry-save-status');
  }
  host.innerHTML = html;
  host.classList.remove('hidden');
  host.focus();
}

function clearSaveStatus() {
  document.getElementById('entry-save-status')?.remove();
}

/** Reload the server's latest version of the edited item (conflict path). */
async function reloadLatest() {
  try {
    vault.entries = await recordSync.fetchAll();
    renderTabs();
    renderTable();
    const fresh = vault.entries.find(item => item.id === state.editingId);
    closeOverlays();
    if (fresh) openEntryModal(fresh.id);
  } catch {
    toast(apiErrorMessage('PM-NETWORK-UNREACHABLE'), 'alert');
  }
}

/**
 * Map a save failure to the ITEM-006 status report. Retrying re-runs the
 * same idempotent write (create reuses the derived id; edits reuse the same
 * compare-and-set revision), so a retry can never duplicate the item.
 */
function reportSaveFailure(error) {
  const code = (error && error.code) || '';
  const status = (error && error.status) || 0;
  const conflict = code === 'PM-STORE-CONFLICT' || status === 409;
  const unreachable = code === 'PM-NETWORK-UNREACHABLE' || status >= 500;
  const body = conflict
    ? t('save.statusConflict')
    : unreachable
      ? t('save.statusNetwork')
      : t('save.statusOther', { message: apiErrorMessage(code) });
  const action = conflict
    ? `<button class="btn btn-primary" id="save-reload">${t('save.statusReload')}</button>`
    : `<button class="btn btn-primary" id="save-retry">${t('save.statusRetry')}</button>`;
  // PRD 25.4/DIAG-003: quote the request id so a user report and the
  // server log line up; only shown when the service provided one.
  const requestLine = error && error.requestId
    ? `<p class="save-status-request">${t('save.statusRequestId', { id: error.requestId })}</p>`
    : '';
  renderSaveStatus(`
    <strong>${t('save.statusTitle')}</strong>
    <p>${body}</p>
    ${requestLine}
    <div class="saved-actions">${action}</div>`);
  const retry = document.getElementById('save-retry');
  if (retry) retry.onclick = () => saveEntry();
  const reload = document.getElementById('save-reload');
  if (reload) reload.onclick = () => reloadLatest();
}

/**
 * Post-save panel (ITEM-007): name the saved item and offer the next
 * actions — return to the vault, copy the secret, or add another item.
 * The list is refreshed underneath so closing via the backdrop also
 * shows the saved row.
 */
function showSavedPanel(entry, options = {}) {
  const desktop = isDesktopRuntime();
  const pending = options.pending || pendingQueue
    .pendingIds(vault.meta && vault.meta.salt).includes(entry.id);
  $('#tmpl-grid').classList.add('hidden');
  $('#entry-form-foot')?.classList.add('hidden');
  $('#btn-save-entry').classList.add('hidden');
  $('#entry-fields').innerHTML = `
    <div class="saved-panel" role="status" aria-live="polite" aria-atomic="true">
      <span class="tile tile-lg">${icon('check', 20)}</span>
      <div class="saved-title">${t('modal.savedTitle')}</div>
      <div class="saved-body">${t('modal.savedBody', { name: esc(entry.name) })}</div>
      <div class="saved-sync micro" id="saved-sync-line">${pending
    ? t(desktop ? 'modal.savedPendingDesktop' : 'modal.savedPending')
    : t('modal.savedSync', { revision: entry.revision })}</div>
      <div class="saved-actions">
        <button class="btn btn-primary" id="saved-back">${t('modal.savedBack')}</button>
        ${pending ? `<button class="btn" id="saved-sync-now">${icon('refresh', 14)}${t(desktop ? 'modal.syncNowDesktop' : 'modal.syncNow')}</button>` : ''}
        ${entry.secret ? `<button class="btn" id="saved-copy">${icon('copy', 14)}${t('modal.savedCopy')}</button>` : ''}
        <button class="btn" id="saved-add">${icon('plus', 14)}${t('modal.savedAdd')}</button>
      </div>
    </div>`;
  const syncNow = document.getElementById('saved-sync-now');
  if (syncNow) {
    syncNow.onclick = async () => {
      syncNow.disabled = true;
      const result = await recordSync.flushPending();
      if (result.pending > 0) {
        syncNow.disabled = false;
        toast(apiErrorMessage('PM-NETWORK-UNREACHABLE'), 'alert');
        return;
      }
      try {
        vault.entries = await recordSync.fetchAll();
        renderTabs();
        renderTable();
        const fresh = vault.entries.find(item => item.id === entry.id);
        const line = document.getElementById('saved-sync-line');
        if (line && fresh) line.textContent = t('modal.savedSync', { revision: fresh.revision });
        syncNow.remove();
      } catch {
        syncNow.disabled = false;
      }
    };
  }
  $('#saved-back').onclick = async () => {
    closeOverlays();
    state.detailView = null;
    // The deferred post-save refresh (PERF-F-001) lands here: the table
    // the user returns to reflects the saved entry.
    renderTabs();
    renderTable();
    const { closeDrawer } = await import('./drawer.js');
    if ($('#drawer')?.classList.contains('on')) closeDrawer();
  };
  if ($('#saved-copy')) $('#saved-copy').onclick = () => copyWithTimeout(entry.secret);
  $('#saved-add').onclick = () => openEntryModal();
  setTimeout(() => { const back = $('#saved-back'); if (back) back.focus(); }, 50);
}

async function saveEntry() {
  clearSaveStatus();
  const defs = TEMPLATE_FIELDS[state.entryTmpl];
  let savedEntry = null;
  const read = key => {
    const input = document.getElementById(`f-${key}`);
    return input ? input.value.trim() : '';
  };
  const name = read('name');
  // Validation collects every problem up front so all of them are reported
  // at once, inline beside each field, with a summary when there are
  // several — and the typed input is always preserved (ACC-010).
  const errors = [];
  if (!name) errors.push({ key: 'name', message: t('field.errNameRequired') });
  if (SECRET_REQUIRED.includes(state.entryTmpl) && !read('secret')) {
    errors.push({ key: 'secret', message: t('field.errSecretRequired') });
  }
  let totp = { ok: true, value: '' };
  const totpInput = document.getElementById('f-totpSecret');
  if (state.entryTmpl === 'login' && totpInput && totpInput.value.trim()) {
    totp = normalizeTotpSecret(totpInput.value);
    if (!totp.ok) errors.push({ key: 'totpSecret', message: t(totpErrorKey(totp.reason)) });
  }
  if (errors.length) {
    errors.forEach(err => setFieldError(err.key, err.message));
    renderErrorSummary(errors);
    return;
  }
  renderErrorSummary([]);
  const saveButton = $('#btn-save-entry');
  saveButton.disabled = true; // seal + PUT is async; block double submits
  let pendingOffline = false;
  try {
    if (state.editingId) {
      const existing = vault.entries.find(item => item.id === state.editingId);
      const candidate = { ...existing, name, updated: new Date().toISOString() };
      defs.forEach(def => {
        if (def.k === 'name') return;
        candidate[def.k] = def.k === 'totpSecret' ? totp.value
          : def.k === 'tags' ? parseTags(read(def.k)) : read(def.k);
      });
      try {
        await recordSync.saveEntry(candidate, existing.revision);
      } catch (error) {
        // Offline: the sealed write sits in the pending queue; keep the edit
        // in session state and report it as pending, not lost (ITEM-006).
        if (!error.queued) throw error;
        pendingOffline = true;
      }
      Object.assign(existing, candidate);
      state.selectedId = existing.id;
      toast(t('toast.updated', { revision: existing.revision }), 'check');
      savedEntry = existing;
    } else {
      let id = slugify(name);
      let suffix = 2;
      while (vault.entries.some(item => item.id === id)) id = `${slugify(name)}-${suffix++}`;
      const entry = { id, type: state.entryTmpl, name, revision: 1, updated: new Date().toISOString(), favorite: false };
      defs.forEach(def => {
        if (def.k === 'name') return;
        entry[def.k] = def.k === 'totpSecret' ? totp.value
          : def.k === 'tags' ? parseTags(read(def.k)) : read(def.k);
      });
      try {
        await recordSync.saveEntry(entry);
      } catch (error) {
        if (!error.queued) throw error;
        pendingOffline = true;
      }
      vault.entries.push(entry);
      state.selectedId = id;
      toast(t('toast.created'), 'lock');
      // UX-ONB-010: a saved Login (never vault creation) starts first-success.
      if (state.entryTmpl === 'login') firstSuccess.recordLoginSaved();
      savedEntry = entry;
    }
  } catch (error) {
    saveButton.disabled = false;
    return reportSaveFailure(error);
  }
  saveButton.disabled = false;
  state.detailView = null;
  // PERF-F-001: the acknowledgment panel must not wait for a table
  // re-render on large vaults — above the render window the refresh is
  // deferred until the panel closes (saved-back always re-renders), while
  // small vaults keep the immediate refresh. The drawer (edit path) still
  // refreshes so the visible revision matches either way.
  if (vault.entries.length <= 500) {
    renderTabs();
    renderTable();
  }
  if (document.querySelector('#drawer.on')) {
    import('./drawer.js').then(module => module.renderDetail());
  }
  showSavedPanel(savedEntry, { pending: pendingOffline });
}

/* ------------------------------------------------------------------ */
/* Password generator                                                  */
/* ------------------------------------------------------------------ */

const GENERATOR_OPTIONS = Object.freeze([
  Object.freeze(['gen-upper', 'upper']),
  Object.freeze(['gen-lower', 'lower']),
  Object.freeze(['gen-digit', 'digit']),
  Object.freeze(['gen-sym', 'sym']),
  Object.freeze(['gen-amb', 'amb']),
]);

/** Open the generator; `targetKey` names a secret field to fill on use. */
export function openGenerator(targetKey) {
  guardRender('generator', () => openGeneratorInner(targetKey));
}

function openGeneratorInner(targetKey) {
  generatorTarget = targetKey || null;
  $('#gen-use').classList.toggle('hidden', !generatorTarget);
  const range = $('#gen-len');
  range.min = GENERATOR.length.min;
  range.max = GENERATOR.length.max;
  range.value = state.gen.len;
  renderGenerator();
  captureFocusReturn($('#ov-gen'));
  $('#ov-gen').classList.add('on');
  // Bring focus inside the dialog so the Tab trap holds from the first press.
  setTimeout(() => { const slider = $('#gen-len'); if (slider) slider.focus(); }, 50);
}

function renderGenerator() {
  const result = kernel.generatePassword(state.gen);
  if (!result) {
    toast(t('gen.errCharset'), 'alert');
    return;
  }
  $('#gen-pass').textContent = result.value;
  $('#gen-bits').innerHTML = `${entropyBits(state.gen.len, result.poolSize)} <small>${t('gen.bitsUnit')}</small>`;
  const estimate = strength(result.value);
  [...$('#gen-meter').children].forEach((bar, index) => bar.classList.toggle('on', estimate.segments > index));
  $('#gen-strength').textContent = t('gen.poolNote', { count: result.poolSize });
  $('#gen-len-val').textContent = state.gen.len;
}

/**
 * Install document-level delegation for all modal controls. Delegation
 * survives dashboard re-renders (theme, locale) without rebinding.
 */
export function installModalDelegation() {
  document.addEventListener('click', event => {
    if (event.target.closest('#btn-save-entry')) return saveEntry();
    if (event.target.closest('#gen-refresh')) return renderGenerator();
    if (event.target.closest('#gen-copy')) return copyWithTimeout($('#gen-pass').textContent);
    if (event.target.closest('#gen-use')) return useGeneratedPassword();
    const box = event.target.closest('.chk[id^="gen-"]');
    if (box) toggleGeneratorOption(box);
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'gen-len') {
      state.gen.len = Number(event.target.value);
      renderGenerator();
    }
  });
  document.addEventListener('keydown', event => {
    const box = event.target.closest && event.target.closest('.chk[id^="gen-"]');
    if (box && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      toggleGeneratorOption(box);
    }
  });
}

function toggleGeneratorOption(box) {
  const mapping = GENERATOR_OPTIONS.find(([id]) => id === box.id);
  if (!mapping) return;
  const [, option] = mapping;
  state.gen[option] = !state.gen[option];
  box.classList.toggle('on', state.gen[option]);
  box.setAttribute('aria-checked', String(state.gen[option]));
  renderGenerator();
}

function useGeneratedPassword() {
  if (!generatorTarget) return;
  const input = document.getElementById(`f-${generatorTarget}`);
  if (input) {
    input.value = $('#gen-pass').textContent;
    input.dispatchEvent(new Event('input'));
  }
  closeOverlays();
}
