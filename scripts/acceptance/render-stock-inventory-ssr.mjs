#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPathInside, resolveAcceptanceReportPath, writeNewJsonAtomically } from "./safe-output.mjs";

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--") || values[index + 1] === undefined) throw new Error(`Invalid argument: ${key || "<missing>"}`);
    result[key.slice(2)] = values[index + 1];
  }
  for (const required of ["fixture", "fixture-root", "report"]) {
    if (!result[required]) throw new Error(`--${required} is required`);
  }
  return result;
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function sidecarState(fixture) {
  return Object.fromEntries(["-wal", "-shm"].map((suffix) => {
    const candidate = `${fixture}${suffix}`;
    return [suffix.slice(1), fs.existsSync(candidate) ? { exists: true, size: fs.statSync(candidate).size, sha256: sha256File(candidate) } : { exists: false }];
  }));
}

function loadRows(fixture) {
  const database = new DatabaseSync(fixture, { readOnly: true });
  try {
    const products = database.prepare(`
      SELECT id, product_name, category_name, unit, barcode, sale_rate, minimum_stock, active
      FROM local_products WHERE deleted_at IS NULL ORDER BY product_name
    `).all().map((row) => ({ ...row, category: row.category_name, selling_rate: row.sale_rate }));
    const lots = database.prepare(`
      SELECT id, product_id, product_name, supplier_id, supplier_name, lot_no, size_grade,
             opening_date, opening_qty, sold_qty, adjusted_qty, balance_qty, cost_rate, sale_rate,
             status, remarks, created_at, updated_at
      FROM local_inventory_lots WHERE deleted_at IS NULL ORDER BY product_name, opening_date, id
    `).all().map((row) => ({
      ...row,
      batch_no: row.lot_no,
      lot_name: row.lot_no,
      lot_size: row.size_grade,
      purchase_date: row.opening_date,
      purchase_qty: row.opening_qty,
      remaining_qty: row.balance_qty,
      purchase_rate: row.cost_rate,
      effective_cost_per_unit: row.cost_rate,
      temporary_sale_rate: row.sale_rate,
      batch_status: row.status,
    }));
    return { products, lots };
  } finally {
    database.close();
  }
}

function memoryStorage(values) {
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: (key) => { delete values[key]; },
  };
}

async function createInventoryRenderer(repoRoot) {
  const frontendRoot = path.join(repoRoot, "frontend");
  const require = createRequire(path.join(frontendRoot, "package.json"));
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const stub = path.join(repoRoot, "scripts", "acceptance", "module-stub.mjs").replaceAll("\\", "/");
  const bootstrapStorage = memoryStorage({});
  globalThis.window = {
    __TAURI_INTERNALS__: null,
    __TAURI__: null,
    location: { origin: "http://localhost", protocol: "http:", host: "localhost", hostname: "localhost" },
    localStorage: bootstrapStorage,
  };
  globalThis.localStorage = bootstrapStorage;
  const { createServer } = await import(pathToFileURL(path.join(frontendRoot, "node_modules", "vite", "dist", "node", "index.js")));
  const server = await createServer({
    root: frontendRoot,
    plugins: [{
      name: "froozerp-acceptance-stubs",
      enforce: "pre",
      resolveId(id) {
        if (["html2canvas", "jspdf", "pdfjs-dist", "qrcode"].includes(id) || id.startsWith("pdfjs-dist/build/pdf.worker.mjs")) return stub;
        return null;
      },
    }],
    ssr: { noExternal: ["html2canvas", "jspdf", "pdfjs-dist", "qrcode"] },
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  try {
    const module = await server.ssrLoadModule("/src/App.jsx?acceptance-inventory-ssr");
    return {
      render({ rows, name, viewMode, loadState = "ready", loadError = "" }) {
        const storageValues = viewMode === null ? {} : { "froozerp-stock-view-mode": viewMode };
        const storage = memoryStorage(storageValues);
        globalThis.window = {
          __TAURI_INTERNALS__: null,
          __TAURI__: null,
          location: { origin: "http://localhost", protocol: "http:", host: "localhost", hostname: "localhost" },
          localStorage: storage,
        };
        globalThis.localStorage = storage;
        const html = renderToStaticMarkup(React.createElement(module.StockInventoryReport, {
          auditEndpoint: "",
          canManageStock: true,
          loadError,
          loadState,
          lots: rows.lots,
          products: rows.products,
        }));
        return {
          name,
          requestedViewMode: viewMode,
          persistedViewModeAfterRender: storageValues["froozerp-stock-view-mode"] ?? null,
          productRows: (html.match(/data-inventory-product-row=/g) || []).length,
          lotRows: (html.match(/data-inventory-lot-row=/g) || []).length,
          hasErrorState: /class="error-banner"[^>]*role="alert"/.test(html),
          hasEmptyProductState: html.includes("No matching stock products found."),
          hasEmptyLotState: html.includes("No matching stock lots found."),
          containsSanitizedError: loadError ? html.includes(loadError) : false,
          htmlLength: html.length,
        };
      },
      async close() {
        await server.close();
        delete globalThis.window;
        delete globalThis.localStorage;
      },
    };
  } catch (error) {
    await server.close();
    delete globalThis.window;
    delete globalThis.localStorage;
    throw error;
  }
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(args["repo-root"] || process.cwd());
const fixtureRoot = path.resolve(args["fixture-root"]);
const fixture = path.resolve(args.fixture);
if (!isPathInside(fixtureRoot, fixture)) throw new Error("SSR fixture must remain inside the disposable fixture root.");
const report = resolveAcceptanceReportPath({ report: args.report, fixtureRoot, evidenceRoot: args["evidence-root"], repoRoot });
if (!fs.statSync(fixture).isFile()) throw new Error("SSR fixture must be a SQLite file.");

const inputHashBefore = sha256File(fixture);
const sidecarsBefore = sidecarState(fixture);
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "froozerp-inventory-render-"));
try {
  const stagedFixture = path.join(temporaryRoot, "fixture.sqlite3");
  await fsp.copyFile(fixture, stagedFixture);
  const rows = loadRows(stagedFixture);
  const renderer = await createInventoryRenderer(repoRoot);
  let scenarios;
  try {
    scenarios = [
      renderer.render({ rows, name: "fresh-product", viewMode: null }),
      renderer.render({ rows, name: "restored-product", viewMode: "PRODUCT" }),
      renderer.render({ rows, name: "restored-stale-mode", viewMode: "BROKEN" }),
      renderer.render({ rows, name: "restored-lot", viewMode: "LOT" }),
      renderer.render({ rows: { products: [], lots: [] }, name: "genuine-empty", viewMode: "PRODUCT" }),
      renderer.render({
        rows: { products: [], lots: [] },
        name: "malformed-contract-error",
        viewMode: "PRODUCT",
        loadState: "error",
        loadError: "Inventory response was malformed. Retry local inventory loading.",
      }),
    ];
  } finally {
    await renderer.close();
  }

  for (const scenario of scenarios.slice(0, 3)) {
    assert.equal(scenario.productRows, 17, `${scenario.name} must render 17 in-stock product rows`);
    assert.equal(scenario.hasErrorState, false);
  }
  assert.equal(scenarios[2].persistedViewModeAfterRender, "BROKEN", "SSR does not run effects; normalized PRODUCT output must be proven by rendered rows");
  assert.equal(scenarios[3].lotRows, 44, "Lot View must render all 44 active available lots");
  assert.equal(scenarios[3].hasErrorState, false);
  assert.equal(scenarios[4].productRows, 0);
  assert.equal(scenarios[4].hasEmptyProductState, true, "A legitimate empty result must render the empty state");
  assert.equal(scenarios[4].hasErrorState, false);
  assert.equal(scenarios[5].productRows, 0);
  assert.equal(scenarios[5].hasErrorState, true, "A malformed contract must render an error state");
  assert.equal(scenarios[5].hasEmptyProductState, false, "An error must not masquerade as empty success");
  assert.equal(scenarios[5].containsSanitizedError, true);

  const inputHashAfter = sha256File(fixture);
  const sidecarsAfter = sidecarState(fixture);
  assert.equal(inputHashAfter, inputHashBefore, "SSR harness must not modify the source fixture");
  assert.deepEqual(sidecarsAfter, sidecarsBefore, "SSR harness must not create or modify fixture WAL/SHM sidecars");
  const output = {
    schemaVersion: 2,
    passed: true,
    assertionLevel: "actual-react-component-ssr",
    runtimeScope: {
      frontendComponentExecuted: true,
      backendExecuted: false,
      tauriWebViewExecuted: false,
      packagedRuntimeExecuted: false,
    },
    fixtureSafety: { inputHashBefore, inputHashAfter, inputUnchanged: true, sidecarsBefore, sidecarsAfter, sidecarsUnchanged: true },
    expected: { products: 25, lots: 70, renderedProductRows: 17, renderedLotRows: 44 },
    actual: { products: rows.products.length, lots: rows.lots.length },
    scenarios,
    limitations: ["This executes the real React Inventory component through Vite SSR; it does not claim Tauri WebView or backend runtime coverage."],
  };
  assert.equal(output.actual.products, output.expected.products);
  assert.equal(output.actual.lots, output.expected.lots);
  await writeNewJsonAtomically(report, output);
  console.log(JSON.stringify(output, null, 2));
} finally {
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
