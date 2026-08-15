/**
 * Password strength estimation.
 *
 * Charset-size heuristic: entropy = length × log2(pool size). Thresholds
 * come from configuration so policy changes never touch view code.
 */
import { SECURITY } from '../config.js';

/** i18n label keys for each strength tier. */
const LABEL_KEYS = Object.freeze(['strength.weak', 'strength.fair', 'strength.good', 'strength.strong', 'strength.excellent']);

function charsetSize(password) {
  let size = 0;
  if (/[a-z]/.test(password)) size += 26;
  if (/[A-Z]/.test(password)) size += 26;
  if (/[0-9]/.test(password)) size += 10;
  if (/[^a-zA-Z0-9]/.test(password)) size += 32;
  return size;
}

/**
 * Estimate strength for a password.
 * @returns {{bits:number, segments:number, labelKey:string}}
 */
export function strength(password) {
  if (!password) return { bits: 0, segments: 0, labelKey: LABEL_KEYS[0] };
  const bits = Math.round(password.length * Math.log2(charsetSize(password) || 1));
  const thresholds = SECURITY.password.strengthThresholdsBits;
  const tier = thresholds.filter(threshold => bits >= threshold).length;
  const index = Math.min(tier, LABEL_KEYS.length - 1);
  return { bits, segments: index + 1, labelKey: LABEL_KEYS[index] };
}
