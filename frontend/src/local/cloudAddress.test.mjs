import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The app must know its own cloud without being told.
 *
 * ## What went wrong
 *
 * `src-tauri/src/lib.rs` launched `desktopGateway.js` with no cloud address. The gateway therefore
 * had no cloud target and refused every cloud route by name -- on a machine with working internet.
 * From the app's side that is indistinguishable from being offline, so nothing said so.
 *
 * The frontend half of the same gap was a **Cloud API URL** text box whose placeholder,
 * `https://api.froozerp.com`, read exactly like a filled-in value. On 2026-09-02 the maintainer
 * looked straight at it and reported the field as set. It was empty.
 *
 * ## What is checked here, and why here
 *
 * The address is now a build-time fact on both sides, the way the backend port is. The same drift
 * argument applies and is worse: two sides naming *different* clouds does not fail loudly, it
 * splits the shop's data across two databases, and neither one is obviously wrong on screen.
 *
 * The debug case is the other half. `npm run app:disposable` seeds itself from a copy of live
 * business data; a development build that quietly synced that copy into production would be worse
 * than anything the rehearsal was meant to catch. So a development build gets no cloud unless it is
 * handed one explicitly.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUST = fs.readFileSync(path.join(HERE, "..", "..", "..", "src-tauri", "src", "lib.rs"), "utf8");
const APP = fs.readFileSync(path.join(HERE, "..", "App.jsx"), "utf8");
const GATEWAY = fs.readFileSync(path.join(HERE, "..", "..", "..", "backend", "desktopGateway.js"), "utf8");

const rustString = (name) => RUST.match(new RegExp(`const ${name}: &str = "([^"]+)"`))?.[1];
const jsString = (source, name) => source.match(new RegExp(`const ${name} = "([^"]+)"`))?.[1];

const cloudFn = RUST.slice(RUST.indexOf("fn cloud_api_url"), RUST.indexOf("fn local_backend_url"));

test("the shell hands the gateway a cloud address at all", () => {
  // The line whose absence was the whole fault. Without it the gateway's CLOUD_API_URL is empty,
  // CLOUD_TARGET_CONFIGURED is false, and every cloud route is refused as CLOUD_NOT_CONFIGURED.
  assert.match(
    RUST,
    /\.env\("CLOUD_API_URL", cloud_api_url\(\)\)/,
    "the desktop gateway must be launched with a cloud address",
  );
  assert.match(GATEWAY, /process\.env\.CLOUD_API_URL/, "and the gateway must read it");
});

test("both sides name the same cloud, character for character", () => {
  // Drift here does not error. It splits one shop's bills across two databases.
  const rust = rustString("PRODUCTION_CLOUD_API_URL");
  const frontend = jsString(APP, "DEFAULT_PRODUCTION_CLOUD_API_URL");
  assert.ok(rust, "Rust must name the production cloud");
  assert.ok(frontend, "the frontend must name the production cloud");
  assert.equal(rust, frontend);
});

test("the address is a real hosted URL, not a placeholder or a local one", () => {
  // `https://api.froozerp.com` is the placeholder that was mistaken for a value; it resolves to
  // nothing. A localhost address baked into a shipped build would be worse still -- every counter
  // would "sync" to itself and quietly diverge.
  const rust = rustString("PRODUCTION_CLOUD_API_URL");
  const parsed = new URL(rust);
  assert.equal(parsed.protocol, "https:", "a shipped cloud address must be https");
  assert.equal(
    /localhost|127\.0\.0\.1|\[::1\]|\.local$/i.test(parsed.hostname),
    false,
    "a shipped build must not sync to a machine on the counter",
  );
  assert.notEqual(rust.replace(/\/$/, ""), "https://api.froozerp.com", "that host is the placeholder, not the cloud");
  assert.equal(rust.endsWith("/"), false, "a trailing slash doubles the slash in every proxied route");
});

test("an explicit address wins in either build, so a rehearsal can point somewhere safe", () => {
  assert.match(cloudFn, /FROOZERP_CLOUD_API_URL/, "the override must be readable by name");
  assert.match(cloudFn, /CLOUD_API_URL/, "and the plain name must work too");
  assert.match(cloudFn, /trim_end_matches\('\/'\)/, "an address typed with a trailing slash must still work");
  assert.ok(
    cloudFn.indexOf("FROOZERP_CLOUD_API_URL") < cloudFn.indexOf("cfg!(debug_assertions)"),
    "the override must be consulted before the build profile decides anything",
  );
});

test("a development build has no cloud unless it is handed one", () => {
  // `npm run app:disposable` opens a copy of live business data. If a debug build carried the
  // production address, a rehearsal would sync that copy into the real cloud -- silently, and with
  // no easy undo, which is the same shape of failure the rehearsal exists to prevent.
  assert.match(
    cloudFn,
    /if cfg!\(debug_assertions\) \{\s*return String::new\(\);/,
    "a debug build must fall through to no cloud at all",
  );
  assert.ok(
    cloudFn.indexOf("cfg!(debug_assertions)") < cloudFn.indexOf("PRODUCTION_CLOUD_API_URL"),
    "and must reach that decision before the production constant",
  );
});

test("the empty case is still passed to the child, not left unset", () => {
  // Leaving it unset lets a CLOUD_API_URL exported in some unrelated terminal become a development
  // build's cloud. Passing "" explicitly overwrites whatever the parent had.
  assert.match(cloudFn, /return String::new\(\)/, "the empty answer must be a value, not an omission");
  assert.doesNotMatch(RUST, /env_remove\("CLOUD_API_URL"\)/, "and must not be expressed as a removal");
});
