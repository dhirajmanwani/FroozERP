"use strict";

/**
 * A disposable run must not read or write the real machine's connectivity policy.
 *
 * ## What went wrong
 *
 * `scripts/run-disposable-app.mjs` exists so a development run cannot touch live business data, and
 * its own header explains at length why an environment variable is not a safeguard. It isolates the
 * *database*. It never isolated the gateway's app-data directory, because the gateway computed that
 * for itself from `%APPDATA%` -- so `cloud-network-policy.json` and `cloud-request-audit.jsonl`
 * were the real ones no matter which profile was running.
 *
 * Found on 2026-09-03 in the middle of a rehearsal. A disposable profile seeded from live opened
 * announcing "This computer is being kept off the internet on purpose". That was true -- of the
 * maintainer's actual laptop, whose policy file still said so from an earlier session. The
 * rehearsal was reporting on the shop's machine instead of on itself, which is the one thing a
 * disposable run must never do.
 *
 * The reverse direction is worse and is what makes this more than cosmetic: a rehearsal that
 * changed the setting would have changed it for the installed app, and the audit log would carry
 * rehearsal entries indistinguishable from real ones.
 *
 * ## Why the variable is preferred rather than required
 *
 * The maintainer's installed app resolves its backend to the repository's own `backend/` folder, so
 * a `git pull` updates the shop's gateway while the shell binary stays whatever was last built. A
 * required variable would mean a newer gateway paired with an older shell resolved its policy to
 * nowhere -- and "nowhere" reads as an unreadable file, which fails closed and takes the shop
 * offline. Falling back to the previous derivation keeps that pairing behaving exactly as before.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GATEWAY = fs.readFileSync(path.join(__dirname, "desktopGateway.js"), "utf8");
const SHELL = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");

/** Load a fresh copy of the gateway's path resolution under a given environment. */
const resolvePathsUnder = (env) => {
  const previous = {};
  for (const key of ["FROOZERP_APP_DATA_DIR", "APPDATA", "FROOZERP_SQLITE_PATH"]) {
    previous[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    delete require.cache[require.resolve("./desktopGateway")];
    const loaded = require("./desktopGateway");
    return { policyPath: loaded.POLICY_PATH, auditPath: loaded.CLOUD_REQUEST_AUDIT_PATH };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve("./desktopGateway")];
  }
};

test("the shell tells the gateway which app-data directory to use", () => {
  assert.match(
    SHELL,
    /\.env\("FROOZERP_APP_DATA_DIR", app_data_dir\(\)\)/,
    "the gateway must be launched with the resolved app-data directory",
  );
  // `app_data_dir()` is the function that already honours FROOZERP_ISOLATED_SQLITE_DIR. Passing
  // anything else -- a literal, or %APPDATA% re-derived -- would reintroduce the hole.
  assert.match(SHELL, /fn app_data_dir\(\) -> PathBuf \{[\s\S]*FROOZERP_ISOLATED_SQLITE_DIR/, "and that function must be the isolated one");
});

test("an isolated run keeps its policy and audit log inside its own profile", () => {
  const isolated = path.join(os.tmpdir(), "froozerp-disposable", "profile-rehearsal");
  const real = path.join(os.tmpdir(), "real-appdata");
  const { policyPath, auditPath } = resolvePathsUnder({
    FROOZERP_APP_DATA_DIR: isolated,
    APPDATA: real,
  });

  assert.equal(policyPath, path.join(isolated, "cloud-network-policy.json"));
  assert.equal(auditPath, path.join(isolated, "logs", "cloud-request-audit.jsonl"));

  // The failure as it actually presented: the real file being read while a disposable profile ran.
  assert.equal(policyPath.startsWith(real), false, "the real app data must not be reached at all");
  assert.equal(auditPath.startsWith(real), false, "and the real audit log must not be appended to");
});

test("an ordinary install resolves exactly where it always did", () => {
  // The gateway ships as plain JS that a `git pull` can update ahead of the shell binary. If this
  // path changed, an updated backend under an older shell would look for its policy somewhere new,
  // find nothing, and -- since an unreadable policy fails closed -- take the shop off the cloud.
  const appData = path.join(os.tmpdir(), "roaming");
  const { policyPath, auditPath } = resolvePathsUnder({ APPDATA: appData });

  assert.equal(policyPath, path.join(appData, "com.srtcompany.froozerp", "cloud-network-policy.json"));
  assert.equal(auditPath, path.join(appData, "com.srtcompany.froozerp", "logs", "cloud-request-audit.jsonl"));
});

test("the override wins over APPDATA, and is not itself suffixed with the identifier", () => {
  // `app_data_dir()` already ends in `com.srtcompany.froozerp`. Joining it again would produce
  // `.../com.srtcompany.froozerp/com.srtcompany.froozerp`, which is a directory that exists, is
  // writable, and is silently the wrong one -- the hardest shape of this bug to notice.
  const dir = path.join(os.tmpdir(), "roaming", "com.srtcompany.froozerp");
  const { policyPath } = resolvePathsUnder({ FROOZERP_APP_DATA_DIR: dir, APPDATA: path.join(os.tmpdir(), "other") });
  assert.equal(policyPath, path.join(dir, "cloud-network-policy.json"));
  assert.equal(policyPath.includes(`com.srtcompany.froozerp${path.sep}com.srtcompany.froozerp`), false);
});

test("the gateway still resolves something when the shell is older than these files", () => {
  // No override at all: the pre-2026-09-03 derivation, unchanged.
  assert.match(GATEWAY, /process\.env\.FROOZERP_APP_DATA_DIR\s*\?/, "the override must be optional");
  assert.match(GATEWAY, /process\.env\.APPDATA/, "and the old derivation must remain as the fallback");
});
