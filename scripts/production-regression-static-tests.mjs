import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const app = read("frontend", "src", "App.jsx");
const css = read("frontend", "src", "App.css");
const gateway = read("backend", "desktopGateway.js");
const localSettingsStore = read("backend", "localSettingsStore.js");
const adapters = read("backend", "storageAdapters.js");
const backend = read("backend", "server.js");
const operationalV3 = read("backend", "operationalV3.js");
const rust = read("src-tauri", "src", "lib.rs");
const localDb = read("src-tauri", "src", "local_db.rs");

assert.ok(app.includes('data && typeof data === "object" ? data : {}'), "Settings updater data must normalize null before reading version");
assert.ok(app.includes("markLocalServiceHealthy"), "Recovered native backend health must clear stale frontend service errors");
assert.ok(app.includes("refreshBusinessDataAfterSync"), "Successful sync must refresh dashboard and module state");
assert.ok(app.includes("cacheLocalReferenceSnapshot(snapshot)"), "Successful sync must refresh the durable offline dashboard cache");
for (const loader of ["loadDashboardData", "loadProducts", "loadProductCategories", "loadSalesHistory", "loadPurchases", "loadAccounts", "loadExpenses", "loadReports"]) {
  assert.ok(app.includes(loader), `Post-sync refresh must include ${loader}`);
}

for (const containment of ["min-width: 0", "max-width: 100%", "box-sizing: border-box", "overflow-wrap: anywhere", "word-break: break-word"]) {
  assert.ok(css.includes(containment), `Responsive containment must include ${containment}`);
}
assert.ok(css.includes(".login-panel"), "Login containment must be explicit");
assert.ok(css.includes(".settings-layout"), "Settings containment must be explicit");

assert.ok(rust.includes("LOCAL_BACKEND_START_GUARD"), "Concurrent backend starts must be serialized");
assert.ok(rust.includes('.arg("desktopGateway.js")'), "Desktop must launch the PostgreSQL-free gateway");
for (const variable of ["DATABASE_URL", "CLOUD_DATABASE_URL", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
  assert.ok(rust.includes(`.env_remove("${variable}")`), `Desktop child must remove inherited ${variable}`);
}
assert.ok(adapters.includes("resolveDesktopSqlitePath"), "Desktop SQLite must resolve without user configuration");
assert.ok(adapters.includes('require("node:sqlite")'), "Clean development profiles must create a valid SQLite file");
assert.ok(gateway.includes('"cache-control,content-type'), "WebView health preflight must allow Cache-Control");
assert.ok(gateway.includes('"access-control-allow-private-network": "true"'), "WebView private-network health requests must be allowed");
assert.ok(gateway.includes("writePolicy(input.allowInternetAccess !== false"), "Owner must be able to request either confirmed connectivity mode");
assert.ok(gateway.includes("readAuthoritativeTime"), "Connectivity mode audit must use server-confirmed time when Railway is available");
assert.ok(gateway.includes('role !== "OWNER"'), "App Internet mode changes must remain Owner-only");
assert.ok(gateway.includes('url.pathname === "/settings"') && gateway.includes('source: "local-sqlite"'), "Local Only settings must be served by the local SQLite route");
assert.ok(gateway.includes("blocked: true") && gateway.includes("reachedCloud: false"), "Local Only settings requests must be audited as blocked before cloud routing");
assert.ok(localSettingsStore.includes("PRAGMA query_only = ON"), "Local settings access must remain read-only");
assert.ok(localSettingsStore.includes("LOCAL_SETTINGS_MALFORMED"), "Malformed local settings must fail explicitly without replacement defaults");
assert.ok(localSettingsStore.includes("registration_status") && localSettingsStore.includes("branch_id = ?"), "Local settings must use canonical approved-device branch scope");
assert.equal(/127\.0\.0\.1:5432/.test(gateway), false, "Desktop gateway must never target local PostgreSQL");

assert.ok(backend.includes("ON CONFLICT (operation_id) DO NOTHING"), "Cloud operation acknowledgements must be idempotent");
assert.ok(backend.includes("payload: { ...payload, ...sale"), "Cloud POS change feed must retain invoice items for other devices");
assert.ok(localDb.includes("ON CONFLICT(operation_id) DO NOTHING"), "Local outbox operation IDs must be unique");
assert.ok(localDb.includes("ON CONFLICT(id) DO UPDATE"), "Pulled local entities must upsert idempotently");
assert.ok(localDb.includes('apply_migration(&mut conn, "006_multibranch_identity_foundation"'), "SQLite identity migration must be active");
assert.ok(localDb.includes('apply_migration(&mut conn, "007_cloud_runtime_and_inbox_foundation"'), "SQLite cloud inbox migration must be active");
assert.ok(localDb.includes('apply_migration(&mut conn, "013_operational_location_foundation"'), "SQLite operational-location migration must be active");
assert.ok(localDb.includes('"pos_sale" => apply_pulled_pos_sale_with_tx'), "Pulled POS sales must be applied to the second-device cache");
assert.ok(backend.includes('"/api/v3/operational-context"'), "Protocol v3 must expose canonical operational context");
assert.ok(backend.includes('"/api/v3/inventory"'), "Protocol v3 inventory must be location-scoped");
assert.ok(backend.includes("validateSyncBatchScope"), "Strict sync must reject mixed-location batches");
assert.ok(backend.includes("SCOPE_MODES.ENFORCE"), "Operational-location enforcement must remain feature-gated");
assert.ok(operationalV3.includes('"/api/v3/purchase-orders"'), "Protocol v3 purchase-order CRUD must remain registered");
assert.ok(operationalV3.includes('"/api/v3/goods-receipts"'), "Protocol v3 GRN CRUD must remain registered");
assert.ok(operationalV3.includes('"/api/v3/payment-allocations"'), "Protocol v3 payment-allocation CRUD must remain registered");
assert.ok(operationalV3.includes('"/api/v3/transfers/:transferId/actions/:action"'), "Protocol v3 transfer transitions must remain registered");
assert.ok(operationalV3.includes('"/api/v3/reports/consolidated"'), "Owner consolidated reporting must remain registered");
assert.ok(operationalV3.includes("applyTransferStockEffect"), "Transfer transitions must retain stock effects");

console.log("Production regression static tests passed");
