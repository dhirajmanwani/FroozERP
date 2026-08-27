"use strict";

/**
 * Every `*.test.js` in this directory is actually run by `npm --prefix backend test`.
 *
 * The test script names its files one by one rather than globbing a directory. That is deliberate -
 * it keeps the order readable and makes it obvious which suites exist - but it means adding a suite
 * is two steps, and forgetting the second one produces a file full of green assertions that nobody
 * ever executes. Which is worse than having no tests: the suite exists, it looks like coverage, and
 * it is not.
 *
 * This was not hypothetical. `isolatedCloudEndpoint.test.js` was written, committed, and left out
 * of the script; it had never run in the batch until this test was added, and it was found only
 * because a second suite went missing the same way.
 *
 * Asserted in both directions, because the opposite mistake - a name left in the script after the
 * file is renamed or deleted - makes `node --test` fail with a message about a missing file that
 * says nothing about which change caused it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const listed = packageJson.scripts.test.split(/\s+/).filter((token) => token.endsWith(".test.js"));
const onDisk = fs.readdirSync(__dirname).filter((name) => name.endsWith(".test.js"));

test("no suite on disk is missing from the test script", () => {
  const missing = onDisk.filter((name) => !listed.includes(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `these suites exist but never run: ${missing.join(", ")}. Add them to backend/package.json "test".`,
  );
});

test("the test script names no suite that does not exist", () => {
  const absent = listed.filter((name) => !onDisk.includes(name)).sort();
  assert.deepEqual(absent, [], `these suites are named but missing: ${absent.join(", ")}`);
});

test("no suite is named twice", () => {
  // A duplicate runs the file twice and inflates the pass count, which is how a suite that quietly
  // stopped running can be hidden by a total that still looks right.
  const seen = new Set();
  const duplicates = listed.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
  assert.deepEqual(duplicates, [], `named more than once: ${duplicates.join(", ")}`);
});
