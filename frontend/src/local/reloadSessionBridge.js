/**
 * Carry a signed-in session across the one `window.location.reload()` that `saveApiConfig` performs
 * after changing which backend the app talks to.
 *
 * ## Why the reload exists at all
 *
 * `LOCAL_API_URL`, `CLOUD_API_URL`, `API_URL` and friends in `App.jsx` are plain module-level
 * `const`s, computed once when the script loads from `localStorage`. Changing the saved API mode
 * does not make the running app pick up the new URLs — only a fresh script evaluation does. The
 * reload is how the new mode actually takes effect; there is no way to remove it without turning
 * those constants into reactive state, which is a larger change than this bridges.
 *
 * ## Why the reload used to mean "log in again"
 *
 * `user` is `useState(null)` with no persistence at all. A full page reload re-runs every hook from
 * scratch, so the session was gone the instant the page came back — the maintainer saw this happen
 * on real hardware and asked for it not to. This module exists to answer exactly that, and nothing
 * more: it is a one-shot relay for a reload the app itself triggers, not a "stay signed in" or
 * "remember me" feature. It has no path back to `user` except through a real `/login` response.
 *
 * ## Why `sessionStorage`, not `localStorage`
 *
 * `sessionStorage` is cleared the moment the tab/window actually closes and is never written to
 * disk by the browser the way `localStorage` effectively is. That is the right lifetime for
 * bridging one reload — the session must not quietly outlive the window it was borrowed from, and
 * it must never become a second, undocumented place credentials sit at rest.
 *
 * ## Why a short TTL, and single-use
 *
 * The value is read and deleted in the same call. If the reload never happens — the app crashes, or
 * the tab is closed and reopened by hand before it completes — a lingering entry must not resurrect
 * an old session at some unrelated later startup. The TTL is generous for a `setTimeout(..., 500)`
 * reload and stingy for anything else.
 */

const STORAGE_KEY = "froozerp_reload_session_bridge_v1";
const MAX_AGE_MS = 30_000;

const storage = () => {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    // Some embedding contexts (a locked-down webview, a privacy mode) throw merely on access.
    return null;
  }
};

/**
 * Stash the current session immediately before triggering the reload that needs it back.
 *
 * A no-op, not a throw, when there is nothing to stash or storage is unavailable — this bridge is a
 * convenience for the common case, and its absence must degrade to "log in again", never to a
 * crash on the settings screen.
 */
export const stashSessionForReload = (user, { nowMs = Date.now() } = {}) => {
  const store = storage();
  if (!store || !user || typeof user !== "object") return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ user, stashedAtMs: nowMs }));
  } catch {
    // Storage full or disabled; the reload will just land on the login screen as it always did.
  }
};

/**
 * Read back a stashed session, once. Always removes the key, whether or not it was usable, so a
 * malformed or stale entry can never be read twice or block a future stash.
 *
 * @returns the stashed user object, or `null` if there was nothing usable to restore.
 */
export const consumeStashedSessionForReload = ({ nowMs = Date.now() } = {}) => {
  const store = storage();
  if (!store) return null;
  let raw;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Best effort; an unreadable/unremovable store already failed the read below in practice.
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.user || typeof parsed.user !== "object") return null;
  const stashedAtMs = Number(parsed.stashedAtMs);
  if (!Number.isFinite(stashedAtMs) || nowMs - stashedAtMs > MAX_AGE_MS || nowMs < stashedAtMs) return null;
  return parsed.user;
};
