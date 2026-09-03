import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A development build and the shop's installed app must never want the same port.
 *
 * ## What this is for
 *
 * On 2026-08-20 a `tauri dev` build bound port 5000 and stayed up. On 2026-09-02 -- thirteen days
 * later -- the maintainer opened his installed app to bill, and it refused to start: the port was
 * owned by a process reporting a version it did not recognise. Nothing in the message said
 * "another copy of this app is holding the port", so the failure read as a broken install. The
 * shop could not bill for those thirteen days.
 *
 * `scripts/run-disposable-app.mjs` already isolates the *database* from live app data, and its own
 * header explains at length why an environment variable is not a safeguard. It never isolated the
 * port, and a port is exactly as exclusive as a file.
 *
 * ## Why both sides are checked here
 *
 * The port is decided twice, independently: in Rust from `cfg!(debug_assertions)`, and in the
 * frontend from `import.meta.env.DEV`. That duplication is deliberate -- neither side can ask the
 * other before it starts -- but it means the two can drift.
 *
 * Drift is worse than either value being wrong. A dev frontend calling 5000 while its own backend
 * listens on 5051 does not fail: it succeeds, against the **shop's** backend, writing to live
 * business data while the developer believes they are in a sandbox. That is the failure this file
 * exists to make impossible, and it is why the numbers are compared rather than merely present.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUST = fs.readFileSync(path.join(HERE, "..", "..", "..", "src-tauri", "src", "lib.rs"), "utf8");
const APP = fs.readFileSync(path.join(HERE, "..", "App.jsx"), "utf8");
const TAURI_CONF = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "..", "..", "src-tauri", "tauri.conf.json"), "utf8"),
);

const rustConst = (name) => RUST.match(new RegExp(`const ${name}: &str = "(\\d+)"`))?.[1];
const jsConst = (name) => APP.match(new RegExp(`const ${name} = "(\\d+)"`))?.[1];

test("both sides name a shop port and a development port", () => {
  assert.equal(rustConst("LOCAL_BACKEND_PORT"), "5000", "the installed app keeps the port it has always had");
  assert.ok(rustConst("DEV_BACKEND_PORT"), "Rust must declare a development port");
  assert.ok(jsConst("SHOP_BACKEND_PORT"), "the frontend must declare the shop port");
  assert.ok(jsConst("DEV_BACKEND_PORT"), "the frontend must declare a development port");
});

test("the two sides agree, digit for digit", () => {
  // The drift case. A mismatch does not fail loudly -- it points a dev build at the shop's backend.
  assert.equal(jsConst("SHOP_BACKEND_PORT"), rustConst("LOCAL_BACKEND_PORT"));
  assert.equal(jsConst("DEV_BACKEND_PORT"), rustConst("DEV_BACKEND_PORT"));
});

test("the development port is not the shop's port", () => {
  // The whole point. If these are ever made equal again, thirteen days is the cost.
  assert.notEqual(rustConst("DEV_BACKEND_PORT"), rustConst("LOCAL_BACKEND_PORT"));
  assert.notEqual(jsConst("DEV_BACKEND_PORT"), jsConst("SHOP_BACKEND_PORT"));
});

test("each side chooses by how it was built, not by an environment variable", () => {
  // A variable has to be typed correctly in every terminal window. `run-disposable-app.mjs` exists
  // because that was tried and a `npm run app` from the wrong window still reached live data.
  assert.match(
    RUST,
    /if cfg!\(debug_assertions\) \{\s*return DEV_BACKEND_PORT\.to_string\(\);/,
    "Rust must pick the development port from the build profile",
  );
  assert.match(
    APP,
    /const LOCAL_BACKEND_PORT = import\.meta\.env\.DEV \? DEV_BACKEND_PORT : SHOP_BACKEND_PORT;/,
    "the frontend must pick it from the build mode",
  );
});

test("no local API address hardcodes a port any more", () => {
  // A leftover `127.0.0.1:5000` in the desktop path would send a dev build to the shop's backend
  // however carefully the constants above are maintained.
  assert.doesNotMatch(
    APP,
    /isDesktopShell\(\) \? "http:\/\/127\.0\.0\.1:5000"/,
    "the desktop API base must be built from LOCAL_BACKEND_PORT",
  );
});

test("an address on the development port still counts as a local address", () => {
  // `pointsToLocalApi` decides whether a saved configuration is talking to a local backend. If it
  // did not recognise the development port, a dev run would classify itself as cloud -- and the
  // LOCAL_ONLY guarantees are decided from that classification.
  const guard = APP.match(/return \/localhost\|[^/]*\/i\.test\(url\);/)?.[0] || "";
  assert.match(guard, /:5000/, "the shop port must still count");
  assert.match(guard, new RegExp(`:${jsConst("DEV_BACKEND_PORT")}`), "and so must the development port");
});

test("the technical details panel names the port it actually checked", () => {
  // It said "Port 5000 PID" as a fixed string. On a development build that is now the wrong port,
  // and a diagnostics panel that reports a number it did not look at is worse than one that omits
  // it -- somebody reads "No listener" and goes hunting for a backend that is running fine.
  assert.match(
    APP,
    /\[`Port \$\{LOCAL_BACKEND_PORT\} PID`/,
    "the row label must be built from the port the app uses",
  );
});

test("a release build running from a checkout says so, and a dev build does not", () => {
  // The maintainer's installed app resolves its backend to the repository's own backend folder, so
  // every `git pull` changes the shop's software. That had been true for months with nothing
  // anywhere reporting it.
  //
  // Warned rather than refused: a refusal would leave the shop unable to bill on the spot, and the
  // fix -- moving the installation -- needs a person and an installer. Debug builds are exempt,
  // because a development build is supposed to run from the checkout and warning every time would
  // train the reader to ignore the line.
  assert.match(RUST, /fn source_checkout_warning_for/, "Rust must decide whether to warn");
  const fn = RUST.slice(RUST.indexOf("fn source_checkout_warning_for"), RUST.indexOf("fn resolve_backend_dir"));
  assert.match(fn, /if cfg!\(debug_assertions\) \{\s*return String::new\(\);/, "a dev build must stay quiet");
  assert.match(fn, /backend_dir_is_in_checkout/, "and a release build must check for a checkout");
  assert.match(APP, /source_checkout_warning/, "the panel must read the warning");
  assert.match(APP, /Running from source/, "and show it under a label somebody would notice");
});

test("the shell's content policy lets a development build reach its own backend", () => {
  // Moving the development port was not enough on its own. The Tauri content-security-policy names
  // the addresses the page may talk to, and it listed only 5000 -- so a dev build would have been
  // blocked from reaching the backend it had just started, with the browser refusing the request
  // rather than anything explaining why.
  //
  // Two policies rather than one: the shipped app has no business connecting to a development port,
  // and widening the production policy to make development convenient is how a shipped app ends up
  // able to reach more than it needs.
  const security = TAURI_CONF.app.security;
  const devPort = jsConst("DEV_BACKEND_PORT");
  const shopPort = jsConst("SHOP_BACKEND_PORT");

  assert.ok(security.devCsp, "a development policy must exist");
  assert.ok(security.devCsp.includes(`http://127.0.0.1:${devPort}`), "and must allow the development port");
  assert.ok(security.devCsp.includes(`http://127.0.0.1:${shopPort}`), "while still allowing the shop port");

  assert.ok(security.csp.includes(`http://127.0.0.1:${shopPort}`), "the shipped policy keeps the shop port");
  assert.ok(
    !security.csp.includes(devPort),
    "and must not be widened to the development port -- the shipped app never talks to it",
  );
});
