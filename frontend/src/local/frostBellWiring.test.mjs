import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The bell wiring in App.jsx, held to the three things that would silently break it.
 *
 * `frostBellNotifications.js` decides *what* should be ringing and is tested on its own. What it
 * cannot test is the caller, and every way this feature has a chance of failing is in the caller:
 *
 *  1. **Retracting on a failed read.** The module returns one loud error row when it could not read
 *     the two lists, and on that answer it knows nothing about the rows it raised last time.
 *     Retracting them there would quietly delete real overdue warnings because a request timed out
 *     -- CLAUDE.md's "errors must never render as zero", with the bell as the victim.
 *  2. **Re-raising unchanged rows.** `addNotification` collapses a repeat by bumping its count and
 *     marking it unread again. That is right for a recurrence and wrong for a poll: every FROST row
 *     would be permanently unread, and a badge that is always lit is a badge nobody reads.
 *  3. **Loading only while the panel is open.** That is the bug the maintainer reported --
 *     "reminders notification bell me dikh jane chahiye". A reminder you only see after deciding to
 *     open FROST is one you have already remembered without it. The poll must not depend on
 *     `frostDrawerOpen`.
 *
 * These are source-text assertions, which is what this repo can check for a 17.7k-line component.
 * They are deliberately about the shape of the guard, not its exact spelling.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const appJsx = readFileSync(join(repoRoot, "frontend/src/App.jsx"), "utf8");

/** The body of the effect that publishes FROST rows into the bell. */
const publishEffect = () => {
  const start = appJsx.indexOf("const raisedFrostBellRows");
  assert.notEqual(start, -1, "App.jsx no longer keeps the raised FROST bell rows");
  const end = appJsx.indexOf("frostBellAllowed, notify, clearNotice]", start);
  assert.notEqual(end, -1, "the FROST bell publish effect could not be found after its ref");
  return appJsx.slice(start, end);
};

/** The body of the loader that fetches the two lists. */
const loader = () => {
  const start = appJsx.indexOf("const loadFrostBell = useCallback");
  assert.notEqual(start, -1, "App.jsx no longer loads the FROST bell lists");
  const end = appJsx.indexOf("deviceInfo?.device_id]);", start);
  assert.notEqual(end, -1, "the FROST bell loader's dependency list could not be found");
  return appJsx.slice(start, end);
};

test("the bell is fed by the tested module, not by a second copy of the judgement", () => {
  assert.match(appJsx, /import \{\s*FROST_BELL_STATUS,\s*buildFrostBellNotifications,\s*\} from "\.\/local\/frostBellNotifications"/);
  assert.match(publishEffect(), /buildFrostBellNotifications\(\{/);
});

test("rows are retracted only when the two lists were actually read", () => {
  const body = publishEffect();
  const guard = body.indexOf("FROST_BELL_STATUS.OK");
  assert.notEqual(guard, -1, "the retraction is no longer guarded on a readable answer");
  // Every clearNotice inside the publish effect must sit after that guard, except the one that runs
  // when FROST is not this person's at all -- there, nothing was read and nothing should be shown.
  const permissionExit = body.indexOf("if (!frostBellAllowed)");
  assert.notEqual(permissionExit, -1, "the publish effect no longer checks who FROST belongs to");
  const permissionExitEnd = body.indexOf("if (!frostBell.read)");
  assert.notEqual(permissionExitEnd, -1, "the publish effect no longer waits for a first read");
  let at = body.indexOf("clearNotice(");
  let found = 0;
  while (at !== -1) {
    const insidePermissionExit = at > permissionExit && at < permissionExitEnd;
    assert.ok(insidePermissionExit || at > guard,
      "a FROST bell row is retracted before the readable-answer guard, which would delete real warnings on a failed fetch");
    found += 1;
    at = body.indexOf("clearNotice(", at + 1);
  }
  assert.ok(found >= 2, "expected the publish effect to retract rows both on sign-out and on a clear condition");
});

test("an unchanged row is not raised again, so the badge can be cleared", () => {
  const body = publishEffect();
  assert.match(body, /raised\.get\(item\.dedupeKey\) === item\.message/,
    "the effect no longer skips rows whose wording has not changed; a poll would mark every FROST row unread forever");
});

test("the bell does not wait for the FROST panel to be opened", () => {
  const body = loader();
  assert.ok(!body.includes("frostDrawerOpen"),
    "the bell load depends on the FROST drawer, which is the bug this was built to fix");
  const timer = appJsx.indexOf("loadFrostBell(); }, 300000)");
  assert.notEqual(timer, -1, "the FROST bell no longer refreshes on its own");
});

test("a deliberate skip is stored as a skip, never as a failure", () => {
  const body = loader();
  assert.match(body, /shouldLoad[\s\S]*skipped: true/,
    "a FROST that was never asked -- LOCAL_ONLY, offline, no cloud session -- must not ring as a failure");
  assert.match(body, /catch \(error\)[\s\S]*error: getFrostDiagnosticMessage\(error/,
    "a request that was made and failed must be carried as an error, explained by the same ladder the panel uses");
});

test("only Owner and Admin poll FROST, matching the panel's own expression", () => {
  assert.match(appJsx, /const frostBellAllowed = user\?\.role === "Owner" \|\| user\?\.role === "Admin";/);
  assert.match(loader(), /if \(!user \|\| !frostBellAllowed\) return;/);
});
