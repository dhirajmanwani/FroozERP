import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLOUD_TARGET_REFUSAL_CODE,
  assertCloudTargetConfigured,
  createCloudNotConfiguredError,
  describeCloudTargetRefusal,
  isCloudTargetConfigured,
  normalizeCloudTargetValue,
  resolveCloudTarget,
} from "./cloudTarget.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..", "..");
const read = (...parts) => fs.readFileSync(path.join(repoRoot, ...parts), "utf8");

test("an empty candidate chain resolves to no target, never to a default", () => {
  assert.deepEqual(resolveCloudTarget([]), { configured: false, url: "" });
  assert.deepEqual(resolveCloudTarget(["", "   ", null, undefined]), { configured: false, url: "" });
  assert.deepEqual(resolveCloudTarget(undefined), { configured: false, url: "" });
});

test("the first configured candidate wins and trailing slashes are normalized away", () => {
  assert.deepEqual(
    resolveCloudTarget(["", "  https://cloud.example.com//  ", "https://other.example.com"]),
    { configured: true, url: "https://cloud.example.com" },
  );
  assert.equal(normalizeCloudTargetValue("http://127.0.0.1:5000/"), "http://127.0.0.1:5000");
  assert.equal(isCloudTargetConfigured(""), false);
  assert.equal(isCloudTargetConfigured("https://cloud.example.com"), true);
});

test("an unconfigured target produces a named refusal, not a silent no-op", () => {
  const refusal = describeCloudTargetRefusal("canonical-cloud-login");
  assert.equal(refusal.code, CLOUD_TARGET_REFUSAL_CODE);
  assert.equal(refusal.allowed, false);
  assert.equal(refusal.blocked, true);
  assert.equal(refusal.reachedCloud, false);
  assert.equal(refusal.operation, "canonical-cloud-login");

  const error = createCloudNotConfiguredError("sync-push");
  assert.equal(error.code, "CLOUD_NOT_CONFIGURED");
  assert.equal(error.reachedCloud, false);
  assert.throws(() => assertCloudTargetConfigured("", "sync-push"), /CLOUD_NOT_CONFIGURED|No cloud backend is configured/);
  assert.equal(assertCloudTargetConfigured("https://cloud.example.com/", "sync-push"), "https://cloud.example.com");
});

test("no shipped source treats an unconfigured cloud URL as a reason to use production", () => {
  // The defect is a `||` chain, not a value, so the guard asserts on the chain.
  const sources = {
    "frontend/src/App.jsx": read("frontend", "src", "App.jsx"),
    "frontend/src/local/syncService.js": read("frontend", "src", "local", "syncService.js"),
    "backend/desktopGateway.js": read("backend", "desktopGateway.js"),
  };
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(
      source,
      /\|\|\s*DEFAULT_(PRODUCTION_)?CLOUD_API_URL/,
      `${name} must not fall back to a production cloud URL`,
    );
  }
  assert.match(
    sources["backend/desktopGateway.js"],
    /CLOUD_TARGET_CONFIGURED[\s\S]*throw cloudNotConfiguredError/,
    "The gateway must refuse cloud routing by name when no target is configured",
  );
  assert.doesNotMatch(
    sources["frontend/src/App.jsx"],
    /isDesktopShell\(\)\s*\?\s*DEFAULT_PRODUCTION_CLOUD_API_URL/,
    "The desktop rung of the CLOUD_API_URL chain must resolve to no target",
  );
  // The constant itself stays: it is still needed to recognise and migrate a legacy saved
  // URL. What must not exist is a chain that lands on it when nothing is configured.
  assert.match(sources["frontend/src/App.jsx"], /LEGACY_PRODUCTION_CLOUD_API_URLS/);
  assert.match(sources["frontend/src/local/syncService.js"], /LEGACY_PRODUCTION_CLOUD_API_URLS/);
});

test("this module never names a production host", () => {
  assert.doesNotMatch(read("frontend", "src", "local", "cloudTarget.js"), /railway|https?:\/\//i);
});
