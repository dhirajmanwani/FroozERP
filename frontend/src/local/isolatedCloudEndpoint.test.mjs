import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "../App.jsx"), "utf8");
const tauriConfig = fs.readFileSync(path.join(here, "../../../src-tauri/tauri.conf.json"), "utf8");

test("loopback cloud rehearsal requires both Vite development and an explicit flag", () => {
  assert.match(source, /import\.meta\.env\.DEV/);
  assert.match(source, /VITE_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS !== "true"/);
  assert.match(source, /\["localhost", "127\.0\.0\.1", "::1"\]/);
});

test("the isolated endpoint overrides saved production configuration only inside the gate", () => {
  assert.match(source, /cloudApiUrl: ISOLATED_LOOPBACK_CLOUD_API_URL\s*\|\| canonicalizeCloudApiUrl/);
  assert.match(source, /RAILWAY_PRODUCTION_API_URL \|\|\s*ISOLATED_LOOPBACK_CLOUD_API_URL/);
  assert.match(source, /normalizeApiBase\(url\) === ISOLATED_LOOPBACK_CLOUD_API_URL/);
});

test("the desktop CSP permits only the fixed localhost cloud-rehearsal port", () => {
  assert.match(tauriConfig, /http:\/\/127\.0\.0\.1:55552/);
  assert.match(tauriConfig, /http:\/\/localhost:55552/);
  assert.doesNotMatch(tauriConfig, /http:\/\/127\.0\.0\.1:\*/);
});
