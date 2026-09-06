/**
 * Start-here checklist card (UX-ONB-008/009).
 *
 * A dismissible guide shown above the record table. Steps that exist in
 * this build check themselves off as the user does them — saving an item,
 * copy/reveal, locking, verifying the Recovery Key (UX-ONB-007), and
 * creating an encrypted backup. The card hides itself
 * once every available step is done and reopens from Help.
 */
import { t } from '../i18n/index.js';
import { icon } from '../core/icons.js';
import { $ } from '../core/ui.js';
import { state } from '../core/state.js';
import { vault } from '../core/vault.js';
import { checklist } from '../core/checklist.js';

/** Card steps: [step id, i18n key, available in this build]. */
const STEPS = Object.freeze([
  Object.freeze(['first-item', 'startHere.firstItem', true]),
  Object.freeze(['copy-reveal', 'startHere.copyReveal', true]),
  Object.freeze(['lock', 'startHere.lock', true]),
  Object.freeze(['recovery', 'startHere.recovery', true]),
  Object.freeze(['backup', 'startHere.backup', true]),
]);

/** Render (or remove) the checklist card inside `#start-here`. */
export function renderStartHere() {
  const host = $('#start-here');
  if (!host) return;
  if (vault.entries.length > 0) checklist.markDone('first-item');
  if (checklist.isComplete()) checklist.noteCompletion();
  const show = state.unlocked && !checklist.isHidden();
  host.classList.toggle('on', show);
  if (!show) {
    host.innerHTML = '';
    return;
  }
  const rows = STEPS.map(([step, key, available]) => {
    const done = available && checklist.isDone(step);
    const stateHtml = done
      ? `<span class="sh-check" aria-hidden="true">${icon('check', 12)}</span>`
      : `<span class="sh-box" aria-hidden="true"></span>`;
    const note = available ? '' : `<div class="sh-note">${t('startHere.unavailable')}</div>`;
    return `<li class="sh-item${done ? ' done' : ''}" aria-label="${esc(t(key))}: ${
      done ? t('startHere.done') : (available ? '' : t('startHere.unavailable'))}">
      ${stateHtml}<div><div class="sh-t">${esc(t(key))}</div>${note}</div></li>`;
  }).join('');
  const footer = checklist.isComplete()
    ? `<p class="sh-alldone">${t('startHere.allDone')}</p>`
    : '';
  host.innerHTML = `
    <section class="sh-card" aria-label="${t('startHere.title')}">
      <div class="sh-head">
        <div>
          <div class="sh-title">${t('startHere.title')}</div>
          <div class="sh-sub">${t('startHere.sub')}</div>
        </div>
        <button class="btn-icon" id="sh-hide" title="${t('startHere.hide')}"
                aria-label="${t('startHere.hide')}">${icon('x', 15)}</button>
      </div>
      <ol class="sh-list">${rows}</ol>
      ${footer}
    </section>`;
  $('#sh-hide').addEventListener('click', () => {
    checklist.hide();
    renderStartHere();
  });
}

/** Escape helper kept local so this module stays import-light. */
function esc(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
