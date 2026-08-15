/**
 * Safe localStorage access.
 *
 * Storage can throw (private-mode Safari historically) or be absent
 * (non-browser hosts such as the Node test runner). Every access funnels
 * through here so a hostile storage never crashes the app.
 */
export const storage = {
  get(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // Storage unavailable: preferences simply do not persist.
    }
  },
  remove(key) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // Storage unavailable: nothing to remove.
    }
  },
};
