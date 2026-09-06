/**
 * Entry flow view — the login surface of a zero-knowledge vault.
 *
 * Two states driven by device metadata and user input: create and unlock.
 * Recovery remains unavailable until it can unwrap the existing Vault Key.
 * All copy comes from i18n; this module renders into `#root`.
 */
import { t, apiErrorMessage } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $, esc, guardRender } from '../core/ui.js';
import { vault } from '../core/vault.js';
import { state, resetSession } from '../core/state.js';
import { SECURITY, TIMING, STORAGE_KEYS } from '../config.js';
import { kernel } from '../core/kernel.js';
import { recordSync } from '../core/records.js';
import { storage } from '../core/storage.js';
import { strength } from './strength.js';
import { isCommonPassword } from '../data/blocklist.js';
import { vaultIdentity } from '../data/diagnostics.js';

/** Visual masking glyph — a symbol, not localized text. */
const SECRET_MASK = '••••••••';

const VIEW_IDS = Object.freeze(['lock-routes', 'lock-welcome', 'lock-unlock']);

/**
 * Which Welcome route the user came through; import routes the freshly
 * created vault straight to the Settings import section (UX-ONB-002).
 */
let welcomeRoute = 'create';

/** Called with the activated button once the vault opens; wired by main.js. */
let onVaultEntered = null;
export function setOnVaultEntered(handler) { onVaultEntered = handler; }

/** Render the full entry surface into the app root. */
export function renderEntryFlow(targetView) {
  guardRender('entry-flow', () => renderEntryFlowInner(targetView));
}

function renderEntryFlowInner(targetView) {
  const view = targetView || (vault.hasVault() ? 'lock-unlock' : 'lock-routes');
  $('#root').innerHTML = `
    <div id="view-lock">
      <div class="lock-brand"><span class="brand-mark" aria-hidden="true"></span><span>${t('app.name')}</span></div>
      <div class="lock-corner">
        <button class="lock-theme" id="lock-help">${t('help.title')}</button>
        <button class="lock-theme" id="lock-theme" title="${t('common.themeToggle')}"
                aria-label="${t('common.themeToggle')}"></button>
      </div>
      <div class="lock-card">
        ${routesHtml()}
        ${welcomeHtml()}
        ${unlockHtml()}
      </div>
    </div>`;
  wireEntryFlow();
  wireEntryFlowKeys();
  showView(view);
  applyThemeIcon();
}

/** UX-ONB-002: the four Welcome routes before any password is requested. */
function routesHtml() {
  const route = (id, titleKey, subKey) => `
    <button type="button" class="route-item" id="${id}">
      <span class="route-t">${t(titleKey)}</span>
      <span class="route-s">${t(subKey)}</span>
    </button>`;
  return `
    <div id="lock-routes">
      <div class="micro lock-tag">${t('entry.routes.step')}</div>
      <h1 class="lock-title lock-title-sm">${t('entry.routes.title')}</h1>
      <div class="welcome-intro"><p>${t('entry.routes.sub')}</p></div>
      <div class="route-list">
        ${route('wf-create', 'entry.routes.create', 'entry.routes.createSub')}
        ${route('wf-open', 'entry.routes.open', 'entry.routes.openSub')}
        ${route('wf-import', 'entry.routes.import', 'entry.routes.importSub')}
        ${route('wf-connect', 'entry.routes.connect', 'entry.routes.connectSub')}
      </div>
      <div class="route-note hidden" id="wf-open-note" role="note">
        ${icon('alert', 13)}<span>${t('entry.routes.openNote')}</span>
      </div>
      <button type="button" class="btn btn-link" id="btn-recover-routes"
              style="margin-top:var(--space-3)">${t('entry.recover.link')}</button>
      <button type="button" class="btn-link hidden" id="wf-back">${t('entry.routes.back')}</button>
    </div>`;
}

function welcomeHtml() {
  return `
    <form id="lock-welcome" autocomplete="off">
      <div class="micro lock-tag">${t('entry.create.step')}</div>
      <h1 class="lock-title lock-title-sm">${t('entry.create.title')}</h1>
      <div class="welcome-intro">
        <p>${t('entry.welcome.what')}</p>
        <p>${t('entry.welcome.vault')}</p>
        <p>${t('entry.welcome.mode')}</p>
      </div>
      <div class="route-note hidden" id="route-import-note" role="note">
        ${icon('alert', 13)}<span>${t('entry.routes.importNote')}</span>
      </div>
      <div class="lock-field">
        <label class="micro" for="new-pw">${t('entry.create.passwordLabel')}</label>
        <div class="pwfield">
          <input class="lock-input" id="new-pw" type="password" autocomplete="new-password"
                 aria-describedby="welcome-error"
                 placeholder="${t('entry.create.passwordPh', { min: SECURITY.password.minLength })}">
          <button type="button" class="pw-toggle" data-eye="new-pw" title="${t('common.show')}"
                  aria-label="${t('common.show')}"></button>
        </div>
        <div class="caps-hint micro">${icon('alert', 12)}${t('entry.capsLock')}</div>
        <div class="meter" id="m-new-pw"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="meter-note" id="mn-new-pw"></div>
      </div>
      <div class="lock-field">
        <label class="micro" for="new-pw2">${t('entry.create.confirmLabel')}</label>
        <div class="pwfield">
          <input class="lock-input" id="new-pw2" type="password" autocomplete="new-password"
                 aria-describedby="welcome-error"
                 placeholder="${t('entry.create.confirmPh')}">
          <button type="button" class="pw-toggle" data-eye="new-pw2" title="${t('common.show')}"
                  aria-label="${t('common.show')}"></button>
        </div>
        <div class="meter-note" id="mn-new-pw2"></div>
      </div>
      <div class="create-explain">
        <div class="micro">${t('entry.create.beforeTitle')}</div>
        <ul>
          <li>${t('entry.create.explainStorage')}</li>
          <li>${t('entry.create.explainPassword', { min: SECURITY.password.minLength })}</li>
          <li>${t('entry.create.explainScreening')}</li>
          <li>${t('entry.create.explainRecovery')}</li>
          <li>${t('entry.create.explainBackup')}</li>
        </ul>
      </div>
      <div class="lock-error" id="welcome-error" role="alert" aria-live="assertive" aria-atomic="true"></div>
      <button type="button" class="lock-btn" id="btn-create" data-label="${t('entry.create.btn')}">
        <span class="st-txt">${t('entry.create.btn')}</span><span class="st-ic"></span>
      </button>
      <button type="button" class="btn-link hidden" id="wf-create-back">${t('entry.routes.back')}</button>
    </form>`;
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
                 aria-describedby="unlock-error"
                 placeholder="${SECRET_MASK}">
          <button type="button" class="pw-toggle" data-eye="master-pw" title="${t('common.show')}"
                  aria-label="${t('common.show')}"></button>
        </div>
        <div class="caps-hint micro">${icon('alert', 12)}${t('entry.capsLock')}</div>
      </div>
      <div class="lock-error" id="unlock-error" role="alert" aria-live="assertive" aria-atomic="true"></div>
      <button type="button" class="lock-btn" id="btn-unlock" data-label="${t('entry.unlock.btn')}">
        <span class="st-txt">${t('entry.unlock.btn')}</span><span class="st-ic"></span>
      </button>
      <button type="button" class="btn btn-link" id="btn-recover"
              style="margin-top:var(--space-3)">${t('entry.recover.link')}</button>
    </form>
    <form id="lock-recover" class="hidden" autocomplete="off">
      <div class="micro lock-tag">${t('entry.recover.tag')}</div>
      <h1 class="lock-title">${t('entry.recover.title')}</h1>
      <p class="lock-sub">${t('entry.recover.sub')}</p>
      <label class="micro" for="recover-kit">${t('entry.recover.kitLabel')}</label>
      <textarea class="lock-input" id="recover-kit" rows="3" spellcheck="false"
                autocomplete="off" aria-describedby="recover-error"
                placeholder="${t('entry.recover.kitPlaceholder')}"></textarea>
      <label class="micro" for="recover-new">${t('entry.recover.newLabel')}</label>
      <div class="pwfield">
        <input class="lock-input" id="recover-new" type="password" autocomplete="new-password"
               aria-describedby="recover-error">
      </div>
      <label class="micro" for="recover-new2">${t('entry.recover.confirmLabel')}</label>
      <div class="pwfield">
        <input class="lock-input" id="recover-new2" type="password" autocomplete="new-password"
               aria-describedby="recover-error">
      </div>
      <div class="lock-error" id="recover-error" role="alert" aria-live="assertive" aria-atomic="true"></div>
      <button type="button" class="lock-btn" id="btn-recover-go" data-label="${t('entry.recover.btn')}">
        <span class="st-txt">${t('entry.recover.btn')}</span><span class="st-ic"></span>
      </button>
      <button type="button" class="btn btn-link" id="btn-recover-back"
              style="margin-top:var(--space-3)">${t('common.cancel')}</button>
    </form>`;
}

/* ------------------------------------------------------------------ */

function showView(id) {
  VIEW_IDS.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.classList.toggle('hidden', v !== id);
  });
  if (id === 'lock-routes') {
    $('#wf-open-note').classList.add('hidden');
    $('#wf-back').classList.add('hidden');
    setTimeout(() => { const button = $('#wf-create'); if (button) button.focus(); }, 60);
  }
  if (id === 'lock-welcome') {
    // The route context decides which create-form decorations are honest:
    // the import note only on the import route, and a way back only while
    // no vault exists on this device.
    $('#route-import-note').classList.toggle('hidden', welcomeRoute !== 'import');
    $('#wf-create-back').classList.toggle('hidden', vault.hasVault());
    setTimeout(() => { const input = $('#new-pw'); if (input) input.focus(); }, 60);
  }
  if (id === 'lock-unlock') {
    renderVaultMeta();
    setTimeout(() => { const input = $('#master-pw'); if (input) input.focus(); }, 60);
  }
}

async function renderVaultMeta() {
  const host = $('#vault-meta');
  if (!host || !vault.hasVault()) return;
  const dot = '<span style="width:6px;height:6px;border-radius:50%;background:var(--ink)"></span>';
  // PRD 6.3: a human-readable vault name plus a safe location summary —
  // the local device on the desktop runtime, otherwise the service host
  // alone. The raw vault id stays out of the primary identity line.
  const identity = vaultIdentity();
  const location = identity.kind === 'desktop'
    ? t('vault.locationThisDevice')
    : identity.kind === 'connected'
      ? t('vault.locationService', { host: identity.host })
      : t('vault.locationUnknown');
  const vaultLabel = `${t('vault.nameDefault')} · ${location}`;
  const render = (count) => {
    host.innerHTML = `${dot}${t('entry.unlock.vaultMeta', {
      vault: vaultLabel,
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

function lockError(id, message, fieldIds = []) {
  const el = document.getElementById(id);
  el.innerHTML = `${icon('alert', 13)}<span>${esc(message)}</span>`;
  el.classList.remove('on');
  void el.offsetWidth; // restart the shake animation
  el.classList.add('on');
  fieldIds.forEach(fieldId => document.getElementById(fieldId)?.setAttribute('aria-invalid', 'true'));
}

function clearError(id, fieldIds = []) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('on');
  fieldIds.forEach(fieldId => document.getElementById(fieldId)?.removeAttribute('aria-invalid'));
}

/** Enter the dashboard after unlocking state is prepared. */
function enterVaultNow() {
  resetSession();
  state.unlocked = true;
  if (onVaultEntered) onVaultEntered();
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
  $('#lock-help').addEventListener('click', () => {
    import('./help.js').then(module => module.openHelp());
  });
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
      button.setAttribute('aria-label', button.title);
    });
  });

  ['new-pw', 'master-pw'].forEach(id => {
    const input = document.getElementById(id);
    const hint = input.closest('.lock-field').querySelector('.caps-hint');
    const onKey = (event) => {
      if (event.getModifierState) hint.classList.toggle('on', event.getModifierState('CapsLock'));
    };
    input.addEventListener('keydown', onKey);
    input.addEventListener('keyup', onKey);
  });

  wireWelcomeRoutes();
  wireWelcome();
  wireUnlock();
  wireRecovery();
}

function wireWelcomeRoutes() {
  $('#wf-create').addEventListener('click', () => {
    welcomeRoute = 'create';
    showView('lock-welcome');
  });
  $('#wf-open').addEventListener('click', () => {
    if (vault.hasVault()) return showView('lock-unlock');
    // No device metadata: say so honestly instead of implying a browse.
    $('#wf-open-note').classList.remove('hidden');
    $('#wf-back').classList.remove('hidden');
    $('#wf-back').focus();
  });
  $('#wf-import').addEventListener('click', () => {
    if (vault.hasVault()) return showView('lock-unlock');
    welcomeRoute = 'import';
    showView('lock-welcome');
  });
  $('#wf-connect').addEventListener('click', () => {
    import('./connect.js').then(module => module.renderConnect());
  });
  $('#wf-back').addEventListener('click', () => showView('lock-routes'));
  $('#wf-create-back').addEventListener('click', () => showView('lock-routes'));
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
  $('#btn-create').addEventListener('click', async () => {
    const password = $('#new-pw').value;
    const confirm = $('#new-pw2').value;
    if (password.length < SECURITY.password.minLength) {
      return lockError('welcome-error', t('entry.create.errLength', { min: SECURITY.password.minLength }), ['new-pw']);
    }
    // UX-ONB-006: local-only screening against common breached passwords.
    if (isCommonPassword(password)) {
      return lockError('welcome-error', t('entry.create.errCommon'), ['new-pw']);
    }
    if (password !== confirm) {
      return lockError('welcome-error', t('entry.create.errMismatch'), ['new-pw', 'new-pw2']);
    }
    clearError('welcome-error', ['new-pw', 'new-pw2']);
    vault.create();
    const presentKit = () => import('./backup.js')
      .then(module => module.openKitCeremony())
      .catch(() => {/* the dashboard overlay host appears with the app */});
    // Derive the session root key now so the vault opens ready to write;
    // the verifier record makes even an empty vault password-checked.
    try {
      await stageButtonWork($('#btn-create'), async (label) => {
        await recordSync.initializeVault(password);
        label.textContent = t('entry.stage.decrypting');
        await new Promise(resolve => setTimeout(resolve, TIMING.decryptStageMs));
      });
    } catch {
      recordSync.lock();
      // Keep the just-created local identity. The verifier PUT may have
      // reached the service even if its response was lost; deleting metadata
      // here would orphan that remote ciphertext and make a retry ambiguous.
      renderEntryFlow('lock-unlock');
      return lockError('unlock-error', t('toast.syncFailed'), ['master-pw']);
    }
    enterVaultNow();
    // UX-ONB-007: vault creation presents the Recovery Key for saving and
    // verification right after the vault opens.
    setTimeout(presentKit, TIMING.decryptStageMs);
    // The import route lands in Settings → Data so the CSV import is the
    // immediate next action (UX-ONB-002 route-level behavior).
    if (welcomeRoute === 'import') {
      welcomeRoute = 'create';
      import('./drawer.js').then(module => module.openDrawer('settings'));
    }
  });
}

/** Recovery Key route on the unlock screen (REC-001..005). */
function wireRecovery() {
  const show = panel => {
    $('#lock-unlock').classList.toggle('hidden', panel !== 'unlock');
    $('#lock-recover').classList.toggle('hidden', panel !== 'recover');
    const error = $('#recover-error');
    error.textContent = '';
    error.classList.remove('on');
  };
  const openPanel = () => {
    ['recover-kit', 'recover-new', 'recover-new2'].forEach(id => ($(`#${id}`).value = ''));
    $('#lock-routes').classList.add('hidden');
    $('#lock-unlock').classList.add('hidden');
    $('#lock-recover').classList.remove('hidden');
    $('#recover-kit').focus();
  };
  $('#btn-recover').onclick = openPanel;
  const routesLink = $('#btn-recover-routes');
  if (routesLink) routesLink.onclick = openPanel;
  $('#btn-recover-back').onclick = () => {
    // Return to whichever surface the device actually has.
    $('#lock-recover').classList.add('hidden');
    ($(document.getElementById('lock-unlock')) && vault.hasVault()
      ? $('#lock-unlock') : $('#lock-routes')).classList.remove('hidden');
    ($('#master-pw') || {}).focus?.();
  };
  $('#btn-recover-go').onclick = async () => {
    const error = $('#recover-error');
    const fail = (message, key = '') => {
      error.textContent = message;
      error.dataset.errorKey = key;
      error.classList.add('on');
    };
    error.textContent = '';
    error.classList.remove('on');
    const kit = $('#recover-kit').value.trim();
    const next = $('#recover-new').value;
    const confirm = $('#recover-new2').value;
    if (!kernel.validateRecoveryKit(kit)) {
      return fail(t('entry.recover.errKit'), 'entry.recover.errKit');
    }
    if (next.length < SECURITY.password.minLength) {
      return fail(t('entry.create.errLength', { min: SECURITY.password.minLength }));
    }
    if (next !== confirm) return fail(t('entry.create.errMismatch'));
    let opened = false;
    let failure = null;
    await stageButtonWork($('#btn-recover-go'), async () => {
      await recordSync.recoverVault(kit, next);
      opened = true;
    }).catch(error_ => { failure = error_; });
    if (opened) return enterVaultNow();
    $('#recover-kit').select();
    const text = String((failure && failure.message) || failure || '');
    const kitWrong = /PM-KERNEL-|PM-STORE-NOT-FOUND/.test(text);
    const unreachable = failure && failure.code === 'PM-NETWORK-UNREACHABLE';
    fail(kitWrong ? t('entry.recover.errKit')
      : unreachable ? apiErrorMessage('PM-NETWORK-UNREACHABLE')
        : t('entry.recover.errFailed'),
      kitWrong ? 'entry.recover.errKit'
        : unreachable ? 'PM-NETWORK-UNREACHABLE' : 'entry.recover.errFailed');
  };
}

function wireUnlock() {
  $('#btn-unlock').addEventListener('click', async () => {
    const password = $('#master-pw').value;
    if (!password) return lockError('unlock-error', t('entry.unlock.errEmpty'), ['master-pw']);
    clearError('unlock-error', ['master-pw']);
    let opened = false;
    let failure = null;
    await stageButtonWork($('#btn-unlock'), async (label) => {
      // An interrupted password change resolves here: adopt the committed
      // target scope or fall back to the old salt before deriving.
      const salt = await recordSync.resolvePendingRekey(password)
        || (vault.meta ? vault.meta.salt : '');
      await recordSync.unlockViaWrappers(password, salt);
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
      unreachable ? apiErrorMessage('PM-NETWORK-UNREACHABLE')
        : t('entry.unlock.errWrong'), ['master-pw']);
  });
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
  ];
  advance.forEach(([id, action]) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); action(); }
    });
  });
  ['lock-welcome', 'lock-unlock'].forEach(id => {
    const form = document.getElementById(id);
    if (form) form.addEventListener('submit', event => event.preventDefault());
  });
}
