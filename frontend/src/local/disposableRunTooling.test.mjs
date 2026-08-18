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
