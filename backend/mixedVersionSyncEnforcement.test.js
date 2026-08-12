const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const server = fs.readFileSync(require.resolve("./server"), "utf8");

test("strict sync routes authenticate the signed canonical scope", () => {
  assert.match(server, /const resolveSyncRequestContext = async/);
  assert.match(server, /verifyDeviceSession\(/);
  assert.match(server, /SYNC_SCOPE_REQUIRED/);
  assert.match(server, /rejectDeviceSessionSubstitution\(deviceSession\.claims, submitted\)/);
  assert.match(server, /operational_location_id.*submitted\.operational_location_id/s);
  assert.match(server, /app\.post\("\/api\/sync\/push"[\s\S]*?resolveSyncRequestContext\(req, client\)/);
  assert.match(server, /app\.get\("\/api\/sync\/pull"[\s\S]*?resolveSyncRequestContext\(req/);
  assert.match(server, /app\.get\("\/api\/sync\/status"[\s\S]*?resolveSyncRequestContext\(req\)/);
});

test("legacy operational writes and approvals remain blocked", () => {
  assert.match(server, /CLIENT_UPGRADE_REQUIRED/);
  assert.match(server, /minimum_protocol_version: 3/);
  assert.match(server, /PROTOCOL_V3_DEVICE_APPROVAL_REQUIRED/);
});
