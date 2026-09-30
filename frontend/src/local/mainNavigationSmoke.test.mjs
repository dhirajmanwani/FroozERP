import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const navigationViews = [
  "dashboard", "products", "purchase", "pending-bills", "accounts", "returns", "waste",
  "sales", "discounts", "sale-rates", "expenses", "reports", "settings",
];

test("every main navigation module has a render path and refresh path", () => {
  for (const view of navigationViews) {
    assert.match(appSource, new RegExp(`\\[\\"${view}\\",\\s*\\"`), `${view} is missing from navigation`);
    assert.match(appSource, new RegExp(`activeView === \\"${view}\\"`), `${view} has no render path`);
    // A refresh path is either the menu handler's dispatch or a screen that loads itself when it
    // mounts (`onLoad={...}` on its render path), which also covers Back/Forward -- Sale Rate Update
    // does that so its data is loaded however it is reached.
    const dispatched = new RegExp(`view === \\"${view}\\"|\\[.*\\"${view}\\".*\\]\\.includes\\(view\\)`).test(appSource);
    const selfLoading = new RegExp(`activeView === \\"${view}\\"[^\\n]*\\n[\\s\\S]{0,400}?onLoad=\\{load\\w+\\}`).test(appSource);
    assert.ok(dispatched || selfLoading, `${view} has no refresh path`);
  }
});

test("Settings receives and declares the runtime device identity", () => {
  assert.match(appSource, /<SettingsModule[\s\S]*?deviceInfo=\{deviceInfo\}/);
  assert.match(appSource, /function SettingsModule\(\{[\s\S]*?deviceInfo,/);
});

test("desktop dashboard uses local SQLite projection in hybrid mode", () => {
  assert.match(appSource, /if \(isTauriRuntime\(\)\) return loadDashboardAnalytics/);
  assert.match(appSource, /buildLocalDashboardSnapshot\(\{/);
});
