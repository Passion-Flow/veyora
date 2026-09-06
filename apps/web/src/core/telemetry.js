/**
 * First-success instrumentation for test builds (UX-ONB-010).
 *
 * Vault creation is NOT a success event. First success is a saved Login
 * followed by finding it (a search that narrows the list) and copying or
 * revealing a secret. The recorder stores only event names and
 * timestamps — no item ids, names, fields, queries, or any other Vault
 * content — and it is disabled unless the build explicitly opts in
 * (injected `window.VEYORA_FIRST_SUCCESS_TELEMETRY = true` or the
 * `veyora-first-success=1` URL parameter). Nothing is ever transmitted;
 * the record lives in localStorage so a test harness can inspect it.
 */
import { STORAGE_KEYS } from '../config.js';

const SCHEMA_VERSION = 1;
const MAX_EVENTS = 100;

const EVENT_NAMES = Object.freeze([
  'login-saved',
  'search-performed',
  'secret-copied',
  'secret-revealed',
]);

let enabledCache;

function isEnabled() {
  if (enabledCache !== undefined) return enabledCache;
  enabledCache = false;
  try {
    if (typeof window !== 'undefined') {
      if (window.VEYORA_FIRST_SUCCESS_TELEMETRY === true) {
        enabledCache = true;
      } else {
        enabledCache = new URLSearchParams(window.location.search)
          .get('veyora-first-success') === '1';
      }
    }
  } catch {
    enabledCache = false;
  }
  return enabledCache;
}

function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEYS.firstSuccess);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && parsed.schema_version === SCHEMA_VERSION
      && Array.isArray(parsed.events) ? parsed : { schema_version: SCHEMA_VERSION, events: [] };
  } catch {
    return { schema_version: SCHEMA_VERSION, events: [] };
  }
}

function writeStore(store) {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEYS.firstSuccess,
      JSON.stringify({ schema_version: SCHEMA_VERSION, events: store.events }),
    );
  } catch {
    // Storage unavailable: instrumentation silently no-ops.
  }
}

function record(eventName) {
  if (!EVENT_NAMES.includes(eventName) || !isEnabled()) return false;
  const store = readStore();
  store.events.push({ event: eventName, at: Date.now() });
  if (store.events.length > MAX_EVENTS) {
    store.events = store.events.slice(-MAX_EVENTS);
  }
  writeStore(store);
  return true;
}

/**
 * First-success timestamp, or null until the full sequence exists: a
 * saved Login followed by both a search and a copy/reveal after that
 * save. Ordering uses the event-log position, not millisecond
 * timestamps, so events within one millisecond keep their true order.
 */
function achievedAt() {
  const { events } = readStore();
  const savedIdx = events.findIndex(item => item.event === 'login-saved');
  if (savedIdx < 0) return null;
  const searchedIdx = events.findIndex((item, index) =>
    index > savedIdx && item.event === 'search-performed');
  if (searchedIdx < 0) return null;
  const usedIdx = events.findIndex((item, index) => index > savedIdx
    && (item.event === 'secret-copied' || item.event === 'secret-revealed'));
  return usedIdx >= 0 ? events[usedIdx].at : null;
}

export const firstSuccess = Object.freeze({
  recordLoginSaved: () => record('login-saved'),
  recordSearchPerformed: () => record('search-performed'),
  recordSecretCopied: () => record('secret-copied'),
  recordSecretRevealed: () => record('secret-revealed'),
  achievedAt,
  /** Full event log for test-harness inspection (names + timestamps only). */
  snapshot: () => readStore().events.map(item => ({ ...item })),
  reset: () => writeStore({ schema_version: SCHEMA_VERSION, events: [] }),
});
