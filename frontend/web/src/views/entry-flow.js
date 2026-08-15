/**
 * Entry flow view — the login surface of a zero-knowledge vault.
 *
 * Four states driven by device metadata and user input:
 *   welcome (first run) → kit (one-time recovery code) → unlock → recover.
 * All copy comes from i18n; this module renders into `#root`.
 */
import { t } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $, esc, toast, copyWithTimeout, downloadText } from '../core/ui.js';
import { vault } from '../core/vault.js';
import { state, resetSession } from '../core/state.js';
import { SECURITY, DEMO, TIMING, STORAGE_KEYS } from '../config.js';
import { kernel } from '../core/kernel.js';
import { recordSync } from '../core/records.js';
import { storage } from '../core/storage.js';
import { strength } from './strength.js';

/** Visual masking glyph — a symbol, not localized text. */
const SECRET_MASK = '••••••••';

const VIEW_IDS = Object.freeze(['lock-welcome', 'lock-kit', 'lock-unlock', 'lock-recover']);

/** Called with the activated button once the vault opens; wired by main.js. */
let onVaultEntered = null;
export function setOnVaultEntered(handler) { onVaultEntered = handler; }

/** Render the full entry surface into the app root. */
export function renderEntryFlow(targetView) {
  const view = targetView || (vault.hasVault() ? 'lock-unlock' : 'lock-welcome');
  $('#root').innerHTML = `
    <div id="view-lock">
      <div class="lock-brand">${t('app.name')}</div>
      <button class="lock-theme" id="lock-theme" title="${t('common.themeToggle')}"></button>
      <div class="lock-card">
        ${welcomeHtml()}
        ${kitHtml()}
        ${unlockHtml()}
        ${recoverHtml()}
      </div>
    </div>`;
  wireEntryFlow();
  wireEntryFlowKeys();
  showView(view);
  applyThemeIcon();
}

function welcomeHtml() {
  return `
    <form id="lock-welcome" autocomplete="off">
      <div class="micro lock-tag">${t('entry.create.step')}</div>
      <h1 class="lock-title lock-title-sm">${t('entry.create.title')}</h1>
      <div class="lock-field">
        <label class="micro" for="new-pw">${t('entry.create.passwordLabel')}</label>
        <div class="pwfield">
          <input class="lock-input" id="new-pw" type="password" autocomplete="new-password"
                 placeholder="${t('entry.create.passwordPh', { min: SECURITY.password.minLength })}">
          <button type="button" class="pw-toggle" data-eye="new-pw" title="${t('common.show')}"></button>
        </div>
        <div class="caps-hint micro">${icon('alert', 12)}${t('entry.capsLock')}</div>
        <div class="meter" id="m-new-pw"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="meter-note" id="mn-new-pw"></div>
      </div>
      <div class="lock-field">
        <label class="micro" for="new-pw2">${t('entry.create.confirmLabel')}</label>
        <div class="pwfield">
          <input class="lock-input" id="new-pw2" type="password" autocomplete="new-password"
                 placeholder="${t('entry.create.confirmPh')}">
          <button type="button" class="pw-toggle" data-eye="new-pw2" title="${t('common.show')}"></button>
        </div>
        <div class="meter-note" id="mn-new-pw2"></div>
      </div>
      <label class="ack" id="ack-row">
        <span class="chk" id="ack-chk" role="checkbox" aria-checked="false" tabindex="0"></span>
        <span>${t('entry.create.ack')}</span>
      </label>
      <div class="lock-error" id="welcome-error"></div>
      <button type="button" class="lock-btn" id="btn-create" data-label="${t('entry.create.btn')}">
        <span class="st-txt">${t('entry.create.btn')}</span><span class="st-ic"></span>
      </button>
    </form>`;
}

function kitHtml() {
  return `
    <div id="lock-kit" class="hidden">
      <div class="micro lock-tag">${t('entry.kit.step')}</div>
      <h1 class="lock-title lock-title-sm">${t('entry.kit.title')}</h1>
      <p class="lock-sub">${t('entry.kit.sub')}</p>
      <div class="rec-code" id="kit-code">${esc(vault.meta ? vault.meta.kit : '')}</div>
      <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
        <button type="button" class="btn" id="kit-copy">${icon('copy', 14)}${t('common.copy')}</button>
        <button type="button" class="btn" id="kit-download">${icon('download', 14)}${t('entry.kit.download')}</button>
        <button type="button" class="btn btn-primary" id="btn-kit-done" data-label="${t('entry.kit.open')}">
          <span class="st-txt">${t('entry.kit.open')}</span><span class="st-ic"></span>
        </button>
      </div>
      <button type="button" class="lock-alt" id="kit-skip">${t('entry.kit.skip')}</button>
    </div>`;
}

function unlockHtml() {
  return `
    <form id="lock-unlock" class="hidden" autocomplete="off">
      <div class="micro lock-tag">${t('entry.unlock.tag')}</div>
      <h1 class="lock-title">${t('entry.unlock.title')}</h1>
      <p class="lock-sub">${t('entry.unlock.sub')}</p>
      <div class="lock-vaultmeta" id="vault-meta"></div>
      <div class="lock-field">
        <label class="micro" for="master-pw">${t('entry.unlock.passwordLabel')}</label>
        <div class="pwfield">
          <input class="lock-input" id="master-pw" type="password" autocomplete="current-password"
                 placeholder="${SECRET_MASK}">
          <button type="button" class="pw-toggle" data-eye="master-pw" title="${t('common.show')}"></button>
        </div>
        <div class="caps-hint micro">${icon('alert', 12)}${t('entry.capsLock')}</div>
      </div>
      <div class="lock-error" id="unlock-error"></div>
      <button type="button" class="lock-btn" id="btn-unlock" data-label="${t('entry.unlock.btn')}">
        <span class="st-txt">${t('entry.unlock.btn')}</span><span class="st-ic"></span>
      </button>
      <button type="button" class="lock-alt" id="goto-recover">${t('entry.unlock.recoverLink')}</button>
    </form>`;
}

function recoverHtml() {
  return `
    <form id="lock-recover" class="hidden" autocomplete="off">
      <div class="micro lock-tag">${t('entry.recover.tag')}</div>
      <h1 class="lock-title">${t('entry.recover.title')}</h1>
      <p class="lock-sub">${t('entry.recover.sub')}</p>
      <div class="lock-field">
        <label class="micro" for="recover-kit">${t('entry.recover.kitLabel')}</label>
        <textarea class="field-textarea mono" id="recover-kit" placeholder="${t('entry.recover.kitPh')}"></textarea>
      </div>
      <div class="lock-field">
        <label class="micro" for="recover-pw">${t('entry.recover.newPwLabel')}</label>
        <div class="pwfield">
          <input class="lock-input" id="recover-pw" type="password" autocomplete="new-password"
                 placeholder="${t('entry.create.passwordPh', { min: SECURITY.password.minLength })}">
          <button type="button" class="pw-toggle" data-eye="recover-pw" title="${t('common.show')}"></button>
        </div>
        <div class="caps-hint micro">${icon('alert', 12)}${t('entry.capsLock')}</div>
      </div>
      <div class="lock-field">
        <label class="micro" for="recover-pw2">${t('entry.create.confirmLabel')}</label>
        <div class="pwfield">
          <input class="lock-input" id="recover-pw2" type="password" autocomplete="new-password"
                 placeholder="${t('entry.create.confirmPh')}">
        </div>
        <div class="meter-note" id="mn-recover-pw2"></div>
      </div>
      <div class="lock-error" id="recover-error"></div>
      <button type="button" class="lock-btn" id="btn-recover" data-label="${t('entry.recover.btn')}">
        <span class="st-txt">${t('entry.recover.btn')}</span><span class="st-ic"></span>
      </button>
      <button type="button" class="lock-alt" id="back-unlock">${t('entry.recover.back')}</button>
    </form>`;
}

/* ------------------------------------------------------------------ */

function showView(id) {
  VIEW_IDS.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.classList.toggle('hidden', v !== id);
  });
  if (id === 'lock-unlock') {
    renderVaultMeta();
    setTimeout(() => { const input = $('#master-pw'); if (input) input.focus(); }, 60);
  }
  if (id === 'lock-welcome') {
    setTimeout(() => { const input = $('#new-pw'); if (input) input.focus(); }, 60);
  }
}

async function renderVaultMeta() {
  const host = $('#vault-meta');
  if (!host || !vault.hasVault()) return;
  const meta = vault.meta;
  const dot = '<span style="width:6px;height:6px;border-radius:50%;background:var(--ink)"></span>';
  const render = (count) => {
    host.innerHTML = `${dot}${t('entry.unlock.vaultMeta', {
      vault: meta.vaultId.toUpperCase(),
      count,
      device: t('entry.unlock.saltNote'),
    })}`;
  };
  render(vault.entries.length);
  // Refresh the count from the server (public metadata, no decryption).
  try {
    render(await recordSync.countRecords());
  } catch {
    // API unreachable: keep the local estimate.
  }
}

function applyThemeIcon() {
  const button = $('#lock-theme');
  if (button) button.innerHTML = icon(state.settings.theme === 'dark' ? 'sun' : 'moon', 16);
}

/* ------------------------------------------------------------------ */

function lockError(id, message) {
  const el = document.getElementById(id);
  el.innerHTML = `${icon('alert', 13)}<span>${esc(message)}</span>`;
  el.classList.remove('on');
  void el.offsetWidth; // restart the shake animation
  el.classList.add('on');
}

function clearError(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('on');
}

/** Enter the dashboard after unlocking state is prepared. */
function enterVaultNow() {
  resetSession();
  state.unlocked = true;
  if (onVaultEntered) onVaultEntered();
}

/** Staged hand-off for flows without live decryption work (kit, recover). */
async function enterVault(button) {
  const label = button.querySelector('.st-txt');
  const iconHost = button.querySelector('.st-ic');
  button.disabled = true;
  label.textContent = t('entry.stage.decrypting');
  iconHost.innerHTML = '<span class="spinner"></span>';
  await new Promise(resolve => setTimeout(resolve, TIMING.decryptStageMs));
  button.disabled = false;
  label.textContent = button.dataset.label;
  iconHost.innerHTML = '';
  enterVaultNow();
}

/** Run real kernel work behind the staged button animation. */
async function stageButtonWork(button, work) {
  const label = button.querySelector('.st-txt');
  const iconHost = button.querySelector('.st-ic');
  button.disabled = true;
  label.textContent = t('entry.stage.deriving');
  iconHost.innerHTML = '<span class="spinner"></span>';
  try {
    await work(label);
  } finally {
    button.disabled = false;
    label.textContent = button.dataset.label;
    iconHost.innerHTML = '';
  }
}

/* ------------------------------------------------------------------ */

function wireEntryFlow() {
  $('#lock-theme').addEventListener('click', () => {
    const next = state.settings.theme === 'dark' ? 'light' : 'dark';
    state.settings.theme = next;
    storage.set(STORAGE_KEYS.theme, next);
    document.documentElement.dataset.theme = next;
    applyThemeIcon();
  });

  document.querySelectorAll('.pw-toggle').forEach(button => {
    const input = document.getElementById(button.dataset.eye);
    button.innerHTML = icon('eye', 14);
    button.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.innerHTML = icon(show ? 'eyeOff' : 'eye', 14);
      button.title = show ? t('common.hide') : t('common.show');
    });
  });

  ['new-pw', 'master-pw', 'recover-pw'].forEach(id => {
    const input = document.getElementById(id);
    const hint = input.closest('.lock-field').querySelector('.caps-hint');
    const onKey = (event) => {
      if (event.getModifierState) hint.classList.toggle('on', event.getModifierState('CapsLock'));
    };
    input.addEventListener('keydown', onKey);
    input.addEventListener('keyup', onKey);
  });

  wireWelcome();
  wireKit();
  wireUnlock();
  wireRecover();
}

function wireWelcome() {
  $('#new-pw').addEventListener('input', () => {
    const result = strength($('#new-pw').value);
    [...$('#m-new-pw').children].forEach((bar, index) => bar.classList.toggle('on', result.segments > index));
    $('#mn-new-pw').textContent = $('#new-pw').value
      ? t('strength.readout', { bits: result.bits, label: t(result.labelKey) })
      : '';
  });
  $('#new-pw2').addEventListener('input', () => {
    $('#mn-new-pw2').textContent = confirmNote('#new-pw', '#new-pw2');
  });
  $('#ack-row').addEventListener('click', () => {
    const box = $('#ack-chk');
    box.classList.toggle('on');
    box.setAttribute('aria-checked', String(box.classList.contains('on')));
  });
  $('#ack-chk').addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      $('#ack-row').click();
    }
  });
  $('#btn-create').addEventListener('click', async () => {
    const password = $('#new-pw').value;
    const confirm = $('#new-pw2').value;
    if (password.length < SECURITY.password.minLength) {
      return lockError('welcome-error', t('entry.create.errLength', { min: SECURITY.password.minLength }));
    }
    if (password !== confirm) return lockError('welcome-error', t('entry.create.errMismatch'));
    if (!$('#ack-chk').classList.contains('on')) {
      return lockError('welcome-error', t('entry.create.errAck'));
    }
    clearError('welcome-error');
    vault.create();
    // Derive the session root key now so the vault opens ready to write.
    await stageButtonWork($('#btn-create'), async (label) => {
      recordSync.rootKey = await kernel.deriveRootKey(password, vault.meta.salt);
      label.textContent = t('entry.stage.decrypting');
      await new Promise(resolve => setTimeout(resolve, TIMING.decryptStageMs));
    }).catch(() => {});
    $('#kit-code').textContent = vault.meta.kit;
    showView('lock-kit');
  });
}

function wireKit() {
  $('#kit-copy').addEventListener('click', () => copyWithTimeout(vault.meta.kit));
  $('#kit-download').addEventListener('click', () =>
    downloadText('veyora-recovery-kit.txt',
      `${t('entry.kit.fileHead')}\n\n${vault.meta.kit}\n\n${t('entry.kit.fileTail')}\n`));
  $('#btn-kit-done').addEventListener('click', () => enterVault($('#btn-kit-done')));
  $('#kit-skip').addEventListener('click', () => {
    toast(t('toast.kitSkip'), 'shield');
    enterVault($('#btn-kit-done'));
  });
}

function wireUnlock() {
  $('#btn-unlock').addEventListener('click', async () => {
    const password = $('#master-pw').value;
    if (!password) return lockError('unlock-error', t('entry.unlock.errEmpty'));
    // Demo kernel cannot verify keys, so a probe password demonstrates the
    // failure state; the WASM kernel fails for real on wrong passwords.
    if (state.kernelMode === 'demo' && DEMO.enabled
        && password.toLowerCase() === DEMO.wrongPasswordProbe) {
      return lockError('unlock-error', t('entry.unlock.errWrong'));
    }
    clearError('unlock-error');
    let opened = false;
    let failure = null;
    await stageButtonWork($('#btn-unlock'), async (label) => {
      recordSync.rootKey = await kernel.deriveRootKey(password, vault.meta ? vault.meta.salt : '');
      label.textContent = t('entry.stage.decrypting');
      vault.entries = await recordSync.fetchAll();
      opened = true;
    }).catch((error) => {
      failure = error;
    });
    if (opened) return enterVaultNow();
    // Distinguish connectivity problems from a wrong master password so the
    // message never misleads; reselect the field for a quick retry.
    $('#master-pw').select();
    const unreachable = failure
      && (failure.code === 'PM-NETWORK-UNREACHABLE' || (failure.status || 0) >= 500);
    return lockError('unlock-error',
      unreachable ? t('toast.syncFailed') : t('entry.unlock.errWrong'));
  });
  $('#goto-recover').addEventListener('click', () => showView('lock-recover'));
}

function wireRecover() {
  $('#recover-pw2').addEventListener('input', () => {
    $('#mn-recover-pw2').textContent = confirmNote('#recover-pw', '#recover-pw2');
  });
  $('#btn-recover').addEventListener('click', async () => {
    const kit = $('#recover-kit').value.trim();
    const password = $('#recover-pw').value;
    const confirm = $('#recover-pw2').value;
    if (!kit) return lockError('recover-error', t('entry.recover.errKit'));
    if (state.kernelMode !== 'demo' && !kernel.validateRecoveryKit(kit)) {
      return lockError('recover-error', t('entry.recover.errKitInvalid'));
    }
    if (password.length < SECURITY.password.minLength) {
      return lockError('recover-error', t('entry.create.errLength', { min: SECURITY.password.minLength }));
    }
    if (password !== confirm) return lockError('recover-error', t('entry.create.errMismatch'));
    clearError('recover-error');
    if (!vault.hasVault()) vault.create();
    await stageButtonWork($('#btn-recover'), async (label) => {
      recordSync.rootKey = await kernel.deriveRootKey(password, vault.meta.salt);
      label.textContent = t('entry.stage.decrypting');
      await new Promise(resolve => setTimeout(resolve, TIMING.decryptStageMs));
    }).catch(() => {});
    enterVaultNow();
  });
  $('#back-unlock').addEventListener('click', () => renderEntryFlow('lock-unlock'));
}

function confirmNote(primarySelector, confirmSelector) {
  const primary = $(primarySelector).value;
  const confirm = $(confirmSelector).value;
  if (!confirm) return '';
  return primary === confirm ? t('common.passwordsMatch') : t('common.passwordsMismatch');
}

/** Enter-key navigation across the entry forms. */
export function wireEntryFlowKeys() {
  const advance = [
    ['new-pw', () => $('#new-pw2').focus()],
    ['new-pw2', () => $('#btn-create').click()],
    ['master-pw', () => $('#btn-unlock').click()],
    ['recover-pw', () => $('#recover-pw2').focus()],
    ['recover-pw2', () => $('#btn-recover').click()],
  ];
  advance.forEach(([id, action]) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); action(); }
    });
  });
  ['lock-welcome', 'lock-unlock', 'lock-recover'].forEach(id => {
    const form = document.getElementById(id);
    if (form) form.addEventListener('submit', event => event.preventDefault());
  });
}
