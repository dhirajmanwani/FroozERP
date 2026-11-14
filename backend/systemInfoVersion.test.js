"use strict";

/**
 * Settings > System Info printed "Software Version 1.0.5" on every release after 1.0.5, because
 * `getSystemInfo` carried the number as a literal. It now reports `appVersion`, the same value
 * `/api/health` and the update check report, read from the shipped package.json.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

const systemInfoFunction = () => {
  const start = SERVER.indexOf("const getSystemInfo = async (");
  assert.notEqual(start, -1, "getSystemInfo is gone");
  const end = SERVER.indexOf("\n};\n", start);
  assert.notEqual(end, -1, "could not find the end of getSystemInfo");
  return SERVER.slice(start, end);
};

test("System Info reports the running release, not a typed-in version", () => {
  const body = systemInfoFunction();
  assert.match(body, /softwareVersion: appVersion,/);
  assert.doesNotMatch(body, /softwareVersion: "\d/, "a literal version goes stale on the next release");
});

test("appVersion is the one read from package.json that /api/health also reports", () => {
  assert.match(SERVER, /const appVersion = readReleaseVersion\(\);/);
  const start = SERVER.indexOf("const healthHandler = ");
  assert.notEqual(start, -1, "the health handler is gone");
  const health = SERVER.slice(start, SERVER.indexOf('app.get("/api/health", healthHandler)', start));
  assert.match(health, /version: appVersion/);
});
