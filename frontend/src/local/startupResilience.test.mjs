import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  describeRequestFailure,
  initialiseMandatoryRuntime,
  resolveMandatoryRuntimeRenderState,
  settleNamedRequests,
  shouldShowFatalStartup,
} from "./startupResilience.js";

const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../main.jsx", import.meta.url), "utf8");

test("transient startup failures never replace the loading screen with a fatal screen", () => {
  assert.equal(shouldShowFatalStartup({ mandatoryRuntimeFailed: true, retriesExhausted: false }), false);
  assert.equal(shouldShowFatalStartup({ mandatoryRuntimeFailed: false, retriesExhausted: true }), false);
  assert.equal(shouldShowFatalStartup({ mandatoryRuntimeFailed: true, retriesExhausted: true }), true);
  assert.match(mainSource, /event\.preventDefault\?\.\(\)/);
  assert.match(mainSource, /RUNTIME_FAILURE_EVENT/);
  assert.doesNotMatch(mainSource, /shouldShowFatalStartup/);
  assert.doesNotMatch(mainSource, /onunhandledrejection[\s\S]{0,800}showStartupFailure/);
  assert.doesNotMatch(mainSource, /FroozERP could not start/);
  assert.match(mainSource, /neutral-shell-visible/);
});

test("only confirmed SQLite exhaustion can render the fatal startup state", () => {
  assert.equal(resolveMandatoryRuntimeRenderState({ status: null }), "checking");
  assert.equal(resolveMandatoryRuntimeRenderState({ status: { initialized: false }, retriesExhausted: false }), "checking");
  assert.equal(resolveMandatoryRuntimeRenderState({ status: { initialized: true }, retriesExhausted: true }), "ready");
  assert.equal(resolveMandatoryRuntimeRenderState({ status: { initialized: false, error: "sqlite unavailable" }, retriesExhausted: true }), "fatal");
  assert.match(appSource, /data-fatal-startup="true"/);
  assert.match(appSource, /mandatoryRuntimeState === "fatal"/);
});

test("native window stays hidden until neutral shell paint", async () => {
  const tauriConfig = await readFile(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8");
  assert.match(tauriConfig, /"visible": false/);
  assert.match(mainSource, /requestAnimationFrame/);
  assert.match(mainSource, /show_main_window/);
});

test("self-contained cold-start runner has an independent recovery watchdog", async () => {
  const runner = await readFile(new URL("../../../scripts/phase4-cold-start-runner.ps1", import.meta.url), "utf8");
  const watchdog = await readFile(new URL("../../../scripts/phase4-wifi-recovery.ps1", import.meta.url), "utf8");
  assert.match(runner, /Start-Process powershell\.exe/);
  assert.match(runner, /phase4-wifi-recovery/);
  assert.match(runner, /HasExited/);
  assert.match(runner, /Disable-NetAdapter/);
  assert.match(runner, /finally/);
  assert.match(runner, /ImageFormat\]\:\:Jpeg/);
  assert.match(watchdog, /Enable-NetAdapter/);
  assert.match(watchdog, /DEADLINE=/);
});

test("mandatory local runtime waits through transient failures before succeeding", async () => {
  let calls = 0;
  const result = await initialiseMandatoryRuntime({
    initialize: async () => {
      calls += 1;
      return calls < 3 ? { initialized: false, error: "not ready" } : { initialized: true };
    },
    attempts: 4,
    delay: async () => {},
  });
  assert.equal(result.status.initialized, true);
  assert.equal(result.attemptsUsed, 3);
  assert.equal(result.retriesExhausted, false);
});

test("mandatory local runtime reports exhaustion only after all bounded attempts", async () => {
  const result = await initialiseMandatoryRuntime({
    initialize: async () => ({ initialized: false, error: "sqlite unavailable" }),
    attempts: 3,
    delay: async () => {},
  });
  assert.equal(result.attemptsUsed, 3);
  assert.equal(result.retriesExhausted, true);
});

test("one failed optional startup request keeps successful and preserved values", async () => {
  const networkError = Object.assign(new Error("Network Error"), {
    config: { method: "get", url: "http://127.0.0.1:5000/inventory" },
  });
  const { values, failures } = await settleNamedRequests([
    { key: "products", url: "/products", fallback: ["cached-product"], run: async () => ["live-product"] },
    { key: "inventory", url: "/inventory", fallback: ["cached-lot"], run: async () => { throw networkError; } },
  ]);
  assert.deepEqual(values.products, ["live-product"]);
  assert.deepEqual(values.inventory, ["cached-lot"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].url, "http://127.0.0.1:5000/inventory");
  assert.equal(failures[0].status, null);
});

test("cloud login HTTP 401 is diagnosed without becoming a fatal runtime error", () => {
  const failure = describeRequestFailure({
    message: "Request failed",
    config: { method: "post", url: "https://example.invalid/login" },
    response: { status: 401, data: { code: "INVALID_CREDENTIALS", message: "Invalid username or password." } },
  });
  assert.deepEqual(failure, {
    method: "POST",
    url: "https://example.invalid/login",
    status: 401,
    code: "INVALID_CREDENTIALS",
    message: "Invalid username or password.",
  });
  assert.equal(shouldShowFatalStartup({ mandatoryRuntimeFailed: false, retriesExhausted: false }), false);
});

test("reference and report startup loads are isolated and retain SQLite fallbacks", () => {
  assert.match(appSource, /settleNamedRequests\(definitions\.map/);
  assert.match(appSource, /reference-request-fallback/);
  assert.match(appSource, /report-request-fallback/);
  assert.match(appSource, /Showing the last preserved local values/);
  assert.match(appSource, /Cloud sync is temporarily unavailable\. Local changes remain queued safely/);
  assert.match(appSource, /describeCloudUnavailableSync/);
  assert.doesNotMatch(appSource, /Online sync delivery is not enabled yet/);
});

test("degraded mode keeps every main module and POS render path reachable", () => {
  for (const view of ["dashboard", "products", "purchase", "pending-bills", "accounts", "returns", "waste", "sales", "discounts", "sale-rates", "expenses", "reports", "settings"]) {
    assert.match(appSource, new RegExp(`activeView === \\"${view}\\"`));
  }
  assert.match(appSource, /<PosBilling/);
  assert.match(appSource, /<FrostFloatingCopilot/);
  assert.match(appSource, /<SettingsModule/);
});
