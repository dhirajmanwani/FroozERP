const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { liveDesktopSqlitePath, resolveDesktopSqlitePath } = require("./storageAdapters");

/**
 * `node backend/server.js` with an empty environment resolves to desktop-local and opens the real
 * shop's profile on the real port. That is the documented local run, and it is also where an
 * operator lands who meant to start an isolated backend in a shell that had none of its variables
 * -- which happened on 2026-09-19 during a release rehearsal. Nothing was written, because the
 * desktop-local branch returns before any bootstrap, but nothing said which profile had been
 * opened either: the only signal was recognising an AppData path in a startup line.
 *
 * These pin the two halves of the fix: a path that says which profile is the live one, and a
 * startup that compares against it and says so in words.
 */

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("the live desktop profile path ignores an override, so it always names the real profile", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-live-path-"));
  const override = path.join(base, "isolated", "x.sqlite3");
  const env = { ...process.env, FROOZERP_SQLITE_PATH: override };

  // resolveDesktopSqlitePath honours the override -- that is how isolation works at all.
  assert.equal(resolveDesktopSqlitePath(env), path.resolve(override));

  // liveDesktopSqlitePath must answer a different question: where the profile would be with no
  // isolation. An override-honouring version would report every isolated run as live, so the
  // warning would fire on exactly the runs that are already safe and be ignored by the time it
  // mattered. Asserted as a relationship rather than a literal path, because the default location
  // is platform-specific and this suite has to mean the same thing on Windows and here.
  assert.notEqual(liveDesktopSqlitePath(env), path.resolve(override));
  assert.equal(
    liveDesktopSqlitePath(env),
    resolveDesktopSqlitePath({ ...process.env, FROOZERP_SQLITE_PATH: "" }),
  );
  assert.match(liveDesktopSqlitePath(env), /com\.srtcompany\.froozerp/);
});

test("with nothing set, the resolved path and the live path are the same file", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-live-path-"));
  const env = { APPDATA: base, HOME: base };
  assert.equal(resolveDesktopSqlitePath(env), liveDesktopSqlitePath(env));
});

test("startup compares the opened profile against the live one and warns in words", () => {
  const branch = SERVER.slice(SERVER.indexOf("const prepareDatabaseForStartup"));
  const desktopBranch = branch.slice(0, branch.indexOf("schema bootstrap completed by Tauri SQLite migration runner"));

  assert.match(desktopBranch, /liveDesktopSqlitePath\(\)/, "the desktop-local branch must consult the live path");
  assert.match(desktopBranch, /path\.resolve\(storageHealth\.databasePath\)/, "and compare resolved paths, not raw strings");
  assert.match(desktopBranch, /THIS IS THE LIVE PROFILE/, "and say so unmissably rather than printing a path");
  assert.match(desktopBranch, /console\.warn/, "on the warning stream, not among the ordinary startup chatter");
});

test("the warning names the isolated launcher, so the reader has somewhere to go", () => {
  const start = SERVER.indexOf("THIS IS THE LIVE PROFILE");
  const warning = SERVER.slice(start, start + 900);
  assert.match(warning, /app:disposable/, "a warning that does not say what to do instead gets read once and ignored");
});

test("liveDesktopSqlitePath is exported, so the warning cannot drift from the resolver", () => {
  const adapters = fs.readFileSync(path.join(__dirname, "storageAdapters.js"), "utf8");
  assert.match(adapters, /liveDesktopSqlitePath,/);
  assert.match(SERVER, /liveDesktopSqlitePath \} = require\("\.\/storageAdapters"\)|liveDesktopSqlitePath,?\s*\} = require\("\.\/storageAdapters"\)/);
});
