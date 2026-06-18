import fs from "node:fs";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");

assert.match(
  source,
  /<SettingsModule[\s\S]*?\bbackendHealth=\{backendHealth\}[\s\S]*?\/>/,
  "SettingsModule must receive backendHealth from App state.",
);

assert.match(
  source,
  /function SettingsModule\(\{[\s\S]*?\bbackendHealth\b[\s\S]*?\}\)/,
  "SettingsModule must declare backendHealth in its props.",
);

assert.match(
  source,
  /<SyncSettingsSection[\s\S]*?\bbackendHealth=\{backendHealth\}[\s\S]*?\/>/,
  "SyncSettingsSection must receive backendHealth from SettingsModule props.",
);

console.log("Settings backendHealth regression check passed.");
