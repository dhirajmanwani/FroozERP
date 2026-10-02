import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  HOSTED_CLOUD_HOSTNAME_SUFFIXES,
  LEGACY_PRODUCTION_CLOUD_API_URLS,
  PRODUCTION_CLOUD_API_URL,
  canonicalizeCloudApiUrl,
  isHostedCloudOrigin,
  isLegacyProductionCloudApiUrl,
  normalizeCloudApiUrl,
} from "./cloudOrigins.js";

const browserAt = (href) => {
  const url = new URL(href);
  return { href, origin: url.origin, protocol: url.protocol, host: url.host, hostname: url.hostname };
};
const browser = { tauriRuntime: false };
const tauri = { tauriRuntime: true };

test("the production cloud is Render, and both Railway addresses are retired", () => {
  // The cut-over release of the Render + Neon move. lib.rs, desktopGateway.js, server.js and
  // mobile_gateway.rs move in the same change (cloudAddress.test.mjs).
  assert.equal(PRODUCTION_CLOUD_API_URL, "https://froozerp-cloud.onrender.com");
  assert.deepEqual([...LEGACY_PRODUCTION_CLOUD_API_URLS].sort(), [
    "https://froozerp-production-27bb.up.railway.app",
    "https://froozerp-production.up.railway.app",
  ]);
  assert.equal(Object.isFrozen(LEGACY_PRODUCTION_CLOUD_API_URLS), true, "nobody may push onto the shared list at runtime");
  assert.equal(LEGACY_PRODUCTION_CLOUD_API_URLS.includes(PRODUCTION_CLOUD_API_URL), false, "the current cloud cannot also be retired");
});

test("a retired production URL is rewritten to the current one, in any spelling a user saved", () => {
  for (const saved of [
    "https://froozerp-production.up.railway.app",
    "https://froozerp-production.up.railway.app/",
    "  https://froozerp-production.up.railway.app/  ",
    // Saved on every counter that signed in before the move: without this they keep syncing to
    // Railway, which is frozen, and their bills never reach Neon.
    "https://froozerp-production-27bb.up.railway.app",
    "https://froozerp-production-27bb.up.railway.app/",
  ]) {
    assert.equal(canonicalizeCloudApiUrl(saved), PRODUCTION_CLOUD_API_URL, JSON.stringify(saved));
    assert.equal(isLegacyProductionCloudApiUrl(saved), true);
  }
});

test("anything else is only normalised, and nothing ever becomes production by default", () => {
  assert.equal(canonicalizeCloudApiUrl(PRODUCTION_CLOUD_API_URL), PRODUCTION_CLOUD_API_URL);
  assert.equal(canonicalizeCloudApiUrl("http://127.0.0.1:55552/"), "http://127.0.0.1:55552");
  assert.equal(canonicalizeCloudApiUrl("https://froozerp-cloud.onrender.com/"), "https://froozerp-cloud.onrender.com");
  // An absent URL means "no cloud target". It must never be filled in with production here.
  for (const absent of [undefined, null, "", "   "]) {
    assert.equal(canonicalizeCloudApiUrl(absent), "");
  }
  // Only one trailing slash is dropped -- the same rule as every other layer's normaliser.
  assert.equal(normalizeCloudApiUrl("https://example.test//"), "https://example.test/");
});

test("a browser on the Railway service is hosted, exactly as before the rename", () => {
  // The constraint on this phase: a browser served from the live origin must still resolve
  // CLOUD_PRODUCTION. Any *.up.railway.app host counted before, so it still does.
  assert.equal(isHostedCloudOrigin(browserAt(`${PRODUCTION_CLOUD_API_URL}/`), browser), true);
  assert.equal(isHostedCloudOrigin(browserAt("https://froozerp-production.up.railway.app/login"), browser), true);
  assert.equal(isHostedCloudOrigin(browserAt("https://some-preview-env.up.railway.app/"), browser), true);
  assert.equal(isHostedCloudOrigin(browserAt("https://FROOZERP-PRODUCTION-27BB.UP.RAILWAY.APP/"), browser), true);
});

test("a browser on a Render service is hosted too, so the web UI works from its first deploy", () => {
  assert.equal(isHostedCloudOrigin(browserAt("https://froozerp-cloud.onrender.com/"), browser), true);
  assert.equal(isHostedCloudOrigin(browserAt("https://froozerp-cloud.onrender.com/reports?x=1"), browser), true);
  assert.deepEqual([...HOSTED_CLOUD_HOSTNAME_SUFFIXES].sort(), [".onrender.com", ".up.railway.app"]);
});

test("a look-alike host is not hosted", () => {
  for (const href of [
    "http://localhost:5173/",
    "http://127.0.0.1:5000/",
    "http://192.168.1.20:5000/",
    "https://up.railway.app/",
    "https://onrender.com/",
    "https://evil-onrender.com/",
    "https://froozerp.up.railway.app.attacker.test/",
    "https://froozerp.onrender.com.attacker.test/",
  ]) {
    assert.equal(isHostedCloudOrigin(browserAt(href), browser), false, href);
  }
});

test("the installed app is never hosted, whatever its location says", () => {
  // Inside Tauri the cloud is reached through the local gateway. Treating the shell as the cloud
  // would point every call at its own origin and skip the local backend entirely.
  assert.equal(isHostedCloudOrigin(browserAt("http://tauri.localhost/"), tauri), false);
  assert.equal(isHostedCloudOrigin(browserAt(`${PRODUCTION_CLOUD_API_URL}/`), tauri), false);
  assert.equal(isHostedCloudOrigin(browserAt("https://froozerp-cloud.onrender.com/"), tauri), false);
});

test("no location means not hosted, and the default reads the real window", () => {
  assert.equal(isHostedCloudOrigin(undefined, browser), false);
  assert.equal(isHostedCloudOrigin(null, browser), false);
  assert.equal(isHostedCloudOrigin({}, browser), false);
  // Under node there is no window: the zero-argument form must answer false, not throw.
  assert.equal(isHostedCloudOrigin(), false);

  const previousWindow = globalThis.window;
  try {
    globalThis.window = { location: browserAt("https://froozerp-cloud.onrender.com/") };
    assert.equal(isHostedCloudOrigin(), true, "reads window.location by default");
    globalThis.window.__TAURI_INTERNALS__ = {};
    assert.equal(isHostedCloudOrigin(), false, "and detects the Tauri runtime by default");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("the module stays loadable by node:test", () => {
  // It is shared with App.jsx and syncService.js precisely so it can be tested; a Vite-only import
  // or `import.meta.env` here would quietly put it back out of reach.
  const source = fs.readFileSync(new URL("./cloudOrigins.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /import\.meta\.env/);
  assert.doesNotMatch(source, /^import /m);
});
