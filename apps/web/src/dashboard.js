/**
 * Dashboard view — topbar, type tabs, and the record table.
 * Renders into `#root`; the drawer and modals mount inside this shell.
 */
import { t, formatDate, apiErrorMessage } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $, esc, guardRender, toast, restoreFocusReturn } from '../core/ui.js';
import { state } from '../core/state.js';
import { vault } from '../core/vault.js';
import { TYPES } from '../data/schema.js';
import { analyzePasswordHealth } from '../data/health.js';
import { formatNumber } from '../i18n/index.js';
import { GENERATOR, TIMING } from '../config.js';
import { recordSync } from '../core/records.js';
import { storage } from '../core/storage.js';
import { t as translate } from '../i18n/index.js';
import { matchesQuery } from '../data/search.js';
import { renderStartHere } from './start-here.js';
import { shortcutsHtml, openShortcuts } from './shortcuts.js';
import { exportOverlayHtml } from './export.js';
import { supportBundleOverlayHtml } from './support-bundle.js';
import { firstSuccess } from '../core/telemetry.js';
import { vaultIdentity } from '../data/diagnostics.js';
import { pendingQueue } from '../core/pending-queue.js';

/** Visual masking glyph — a symbol, not localized text. */
const SECRET_MASK = '••••••••';

/** Tab definitions: [nav key, i18n key]. */
const TAB_DEFS = Object.freeze([
  Object.freeze(['all', 'nav.all']),
  Object.freeze(['favorites', 'nav.favorites']),
  ...Object.keys(TYPES).map(key => Object.freeze([key, `type.${key}.plural`])),
  Object.freeze(['trash', 'nav.trash']),
]);

/** Sort options: [value, i18n key] — order defines the select order. */
const SORT_OPTIONS = Object.freeze([
  Object.freeze(['name', 'sort.name']),
  Object.freeze(['name-desc', 'sort.nameDesc']),
  Object.freeze(['updated', 'sort.updated']),
  Object.freeze(['type', 'sort.type']),
]);

/** Apply the current nav/query/sort filters to the entry collection. */
export function visibleEntries() {
  let list = state.nav === 'trash'
    ? [...(state.trashEntries || [])]
    : [...vault.entries];
  if (state.nav === 'favorites') list = list.filter(entry => entry.favorite);
  else if (TYPES[state.nav]) list = list.filter(entry => entry.type === state.nav);
  const query = state.query.trim();
  if (query) {
    list = list.filter(entry =>
      matchesQuery(entry, query, TYPES[entry.type] && t(`type.${entry.type}`)));
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  switch (state.sort) {
    case 'name-desc': list.sort((a, b) => byName(b, a)); break;
    case 'updated': list.sort((a, b) => new Date(b.updated) - new Date(a.updated)); break;
    case 'type': list.sort((a, b) => a.type.localeCompare(b.type) || byName(a, b)); break;
    default: list.sort(byName);
  }
  return list;
}

/**
 * Safe location summary for the vault identity line (PRD 6.3): the local
 * device on the desktop runtime, otherwise the connected service host
 * alone — never a full URL, path, or token.
 */
function vaultLocationText() {
  const identity = vaultIdentity();
  if (identity.kind === 'desktop') return t('vault.locationThisDevice');
  if (identity.kind === 'connected') {
    return t('vault.locationService', { host: identity.host });
  }
  return t('vault.locationUnknown');
}

/** Render the complete dashboard shell into the app root. */
export function renderDashboard() {
  guardRender('dashboard', () => renderDashboardInner());
}

function renderDashboardInner() {
  $('#root').innerHTML = `
    <div id="view-app" class="on">
      <header class="topbar">
        <span class="tb-brand"><span class="brand-mark" aria-hidden="true"></span>${t('app.name')}</span>
        <span class="tb-vault micro" id="tb-vault">${esc(t('vault.nameDefault'))} · ${esc(vaultLocationText())}</span>
        <div class="searchwrap tb-search">
          ${icon('search', 15)}
          <input id="search" type="text" placeholder="${t('top.searchScope', { scope: t('nav.all') })}" autocomplete="off">
        </div>
        <div class="tb-actions">
          <span class="autolock" title="${t('top.autolock')}">${icon('clock', 13)}<span id="autolock-chip">--:--</span></span>
          <button class="btn-icon" id="tb-theme" title="${t('common.themeToggle')}" aria-label="${t('common.themeToggle')}">${icon(state.settings.theme === 'dark' ? 'sun' : 'moon', 16)}</button>
          <button class="tb-lock" id="tb-shortcuts" title="${t('shortcuts.title')}">${icon('terminal', 15)}${t('shortcuts.title')}</button>
          <button class="tb-lock" id="tb-help" title="${t('help.title')}">${icon('help', 15)}${t('help.title')}</button>
          <button class="btn-icon" id="tb-settings" title="${t('top.settings')}" aria-label="${t('top.settings')}">${icon('sliders', 15)}</button>
          <span class="tb-div"></span>
          <button class="tb-lock" id="btn-lock" title="${t('top.lock')}">${icon('lock', 15)}</button>
          <button class="btn btn-primary" id="btn-new">${icon('plus', 14)}${t('top.newEntry')}</button>
        </div>
      </header>
      <nav class="tabs" id="tabs"></nav>
      <div class="table-area">
        <div id="start-here" class="start-here"></div>
        <div class="toolbar">
          <span class="micro" id="table-title"></span>
          <select class="select" id="sort" title="${t('top.sort')}" aria-label="${t('top.sort')}">
            ${SORT_OPTIONS.map(([value, key]) =>
              `<option value="${value}"${value === state.sort ? ' selected' : ''}>${t(key)}</option>`).join('')}
          </select>
        </div>
        <div id="filter-bar" class="filter-bar" aria-label="${t('nav.activeFilters')}"></div>
        <input type="file" id="dash-import-file" accept=".csv,text/csv" class="hidden">
        <div class="tablewrap" id="tablewrap" tabindex="0" role="grid" aria-label="records">
          <div class="tgrid thead">
            <span class="micro col-item">${t('table.colItem')}</span>
            <span class="micro col-type">${t('table.colType')}</span>
            <span class="micro col-login">${t('table.colLogin')}</span>
            <span class="micro col-updated">${t('table.colUpdated')}</span>
            <span class="micro col-actions"></span>
          </div>
          <div id="table-body"></div>
        </div>
      </div>
      <div class="backdrop" id="backdrop"></div>
      <aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <div class="drawer-head">
          <span class="micro" id="drawer-title"></span>
          <button class="btn-icon" id="drawer-close" title="${t('common.close')}" aria-label="${t('common.close')}">${icon('x', 15)}</button>
        </div>
        <div class="drawer-body"><div id="detail-inner"></div></div>
      </aside>
      <div class="overlay" id="ov-entry" role="dialog" aria-modal="true" aria-labelledby="entry-modal-title">
        <div class="modal">
          <div class="modal-head">
            <h2 id="entry-modal-title"></h2>
            <button class="btn-icon" data-close title="${t('common.close')}" aria-label="${t('common.close')}">${icon('x', 15)}</button>
          </div>
          <div class="modal-body">
            <div class="tmpl-grid" id="tmpl-grid"></div>
            <div class="fgrid" id="entry-fields"></div>
          </div>
          <div class="modal-foot" id="entry-form-foot">
            <span class="micro" style="margin-right:auto;align-self:center">${t('modal.encryptedNote')}</span>
            <button class="btn" data-close>${t('common.cancel')}</button>
            <button class="btn btn-primary" id="btn-save-entry"></button>
          </div>
        </div>
      </div>
      <div class="overlay" id="ov-shortcuts" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        ${shortcutsHtml()}
      </div>
      <div class="overlay" id="ov-export" role="dialog" aria-modal="true" aria-labelledby="export-title">
        ${exportOverlayHtml()}
      </div>
      <div class="overlay" id="ov-bundle" role="dialog" aria-modal="true" aria-labelledby="bundle-title">
        ${supportBundleOverlayHtml()}
      </div>
      <div class="overlay" id="ov-gen" role="dialog" aria-modal="true" aria-label="${t('gen.title')}">
        <div class="modal modal-sm">
          <div class="modal-head">
            <h2>${t('gen.title')}</h2>
            <button class="btn-icon" data-close title="${t('common.close')}" aria-label="${t('common.close')}">${icon('x', 15)}</button>
          </div>
          <div class="modal-body">
            <div class="gen-out">
              <div class="gen-pass" id="gen-pass"></div>
              <button class="btn-icon" id="gen-refresh" title="${t('gen.regenerate')}">${icon('refresh', 15)}</button>
            </div>
            <div class="gen-meta">
              <div>
                <div class="meter" id="gen-meter" style="width:150px;margin:0 0 6px"><i></i><i></i><i></i><i></i><i></i></div>
                <span class="meter-note" id="gen-strength"></span>
              </div>
              <div style="text-align:right">
                <div class="gen-entropy" id="gen-bits"></div>
                <span class="micro">${t('gen.entropy')}</span>
              </div>
            </div>
            <div class="gen-opt">
              <label for="gen-len">${t('gen.length')}</label>
              <div style="display:flex;align-items:center;gap:var(--space-3)">
                <input type="range" id="gen-len" min="${GENERATOR.length.min}" max="${GENERATOR.length.max}" value="${state.gen.len}">
                <span class="len-val" id="gen-len-val">${state.gen.len}</span>
              </div>
            </div>
            <div class="gen-opt"><label>${t('gen.upper')}</label><span class="chk${state.gen.upper ? ' on' : ''}" id="gen-upper" role="checkbox" aria-checked="${String(state.gen.upper)}" aria-label="${t('gen.upper')}" tabindex="0"></span></div>
            <div class="gen-opt"><label>${t('gen.lower')}</label><span class="chk${state.gen.lower ? ' on' : ''}" id="gen-lower" role="checkbox" aria-checked="${String(state.gen.lower)}" aria-label="${t('gen.lower')}" tabindex="0"></span></div>
            <div class="gen-opt"><label>${t('gen.digits')}</label><span class="chk${state.gen.digit ? ' on' : ''}" id="gen-digit" role="checkbox" aria-checked="${String(state.gen.digit)}" aria-label="${t('gen.digits')}" tabindex="0"></span></div>
            <div class="gen-opt"><label>${t('gen.symbols')}</label><span class="chk${state.gen.sym ? ' on' : ''}" id="gen-sym" role="checkbox" aria-checked="${String(state.gen.sym)}" aria-label="${t('gen.symbols')}" tabindex="0"></span></div>
            <div class="gen-opt"><label>${t('gen.ambiguous')}</label><span class="chk${state.gen.amb ? ' on' : ''}" id="gen-amb" role="checkbox" aria-checked="${String(state.gen.amb)}" aria-label="${t('gen.ambiguous')}" tabindex="0"></span></div>
          </div>
          <div class="modal-foot">
            <button class="btn" id="gen-copy">${icon('copy', 14)}${t('common.copy')}</button>
            <button class="btn btn-primary hidden" id="gen-use">${t('gen.use')}</button>
          </div>
        </div>
      </div>
    </div>`;
  wireDashboard();
}

/** Pending search debounce handle (see clearSearch). */
let searchTimer = null;

/** Clear the query and drop any pending debounce so the stale timer
 *  cannot re-apply typed text after Escape or chip clearing. */
function clearSearch() {
  clearTimeout(searchTimer);
  state.query = '';
  const input = $('#search');
  if (input) input.value = '';
}

function wireDashboard() {
  $('#search').addEventListener('input', event => {
    const value = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = value;
      if (value.trim()) firstSuccess.recordSearchPerformed(); // UX-ONB-010
      renderTable();
    }, TIMING.searchDebounceMs);
  });
  $('#search').addEventListener('keydown', event => {
    if (event.key === 'Escape' && event.target.value) {
      clearSearch();
      renderTable();
      event.target.blur();
    }
  });
  $('#sort').addEventListener('change', event => {
    state.sort = event.target.value;
    storage.set('veyora.web.sort', state.sort);
    renderTable();
  });
  $('#tablewrap').addEventListener('keydown', onTableKeydown);
  $('#table-body').addEventListener('click', onTableClick);
  $('#filter-bar').addEventListener('click', event => {
    const chip = event.target.closest('[data-clear]');
    if (!chip) return;
    if (chip.dataset.clear === 'query') {
      clearSearch();
    } else {
      state.nav = 'all';
      storage.set('veyora.web.nav', state.nav);
    }
    renderTabs();
    renderTable();
  });
  const dashImportFile = document.getElementById('dash-import-file');
  dashImportFile.addEventListener('change', async () => {
    const file = dashImportFile.files && dashImportFile.files[0];
    dashImportFile.value = '';
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
  });
  $('#drawer-close').addEventListener('click', () => {
    import('./drawer.js').then(module => module.closeDrawer());
  });
  $('#backdrop').addEventListener('click', () => {
    import('./drawer.js').then(module => module.closeDrawer());
  });
  $('#tb-shortcuts').addEventListener('click', openShortcuts);
  $('#tb-help').addEventListener('click', () => {
    import('./help.js').then(module => module.openHelp());
  });
  $('#tb-settings').addEventListener('click', () => {
    import('./drawer.js').then(module => module.openDrawer('settings'));
  });
  document.querySelectorAll('[data-close]').forEach(button =>
    button.addEventListener('click', closeOverlays));
  document.querySelectorAll('.overlay').forEach(overlay =>
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeOverlays();
    }));
}

/**
 * Keep list navigation local to the focused grid. Shortcuts deliberately do
 * not run from buttons or form controls, where the same keys have their own
 * meaning. Arrow keys mirror j/k for users who do not know the shortcuts.
 */
function onTableKeydown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.target.closest('button, input, select, textarea, a, [contenteditable="true"]')) return;
  if (state.nav === 'trash') return;

  const list = visibleEntries();
  if (!list.length) return;
  const current = list.findIndex(entry => entry.id === state.selectedId);
  let next = current;
  if (event.key === 'j' || event.key === 'ArrowDown') {
    next = current < 0 ? 0 : Math.min(current + 1, list.length - 1);
  } else if (event.key === 'k' || event.key === 'ArrowUp') {
    next = current < 0 ? list.length - 1 : Math.max(current - 1, 0);
  } else if (event.key === 'Enter' && current >= 0) {
    event.preventDefault();
    state.detailView = null;
    state.revealed = {};
    void import('./drawer.js').then(module => module.openDrawer());
    return;
  } else {
    return;
  }

  event.preventDefault();
  state.selectedId = list[next].id;
  state.detailView = null;
  renderTable();
}

/** Close any open modal overlay. */
export function closeOverlays() {
  document.querySelectorAll('.overlay').forEach(overlay => {
    if (overlay.classList.contains('on')) restoreFocusReturn(overlay);
    overlay.classList.remove('on');
  });
}

async function onTableClick(event) {
  if (event.target.closest('#empty-cta')) {
    event.stopPropagation();
    return import('./modals.js').then(module => module.openEntryModal());
  }
  if (event.target.closest('#empty-import')) {
    event.stopPropagation();
    document.getElementById('dash-import-file').click();
    return;
  }
  if (event.target.closest('#nores-clear')) {
    event.stopPropagation();
    clearSearch();
    renderTable();
    return;
  }
  if (event.target.closest('#nores-all')) {
    event.stopPropagation();
    clearSearch();
    state.nav = 'all';
    storage.set('veyora.web.nav', state.nav);
    renderTabs();
    renderTable();
    return;
  }
  const entry = vault.entries.find(item => item.id === event.target.closest('[data-copy]')?.dataset.copy);
  if (entry) {
    event.stopPropagation();
    import('../core/ui.js').then(({ copyWithTimeout }) => copyWithTimeout(entry.secret));
    return;
  }
  const restoreId = event.target.closest('[data-restore]')?.dataset.restore;
  if (restoreId) {
    event.stopPropagation();
    const target = (state.trashEntries || []).find(item => item.id === restoreId);
    if (!target) return;
    if (target._undecryptable) {
      toast(t('toast.syncFailed'), 'alert');
      return;
    }
    try {
      await recordSync.restoreEntry(target);
    } catch (error) {
      toast(apiErrorMessage(error.code), 'alert');
      return;
    }
    state.trashEntries = (state.trashEntries || []).filter(item => item.id !== restoreId);
    vault.entries.push(target);
    renderTabs();
    renderTable();
    toast(t('toast.restored'), 'refresh');
    return;
  }
  const favId = event.target.closest('[data-fav]')?.dataset.fav;
  if (favId) {
    event.stopPropagation();
    const target = vault.entries.find(item => item.id === favId);
    if (target) {
      const priorRevision = target.revision;
      target.favorite = !target.favorite;
      renderTabs();
      renderTable();
      recordSync.saveEntry(target, priorRevision).catch(() => {
        target.favorite = !target.favorite;
        target.revision = priorRevision;
        renderTabs();
        renderTable();
        import('../core/ui.js').then(({ toast }) =>
          toast(translate('toast.syncFailed'), 'alert'));
      });
    }
    return;
  }
  const menuButton = event.target.closest('[data-menu]');
  if (menuButton) {
    event.stopPropagation();
    openRowMenu(menuButton, menuButton.dataset.menu);
    return;
  }
  const row = event.target.closest('.trow');
  if (!row) return;
  if (state.nav === 'trash') return;
  state.selectedId = row.dataset.id;
  state.detailView = null;
  state.revealed = {};
  renderTable();
  import('./drawer.js').then(module => module.openDrawer());
}

/* ------------------------------------------------------------------ */
/* Row action menu (kebab)                                             */
/* ------------------------------------------------------------------ */

let rowMenu = null;
let rowMenuTrigger = null;

/** Close the open row menu, if any, and restore its trigger state. */
export function closeRowMenu() {
  if (!rowMenu) return;
  rowMenu.remove();
  rowMenu = null;
  if (rowMenuTrigger?.isConnected) rowMenuTrigger.setAttribute('aria-expanded', 'false');
  rowMenuTrigger = null;
  document.removeEventListener('keydown', onRowMenuKeydown, true);
  document.removeEventListener('pointerdown', onRowMenuPointerDown, true);
  window.removeEventListener('resize', closeRowMenu);
  window.removeEventListener('scroll', closeRowMenu, true);
}

function onRowMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeRowMenu();
  }
}

/** Any pointer press outside the menu dismisses it. Presses on another
 *  kebab trigger are left to the click handler so the menu toggles. */
function onRowMenuPointerDown(event) {
  if (event.target.closest?.('[data-menu]')) return;
  if (rowMenu && !rowMenu.contains(event.target)) closeRowMenu();
}

/**
 * Open the per-row action dropdown anchored below its kebab trigger.
 * Items: edit (opens the entry modal) and delete (armed two-step confirm,
 * mirroring the drawer's delete button — tombstones into the trash).
 */
function openRowMenu(trigger, entryId) {
  const wasOpenOnThisTrigger = rowMenuTrigger === trigger; // second press toggles closed
  closeRowMenu();
  const entry = vault.entries.find(item => item.id === entryId);
  if (wasOpenOnThisTrigger || !entry) return;
  rowMenuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');

  rowMenu = document.createElement('div');
  rowMenu.className = 'row-menu';
  rowMenu.setAttribute('role', 'menu');
  rowMenu.innerHTML = `
    <button class="row-menu-item" role="menuitem">${icon('pencil', 14)}${t('common.edit')}</button>
    <button class="row-menu-item danger" role="menuitem">${icon('trash', 14)}${t('common.delete')}</button>`;
  document.body.appendChild(rowMenu);

  const rect = trigger.getBoundingClientRect();
  const width = rowMenu.offsetWidth;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  rowMenu.style.left = `${left}px`;
  rowMenu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - rowMenu.offsetHeight - 8)}px`;

  const [editItem, deleteItem] = rowMenu.querySelectorAll('.row-menu-item');
  editItem.onclick = event => {
    event.stopPropagation();
    closeRowMenu();
    import('./modals.js').then(module => module.openEntryModal(entryId));
  };
  wireMenuDelete(deleteItem, entry);

  // The opening interaction's pointerdown has already completed by the time
  // this runs (we are inside its click dispatch), so a capture-phase
  // pointerdown listener can never be triggered by the opening event —
  // no deferred-attach race.
  document.addEventListener('pointerdown', onRowMenuPointerDown, true);
  document.addEventListener('keydown', onRowMenuKeydown, true);
  window.addEventListener('resize', closeRowMenu);
  window.addEventListener('scroll', closeRowMenu, true);
}

/** Armed two-step delete inside the row menu — same contract as the drawer. */
function wireMenuDelete(button, entry) {
  button.onclick = async () => {
    if (!button.dataset.armed) {
      button.dataset.armed = '1';
      button.classList.add('armed');
      button.innerHTML = `${icon('alert', 14)}${t('drawer.confirmDelete')}`;
      setTimeout(() => { if (rowMenu?.contains(button)) closeRowMenu(); }, TIMING.deleteArmMs);
      return;
    }
    closeRowMenu();
    await deleteEntryWithUndo(entry);
  };
}

/** Render the type tabs. */
export function renderTabs() {
  $('#tabs').innerHTML = TAB_DEFS.map(([nav, key]) => {
    const count = nav === 'all' ? vault.entries.length
      : nav === 'favorites' ? vault.entries.filter(entry => entry.favorite).length
      : nav === 'trash' ? (state.trashEntries || []).length
      : vault.entries.filter(entry => entry.type === nav).length;
    return `<button class="tab${nav === state.nav ? ' on' : ''}" data-nav="${nav}">${
      t(key)}<span class="cnt">${count}</span></button>`;
  }).join('');
  document.querySelectorAll('.tab').forEach(button =>
    button.addEventListener('click', async () => {
      const requestedNav = button.dataset.nav;
      if (requestedNav === 'trash' && !state.trashEntries) {
        try {
          state.trashEntries = await recordSync.fetchTrash();
        } catch {
          toast(t('toast.syncFailed'), 'alert');
          return;
        }
      }
      state.nav = requestedNav;
      storage.set('veyora.web.nav', state.nav);
      renderTabs();
      renderTable();
    }));
}

/** i18n key naming the current list scope (tab) shown in titles and search. */
function navScopeKey() {
  return state.nav === 'all' ? 'nav.all'
    : state.nav === 'favorites' ? 'nav.favorites'
    : state.nav === 'trash' ? 'nav.trash'
    : `type.${state.nav}.plural`;
}

/** Active filters (scope + text) as individually removable chips (NAV-003). */
function renderFilterBar(scopeKey) {
  const bar = $('#filter-bar');
  if (!bar) return;
  const chips = [];
  if (state.nav !== 'all') {
    const label = t(scopeKey);
    chips.push(`<button class="filter-chip" data-clear="nav" aria-label="${t('action.removeFilter', { filter: label })}">`
      + `${esc(label)}${icon('x', 11)}</button>`);
  }
  const query = state.query.trim();
  if (query) {
    chips.push(`<button class="filter-chip" data-clear="query" aria-label="${t('action.removeFilter', { filter: query })}">`
      + `“${esc(query)}”${icon('x', 11)}</button>`);
  }
  bar.innerHTML = chips.join('');
  bar.classList.toggle('on', chips.length > 0);
}

/**
 * Delete an entry to Trash with an Undo action in the toast (ITEM-008).
 * Both the drawer and the row-menu delete path share this ceremony.
 */
export async function deleteEntryWithUndo(entry) {
  try {
    await recordSync.tombstone(entry.id, entry.revision);
  } catch (error) {
    toast(apiErrorMessage(error.code), 'alert');
    return false;
  }
  vault.entries = vault.entries.filter(item => item.id !== entry.id);
  state.trashEntries = null; // trash tab must refetch to show the new tombstone
  if (state.selectedId === entry.id) {
    state.selectedId = vault.entries[0]?.id ?? null;
    state.detailView = null;
  }
  renderTabs();
  renderTable();
  toast(t('toast.deleted'), 'trash', {
    label: t('common.undo'),
    durationMs: TIMING.undoMs,
    onAction: async () => {
      try {
        await recordSync.restoreEntry(entry);
      } catch (error) {
        toast(apiErrorMessage(error.code), 'alert');
        return;
      }
      state.trashEntries = null;
      vault.entries.push(entry);
      renderTabs();
      renderTable();
      toast(t('toast.restored'), 'refresh');
    },
  });
  return true;
}

/** Render the record table body and the toolbar title. */
export function renderTable() {
  closeRowMenu(); // re-render invalidates menu anchor positions
  const list = visibleEntries();
  renderStartHere();
  const health = analyzePasswordHealth(vault.entries);
  const navLabelKey = navScopeKey();
  const scopeLabel = t(navLabelKey);
  // The search field announces its scope so it is never ambiguous (NAV-002).
  const search = $('#search');
  if (search) {
    const scoped = t('top.searchScope', { scope: scopeLabel });
    search.placeholder = scoped;
    search.setAttribute('aria-label', scoped);
  }
  renderFilterBar(navLabelKey);
  let titleText = `${scopeLabel} · ${t('table.count', { count: list.length })}`;
  if (health.reusedIds.size > 0 || health.staleIds.size > 0) {
    const parts = [];
    if (health.reusedIds.size > 0) parts.push(t('health.reusedCount', { count: health.reusedIds.size }));
    if (health.staleIds.size > 0) parts.push(t('health.staleCount', { count: health.staleIds.size }));
    titleText += ` · ${parts.join(' · ')}`;
  }
  $('#table-title').textContent = titleText;
  const body = $('#table-body');
  if (!list.length) {
    const actions = (buttons) =>
      `<div class="empty-actions">${buttons.join('')}</div>`;
    if (state.nav === 'trash') {
      body.innerHTML = `<div class="table-empty"><div class="big">${t('table.trashEmpty')}</div></div>`;
      return;
    }
    if (state.query.trim()) {
      // No-results names the query and scope and offers both escapes (NAV-005).
      body.innerHTML = `<div class="table-empty">
        <div class="big">${t('table.noResultsTitle')}</div>
        <div>${t('table.noResultsBody', { query: esc(state.query.trim()), scope: scopeLabel })}</div>
        ${actions([
          `<button class="btn" id="nores-clear">${icon('x', 14)}${t('table.clearSearch')}</button>`,
          `<button class="btn btn-primary" id="nores-all">${icon('search', 14)}${t('table.searchAll')}</button>`,
        ])}
      </div>`;
      return;
    }
    if (vault.entries.length === 0) {
      // Truly empty vault: first login plus import as the two starts (NAV-004).
      body.innerHTML = `<div class="table-empty">
        <div class="big">${t('table.emptyVaultTitle')}</div>
        <div>${t('table.emptyVaultBody')}</div>
        ${actions([
          `<button class="btn btn-primary" id="empty-cta">${icon('plus', 14)}${t('table.addFirstLogin')}</button>`,
          `<button class="btn" id="empty-import">${icon('upload', 14)}${t('table.importItems')}</button>`,
        ])}
      </div>`;
      return;
    }
    body.innerHTML = `<div class="table-empty"><div class="big">${t('table.emptyTitle')}</div>
      <div>${t('table.emptyFiltered')}</div></div>`;
    return;
  }
  const pendingSyncIds = new Set(pendingQueue.pendingIds(vault.meta && vault.meta.salt));
  body.innerHTML = list.map(entry => {
    const type = TYPES[entry.type];
    const subtitle = entry.username || entry.website || entry.service
      || entry.host || t(`type.${entry.type}`);
    const loginCell = entry.username || SECRET_MASK;
    const highlightMatch = (text) => {
      if (!state.query.trim()) return esc(text);
      const q = state.query.trim().toLowerCase();
      const idx = String(text).toLowerCase().indexOf(q);
      if (idx < 0) return esc(text);
      const before = esc(String(text).slice(0, idx));
      const match = esc(String(text).slice(idx, idx + q.length));
      const after = esc(String(text).slice(idx + q.length));
      return `${before}<mark>${match}</mark>${after}`;
    };
    const selected = entry.id === state.selectedId && !state.detailView;
    const badges = [];
    if (pendingSyncIds.has(entry.id)) badges.push(`<span class="badge-pending" title="${t('table.pendingSync')}">${icon('clock', 10)}</span>`);
    if (health.reusedIds.has(entry.id)) badges.push(`<span class="badge-warn" title="${t('health.reused')}">${icon('alert', 10)}</span>`);
    if (health.staleIds.has(entry.id)) badges.push(`<span class="badge-stale" title="${t('health.stale')}">${icon('clock', 10)}</span>`);
    return `<div class="tgrid trow${selected ? ' on' : ''}" data-id="${entry.id}" tabindex="0" role="row" aria-selected="${String(selected)}">
      <div class="col-item">
        <span class="tile">${icon(type.icon, 14)}</span>
        <div style="min-width:0">
          <div class="tn">${highlightMatch(entry.name)}${entry.favorite ? ' ' + icon('starFill', 12) : ''}${badges.join('')}</div>
          <div class="ts">${highlightMatch(subtitle)}</div>
        </div>
      </div>
      <span class="col-type"><span class="ttype">${t(`type.${entry.type}`)}</span></span>
      <span class="col-login">${esc(loginCell)}</span>
      <span class="col-updated">${formatDate(entry.updated)}</span>
      <div class="col-actions">${state.nav === 'trash'
        ? `<button class="btn" data-restore="${entry.id}"${entry._undecryptable ? ' disabled' : ''}>${icon('refresh', 13)}${t('action.restore')}</button>`
        : `<button class="btn-icon" data-copy="${entry.id}" title="${t('action.copySecret')}">${icon('copy', 13)}</button>
        <button class="btn-icon" data-fav="${entry.id}" title="${t('action.favorite')}">${icon(entry.favorite ? 'starFill' : 'star', 13)}</button>
        <button class="btn-icon" data-menu="${entry.id}" title="${t('action.more')}" aria-haspopup="menu" aria-expanded="false">${icon('kebab', 15)}</button>`}
      </div>
    </div>`;
  }).join('');
}
