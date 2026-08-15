import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const runner = path.join(here, "render-stock-inventory-ssr.mjs");

function createInventoryFixture(filePath) {
  const database = new DatabaseSync(filePath);
  try {
    database.exec(`
      CREATE TABLE local_products (
        id TEXT PRIMARY KEY, product_name TEXT, category_name TEXT, unit TEXT, barcode TEXT,
        sale_rate REAL, minimum_stock REAL, active INTEGER, deleted_at TEXT
      );
      CREATE TABLE local_inventory_lots (
        id TEXT PRIMARY KEY, product_id TEXT, product_name TEXT, supplier_id TEXT, supplier_name TEXT,
        lot_no TEXT, size_grade TEXT, opening_date TEXT, opening_qty REAL, sold_qty REAL,
        adjusted_qty REAL, balance_qty REAL, cost_rate REAL, sale_rate REAL, status TEXT,
        remarks TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
      );
    `);
    const insertProduct = database.prepare(`
      INSERT INTO local_products VALUES (?, ?, 'Fruit', 'KG', ?, 120, 1, 1, NULL)
    `);
    const insertLot = database.prepare(`
      INSERT INTO local_inventory_lots VALUES (?, ?, ?, 'supplier-1', 'Supplier One', ?, 'A',
        '2026-06-10', 10, 0, 0, ?, 100, 120, ?, '', '2026-06-10', '2026-06-10', NULL)
    `);
    for (let index = 1; index <= 25; index += 1) {
      insertProduct.run(`product-${index}`, `Product ${String(index).padStart(2, "0")}`, `barcode-${index}`);
    }
    for (let index = 1; index <= 44; index += 1) {
      const productIndex = (index - 1) % 17 + 1;
      insertLot.run(`lot-${index}`, `product-${productIndex}`, `Product ${String(productIndex).padStart(2, "0")}`, `ACTIVE-${index}`, 10, "ACTIVE");
    }
    for (let index = 45; index <= 70; index += 1) {
      const productIndex = (index - 1) % 17 + 1;
      insertLot.run(`lot-${index}`, `product-${productIndex}`, `Product ${String(productIndex).padStart(2, "0")}`, `CANCELLED-${index}`, 10, "CANCELLED");
    }
  } finally {
    database.close();
  }
}

test("real StockInventoryReport SSR is deterministic and preserves its fixture", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "froozerp-stock-ssr-selftest-"));
  try {
    const fixture = path.join(root, "fixture.sqlite3");
    const report = path.join(root, "ssr-report.json");
    createInventoryFixture(fixture);
    const before = fs.readFileSync(fixture);
    const result = spawnSync(process.execPath, [runner,
      "--fixture", fixture,
      "--fixture-root", root,
      "--report", report,
      "--repo-root", repoRoot,
    ], { cwd: repoRoot, encoding: "utf8", timeout: 300_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(await fsp.readFile(report, "utf8"));
    assert.equal(evidence.assertionLevel, "actual-react-component-ssr");
    assert.equal(evidence.runtimeScope.frontendComponentExecuted, true);
    assert.equal(evidence.runtimeScope.backendExecuted, false);
    assert.deepEqual(evidence.scenarios.map(({ name, productRows, lotRows, hasErrorState }) => ({ name, productRows, lotRows, hasErrorState })), [
      { name: "fresh-product", productRows: 17, lotRows: 0, hasErrorState: false },
      { name: "restored-product", productRows: 17, lotRows: 0, hasErrorState: false },
      { name: "restored-stale-mode", productRows: 17, lotRows: 0, hasErrorState: false },
      { name: "restored-lot", productRows: 0, lotRows: 44, hasErrorState: false },
      { name: "genuine-empty", productRows: 0, lotRows: 0, hasErrorState: false },
      { name: "malformed-contract-error", productRows: 0, lotRows: 0, hasErrorState: true },
    ]);
    assert.deepEqual(fs.readFileSync(fixture), before);
    assert.equal(fs.existsSync(`${fixture}-wal`), false);
    assert.equal(fs.existsSync(`${fixture}-shm`), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
