/**
 * Guards on the disposable-run launcher.
 *
 * `scripts/run-disposable-app.mjs` exists so that a dev run cannot silently open the maintainer's
 * real business data — the failure that actually occurred on 2026-08-18, when one `npm run app`
 * came from a shell window where the isolation variables had never been set. The refusals below
 * are the whole safety property, so they are tested here rather than left to inspection.
 *
 * This suite lives under `frontend/src/local/` for the same reason
 * `bootstrapCredentialTooling.test.mjs` does: it runs in the ordinary
 * `node --test frontend/src/local/*.test.mjs` gate. A script that stands between a dev command and
 * live data should not be the one piece with no gate on it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  APP_IDENTIFIER,
  disposableStamp,
  isLiveAppDataPath,
  resolveDisposableDir,
  tauriCliEntry,
  PROFILE_DATABASE,
  liveProfileDir,
  seedDisposableProfile,
} from "../../../scripts/run-disposable-app.mjs";

test("a path inside the live application data directory is refused", () => {
  // The exact shape of the real profile on Windows.
  const live = `C:\\Users\\Dell1Pc\\AppData\\Roaming\\${APP_IDENTIFIER}`;
  assert.equal(isLiveAppDataPath(live), true);
  assert.throws(
    () => resolveDisposableDir({ root: live }),
    /live application data/,
    "the launcher must never point the disposable run at the real profile",
  );
});

test("the identifier match is case-insensitive", () => {
  // Windows paths are case-insensitive; a differently-cased path is the same directory.
  assert.equal(isLiveAppDataPath("C:\\Users\\X\\AppData\\Roaming\\COM.SRTCOMPANY.FROOZERP"), true);
  assert.equal(isLiveAppDataPath("/home/user/Com.SrtCompany.Froozerp/data"), true);
});

test("ordinary disposable roots are accepted and made absolute", () => {
  const resolved = resolveDisposableDir({ root: "F:\\froozerp-disposable" });
  assert.equal(path.isAbsolute(resolved), true);
  assert.equal(isLiveAppDataPath(resolved), false);
});

test("a relative root is resolved to an absolute path, never left relative", () => {
  // The Rust guard rejects a relative FROOZERP_ISOLATED_SQLITE_DIR by falling back to LIVE data,
  // so a relative path reaching the child process would be the dangerous outcome, not a crash.
  const resolved = resolveDisposableDir({ root: "scratch-profiles" });
  assert.equal(path.isAbsolute(resolved), true);
});

test("no root falls back to the OS temp directory, not the repository or app data", () => {
  const resolved = resolveDisposableDir({ root: undefined });
  assert.equal(path.isAbsolute(resolved), true);
  assert.equal(isLiveAppDataPath(resolved), false);
  assert.ok(
    resolved.startsWith(path.resolve(os.tmpdir())),
    `expected a path under ${os.tmpdir()}, got ${resolved}`,
  );
});

test("each run gets its own directory, so no profile is ever inherited", () => {
  // Reusing a directory would mean a "fresh" run starting from a half-activated profile — which is
  // precisely what makes an activation-screen test lie.
  const first = resolveDisposableDir({ root: "/tmp/x", now: new Date("2026-08-18T10:03:16Z") });
  const second = resolveDisposableDir({ root: "/tmp/x", now: new Date("2026-08-18T10:03:17Z") });
  assert.notEqual(first, second);
});

test("the timestamp is fixed-width and sorts chronologically", () => {
  const early = disposableStamp(new Date(2026, 7, 18, 9, 3, 6));
  const later = disposableStamp(new Date(2026, 7, 18, 10, 3, 16));
  assert.match(early, /^\d{8}-\d{6}$/);
  assert.equal(early.length, later.length, "zero padding keeps names aligned and sortable");
  assert.ok(early < later, "later runs must sort after earlier ones");
});

test("an empty or whitespace root is treated as unset rather than as the current directory", () => {
  for (const root of ["", "   "]) {
    const resolved = resolveDisposableDir({ root });
    assert.ok(
      resolved.startsWith(path.resolve(os.tmpdir())),
      `empty root must fall back to temp, got ${resolved}`,
    );
  }
});

test("the launcher targets the CLI's .js entry, never the .cmd shim", () => {
  // Windows-only failure, found by running it there: Node refuses to spawn a .cmd directly and
  // fails with EINVAL (the CVE-2024-27980 hardening). `shell: true` would re-open that hole and
  // break on paths containing spaces, which C:\Users\... routinely does. Running the CLI's own
  // .js through process.execPath avoids the shell entirely and behaves the same on every platform.
  const entry = tauriCliEntry("/repo");
  assert.ok(entry.endsWith("tauri.js"), `expected a .js entry, got ${entry}`);
  assert.doesNotMatch(entry, /\.cmd$/, "a .cmd shim cannot be spawned on Windows");
  assert.doesNotMatch(entry, /node_modules[\\/]\.bin/, "the .bin shim is the platform-specific trap");
  assert.ok(entry.includes("@tauri-apps"), "it must come from the installed CLI package");
});

// -----------------------------------------------------------------------------------------------
// Named profiles.
//
// Entitlements are bound to a device id, and a fresh profile is a fresh device — so a fresh run
// always lands on the activation screen. Testing anything past it would mean signing a new .lic on
// every run. A named profile stays activated between runs, which is what makes the app testable at
// all; it must not cost any of the isolation the fresh path provides.
// -----------------------------------------------------------------------------------------------

test("a named profile resolves to the same directory every run", () => {
  const first = resolveDisposableDir({ root: "/tmp/froozerp-x", profile: "test" });
  const second = resolveDisposableDir({ root: "/tmp/froozerp-x", profile: "test", now: new Date(0) });
  assert.equal(first, second, "the whole point is that it survives between runs");
});

test("the default is still a fresh directory every run", () => {
  // Reuse must be opt-in. The failure this script exists to prevent is a run quietly inheriting
  // state, so the unnamed path has to keep being unpredictable.
  const a = resolveDisposableDir({ root: "/tmp/froozerp-x", now: new Date("2026-08-20T10:00:00Z") });
  const b = resolveDisposableDir({ root: "/tmp/froozerp-x", now: new Date("2026-08-20T10:00:01Z") });
  assert.notEqual(a, b);
});

test("a named profile cannot escape the disposable root", () => {
  // A name is a single path segment. Anything that could climb out defeats the only guarantee this
  // script makes, so it is refused rather than sanitised.
  for (const name of ["../escape", "a/b", "a\\b", "/etc", "x".repeat(65), "na me", "a;b"]) {
    assert.throws(
      () => resolveDisposableDir({ root: "/tmp/froozerp-x", profile: name }),
      `must refuse profile name ${JSON.stringify(name)}`,
    );
  }
});

test("a dot-only name stays inside the root instead of climbing", () => {
  // `..` passes the character check; containment is what stops it, and containment is asserted in
  // the resolver rather than left to the naming prefix.
  for (const name of ["..", "...", "."]) {
    const resolved = resolveDisposableDir({ root: "/tmp/froozerp-x", profile: name });
    assert.ok(
      resolved.startsWith("/tmp/froozerp-x/"),
      `${JSON.stringify(name)} escaped to ${resolved}`,
    );
  }
});

test("a named profile is refused inside live app data, exactly like a fresh one", () => {
  assert.throws(() => resolveDisposableDir({
    root: "/home/user/AppData/Roaming/com.srtcompany.froozerp",
    profile: "test",
  }));
});

// -----------------------------------------------------------------------------------------------
// Seeding from a copy of the live database.
//
// The point is that a disposable profile opens already activated, so testing never requires signing
// a licence. The risk is that a script which touches live business data gets one direction wrong,
// so the direction is what these tests pin.
// -----------------------------------------------------------------------------------------------

/** An in-memory stand-in, so no test ever touches a real profile directory. */
const fakeFs = (files) => {
  const store = new Map(Object.entries(files));
  return {
    store,
    writes: [],
    existsSync: (target) => store.has(target),
    copyFileSync(from, to) {
      if (!store.has(from)) throw new Error(`missing source ${from}`);
      this.writes.push({ from, to });
      store.set(to, store.get(from));
    },
  };
};

const LIVE = "/live/com.srtcompany.froozerp";
const DEST = "/tmp/froozerp-x/profile-test";

test("seeding copies the database so the profile is already activated", () => {
  // The device id and the entitlement bound to it both live in this file. Copying it is what makes
  // activation a one-time event rather than a per-run ritual.
  const fileSystem = fakeFs({ [`${LIVE}/${PROFILE_DATABASE}`]: "db" });
  const result = seedDisposableProfile({ sourceDir: LIVE, destinationDir: DEST, fileSystem });

  assert.equal(result.seeded, true);
  assert.deepEqual(result.files, [PROFILE_DATABASE]);
  assert.equal(fileSystem.store.get(`${DEST}/${PROFILE_DATABASE}`), "db");
});

test("the write-ahead log travels with the database", () => {
  // A copy that leaves a populated -wal behind is the database as of some earlier moment: a subtly
  // wrong starting state rather than an obviously broken one, which is worse to debug.
  const fileSystem = fakeFs({
    [`${LIVE}/${PROFILE_DATABASE}`]: "db",
    [`${LIVE}/${PROFILE_DATABASE}-wal`]: "wal",
    [`${LIVE}/${PROFILE_DATABASE}-shm`]: "shm",
  });
  const result = seedDisposableProfile({ sourceDir: LIVE, destinationDir: DEST, fileSystem });
  assert.deepEqual(result.files, [PROFILE_DATABASE, `${PROFILE_DATABASE}-wal`, `${PROFILE_DATABASE}-shm`]);
});

test("nothing is ever written back into the live profile", () => {
  // The one direction that must never reverse. A seeding script that wrote to the source would
  // corrupt the maintainer's real business data, which is the exact outcome this whole file exists
  // to make impossible.
  const fileSystem = fakeFs({ [`${LIVE}/${PROFILE_DATABASE}`]: "db" });
  seedDisposableProfile({ sourceDir: LIVE, destinationDir: DEST, fileSystem });
  for (const { to } of fileSystem.writes) {
    assert.ok(!to.startsWith(LIVE), `wrote into the live profile: ${to}`);
    assert.ok(to.startsWith(DEST), `wrote outside the disposable profile: ${to}`);
  }
});

test("seeding into live application data is refused outright", () => {
  const fileSystem = fakeFs({ [`${LIVE}/${PROFILE_DATABASE}`]: "db" });
  assert.throws(() => seedDisposableProfile({
    sourceDir: LIVE,
    destinationDir: "/home/user/AppData/Roaming/com.srtcompany.froozerp",
    fileSystem,
  }));
  assert.equal(fileSystem.writes.length, 0, "nothing may be copied before the refusal");
});

test("an existing disposable database is never overwritten", () => {
  // A second run must not silently replace a state the maintainer is mid-way through testing —
  // including one where they have just reproduced a bug.
  const fileSystem = fakeFs({
    [`${LIVE}/${PROFILE_DATABASE}`]: "live",
    [`${DEST}/${PROFILE_DATABASE}`]: "work in progress",
  });
  const result = seedDisposableProfile({ sourceDir: LIVE, destinationDir: DEST, fileSystem });

  assert.equal(result.seeded, false);
  assert.equal(fileSystem.store.get(`${DEST}/${PROFILE_DATABASE}`), "work in progress");
  assert.equal(fileSystem.writes.length, 0);
});

test("a missing live database reports why instead of throwing", () => {
  // Seeding is a convenience. Failing the whole run because there is nothing to copy would turn it
  // into a requirement.
  const result = seedDisposableProfile({ sourceDir: LIVE, destinationDir: DEST, fileSystem: fakeFs({}) });
  assert.equal(result.seeded, false);
  assert.match(result.reason, /no live database/);
});

test("the live profile path matches where the app actually stores its database", () => {
  // Pinned against src-tauri/src/lib.rs and backend/desktopGateway.js. A drift here means seeding
  // silently copies nothing and the maintainer is back to signing a licence every run.
  assert.match(liveProfileDir({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32"), /com\.srtcompany\.froozerp$/);
  assert.match(liveProfileDir({}, "linux"), /com\.srtcompany\.froozerp$/);
  assert.equal(PROFILE_DATABASE, "froozerp-local.sqlite3");
});
