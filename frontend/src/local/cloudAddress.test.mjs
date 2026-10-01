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
const SYNC = fs.readFileSync(path.join(HERE, "syncService.js"), "utf8");
const ORIGINS = fs.readFileSync(path.join(HERE, "cloudOrigins.js"), "utf8");
const GATEWAY = fs.readFileSync(path.join(HERE, "..", "..", "..", "backend", "desktopGateway.js"), "utf8");
const SERVER = fs.readFileSync(path.join(HERE, "..", "..", "..", "backend", "server.js"), "utf8");
const MOBILE_GATEWAY = fs.readFileSync(path.join(HERE, "..", "..", "..", "src-tauri", "src", "mobile_gateway.rs"), "utf8");

const rustString = (name) => RUST.match(new RegExp(`const ${name}: &str = "([^"]+)"`))?.[1];
const jsString = (source, name) => source.match(new RegExp(`const ${name} = "([^"]+)"`))?.[1];
const quoted = (text) => [...String(text ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
// Read a legacy list as a sorted set of its string literals. `undefined` when the declaration is
// missing, so a rename fails here by name instead of comparing two empty lists as equal.
const listLiterals = (source, pattern) => {
  const body = source.match(pattern)?.[1];
  return body === undefined ? undefined : [...new Set(quoted(body))].sort();
};

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
  const frontend = jsString(ORIGINS, "PRODUCTION_CLOUD_API_URL");
  assert.ok(rust, "Rust must name the production cloud");
  assert.ok(frontend, "the frontend must name the production cloud, in local/cloudOrigins.js");
  assert.equal(rust, frontend);
});

test("the shell, the frontend, the desktop gateway and the server all name the same production cloud", () => {
  // The cloud is about to move. Moving it is one literal per layer, and a layer left behind does not
  // fail -- it keeps talking to the old service. So every literal is pinned to the others here.
  const rust = rustString("PRODUCTION_CLOUD_API_URL");
  const frontend = jsString(ORIGINS, "PRODUCTION_CLOUD_API_URL");
  const gateway = jsString(GATEWAY, "DEFAULT_CLOUD_API_URL");
  // Renamed from productionRailwayOrigin in the host-agnostic backend change; either name counts.
  const server = SERVER.match(/const (?:productionRailwayOrigin|defaultProductionCloudOrigin) = "([^"]+)"/)?.[1];
  assert.ok(gateway, "backend/desktopGateway.js must name the production cloud as DEFAULT_CLOUD_API_URL");
  assert.ok(server, "backend/server.js must name its default production origin");
  assert.equal(frontend, rust, "cloudOrigins.js and lib.rs disagree");
  assert.equal(gateway, rust, "desktopGateway.js and lib.rs disagree");
  assert.equal(server, rust, "server.js and lib.rs disagree");
});

test("the frontend names the production cloud once, in cloudOrigins.js", () => {
  // App.jsx and syncService.js each used to carry their own copy of the URL, the legacy list and the
  // hosted-origin test. Two copies drift; one import cannot.
  for (const [name, source] of [["App.jsx", APP], ["syncService.js", SYNC]]) {
    assert.match(
      source,
      /import \{[^}]*\bcanonicalizeCloudApiUrl\b[^}]*\bisHostedCloudOrigin\b[^}]*\} from "\.\/(?:local\/)?cloudOrigins\.js";/,
      `${name} must take the cloud's address and origin test from cloudOrigins.js`,
    );
    assert.doesNotMatch(source, /froozerp-production|\.up\.railway\.app|\.onrender\.com/, `${name} must not re-declare a cloud address`);
    assert.doesNotMatch(source, /const (?:LEGACY_PRODUCTION_CLOUD_API_URLS|DEFAULT_PRODUCTION_CLOUD_API_URL|canonicalizeCloudApiUrl|isRailwayProductionHost|isHostedCloudOrigin) =/);
  }
});

test("every layer retires the same old addresses", () => {
  // A saved URL that one layer rewrites and another does not is the split-brain this file exists to
  // prevent, reached through the migration path instead of the default. Each list is compared as a
  // set: order carries no meaning, and the Rust array length must match what it holds.
  const frontend = listLiterals(ORIGINS, /export const LEGACY_PRODUCTION_CLOUD_API_URLS = Object\.freeze\(\[([^\]]*)\]\)/);
  const gateway = listLiterals(GATEWAY, /const LEGACY_CLOUD_API_URLS = new Set\(\[([^\]]*)\]\)/);
  const server = listLiterals(SERVER, /const (?:legacyProductionRailwayOrigins|legacyProductionCloudOrigins) = new Set\(\[([^\]]*)\]\)/);
  const mobileDeclaration = MOBILE_GATEWAY.match(/const LEGACY_CLOUD_API_URLS: \[&str; (\d+)\] = \[([^\]]*)\]/);
  const mobile = mobileDeclaration ? [...new Set(quoted(mobileDeclaration[2]))].sort() : undefined;

  assert.ok(frontend, "cloudOrigins.js must declare LEGACY_PRODUCTION_CLOUD_API_URLS");
  assert.ok(gateway, "desktopGateway.js must declare LEGACY_CLOUD_API_URLS");
  assert.ok(server, "server.js must declare its legacy production origins");
  assert.ok(mobile, "mobile_gateway.rs must declare LEGACY_CLOUD_API_URLS");
  assert.ok(frontend.length > 0, "the legacy list cannot be empty while a retired address is still saved on counters");
  assert.equal(Number(mobileDeclaration[1]), quoted(mobileDeclaration[2]).length, "the Rust array length must match its contents");

  assert.deepEqual(gateway, frontend, "desktopGateway.js retires a different set");
  assert.deepEqual(server, frontend, "server.js retires a different set");
  assert.deepEqual(mobile, frontend, "mobile_gateway.rs retires a different set");

  const production = rustString("PRODUCTION_CLOUD_API_URL");
  assert.equal(frontend.includes(production), false, "the current cloud cannot also be a retired one");
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

test("a phone build chooses its cloud when the APK is built, and never touches the desktop rule", () => {
  // A phone has no environment to set and no disposable profile of live data, so a debug APK with
  // no cloud could never sign in. It names one at compile time instead; desktop keeps the rule above.
  const mobileFn = RUST.slice(RUST.indexOf("fn mobile_cloud_api_url"), RUST.indexOf("fn local_backend_url"));
  assert.match(cloudFn, /if cfg!\(mobile\) \{\s*return mobile_cloud_api_url\(\);\s*\}/);
  assert.match(mobileFn, /option_env!\("FROOZERP_MOBILE_CLOUD_API_URL"\)/, "a rehearsal APK is pointed away from production at build time");
  assert.ok(
    mobileFn.indexOf("FROOZERP_MOBILE_CLOUD_API_URL") < mobileFn.indexOf("PRODUCTION_CLOUD_API_URL"),
    "the build-time address wins over production",
  );
});
