import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const syncService = fs.readFileSync(new URL("./syncService.js", import.meta.url), "utf8");
const localDatabase = fs.readFileSync(new URL("./localDatabase.js", import.meta.url), "utf8");
const repositories = fs.readFileSync(new URL("./repositories.js", import.meta.url), "utf8");

test("cursor zero opts into reference bootstrap and applies it atomically", () => {
  assert.match(syncService, /bootstrap_protocol: cursor === "0" \? "reference-v1" : undefined/);
  assert.match(syncService, /"x-froozerp-device-session": context\.deviceSessionToken/);
  assert.match(syncService, /response\.data\?\.reference_bootstrap/);
  assert.match(syncService, /repositories\.pull\.bootstrap/);
  assert.match(localDatabase, /sync_apply_reference_bootstrap/);
  assert.match(repositories, /bootstrap: applyReferenceBootstrap/);
});

test("ordinary incremental pulls retain the existing apply path", () => {
  assert.match(syncService, /applyPulledChanges\(\{/);
  assert.match(syncService, /nextCursor: response\.data\?\.next_cursor \|\| cursor/);
});
