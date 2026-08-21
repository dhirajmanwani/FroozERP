import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ALL_SURFACES, buildInventoryBoundary, inspectSourceContracts, normalizeCollection, normalizeProfile } from "./module-matrix-core.mjs";
import { resolveAcceptanceReportPath, writeNewJsonAtomically } from "./safe-output.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "run-disposable-module-matrix.mjs");

test("canonical string product IDs retain their active lots", () => {
  const products = [{ id: "product-1" }, { id: "product-aac83a1a" }];
  const lots = [
    { id: "lot-1", product_id: "product-1", balance_qty: 3, cost_rate: 10, status: "ACTIVE" },
    { id: "lot-2", product_id: "product-aac83a1a", balance_qty: 2, cost_rate: 20, status: "ACTIVE" },
    { id: "lot-3", product_id: "product-1", balance_qty: 0, cost_rate: 10, status: "ACTIVE" },
  ];
  assert.deepEqual(buildInventoryBoundary(products, lots), {
    products: 2, lots: 3, activeAvailableLots: 2, productsWithAvailableStock: 2,
    quantity: 5, stockValue: 70, missingCostLots: 0, unmatchedProductReferences: [],
  });
});

test("fixture model preserves the captured Inventory boundary metrics", () => {
  const products = Array.from({ length: 25 }, (_, index) => ({ id: `product-${index + 1}` }));
  const activeLots = Array.from({ length: 44 }, (_, index) => ({
    id: `lot-${index + 1}`,
    product_id: `product-${index % 17 + 1}`,
    balance_qty: index === 43 ? 753.55 : 10,
    cost_rate: index === 43 ? 239275 / 753.55 : 100,
    status: "ACTIVE",
  }));
  const cancelledLots = Array.from({ length: 26 }, (_, index) => ({
    id: `cancelled-lot-${index + 1}`,
    product_id: `product-${index % 17 + 1}`,
    balance_qty: 5,
    cost_rate: 100,
    status: "CANCELLED",
  }));
  const result = buildInventoryBoundary(products, [...activeLots, ...cancelledLots]);
  assert.equal(result.products, 25);
  assert.equal(result.lots, 70);
  assert.equal(result.activeAvailableLots, 44);
  assert.equal(result.productsWithAvailableStock, 17);
  assert.ok(Math.abs(result.quantity - 1183.55) < 0.0005);
  assert.ok(Math.abs(result.stockValue - 282275) < 0.0005);
});

test("malformed collection contracts cannot become empty success", () => {
  assert.throws(() => normalizeCollection({}, ["inventory"]), /Malformed collection response/);
  assert.throws(() => normalizeCollection({ inventory: null }, ["inventory"]), /Malformed collection response/);
  assert.deepEqual(normalizeCollection({ inventory: [{ id: 1 }] }, ["inventory"]), [{ id: 1 }]);
});

test("restored stale Inventory state is normalized without inventing a date filter", () => {
  assert.deepEqual(normalizeProfile({ localStorage: { "froozerp-stock-view-mode": "BROKEN" } }), {
    viewMode: "PRODUCT", stockDateFrom: "", stockDateTo: "", outerReportRangeIsInventoryFilter: false, staleViewModeIgnored: true,
  });
});

test("source audit rejects numeric identity coercion and missing error contracts", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "froozerp-source-audit-selftest-"));
  try {
    await fsp.mkdir(path.join(root, "frontend", "src"), { recursive: true });
    await fsp.mkdir(path.join(root, "backend"), { recursive: true });
    await fsp.writeFile(path.join(root, "frontend", "src", "App.jsx"), "Number(lot.product_id) === Number(product.product_id)");
    await fsp.writeFile(path.join(root, "backend", "server.js"), "");
    const result = inspectSourceContracts(root);
    assert.equal(result.passed, false);
    assert.equal(result.inventoryContracts.find(({ id }) => id === "canonical-string-product-identity").passed, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("report paths are constrained and reports are create-new", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "froozerp-safe-output-selftest-"));
  try {
    const repoRoot = path.join(root, "repo");
    const fixtureRoot = path.join(root, "fixture");
    const evidenceRoot = path.join(repoRoot, ".cache", "evidence");
    await fsp.mkdir(fixtureRoot, { recursive: true });
    await fsp.mkdir(evidenceRoot, { recursive: true });
    const fixtureReport = resolveAcceptanceReportPath({
      report: path.join(fixtureRoot, "report.json"), fixtureRoot, repoRoot,
    });
    const evidenceReport = resolveAcceptanceReportPath({
      report: path.join(evidenceRoot, "report.json"), fixtureRoot, evidenceRoot, repoRoot,
    });
    assert.throws(() => resolveAcceptanceReportPath({
      report: path.join(root, "arbitrary.json"), fixtureRoot, repoRoot,
    }), /must be inside/);
    assert.throws(() => resolveAcceptanceReportPath({
      report: path.join(root, "outside-evidence", "report.json"),
      fixtureRoot,
      evidenceRoot: path.join(root, "outside-evidence"),
      repoRoot,
    }), /excluded \.cache/);
    await writeNewJsonAtomically(fixtureReport, { first: true });
    await writeNewJsonAtomically(evidenceReport, { evidence: true });
    await assert.rejects(writeNewJsonAtomically(fixtureReport, { overwritten: true }), /EEXIST/);
    assert.deepEqual(JSON.parse(await fsp.readFile(fixtureReport, "utf8")), { first: true });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runner uses a disposable copy, records all surfaces, and proves rollback", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "froozerp-matrix-selftest-"));
  try {
    const fixture = path.join(root, "fixture.sqlite3");
    const profile = path.join(root, "restored-profile.json");
    const report = path.join(root, "report.json");
    const sourceRoot = path.join(root, "source");
    await fsp.mkdir(path.join(sourceRoot, "frontend", "src"), { recursive: true });
    await fsp.mkdir(path.join(sourceRoot, "backend"), { recursive: true });
    const sourceTokens = ALL_SURFACES.flatMap((surface) => [
      ...(surface.primary ? [`[\"${surface.id}\", \"${surface.title}\"]`, `activeView === \"${surface.id}\"`] : []),
      ...surface.endpoints,
    ]);
    sourceTokens.push(
      "const loadReports = async () => { stockReport: localSnapshot.products; inventoryLoadError; normalizeStockViewMode; };",
      "const loadExpenses = async () => {};"
    );
    await fsp.writeFile(path.join(sourceRoot, "frontend", "src", "App.jsx"), sourceTokens.join("\n"));
    await fsp.writeFile(path.join(sourceRoot, "backend", "server.js"), sourceTokens.join("\n"));
    const db = new DatabaseSync(fixture);
    db.exec(`
      CREATE TABLE local_products (id TEXT PRIMARY KEY, product_name TEXT);
      CREATE TABLE local_inventory_lots (id TEXT PRIMARY KEY, product_id TEXT, balance_qty REAL, cost_rate REAL, status TEXT, deleted_at TEXT);
      CREATE TABLE local_supplier_references (supplier_id TEXT PRIMARY KEY, supplier_name TEXT);
      CREATE TABLE local_outbox (event_id TEXT PRIMARY KEY, status TEXT, device_id TEXT);
      INSERT INTO local_products VALUES ('product-1', 'One'), ('product-2', 'Two');
      INSERT INTO local_inventory_lots VALUES
        ('lot-1', 'product-1', 3, 10, 'ACTIVE', NULL),
        ('lot-2', 'product-2', 2, 20, 'ACTIVE', NULL),
        ('lot-3', 'product-1', 0, 10, 'ACTIVE', NULL);
      INSERT INTO local_supplier_references VALUES ('supplier-1', 'Supplier One');
      INSERT INTO local_outbox VALUES ('event-1', 'pending', 'device-1');
    `);
    db.close();
    await fsp.writeFile(profile, JSON.stringify({ localStorage: { "froozerp-stock-view-mode": "BROKEN" } }));
    const before = fs.readFileSync(fixture);
    const result = spawnSync(process.execPath, [runner,
      "--fixture", fixture, "--fixture-root", root, "--restored-profile", profile, "--report", report,
      "--repo-root", sourceRoot,
      "--expect-products", "2", "--expect-lots", "3", "--expect-active-lots", "2",
      "--expect-stock-products", "2", "--expect-quantity", "5", "--expect-stock-value", "70",
    ], { cwd: path.resolve(here, "..", ".."), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await fsp.readFile(report, "utf8"));
    assert.equal(output.schemaVersion, 2);
    assert.equal(output.scope, "non-production-disposable-preflight");
    assert.equal(output.result.preflightPassed, true);
    assert.equal(output.result.completeRuntimeAcceptancePassed, false);
    assert.equal(output.result.releaseAcceptanceClaim, "PRECHECK_ONLY");
    assert.equal(output.fixture.rollbackExact, true);
    assert.equal(output.safety.inputUnchanged, true);
    // Derived, not written out: this was a bare 21, and adding one surface failed here with
    // "22 !== 21" and no hint that the list is the thing that moved. What matters is that the
    // runner reports every surface it was given, which is what this now says.
    assert.equal(output.moduleMatrix.length, ALL_SURFACES.length);
    assert.deepEqual(output.profiles.map(({ name }) => name), ["fresh", "restored"]);
    assert.equal(output.moduleMatrix.every((entry) => entry.evidence.staticPreflight.endpoints.length > 0), true);
    assert.equal(output.moduleMatrix.every((entry) => Array.isArray(entry.errors)), true);
    assert.equal(output.moduleMatrix.every((entry) => entry.evidence.backendRuntime.executed === false), true);
    assert.equal(output.moduleMatrix.every((entry) => entry.evidence.frontendRuntime.executed === false), true);
    assert.equal(output.moduleMatrix.every((entry) => entry.completeRuntimeAcceptancePassed === null), true);
    assert.equal(output.safety.nonLoopbackAttempts, 0);
    assert.equal(output.inventoryBoundary.productsWithAvailableStock, 2);
    assert.equal(output.sourceContracts.every((contract) => contract.passed), true);
    assert.deepEqual(fs.readFileSync(fixture), before);
    assert.equal(fs.existsSync(`${fixture}-wal`), false);
    assert.equal(fs.existsSync(`${fixture}-shm`), false);

    const repeat = spawnSync(process.execPath, [runner,
      "--fixture", fixture, "--fixture-root", root, "--restored-profile", profile, "--report", report,
      "--repo-root", sourceRoot,
    ], { cwd: path.resolve(here, "..", ".."), encoding: "utf8" });
    assert.notEqual(repeat.status, 0, "A pre-existing report must not be overwritten");
    assert.match(repeat.stderr, /EEXIST/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
