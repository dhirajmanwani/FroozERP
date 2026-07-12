import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const appPath = path.join(root, "frontend", "src", "App.jsx");
const source = fs.readFileSync(appPath, "utf8");
const start = source.indexOf("function UpdateCenterSection");
const end = source.indexOf("\nfunction ", start + 1);
assert.notEqual(start, -1, "UpdateCenterSection must exist");
assert.notEqual(end, -1, "UpdateCenterSection end must be discoverable");
const section = source.slice(start, end);

const count = (needle) => (section.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;

assert.equal(count('label="Installed App Version"'), 1, "Installed version should render once");
assert.equal(count('label="Latest Available Version"'), 1, "Latest version should render once");
assert.equal(count('label="Published"'), 1, "Published date should render once");
assert.equal(count(">Check for Updates<"), 1, "Check button should render once");
assert.equal(count(">Download Update<"), 1, "Download button should render once");
assert.equal(count(">Install and Restart<"), 1, "Install button should render once");
assert.equal(count("update-foundation-panel"), 1, "There must be one update status card");
assert.equal(count("form-grid supplier-form-grid"), 0, "Legacy disabled duplicate form grid must not render");
assert.equal(count("purchase-summary-grid supplier-payment-preview"), 0, "Legacy duplicate summary grid must not render");

for (const phase of ["idle", "checking", "update_available", "up_to_date", "downloading", "downloaded", "installing", "error"]) {
  assert.ok(section.includes(`"${phase}"`), `Updater state phase ${phase} must be represented`);
}

assert.ok(section.includes("updateRequestIdRef.current !== requestId"), "Stale updater responses must be ignored");
assert.equal(section.includes("readManifestFallback"), false, "Legacy manifest writer must be removed");
assert.equal(section.includes("/settings/update-center"), false, "Update Center must not persist stale status drafts");
assert.equal(section.includes("setInterval"), false, "Update Center must not poll");
assert.equal(section.includes("update_status"), false, "Legacy update_status state must not drive rendering");

const normalizeVersion = (value) => {
  const text = String(value || "").trim();
  const match = text.match(/v?(\d+(?:\.\d+){1,3})(?:[^\d].*)?$/i) || text.match(/v?(\d+(?:\.\d+){1,3})/i);
  return match ? match[1] : "";
};
const compareVersions = (left, right) => {
  const a = normalizeVersion(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = normalizeVersion(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

assert.equal(compareVersions("1.0.38", "1.0.38"), 0, "Equal semantic versions must compare equal");
assert.equal(compareVersions("v1.0.39", "1.0.38") > 0, true, "Newer semantic version must compare greater");
assert.equal(compareVersions("1.0.35", "1.0.38") < 0, true, "Older semantic version must compare lower");

console.log("Update Center static tests passed");
