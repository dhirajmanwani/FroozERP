import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sanitizeLocalSnapshotLoadError } from "./localDatabase.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseSource = fs.readFileSync(path.join(here, "localDatabase.js"), "utf8");
const appSource = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");

test("snapshot loader uses the Tauri camel-case command contract", () => {
  const start = databaseSource.indexOf("export async function loadLocalReferenceSnapshot");
  const end = databaseSource.indexOf("export async function getOrCreateLocalDeviceIdentity", start);
  const source = databaseSource.slice(start, end);
  assert.match(source, /deviceId: deviceId \|\| null/);
  assert.doesNotMatch(source, /device_id:/);
});

test("snapshot bridge and SQLite failures are sanitized into stable diagnostics", () => {
  assert.match(databaseSource, /LOCAL_SNAPSHOT_BRIDGE_CONTRACT/);
  assert.match(databaseSource, /LOCAL_SNAPSHOT_CORRUPT/);
  assert.match(databaseSource, /LOCAL_SNAPSHOT_INCOMPATIBLE/);
  assert.match(databaseSource, /did not create a replacement database/);
  assert.equal(
    sanitizeLocalSnapshotLoadError(new Error("invalid args for command local_load_reference_snapshot: missing required key deviceId")).code,
    "LOCAL_SNAPSHOT_BRIDGE_CONTRACT"
  );
  assert.equal(sanitizeLocalSnapshotLoadError(new Error("file is not a database")).code, "LOCAL_SNAPSHOT_CORRUPT");
  assert.equal(
    sanitizeLocalSnapshotLoadError(new Error("no such table: local_supplier_references")).code,
    "LOCAL_SNAPSHOT_INCOMPATIBLE"
  );
});

test("offline login never converts a snapshot-load failure into an empty database", () => {
  const start = appSource.indexOf("const continueOffline = async");
  const end = appSource.indexOf("const loadProducts = async", start);
  const source = appSource.slice(start, end);
  assert.match(source, /local-reference-snapshot-load-failed/);
  assert.match(source, /return false/);
  assert.doesNotMatch(source, /loadLocalReferenceSnapshot\([\s\S]*?\.catch\(\(\) => null\)/);
});

test("legacy settings entry points preserve behavior while hooks remain in React components", () => {
  assert.match(
    appSource,
    /function _LegacySecurityDevicesSection\(props\) \{\s+return <LegacySecurityDevicesSection \{\.\.\.props\} \/>;\s+\}/
  );
  assert.match(appSource, /function LegacySecurityDevicesSection\([^)]*\) \{\s+const \[generatedCode, setGeneratedCode\] = useState/);
  assert.match(
    appSource,
    /function _LegacyBranchCounterSettings\(props\) \{\s+return <LegacyBranchCounterSettings \{\.\.\.props\} \/>;\s+\}/
  );
  assert.match(appSource, /function LegacyBranchCounterSettings\([^)]*\) \{\s+const \[branchDraft, setBranchDraft\] = useState/);
});
