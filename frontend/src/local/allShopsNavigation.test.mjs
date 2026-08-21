import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The All Shops item is wired into the sidebar, and wired Owner-only.
 *
 * Asserted against `App.jsx` source text, which is the existing convention in this directory for
 * things that live in that file and cannot otherwise be reached. It exists because the item failed
 * to appear on the maintainer's machine on first run and there was no automated answer to "is the
 * wiring actually there" — every check had to be done by hand against a 17k-line file.
 *
 * Five separate places have to agree for a view to show up. Each is asserted here so a failure
 * names the one that is missing instead of leaving someone to find it.
 */

const app = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"),
  "utf8",
);

test("All Shops is registered in the sidebar navigation", () => {
  assert.match(app, /\["all-shops", "All Shops"\]/);
});

test("All Shops has an icon, so the sidebar entry is not a blank space", () => {
  // It shipped without one. `Icon` renders `{paths[name]}`, and an unknown name is `undefined`,
  // which React renders as nothing — no crash, no warning, just a button with no glyph beside
  // every other one that has a glyph.
  assert.match(app, /"all-shops":\s*"[a-z]+"/);
});

test("All Shops has a render path", () => {
  assert.match(app, /activeView === "all-shops"/);
});

test("All Shops loads its data when navigated to", () => {
  assert.match(app, /if \(view === "all-shops"\) await loadAllShops\(\);/);
});

test("All Shops is Owner-only, and decided before the general permission test", () => {
  // Admin's default permissions are `{ all: true }`, so anything reaching the general test is open
  // to Admin. The Owner check must therefore come first inside hasModuleAccess, and this asserts
  // the ordering rather than merely the presence of a check.
  const start = app.indexOf("const hasModuleAccess = (view) => {");
  assert.ok(start > 0, "hasModuleAccess must exist");
  const body = app.slice(start, start + 1600);
  const ownerCheck = body.indexOf('view === "all-shops"');
  const generalCheck = body.indexOf("defaultPermissions.all");
  assert.ok(ownerCheck > 0, "all-shops must be gated inside hasModuleAccess");
  assert.ok(generalCheck > 0, "the general permission test must still exist");
  assert.ok(
    ownerCheck < generalCheck,
    "the Owner gate must be decided before the general test, or Admin gets in through `all: true`",
  );
  assert.match(body.slice(ownerCheck - 60, ownerCheck + 120), /OWNER/);
});

test("All Shops is classified as needing the backend, not as offline-capable", () => {
  // No device holds another shop's books, so this view has no local fallback. Listing it as an
  // offline local-data view would promise a snapshot that cannot exist.
  const offlineLocal = app.match(/const offlineLocalDataViews = new Set\(\[([^\]]*)\]\)/);
  const backendRequired = app.match(/const offlineBackendRequiredViews = new Set\(\[([^\]]*)\]\)/);
  assert.ok(offlineLocal && backendRequired, "both offline view sets must exist");
  assert.doesNotMatch(offlineLocal[1], /all-shops/);
  assert.match(backendRequired[1], /all-shops/);
});
