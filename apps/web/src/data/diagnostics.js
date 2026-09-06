/**
 * Safe diagnostics data (DIAG-001).
 *
 * Everything here is deliberately derived from non-secret sources: the
 * product version authority, the build stamp, the service origin host, and
 * a bare last-synchronization timestamp. No record content, no tokens, no
 * salts, no full service URLs.
 */
import { API, APP, STORAGE_KEYS } from '../config.js';
import { storage } from '../core/storage.js';

/** Stamp a successful service synchronization (a timestamp only). */
export function markSynced() {
  storage.set(STORAGE_KEYS.lastSync, new Date().toISOString());
}

/** Last successful synchronization as an ISO string, or null. */
export function lastSyncIso() {
  return storage.get(STORAGE_KEYS.lastSync);
}

/**
 * Build identity stamped into the image at build time
 * (deploy/web/Dockerfile, VEYORA_BUILD_COMMIT). Returns null when the
 * image was not stamped — displayed honestly, never guessed.
 */
export function buildCommit() {
  let value = '';
  try {
    value = String(globalThis.window?.VEYORA_BUILD_COMMIT || '');
  } catch {
    value = '';
  }
  return value && value !== 'unknown' ? value : null;
}

/**
 * True when this client runs inside the desktop shell (the Tauri WebView
 * injects `window.VEYORA_DESKTOP` before any client script). The desktop
 * hosts a local vault against an embedded loopback API, so diagnostics
 * must report a local vault — never a connected-vault mode or a service
 * host — for that runtime.
 */
export function isDesktopRuntime() {
  try {
    return globalThis.window?.VEYORA_DESKTOP === true;
  } catch {
    return false;
  }
}

/**
 * Safe service location summary: the origin host only. Never the full
 * URL, path, query, or connection token. A relative API base means the
 * service sits behind this page's origin, so the page host is the summary.
 * Desktop callers must not use this: a loopback host is meaningless as a
 * user-facing storage summary there.
 */
export function serviceHost() {
  try {
    if (typeof window !== 'undefined') {
      const base = API.baseUrl;
      if (base && !base.startsWith('/')) return new URL(base).host;
      return window.location.host || null;
    }
  } catch {
    // Fall through to the honest unknown below.
  }
  return null;
}

/**
 * Vault identity summary for the locked/unlocked screens (PRD 6.3): a
 * location descriptor only, never a secret. Desktop reports the local
 * device; connected runtimes report the origin host alone; a missing
 * summary is reported as unknown rather than guessed. Views pair this
 * with the localized default vault name — the identity never includes
 * tokens, paths, or full URLs.
 */
export function vaultIdentity() {
  if (isDesktopRuntime()) return { kind: 'desktop', host: null };
  const host = serviceHost();
  return host ? { kind: 'connected', host } : { kind: 'unknown', host: null };
}

/**
 * Probe the service health endpoint (process-alive only; the endpoint is
 * unauthenticated and returns no data). Resolves to 'ok', 'unhealthy',
 * or 'unreachable'.
 */
export async function serviceHealth() {
  try {
    const response = await fetch(`${API.baseUrl}${API.paths.health}`);
    return response.ok ? 'ok' : 'unhealthy';
  } catch {
    return 'unreachable';
  }
}

/**
 * Build the opt-in support bundle text (DIAG-002).
 *
 * The bundle is a plain-text engineering artifact with fixed English
 * labels (non-localizable, like the API error messages): a support
 * engineer must be able to read it regardless of the user's locale.
 * Content is derived only from the DIAG-001 safe sources — version,
 * build stamp, mode, origin host, health, last-sync timestamp, and the
 * backup status — never from records, credentials, tokens, salts, or
 * full URLs. Nothing here uploads; the user previews and copies it.
 */
export function buildSupportBundle(health) {
  const location = isDesktopRuntime()
    ? 'storage: local vault on this device'
    : `service-host: ${serviceHost() || 'unknown'}`;
  return [
    'Veyora support bundle',
    `version: ${APP.version}`,
    `build: ${buildCommit() || 'not-stamped'}`,
    `mode: ${isDesktopRuntime() ? 'desktop-local-vault' : 'connected-vault'}`,
    location,
    `service-health: ${typeof health === 'string' ? health : 'unknown'}`,
    `last-sync: ${lastSyncIso() || 'never'}`,
    'last-verified-backup: not-available',
  ].join('\n');
}
