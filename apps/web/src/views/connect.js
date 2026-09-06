/**
 * Connect / Sign-in gate — UX-ONB-003.
 *
 * The web client is connected-only: it MUST NOT create or unlock a vault
 * before a service session exists. The gate is decided by the service
 * itself — an unauthenticated probe of the records endpoint that answers
 * 401 means the deployment requires a session, and until a connection
 * credential is stored this view is the only thing the user sees.
 *
 * The credential model is deliberately honest: the scoped, rotatable
 * pairing of connected mode (sequence 8) does not exist yet, so this form
 * signs in with the deployment token the operator issued. Nothing about
 * the Master Password is involved in this screen.
 */
import { t } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $, esc } from '../core/ui.js';
import { state } from '../core/state.js';
import { storage } from '../core/storage.js';
import { API, STORAGE_KEYS, TIMING } from '../config.js';

/** Probe verdicts for {@link probeServiceSession}. */
export const SESSION_GATE = Object.freeze({
  open: 'open',
  authRequired: 'auth-required',
});

/**
 * Classify a probe response status. Only an explicit 401 from the service
 * gates the client: every other outcome (including outages) defers to the
 * existing unlock error paths, which already distinguish connectivity
 * from credential failures. Unit-tested in test/connect.test.mjs.
 */
export function classifyProbeStatus(status) {
  return status === 401 ? SESSION_GATE.authRequired : SESSION_GATE.open;
}

/** Stored connection token, when the user has already signed in. */
export function readStoredToken() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEYS.apiToken) ?? null;
  } catch {
    return null;
  }
}

/**
 * Ask the service whether a session is required. The probe reuses the
 * same bearer token the record client would send, so a valid stored
 * credential passes and a missing/expired one gates.
 */
export async function probeServiceSession() {
  const headers = new Headers();
  const token = readStoredToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response;
  try {
    // A declared (nonexistent) vault scope keeps the probe meaningful
    // under vault-scoped listings: 200/4xx-with-body still classify by
    // authentication status alone (UX-ONB-003, DATA-002).
    response = await fetch(`${API.baseUrl + API.paths.records}?vault=probe`, { headers });
  } catch {
    // Unreachable services are handled by unlock, not by this gate.
    return SESSION_GATE.open;
  }
  return classifyProbeStatus(response.status);
}

/** Render the full Connect / Sign-in surface into the app root. */
export function renderConnect() {
  const url = API.baseUrl || '';
  $('#root').innerHTML = `
    <div id="view-connect">
      <div class="lock-brand"><span class="brand-mark" aria-hidden="true"></span><span>${t('app.name')}</span></div>
      <div class="lock-corner">
        <button class="lock-theme" id="conn-help">${t('help.title')}</button>
        <button class="lock-theme" id="conn-theme" title="${t('common.themeToggle')}"
                aria-label="${t('common.themeToggle')}"></button>
      </div>
      <div class="lock-card">
        <form id="connect-form" autocomplete="off" novalidate>
          <div class="micro lock-tag">${t('connect.tag')}</div>
          <h1 class="lock-title lock-title-sm">${t('connect.title')}</h1>
          <div class="welcome-intro"><p>${t('connect.sub')}</p></div>
          <div class="lock-field">
            <label class="micro" for="conn-url">${t('connect.urlLabel')}</label>
            <input class="lock-input" id="conn-url" type="text" spellcheck="false"
                   value="${esc(url)}" autocomplete="off">
          </div>
          <div class="lock-field">
            <label class="micro" for="conn-token">${t('connect.tokenLabel')}</label>
            <div class="pwfield">
              <input class="lock-input" id="conn-token" type="password" autocomplete="off"
                     aria-describedby="conn-error" placeholder="${t('connect.tokenPh')}">
              <button type="button" class="pw-toggle" data-eye="conn-token" title="${t('common.show')}"
                      aria-label="${t('common.show')}"></button>
            </div>
            <div class="micro conn-note">${t('connect.tokenHelp')}</div>
          </div>
          <div class="lock-error" id="conn-error" role="alert" aria-live="assertive" aria-atomic="true"></div>
          <button type="button" class="lock-btn" id="btn-connect" data-label="${t('connect.btn')}">
            <span class="st-txt">${t('connect.btn')}</span><span class="st-ic"></span>
          </button>
        </form>
      </div>
    </div>`;
  wireConnect();
  applyConnectThemeIcon();
  setTimeout(() => { const input = $('#conn-token'); if (input) input.focus(); }, 60);
}

function applyConnectThemeIcon() {
  const button = $('#conn-theme');
  if (button) button.innerHTML = icon(state.settings.theme === 'dark' ? 'sun' : 'moon', 16);
}

function connectError(message, fieldIds = []) {
  const el = document.getElementById('conn-error');
  el.innerHTML = `${icon('alert', 13)}<span>${esc(message)}</span>`;
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
  fieldIds.forEach(id => document.getElementById(id)?.setAttribute('aria-invalid', 'true'));
}

function clearConnectError(fieldIds = []) {
  const el = document.getElementById('conn-error');
  if (el) el.classList.remove('on');
  fieldIds.forEach(id => document.getElementById(id)?.removeAttribute('aria-invalid'));
}

/** Verify a candidate URL + token exactly the way boot will probe. */
async function verifyCandidate(url, token) {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  let response;
  try {
    response = await fetch(`${url.replace(/\/$/, '') + API.paths.records}?vault=probe`, { headers });
  } catch {
    return { status: 0 };
  }
  return { status: response.status };
}

function wireConnect() {
  $('#conn-help').addEventListener('click', () => {
    import('./help.js').then(module => module.openHelp());
  });
  $('#conn-theme').addEventListener('click', () => {
    const next = state.settings.theme === 'dark' ? 'light' : 'dark';
    state.settings.theme = next;
    storage.set(STORAGE_KEYS.theme, next);
    document.documentElement.dataset.theme = next;
    applyConnectThemeIcon();
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
  $('#connect-form').addEventListener('submit', event => event.preventDefault());
  $('#conn-token').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); $('#btn-connect').click(); }
  });

  $('#btn-connect').addEventListener('click', async () => {
    const url = $('#conn-url').value.trim();
    const token = $('#conn-token').value;
    if (!url || !token) {
      return connectError(t('connect.errEmpty'), [!url && 'conn-url', !token && 'conn-token'].filter(Boolean));
    }
    clearConnectError(['conn-url', 'conn-token']);
    const button = $('#btn-connect');
    const label = button.querySelector('.st-txt');
    button.disabled = true;
    label.textContent = t('entry.stage.deriving');
    try {
      const { status } = await verifyCandidate(url, token);
      if (status === 401) return connectError(t('connect.errWrong'), ['conn-token']);
      if (status === 0) return connectError(t('connect.errUnreachable'), ['conn-url']);
      if (status >= 400) return connectError(t('connect.errUnreachable'), ['conn-url']);
      // Persist the session, then re-enter through boot so every module
      // re-resolves the API base URL from storage.
      storage.set(STORAGE_KEYS.apiUrl, url.replace(/\/$/, ''));
      storage.set(STORAGE_KEYS.apiToken, token);
      await new Promise(resolve => setTimeout(resolve, TIMING.deriveStageMs));
      window.location.reload();
    } finally {
      button.disabled = false;
      label.textContent = button.dataset.label;
    }
  });
}
