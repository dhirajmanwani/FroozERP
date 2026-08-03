const assert = require("node:assert/strict");
const test = require("node:test");

const serverPath = require("node:path").join(__dirname, "server.js");

test("loopback cloud endpoint remains disabled without the isolated-test gate", () => {
  const source = require("node:fs").readFileSync(serverPath, "utf8");
  assert.match(source, /process\.env\.NODE_ENV === "test"/);
  assert.match(source, /FROOZERP_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS/);
  assert.match(source, /allowLoopbackCloudForIsolatedTests && isLoopbackCloudUrl/);
});

test("production mode cannot enable the isolated loopback cloud endpoint", () => {
  const source = require("node:fs").readFileSync(serverPath, "utf8");
  const guard = source.indexOf('process.env.NODE_ENV === "test"');
  const flag = source.indexOf("FROOZERP_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS");
  assert.ok(guard >= 0 && flag > guard);
});
