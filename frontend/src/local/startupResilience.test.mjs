import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  describeRequestFailure,
  settleNamedRequests,
  shouldShowFatalStartup,
} from "./startupResilience.js";

const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const mainSource = await readFile(new URL("../main.jsx", import.meta.url), "utf8");

test("only a pre-mount failure may replace the application with the fatal screen", () => {
  assert.equal(shouldShowFatalStartup({ reactMounted: false }), true);
  assert.equal(shouldShowFatalStartup({ reactMounted: true }), false);
  assert.match(mainSource, /event\.preventDefault\?\.\(\)/);
  assert.match(mainSource, /RUNTIME_FAILURE_EVENT/);
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
  assert.equal(shouldShowFatalStartup({ reactMounted: true }), false);
});

test("reference and report startup loads are isolated and retain SQLite fallbacks", () => {
  assert.match(appSource, /settleNamedRequests\(definitions\.map/);
  assert.match(appSource, /reference-request-fallback/);
  assert.match(appSource, /report-request-fallback/);
  assert.match(appSource, /Showing the last preserved local values/);
  assert.match(appSource, /Cloud sync is temporarily unavailable\. Local changes remain queued safely/);
});

test("degraded mode keeps every main module and POS render path reachable", () => {
  for (const view of ["dashboard", "products", "purchase", "pending-bills", "accounts", "returns", "waste", "sales", "discounts", "sale-rates", "expenses", "reports", "settings"]) {
    assert.match(appSource, new RegExp(`activeView === \\"${view}\\"`));
  }
  assert.match(appSource, /<PosBilling/);
  assert.match(appSource, /<FrostFloatingCopilot/);
  assert.match(appSource, /<SettingsModule/);
});
