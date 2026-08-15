/**
 * Modal views — the entry create/edit form and the password generator.
 * Both mount into overlay containers rendered by dashboard.js.
 */
import { t } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $, esc, toast, copyWithTimeout } from '../core/ui.js';
import { state } from '../core/state.js';
import { vault } from '../core/vault.js';
import { kernel, entropyBits } from '../core/kernel.js';
import { TYPES, TEMPLATE_FIELDS, SECRET_REQUIRED, slugify } from '../data/schema.js';
import { GENERATOR } from '../config.js';
import { strength } from './strength.js';
import { renderTabs, renderTable, closeOverlays } from './dashboard.js';

/** Target field for "use this password", or null when opened standalone. */
let generatorTarget = null;

/* ------------------------------------------------------------------ */
/* Entry create / edit                                                 */
/* ------------------------------------------------------------------ */

/** Open the entry modal; pass an id to edit an existing record. */
export function openEntryModal(editId) {
  state.editingId = editId || null;
  const entry = editId ? vault.entries.find(item => item.id === editId) : null;
  state.entryTmpl = entry ? entry.type : 'login';
  $('#entry-modal-title').textContent = entry ? t('modal.editTitle') : t('modal.newTitle');
  $('#btn-save-entry').textContent = entry ? t('modal.save') : t('modal.create');
  renderTemplateGrid();
  renderEntryFields(entry);
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

function renderEntryFields(entry) {
  const defs = TEMPLATE_FIELDS[state.entryTmpl];
  $('#entry-fields').innerHTML = defs.map(def => {
    const value = entry ? (entry[def.k] || '') : '';
    const spanClass = def.span ? ' span2' : '';
    if (def.textarea) {
      return `<div class="fld${spanClass}"><label class="micro">${t(def.labelKey)}</label>
        <textarea class="field-textarea${def.mono ? ' mono' : ''}" id="f-${def.k}"
                  placeholder="${def.phKey ? t(def.phKey) : ''}">${esc(value)}</textarea></div>`;
    }
    if (def.secret) {
      return `<div class="fld${spanClass}"><label class="micro">${t(def.labelKey)}</label>
        <div class="pw-wrap">
          <input class="field-input" id="f-${def.k}" type="text" value="${esc(value)}"
                 placeholder="${t('ph.generate')}" autocomplete="off">
          ${def.gen ? `<button class="pw-gen" id="fgen-${def.k}" type="button">${icon('refresh', 12)}${t('modal.generate')}</button>` : ''}
        </div>
        <div class="meter" id="m-${def.k}"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="meter-note" id="mn-${def.k}"></div></div>`;
    }
    return `<div class="fld${spanClass}"><label class="micro">${t(def.labelKey)}</label>
      <input class="field-input" id="f-${def.k}" type="text" value="${esc(value)}"
             placeholder="${def.phKey ? t(def.phKey) : ''}" autocomplete="off"></div>`;
  }).join('');
  defs.filter(def => def.secret).forEach(def => {
    const input = document.getElementById(`f-${def.k}`);
    input.addEventListener('input', () => updateMeter(def.k, input.value));
    const generate = document.getElementById(`fgen-${def.k}`);
    if (generate) generate.addEventListener('click', () => openGenerator(def.k));
    updateMeter(def.k, input.value);
  });
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

function saveEntry() {
  const defs = TEMPLATE_FIELDS[state.entryTmpl];
  const read = key => {
    const input = document.getElementById(`f-${key}`);
    return input ? input.value.trim() : '';
  };
  const name = read('name');
  if (!name) return toast(t('modal.nameRequired'), 'alert');
  if (SECRET_REQUIRED.includes(state.entryTmpl) && !read('secret')) {
    return toast(t('modal.secretRequired'), 'alert');
  }
  if (state.editingId) {
    const entry = vault.entries.find(item => item.id === state.editingId);
    defs.forEach(def => { if (def.k !== 'name') entry[def.k] = read(def.k); });
    entry.name = name;
    entry.revision += 1;
    entry.updated = new Date().toISOString();
    state.selectedId = entry.id;
    toast(t('toast.updated', { revision: entry.revision }), 'check');
  } else {
    let id = slugify(name);
    let suffix = 2;
    while (vault.entries.some(item => item.id === id)) id = `${slugify(name)}-${suffix++}`;
    const entry = { id, type: state.entryTmpl, name, revision: 1, updated: new Date().toISOString(), favorite: false };
    defs.forEach(def => { if (def.k !== 'name') entry[def.k] = read(def.k); });
    vault.entries.push(entry);
    state.selectedId = id;
    toast(t('toast.created'), 'lock');
  }
  state.detailView = null;
  closeOverlays();
  renderTabs();
  renderTable();
  import('./drawer.js').then(module => module.openDrawer());
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
  generatorTarget = targetKey || null;
  $('#gen-use').classList.toggle('hidden', !generatorTarget);
  const range = $('#gen-len');
  range.min = GENERATOR.length.min;
  range.max = GENERATOR.length.max;
  range.value = state.gen.len;
  renderGenerator();
  $('#ov-gen').classList.add('on');
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
