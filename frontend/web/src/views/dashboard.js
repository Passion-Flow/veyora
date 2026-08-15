/**
 * Dashboard view — topbar, type tabs, and the record table.
 * Renders into `#root`; the drawer and modals mount inside this shell.
 */
import { t, formatDate } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $, esc, guardRender } from '../core/ui.js';
import { state } from '../core/state.js';
import { vault } from '../core/vault.js';
import { TYPES } from '../data/schema.js';
import { GENERATOR, TIMING } from '../config.js';
import { recordSync } from '../core/records.js';
import { t as translate } from '../i18n/index.js';

/** Visual masking glyph — a symbol, not localized text. */
const SECRET_MASK = '••••••••';

/** Tab definitions: [nav key, i18n key]. */
const TAB_DEFS = Object.freeze([
  Object.freeze(['all', 'nav.all']),
  Object.freeze(['favorites', 'nav.favorites']),
  ...Object.keys(TYPES).map(key => Object.freeze([key, `type.${key}.plural`])),
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
  let list = [...vault.entries];
  if (state.nav === 'favorites') list = list.filter(entry => entry.favorite);
  else if (TYPES[state.nav]) list = list.filter(entry => entry.type === state.nav);
  const query = state.query.trim().toLowerCase();
  if (query) {
    list = list.filter(entry => {
      const haystack = [
        entry.name, entry.username, entry.website, entry.service,
        entry.host, entry.notes, entry.secret,
        TYPES[entry.type] && t(`type.${entry.type}`),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
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

/** Render the complete dashboard shell into the app root. */
export function renderDashboard() {
  guardRender('dashboard', () => renderDashboardInner());
}

function renderDashboardInner() {
  $('#root').innerHTML = `
    <div id="view-app" class="on">
      <header class="topbar">
        <span class="tb-brand">${t('app.name')}</span>
        <div class="searchwrap tb-search">
          ${icon('search', 15)}
          <input id="search" type="text" placeholder="${t('top.searchPh')}" autocomplete="off">
        </div>
        <div class="tb-actions">
          <span class="autolock" title="${t('top.autolock')}">${icon('clock', 13)}<span id="autolock-chip">--:--</span></span>
          <button class="btn-icon" id="tb-theme" title="${t('common.themeToggle')}"></button>
          <button class="btn-icon" id="tb-recovery" title="${t('top.recovery')}">${icon('shield', 15)}</button>
          <button class="btn-icon" id="tb-settings" title="${t('top.settings')}">${icon('sliders', 15)}</button>
          <span class="tb-div"></span>
          <button class="tb-lock" id="btn-lock" title="${t('top.lock')}">${icon('lock', 15)}</button>
          <button class="btn btn-primary" id="btn-new">${icon('plus', 14)}${t('top.newEntry')}</button>
        </div>
      </header>
      <nav class="tabs" id="tabs"></nav>
      <div class="table-area">
        <div class="toolbar">
          <span class="micro" id="table-title"></span>
          <select class="select" id="sort" title="${t('top.sort')}">
            ${SORT_OPTIONS.map(([value, key]) =>
              `<option value="${value}"${value === state.sort ? ' selected' : ''}>${t(key)}</option>`).join('')}
          </select>
        </div>
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
            <button class="btn-icon" data-close title="${t('common.close')}">${icon('x', 15)}</button>
          </div>
          <div class="modal-body">
            <div class="tmpl-grid" id="tmpl-grid"></div>
            <div class="fgrid" id="entry-fields"></div>
          </div>
          <div class="modal-foot">
            <span class="micro" style="margin-right:auto;align-self:center">${t('modal.encryptedNote')}</span>
            <button class="btn" data-close>${t('common.cancel')}</button>
            <button class="btn btn-primary" id="btn-save-entry"></button>
          </div>
        </div>
      </div>
      <div class="overlay" id="ov-gen" role="dialog" aria-modal="true" aria-label="${t('gen.title')}">
        <div class="modal modal-sm">
          <div class="modal-head">
            <h2>${t('gen.title')}</h2>
            <button class="btn-icon" data-close title="${t('common.close')}">${icon('x', 15)}</button>
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
            <div class="gen-opt"><label>${t('gen.upper')}</label><span class="chk${state.gen.upper ? ' on' : ''}" id="gen-upper" role="checkbox" aria-checked="${String(state.gen.upper)}" tabindex="0"></span></div>
            <div class="gen-opt"><label>${t('gen.lower')}</label><span class="chk${state.gen.lower ? ' on' : ''}" id="gen-lower" role="checkbox" aria-checked="${String(state.gen.lower)}" tabindex="0"></span></div>
            <div class="gen-opt"><label>${t('gen.digits')}</label><span class="chk${state.gen.digit ? ' on' : ''}" id="gen-digit" role="checkbox" aria-checked="${String(state.gen.digit)}" tabindex="0"></span></div>
            <div class="gen-opt"><label>${t('gen.symbols')}</label><span class="chk${state.gen.sym ? ' on' : ''}" id="gen-sym" role="checkbox" aria-checked="${String(state.gen.sym)}" tabindex="0"></span></div>
            <div class="gen-opt"><label>${t('gen.ambiguous')}</label><span class="chk${state.gen.amb ? ' on' : ''}" id="gen-amb" role="checkbox" aria-checked="${String(state.gen.amb)}" tabindex="0"></span></div>
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

function wireDashboard() {
  let searchTimer = null;
  $('#search').addEventListener('input', event => {
    const value = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = value;
      renderTable();
    }, TIMING.searchDebounceMs);
  });
  $('#search').addEventListener('keydown', event => {
    if (event.key === 'Escape' && event.target.value) {
      event.target.value = '';
      state.query = '';
      renderTable();
      event.target.blur();
    }
  });
  $('#sort').addEventListener('change', event => {
    state.sort = event.target.value;
    renderTable();
  });
  $('#table-body').addEventListener('click', onTableClick);
  $('#drawer-close').addEventListener('click', () => {
    import('./drawer.js').then(module => module.closeDrawer());
  });
  $('#backdrop').addEventListener('click', () => {
    import('./drawer.js').then(module => module.closeDrawer());
  });
  $('#tb-recovery').addEventListener('click', () => {
    import('./drawer.js').then(module => module.openDrawer('recovery'));
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

/** Close any open modal overlay. */
export function closeOverlays() {
  document.querySelectorAll('.overlay').forEach(overlay => overlay.classList.remove('on'));
}

function onTableClick(event) {
  if (event.target.closest('#empty-cta')) {
    event.stopPropagation();
    return import('./modals.js').then(module => module.openEntryModal());
  }
  const entry = vault.entries.find(item => item.id === event.target.closest('[data-copy]')?.dataset.copy);
  if (entry) {
    event.stopPropagation();
    import('../core/ui.js').then(({ copyWithTimeout }) => copyWithTimeout(entry.secret));
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
  const editId = event.target.closest('[data-edit]')?.dataset.edit;
  if (editId) {
    event.stopPropagation();
    import('./modals.js').then(module => module.openEntryModal(editId));
    return;
  }
  const row = event.target.closest('.trow');
  if (!row) return;
  state.selectedId = row.dataset.id;
  state.detailView = null;
  state.revealed = {};
  renderTable();
  import('./drawer.js').then(module => module.openDrawer());
}

/** Render the type tabs. */
export function renderTabs() {
  $('#tabs').innerHTML = TAB_DEFS.map(([nav, key]) => {
    const count = nav === 'all' ? vault.entries.length
      : nav === 'favorites' ? vault.entries.filter(entry => entry.favorite).length
      : vault.entries.filter(entry => entry.type === nav).length;
    return `<button class="tab${nav === state.nav ? ' on' : ''}" data-nav="${nav}">${
      t(key)}<span class="cnt">${count}</span></button>`;
  }).join('');
  document.querySelectorAll('.tab').forEach(button =>
    button.addEventListener('click', () => {
      state.nav = button.dataset.nav;
      renderTabs();
      renderTable();
    }));
}

/** Render the record table body and the toolbar title. */
export function renderTable() {
  const list = visibleEntries();
  const navLabelKey = state.nav === 'all' ? 'nav.all'
    : state.nav === 'favorites' ? 'nav.favorites'
    : `type.${state.nav}.plural`;
  $('#table-title').textContent = `${t(navLabelKey)} · ${t('table.count', { count: list.length })}`;
  const body = $('#table-body');
  if (!list.length) {
    body.innerHTML = `<div class="table-empty"><div class="big">${t('table.emptyTitle')}</div><div>${
      state.query ? t('table.emptyNoResults', { query: esc(state.query) }) : t('table.emptyNew')
    }</div>${state.query ? '' :
      `<button class="btn btn-primary" id="empty-cta" style="margin-top:18px">${icon('plus', 14)}${t('top.newEntry')}</button>`}
    </div>`;
    return;
  }
  body.innerHTML = list.map(entry => {
    const type = TYPES[entry.type];
    const subtitle = entry.username || entry.website || entry.service
      || entry.host || t(`type.${entry.type}`);
    const loginCell = entry.username || SECRET_MASK;
    const selected = entry.id === state.selectedId && !state.detailView;
    return `<div class="tgrid trow${selected ? ' on' : ''}" data-id="${entry.id}" tabindex="0">
      <div class="col-item">
        <span class="tile">${icon(type.icon, 14)}</span>
        <div style="min-width:0">
          <div class="tn">${esc(entry.name)}${entry.favorite ? ' ' + icon('starFill', 12) : ''}</div>
          <div class="ts">${esc(subtitle)}</div>
        </div>
      </div>
      <span class="col-type"><span class="ttype">${t(`type.${entry.type}`)}</span></span>
      <span class="col-login">${esc(loginCell)}</span>
      <span class="col-updated">${formatDate(entry.updated)}</span>
      <div class="col-actions">
        <button class="btn-icon" data-copy="${entry.id}" title="${t('action.copySecret')}">${icon('copy', 13)}</button>
        <button class="btn-icon" data-fav="${entry.id}" title="${t('action.favorite')}">${icon(entry.favorite ? 'starFill' : 'star', 13)}</button>
        <button class="btn-icon" data-edit="${entry.id}" title="${t('common.edit')}">${icon('pencil', 13)}</button>
      </div>
    </div>`;
  }).join('');
}
