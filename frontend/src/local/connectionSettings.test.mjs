import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * The connection settings must stay gone.
 *
 * ## What was removed, and why a test guards it
 *
 * Four settings decided one behaviour: **App Mode** (nine options), **Connectivity Mode**
 * (AUTO / LOCAL ONLY), a **Cloud API URL** box with two siblings, and a policy file on disk. All
 * four had to agree for the shop to sync, and nothing on screen said which one was in charge.
 *
 * On 2026-09-02 that cost an afternoon. The app reported "Local Only mode selected" on a machine
 * where nobody had selected it; the Cloud API URL box looked filled because its placeholder was a
 * plausible URL; and the diagnosis went through the internet, then a mode, then the box before
 * reaching the truth, which was that nobody had ever configured any of it and nothing said so.
 *
 * The maintainer -- who owns the shop this runs in -- ruled: *"mujhe khud switch krne ki zarurat hi
 * nhi padni chahiye"*. Net nahi hai to local chale, net aa jaye to apne aap sync ho jaye.
 *
 * ## Why this is a test and not just a deletion
 *
 * Every one of these controls was added by somebody solving a real problem in front of them, and
 * each is a natural thing to add again the next time a machine will not sync. A deleted control
 * comes back; a failing test explains why it should not. `docs/connection-simplification-decision.md`
 * carries the full reasoning.
 *
 * What is emphatically **not** removed is the LOCAL_ONLY engine. `CLAUDE.md` requires that when the
 * kill switch is on, nothing reaches the cloud -- blocked, no cloud-router calls, no external
 * connections -- and those guarantees are unchanged and still tested in
 * `desktopGatewayOwnerControl.test.js` and `storageAdapters.test.js`. It simply is not a control a
 * shopkeeper can reach.
 */

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

/**
 * The same source with comments removed, for the "must not exist" checks.
 *
 * Those checks would otherwise fail on the comments left behind explaining what was removed and
 * why -- a guard reporting a violation it is itself the only instance of. It has happened twice in
 * this repository already, so the stripping is deliberate rather than incidental: the assertions
 * below are about what the app *does*, and a comment does nothing.
 */
const code = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("no screen asks anybody to pick a mode", () => {
  assert.doesNotMatch(code, /Select App Mode/, "the App Mode dropdown must stay gone");
  assert.doesNotMatch(code, /API_MODE_OPTIONS/, "and the list that filled it");
  assert.doesNotMatch(code, /aria-label="Connectivity Mode"/, "the AUTO / LOCAL ONLY pair must stay gone");
  assert.doesNotMatch(code, />Save Mode</, "and the button that saved the result");
});

test("no screen asks anybody to type a server address", () => {
  // The specific trap: grey placeholder text in an empty box, reported in good faith as a filled-in
  // value. Any of these three coming back brings that reading back with it.
  assert.doesNotMatch(code, /label="Cloud API URL"><input disabled=\{!canManage\}/, "the editable Cloud API URL box must stay gone");
  assert.doesNotMatch(code, /placeholder="https:\/\/api\.froozerp\.com"/, "and the placeholder that read as a value");
  assert.doesNotMatch(code, /label="Branch Server URL\/IP"/, "the branch server box must stay gone");
  assert.doesNotMatch(code, /label="Custom API URL"><input disabled=\{!canManage\}/, "and the custom one");
});

test("the addresses are still shown as facts, because a diagnosis needs them", () => {
  // Removing the *questions* is the point; removing the *answers* would replace one silent failure
  // with another. These are disabled rows in Advanced Diagnostics, and "Copy Safe Diagnostics"
  // depends on them being visible somewhere.
  assert.match(app, /label="Cloud API URL"><input disabled value=\{API_CONFIG\.cloudApiUrl\}/);
  assert.match(app, /label="Selected API URL"><input disabled value=\{API_CONFIG\.apiUrl\}/);
});

test("the shop is told what is happening in words, not in state names", () => {
  assert.match(app, /resolveConnectionStatus\(\{/, "the plain-language module must be wired in");
  assert.match(app, /connectionSentence\.headline/, "and its sentence rendered");
  assert.match(app, /connectionSentence\.showsInTopBar/, "including its own decision about when to stay quiet");
});

test("the engine underneath is untouched", () => {
  // The modes still exist and still decide where requests go. What changed is that nobody is asked
  // which one applies. Deleting these would be a different and much larger change, and this test
  // exists partly to make that distinction legible to whoever reads the diff next.
  assert.match(app, /const API_MODES = Object\.freeze\(\{/);
  assert.match(app, /const API_MODE_RESOLUTION = resolveApiMode\(\{/);
  assert.match(app, /CONNECTIVITY_MODES\.LOCAL_ONLY/, "the kill switch must still be expressible");
  assert.match(app, /createCloudCallGuard\(\{/, "and the guard that enforces it must still be built");
});

test("the cloud address comes from the build, not from saved settings", () => {
  // The runtime fallback, and the two things it must not be: a development default (a rehearsal
  // opens a copy of live data) or something written back to localStorage (`sanitizeSavedApiConfig`
  // ForRuntime refuses to persist defaults precisely because that re-poisons the saved config).
  const start = app.indexOf("const BUILT_IN_DESKTOP_CLOUD_API_URL");
  assert.notEqual(start, -1, "the built-in address must exist");
  const declaration = app.slice(start, app.indexOf("const CLOUD_API_URL", start));
  assert.match(declaration, /isDesktopShell\(\) && !import\.meta\.env\.DEV/, "desktop release builds only");
  assert.match(declaration, /DEFAULT_PRODUCTION_CLOUD_API_URL/, "and it must be the one production address");
  assert.doesNotMatch(declaration, /writeSavedApiConfig/, "it must never be persisted");

  // Order matters: anything explicitly configured has to win over the built-in fallback, or a
  // deliberately pointed installation would be silently redirected to production.
  const chain = app.slice(app.indexOf("const CLOUD_API_URL"), app.indexOf("const CUSTOM_API_URL"));
  assert.ok(
    chain.indexOf("SAVED_API_CONFIG.cloudApiUrl") < chain.indexOf("BUILT_IN_DESKTOP_CLOUD_API_URL"),
    "a saved address must be consulted before the built-in one",
  );
  assert.ok(
    chain.indexOf("VITE_CLOUD_API_URL") < chain.indexOf("BUILT_IN_DESKTOP_CLOUD_API_URL"),
    "and so must an explicitly configured one",
  );
});
