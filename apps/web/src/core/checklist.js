/**
 * Start-here checklist progress (UX-ONB-008/009).
 *
 * Completion state persists in localStorage so the checklist survives lock,
 * unlock, and reloads. The card hides itself once every available step is
 * done and can be reopened from Help at any time.
 */
import { storage } from './storage.js';
import { STORAGE_KEYS } from '../config.js';

/** Steps that can actually be completed in this build. Recovery
 *  verification and encrypted backup are unavailable (sequence 5) and are
 *  shown as pending-but-unavailable rather than silently omitted. */
export const TRACKED_STEPS = Object.freeze([
  'first-item', 'copy-reveal', 'lock', 'recovery', 'backup',
]);

const DEFAULT_STATE = Object.freeze({ hidden: false, noted: false, done: {} });

function read() {
  try {
    const parsed = JSON.parse(storage.get(STORAGE_KEYS.startHere));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_STATE, done: {} };
    return {
      hidden: Boolean(parsed.hidden),
      noted: Boolean(parsed.noted),
      done: (parsed.done && typeof parsed.done === 'object') ? { ...parsed.done } : {},
    };
  } catch {
    return { ...DEFAULT_STATE, done: {} };
  }
}

function write(value) {
  storage.set(STORAGE_KEYS.startHere, JSON.stringify(value));
  try {
    globalThis.window?.dispatchEvent(new CustomEvent('veyora:checklist-changed'));
  } catch { /* non-browser host (Node test runner) */ }
}

export const checklist = {
  isHidden() {
    return read().hidden;
  },
  hide() {
    const value = read();
    write({ ...value, hidden: true });
  },
  /** Reopen from Help: show again even when already complete. */
  unhide() {
    const value = read();
    write({ ...value, hidden: false });
  },
  isDone(step) {
    return Boolean(read().done[step]);
  },
  markDone(step) {
    const value = read();
    if (value.done[step]) return;
    value.done[step] = true;
    write(value);
  },
  /** True once every available step is done (auto-hide trigger). */
  isComplete() {
    const value = read();
    return TRACKED_STEPS.every(step => value.done[step]);
  },
  /** Record that completion was noticed so the card does not re-hide after
   *  the user reopens it from Help. */
  noteCompletion() {
    const value = read();
    if (value.noted) return false;
    write({ ...value, noted: true, hidden: true });
    return true;
  },
};
