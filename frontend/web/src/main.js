/**
 * Application entry point.
 *
 * Boots the vault store, i18n, and theme; owns cross-cutting concerns
 * (auto-lock, keyboard shortcuts, locale-change re-render) and switches
 * between the entry flow and the dashboard.
 */
import { t, setLocale, detectLocale } from './i18n/index.js';
import { state, resetSession } from './core/state.js';
import { vault } from './core/vault.js';
import { loadKernel } from './core/kernel.js';
import { recordSync } from './core/records.js';
import { icon } from './core/icons.js';
import { $, toast } from './core/ui.js';
import { STORAGE_KEYS, TIMING } from './config.js';
import { renderEntryFlow, setOnVaultEntered } from './views/entry-flow.js';
import { renderDashboard, renderTabs, renderTable, closeOverlays } from './views/dashboard.js';
import { openDrawer, closeDrawer, LOCALE_CHANGED_EVENT } from './views/drawer.js';
import { openEntryModal, openGenerator, installModalDelegation } from './views/modals.js';

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function applyDocumentTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
  const button = $('#tb-theme');
  if (button) button.innerHTML = icon(state.settings.theme === 'dark' ? 'sun' : 'moon', 16);
}

/* ------------------------------------------------------------------ */
/* Auto-lock                                                           */
/* ------------------------------------------------------------------ */

let lockDeadline = 0;
let lockInterval = null;
let lastActivity = 0;

function startLockTimer() {
  stopLockTimer();
  lockDeadline = Date.now() + state.settings.autoLockMin * 60000;
  lockInterval = setInterval(tickLock, TIMING.lockTickMs);
  tickLock();
}

function stopLockTimer() {
  clearInterval(lockInterval);
  lockInterval = null;
}

function tickLock() {
  const remaining = lockDeadline - Date.now();
  if (remaining <= 0) {
    lockVault();
    return;
  }
  const chip = $('#autolock-chip');
  if (!chip) return;
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  chip.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function trackActivity() {
  const now = Date.now();
  if (now - lastActivity < TIMING.activityThrottleMs) return;
  lastActivity = now;
  if (lockInterval) lockDeadline = Date.now() + state.settings.autoLockMin * 60000;
}

['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach(type =>
  document.addEventListener(type, trackActivity, { passive: true }));

window.addEventListener('veyora:autolock-changed', () => {
  if (state.unlocked) startLockTimer();
});

/* ------------------------------------------------------------------ */
/* Lock / unlock transitions                                           */
/* ------------------------------------------------------------------ */

function lockVault() {
  stopLockTimer();
  closeDrawer();
  closeOverlays();
  resetSession();
  recordSync.lock(); // zero the session root key
  $('#root').innerHTML = '';
  renderEntryFlow('lock-unlock');
  toast(t('toast.locked'), 'lock');
}

setOnVaultEntered(() => {
  renderDashboard();
  renderTabs();
  renderTable();
  startLockTimer();
});

/* ------------------------------------------------------------------ */
/* Global delegation: topbar controls                                  */
/* ------------------------------------------------------------------ */

document.addEventListener('click', event => {
  if (event.target.closest('#btn-new')) return openEntryModal();
  if (event.target.closest('#btn-lock')) return lockVault();
  if (event.target.closest('#tb-theme')) {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEYS.theme, state.settings.theme);
    applyDocumentTheme();
    const entryFlowButton = $('#lock-theme');
    if (entryFlowButton) {
      entryFlowButton.innerHTML = icon(state.settings.theme === 'dark' ? 'sun' : 'moon', 16);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts                                                  */
/* ------------------------------------------------------------------ */

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (document.querySelector('.overlay.on')) return closeOverlays();
    if ($('#drawer') && $('#drawer').classList.contains('on')) return closeDrawer();
    return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  if (!$('#view-app')) return;
  switch (event.key.toLowerCase()) {
    case 'k':
    case 'f':
      event.preventDefault();
      $('#search') && ($('#search').focus(), $('#search').select());
      break;
    case 'n':
      event.preventDefault();
      openEntryModal();
      break;
    case 'g':
      event.preventDefault();
      openGenerator();
      break;
    case 'l':
      event.preventDefault();
      lockVault();
      break;
  }
});

/* ------------------------------------------------------------------ */
/* Locale changes                                                      */
/* ------------------------------------------------------------------ */

window.addEventListener(LOCALE_CHANGED_EVENT, () => {
  applyDocumentTitle();
  if (state.unlocked) {
    const hadDrawer = $('#drawer') && $('#drawer').classList.contains('on');
    const detailView = state.detailView;
    renderDashboard();
    applyDocumentTheme();
    renderTabs();
    renderTable();
    if (hadDrawer && (detailView || state.selectedId)) openDrawer(detailView);
  } else {
    renderEntryFlow();
  }
});

function applyDocumentTitle() {
  document.title = `${t('app.name')} — ${t('app.tagline')}`;
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  vault.load();
  state.kernelMode = await loadKernel();
  const requested = state.settings.locale || detectLocale();
  await setLocale(requested);
  applyDocumentTheme();
  applyDocumentTitle();
  installModalDelegation();
  renderEntryFlow();
}

boot();
