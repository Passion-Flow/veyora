/**
 * Veyora web client configuration.
 *
 * Every tunable value used by the application lives here. Application code
 * must reference these constants — literal values in views and logic are
 * not permitted. Visual values are owned by src/styles/tokens.css.
 */

/** Product identity. The wordmark is text-only per brand guidelines. */
export const APP = Object.freeze({
  id: 'veyora',
  name: 'veyora', // i18n key `app.name` renders the display wordmark
  version: '1.0.0-preview',
  status: 'preview',
});

/** Security-related defaults and option tables. */
export const SECURITY = Object.freeze({
  password: Object.freeze({
    minLength: 8,
    /** Bits thresholds for the 5 strength tiers: <t0 <t1 <t2 <t3 <t4... */
    strengthThresholdsBits: Object.freeze([40, 60, 80, 110]),
  }),
  autoLock: Object.freeze({
    defaultMinutes: 5,
    optionsMinutes: Object.freeze([1, 5, 15, 30]),
  }),
  clipboard: Object.freeze({
    defaultSeconds: 30,
    optionsSeconds: Object.freeze([10, 20, 30, 60]),
  }),
  salt: Object.freeze({
    bytes: 16,
  }),
  vaultId: Object.freeze({
    bytes: 4,
  }),
});

/** Password generator rules. Character pools are protocol-level facts. */
export const GENERATOR = Object.freeze({
  length: Object.freeze({ min: 12, max: 64, default: 20 }),
  ambiguousCharacters: 'Il1O0o',
  sets: Object.freeze({
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower: 'abcdefghijklmnopqrstuvwxyz',
    digit: '0123456789',
    symbol: '!@#$%^&*()-_=+[]{};:,.?/',
  }),
});

/** Recovery kit encoding parameters. */
export const RECOVERY_KIT = Object.freeze({
  groups: 12,
  groupSize: 4,
  alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
  separator: ' ',
  checksumSeparator: ' · ',
});

/** Wire protocol constants shared by the kernel adapter and the API client. */
export const PROTOCOL = Object.freeze({
  version: 1,
  suiteId: 1,
  /** XChaCha20-Poly1305 nonce length in bytes. */
  nonceLength: 24,
  /** CBOR context for domain-separated record keys (kept byte-identical
   *  to values used by previously stored records). */
  recordKeyContext: Object.freeze([0x82, 0x40, 0x40]),
  recordAad: 'pm-v1/record-aad',
  /** Placeholder envelope hashes until template packs and manifests ship. */
  zeroHash: '0'.repeat(64),
});

/** Timing constants (demo staging; the real kernel replaces the waits). */
export const TIMING = Object.freeze({
  deriveStageMs: 500,
  decryptStageMs: 550,
  toastMs: 2600,
  deleteArmMs: 2600,
  lockTickMs: 1000,
  activityThrottleMs: 4000,
  searchDebounceMs: 120,
});

/** Vault data export (CSV) parameters — protocol-level column names. */
export const DATA_EXPORT = Object.freeze({
  filename: 'veyora-export.csv',
  columns: Object.freeze(['name', 'type', 'username', 'secret']),
  delimiter: ',',
});

/** localStorage keys — one namespace, no scattered strings. */
export const STORAGE_KEYS = Object.freeze({
  theme: 'veyora.web.theme',
  locale: 'veyora.web.locale',
  vault: 'veyora.web.vault',
});

/** Demo-stage behaviors that differ from the production client. */
export const DEMO = Object.freeze({
  enabled: true,
  wrongPasswordProbe: 'wrong',
});

/**
 * API endpoint resolution. Explicit before implicit, mirroring the legacy
 * client: stored override, injected global, then location heuristic.
 */
function resolveApiBaseUrl() {
  const stored = localStorage.getItem('veyora-api-url');
  if (stored) return stored;
  if (typeof window.VEYORA_API_BASE_URL === 'string' && window.VEYORA_API_BASE_URL) {
    return window.VEYORA_API_BASE_URL;
  }
  const devHosts = Object.freeze(['localhost', '127.0.0.1']);
  const devPorts = Object.freeze(['3000']);
  if (devHosts.includes(window.location.hostname) || devPorts.includes(window.location.port)) {
    return 'http://127.0.0.1:8080';
  }
  return window.location.origin + '/api';
}

export const API = Object.freeze({
  baseUrl: resolveApiBaseUrl(),
  paths: Object.freeze({
    health: '/healthz',
    records: '/records',
  }),
});
