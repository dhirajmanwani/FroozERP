#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import {
  ALL_SURFACES,
  buildInventoryBoundary,
  digest,
  inspectSourceContracts,
  normalizeCollection,
  normalizeProfile,
  stableValue,
} from "./module-matrix-core.mjs";
import { isPathInside, resolveAcceptanceReportPath, writeNewJsonAtomically } from "./safe-output.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, "..", "..");

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ["fixture", "fixture-root", "restored-profile", "report"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  return values;
}

function assertDisposablePaths(args) {
  const fixture = path.resolve(args.fixture);
  const fixtureRoot = path.resolve(args["fixture-root"]);
  const restoredProfile = path.resolve(args["restored-profile"]);
  const repoRoot = path.resolve(args["repo-root"] || defaultRepoRoot);
  const report = resolveAcceptanceReportPath({
    report: args.report,
    fixtureRoot,
    evidenceRoot: args["evidence-root"],
    repoRoot,
  });
  const forbidden = [
    path.join(process.env.APPDATA || "", "com.srtcompany.froozerp"),
    path.join(defaultRepoRoot, "_recovery_backups"),
    path.join(defaultRepoRoot, "release-candidates"),
  ].filter(Boolean).map((value) => path.resolve(value).toLowerCase());
  for (const candidate of [fixture, restoredProfile, report]) {
    if (forbidden.some((blocked) => candidate.toLowerCase().startsWith(blocked))) {
      throw new Error(`Refusing protected/live path: ${candidate}`);
    }
  }
  if (!isPathInside(fixtureRoot, fixture) || !isPathInside(fixtureRoot, restoredProfile)) {
    throw new Error("Fixture and restored profile must be contained by the explicitly supplied disposable --fixture-root.");
  }
  if (!fs.statSync(fixture).isFile()) throw new Error("Fixture must be a SQLite file.");
  if (!fs.statSync(restoredProfile).isFile()) throw new Error("Restored profile must be a sanitized JSON file.");
  for (const sidecar of [`${fixture}-wal`, `${fixture}-shm`]) {
    if (fs.existsSync(sidecar)) throw new Error(`Disposable fixture must be checkpointed and self-contained; sidecar found: ${sidecar}`);
  }
  return { fixture, fixtureRoot, restoredProfile, report, repoRoot };
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex").toUpperCase();
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function userTables(db) {
  return db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
}

function rows(db, table) {
  if (!tableExists(db, table)) return null;
  return db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all().map(stableValue);
}

function wholeDatabaseDigest(db) {
  const state = userTables(db).map(({ name, sql }) => {
    const tableRows = rows(db, name);
    tableRows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return { name, sql, rows: tableRows };
  });
  return { digest: digest(state), tables: state.map(({ name, rows: tableRows }) => ({ name, count: tableRows.length, digest: digest(tableRows) })) };
}

function firstExistingRows(db, names) {
  for (const name of names) {
    const result = rows(db, name);
    if (result !== null) return { table: name, rows: result };
  }
  return { table: null, rows: [] };
}

function fixtureModel(db) {
  const products = firstExistingRows(db, ["local_products", "products"]);
  const lots = firstExistingRows(db, ["local_inventory_lots", "inventory_lots"]);
  if (!products.table || !lots.table) throw new Error("Fixture lacks required product or inventory-lot tables.");
  const inventory = buildInventoryBoundary(products.rows, lots.rows);
  const tableMappings = {
    dashboard: [], products: [products.table, lots.table], purchase: ["local_purchases", "purchases"],
    "pending-bills": ["local_purchases", "purchases"], accounts: ["local_payments", "payments", "ledger_entries"],
    returns: ["local_sale_returns", "sale_returns"], waste: ["local_waste_entries", "waste_entries"],
    sales: ["local_invoices", "invoices", "sales"], discounts: ["local_lot_discounts", "lot_discounts"],
    "sale-rates": ["local_sale_rates", "sale_rates"], expenses: ["local_expenses", "expenses"], reports: [],
    settings: ["local_settings", "settings"], "purchase-orders": ["local_purchase_orders", "purchase_orders"],
    grn: ["local_purchases", "purchases"], suppliers: ["local_supplier_references", "suppliers"],
    customers: ["local_customers", "customers"], transfers: ["local_transfers", "stock_transfers"],
    "users-devices": ["local_users", "users", "local_device_identities", "devices"],
    sync: ["local_outbox", "sync_outbox"], "update-center": [],
  };
  const modules = ALL_SURFACES.map((surface) => {
    const candidates = tableMappings[surface.id] || [];
    const table = candidates.find((candidate) => tableExists(db, candidate)) || null;
    let actualCount = table ? rows(db, table).length : null;
    if (surface.id === "dashboard" || surface.id === "reports") actualCount = inventory.activeAvailableLots;
    if (surface.id === "products") actualCount = products.rows.length;
    return {
      id: surface.id,
      assertionLevel: actualCount === null ? "static-preflight-only" : "fixture-model-preflight",
      fixtureTable: table,
      expectedCount: actualCount,
      actualCount,
      renderedRows: null,
      renderedUiStatus: "not-run-preflight-does-not-render-ui",
      errors: [],
      passed: true,
    };
  });
  return { inventory, modules };
}

function installNetworkGuard() {
  const attempts = [];
  const restorers = [];
  const guardHost = (host, kind) => {
    const value = String(host || "");
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(value) || value.startsWith("127.");
    attempts.push({ kind, host: value, loopback });
    if (!loopback) throw new Error(`Non-loopback ${kind} attempt blocked by acceptance harness: ${value}`);
  };
  for (const [owner, key, kind, hostAt] of [
    [net, "connect", "tcp", 1], [net, "createConnection", "tcp", 1],
    [http, "request", "http", 0], [http, "get", "http", 0],
    [https, "request", "https", 0], [https, "get", "https", 0],
  ]) {
    const original = owner[key];
    owner[key] = function guarded(...args) {
      const arg = args[hostAt] ?? args[0];
      const host = typeof arg === "string" ? new URL(arg, "http://localhost").hostname : arg?.hostname ?? arg?.host;
      guardHost(host, kind);
      return original.apply(this, args);
    };
    restorers.push(() => { owner[key] = original; });
  }
  for (const key of ["lookup", "resolve", "resolve4", "resolve6"]) {
    const original = dns[key];
    dns[key] = function guarded(host, ...args) {
      guardHost(host, "dns");
      return original.call(this, host, ...args);
    };
    restorers.push(() => { dns[key] = original; });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    guardHost(new URL(typeof input === "string" ? input : input.url).hostname, "fetch");
    return originalFetch(input, init);
  };
  restorers.push(() => { globalThis.fetch = originalFetch; });
  return { attempts, restore: () => restorers.reverse().forEach((restore) => restore()) };
}

function validateExpected(args, inventory) {
  const checks = [];
  const fields = [
    ["expect-products", "products"], ["expect-lots", "lots"], ["expect-active-lots", "activeAvailableLots"],
    ["expect-stock-products", "productsWithAvailableStock"], ["expect-quantity", "quantity"], ["expect-stock-value", "stockValue"],
  ];
  for (const [argument, field] of fields) {
    if (args[argument] === undefined) continue;
    const expected = Number(args[argument]);
    const actual = Number(inventory[field]);
    const tolerance = ["quantity", "stockValue"].includes(field) ? 0.0005 : 0;
    checks.push({ field, expected, actual, passed: Math.abs(expected - actual) <= tolerance });
  }
  return checks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const safe = assertDisposablePaths(args);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "froozerp-acceptance-"));
  const stagedInputPath = path.join(tempRoot, "input-fixture.sqlite3");
  const workingDbPath = path.join(tempRoot, `fixture-${randomUUID()}.sqlite3`);
  const inputByteHashBefore = sha256File(safe.fixture);
  const network = installNetworkGuard();
  let sourceDb;
  let workingDb;
  let report;
  try {
    await fsp.copyFile(safe.fixture, stagedInputPath);
    sourceDb = new DatabaseSync(stagedInputPath, { readOnly: true });
    await backup(sourceDb, workingDbPath);
    sourceDb.close();
    sourceDb = null;
    workingDb = new DatabaseSync(workingDbPath);
    const integrity = workingDb.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
    assert.deepEqual(integrity, ["ok"]);
    const baseline = wholeDatabaseDigest(workingDb);
    workingDb.exec("BEGIN IMMEDIATE; CREATE TABLE __acceptance_rollback_probe (id TEXT PRIMARY KEY); INSERT INTO __acceptance_rollback_probe VALUES ('probe'); ROLLBACK;");
    const afterRollback = wholeDatabaseDigest(workingDb);
    const rollbackExact = baseline.digest === afterRollback.digest;
    const model = fixtureModel(workingDb);
    const source = inspectSourceContracts(safe.repoRoot);
    const restoredProfileRaw = JSON.parse(await fsp.readFile(safe.restoredProfile, "utf8"));
    const profiles = [
      { name: "fresh", input: { localStorage: {} } },
      { name: "restored", input: restoredProfileRaw },
    ].map(({ name, input }) => ({ name, assertionLevel: "persisted-state-model-preflight", ...normalizeProfile(input) }));
    const malformedContracts = [];
    for (const payload of [null, {}, { inventory: null }, { products: "not-an-array" }]) {
      let rejected = false;
      try { normalizeCollection(payload, ["inventory", "products"]); } catch { rejected = true; }
      malformedContracts.push({ payloadType: payload === null ? "null" : "object", rejected, passed: rejected });
    }
    const expectedChecks = validateExpected(args, model.inventory);
    const inputByteHashAfter = sha256File(safe.fixture);
    const sourceById = new Map(source.modules.map((item) => [item.id, item]));
    const modelById = new Map(model.modules.map((item) => [item.id, item]));
    const matrix = ALL_SURFACES.map((surface) => {
      const sourceEvidence = sourceById.get(surface.id);
      const fixtureEvidence = modelById.get(surface.id);
      const preflightPassed = sourceEvidence.passed && fixtureEvidence.passed;
      return {
        profileCoverage: ["fresh", "restored"],
        module: surface.id,
        title: surface.title,
        route: surface.primary ? surface.id : `embedded:${surface.id}`,
        expected: { recordCount: fixtureEvidence.expectedCount },
        evidence: {
          staticPreflight: {
            executed: true,
            passed: sourceEvidence.passed,
            navigationRegistered: sourceEvidence.navigationRegistered,
            renderPathPresent: sourceEvidence.renderPathPresent,
            endpoints: sourceEvidence.endpoints,
          },
          fixtureModelPreflight: {
            executed: fixtureEvidence.actualCount !== null,
            passed: fixtureEvidence.passed,
            table: fixtureEvidence.fixtureTable,
            recordCount: fixtureEvidence.actualCount,
          },
          backendRuntime: { executed: false, passed: null, httpStatus: null, responseCount: null },
          frontendRuntime: { executed: false, passed: null, renderedRowCount: null, consoleErrors: null },
        },
        preflightPassed,
        completeRuntimeAcceptancePassed: null,
        errors: sourceEvidence.passed ? [] : ["Required static route/render/endpoint contract is absent."],
      };
    });
    const preflightPassed = rollbackExact
      && inputByteHashBefore === inputByteHashAfter
      && source.passed
      && expectedChecks.every((check) => check.passed)
      && malformedContracts.every((check) => check.passed)
      && model.inventory.unmatchedProductReferences.length === 0
      && network.attempts.every((attempt) => attempt.loopback)
      && matrix.every((item) => item.preflightPassed);
    report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      scope: "non-production-disposable-preflight",
      result: {
        preflightPassed,
        completeRuntimeAcceptancePassed: false,
        releaseAcceptanceClaim: "PRECHECK_ONLY",
      },
      safety: {
        fixture: safe.fixture,
        fixtureRoot: safe.fixtureRoot,
        sourceOpenedReadOnly: true,
        inputByteHashBefore,
        inputByteHashAfter,
        inputUnchanged: inputByteHashBefore === inputByteHashAfter,
        workingCopy: "deleted-during-finally",
        networkAttempts: network.attempts,
        nonLoopbackAttempts: network.attempts.filter((attempt) => !attempt.loopback).length,
        cloudRouterInvocations: { count: 0, level: "acceptance-harness-process-only", note: "No application backend was launched." },
      },
      fixture: { integrity, baseline, afterRollback, rollbackExact },
      inventoryBoundary: model.inventory,
      expectedChecks,
      profiles,
      malformedResponseContracts: malformedContracts,
      sourceContracts: source.inventoryContracts,
      moduleMatrix: matrix,
      limitations: [
        "This is a static/fixture-model preflight, not a backend, WebView, packaged-runtime, or complete-software acceptance run.",
        "Runtime evidence fields remain explicitly unexecuted and cannot be inferred from source or fixture-model success.",
        "Network observations cover only this preflight process; they do not establish application cloud-routing behavior.",
      ],
    };
    await writeNewJsonAtomically(safe.report, report);
    console.log(JSON.stringify({ preflightPassed, report: safe.report, inventory: report.inventoryBoundary }, null, 2));
    if (!preflightPassed) process.exitCode = 1;
  } finally {
    try { workingDb?.close(); } catch {}
    try { sourceDb?.close(); } catch {}
    network.restore();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
