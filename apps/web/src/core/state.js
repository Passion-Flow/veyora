/**
 * Application state.
 *
 * A single mutable store with explicit render calls after mutations —
 * deliberately framework-free and easy to audit. All UI state lives here;
 * persistence goes through the storage helpers.
 */
import { SECURITY, STORAGE_KEYS, GENERATOR } from '../config.js';
import { storage } from './storage.js';

const storedTrashRetention = Number(storage.get(STORAGE_KEYS.trashRetention));
const trashRetentionDays = SECURITY.trash.optionsDays.includes(storedTrashRetention)
  ? storedTrashRetention
  : SECURITY.trash.defaultRetentionDays;

export const state = {
  /** Dashboard filter: 'all' | 'favorites' | 'trash' | a type key. */
  nav: 'all',
  /** Active tag filter inside the Tags scope (NAV/PRD 7.1). */
  tagFilter: null,
  /** Decrypted tombstones loaded only while the Trash view is active. */
  trashEntries: null,
  /** Current table search text. */
  query: '',
  /** Active sort key. */
  sort: 'name',
  /** Selected entry id for the drawer, when showing an entry. */
  selectedId: null,
  /** Drawer content override: null | 'settings'. */
  detailView: null,
  /** Entry id being edited in the modal, or null for creation. */
  editingId: null,
  /** Template preselected in the entry modal. */
  entryTmpl: 'login',
  /** Per-entry reveal flags: { [entryId]: boolean }. */
  revealed: {},
  /** Whether the vault is currently unlocked. */
  unlocked: false,
  /** Active kernel adapter mode: 'unavailable' until real WASM passes self-test. */
  kernelMode: 'unavailable',
  /** User preferences (persisted where noted). */
  settings: {
    theme: storage.get(STORAGE_KEYS.theme) || 'light',        // persisted
    locale: storage.get(STORAGE_KEYS.locale) || null,         // null = auto
    autoLockMin: SECURITY.autoLock.defaultMinutes,
    clipboardSec: SECURITY.clipboard.defaultSeconds,
    trashRetentionDays,                                        // persisted
  },
  /** Generator panel options. */
  gen: {
    len: GENERATOR.length.default, upper: true, lower: true, digit: true, sym: true, amb: true,
  },
};

/** Reset all session-scoped state (used on lock). */
export function resetSession() {
  state.selectedId = null;
  state.detailView = null;
  state.editingId = null;
  state.revealed = {};
  state.trashEntries = null;
  state.unlocked = false;
}
