import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The All Shops item is wired into the sidebar, and wired Owner-only.
 *
 * Asserted against `App.jsx` source text, which is the existing convention in this directory for
 * things that live in that file and cannot otherwise be reached. It exists because the item failed
 * to appear on the maintainer's machine on first run and there was no automated answer to "is the
 * wiring actually there" — every check had to be done by hand against a 17k-line file.
 *
 * Five separate places have to agree for a view to show up. Each is asserted here so a failure
 * names the one that is missing instead of leaving someone to find it.
 */

const app = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"),
  "utf8",
);

test("All Shops is registered in the sidebar navigation", () => {
  assert.match(app, /\["all-shops", "All Shops"\]/);
});

test("All Shops has an icon, so the sidebar entry is not a blank space", () => {
  // It shipped without one. `Icon` renders `{paths[name]}`, and an unknown name is `undefined`,
  // which React renders as nothing — no crash, no warning, just a button with no glyph beside
  // every other one that has a glyph.
  assert.match(app, /"all-shops":\s*"[a-z]+"/);
});

test("All Shops has a render path", () => {
  assert.match(app, /activeView === "all-shops"/);
});

test("All Shops loads its data when navigated to", () => {
  assert.match(app, /if \(view === "all-shops"\) await loadAllShops\(\);/);
});

test("All Shops is Owner-only, and decided before the general permission test", () => {
  // Admin's default permissions are `{ all: true }`, so anything reaching the general test is open
  // to Admin. The Owner check must therefore come first inside hasModuleAccess, and this asserts
  // the ordering rather than merely the presence of a check.
  const start = app.indexOf("const hasModuleAccess = (view) => {");
  assert.ok(start > 0, "hasModuleAccess must exist");
  const body = app.slice(start, start + 1600);
  const ownerCheck = body.indexOf('view === "all-shops"');
  const generalCheck = body.indexOf("defaultPermissions.all");
  assert.ok(ownerCheck > 0, "all-shops must be gated inside hasModuleAccess");
  assert.ok(generalCheck > 0, "the general permission test must still exist");
  assert.ok(
    ownerCheck < generalCheck,
    "the Owner gate must be decided before the general test, or Admin gets in through `all: true`",
  );
  assert.match(body.slice(ownerCheck - 60, ownerCheck + 120), /OWNER/);
});

test("All Shops is classified as needing the backend, not as offline-capable", () => {
  // No device holds another shop's books, so this view has no local fallback. Listing it as an
  // offline local-data view would promise a snapshot that cannot exist.
  const offlineLocal = app.match(/const offlineLocalDataViews = new Set\(\[([^\]]*)\]\)/);
  const backendRequired = app.match(/const offlineBackendRequiredViews = new Set\(\[([^\]]*)\]\)/);
  assert.ok(offlineLocal && backendRequired, "both offline view sets must exist");
  assert.doesNotMatch(offlineLocal[1], /all-shops/);
  assert.match(backendRequired[1], /all-shops/);
});

test("the shop picker is only rendered when the state module says so", () => {
  // The picker must never be drawn from raw state. `shopPickerVisible` hides it for a single-shop
  // business and for non-Owners, and a component that checked `branches.length` itself would
  // quietly disagree with the tests that pin those rules.
  assert.match(app, /shopPickerVisible\(shopView\)/);
  assert.doesNotMatch(app, /shopViewState\.branches\.length/);
});

test("the viewing-another-shop banner is rendered from the resolved presentation", () => {
  assert.match(app, /shopView\.banner && \(/);
  assert.match(app, /switchShopView\(shopView\.banner\.returnBranchId\)/);
});

test("the banner sits above the connectivity notice", () => {
  // Local Only changes where the numbers come from; viewing another shop changes whose they are.
  // The more surprising message goes first, and ordering in JSX is ordering on screen.
  const shopBanner = app.indexOf('data-shop-view="OTHER_BRANCH"');
  const localOnlyBanner = app.indexOf('data-connectivity-mode="LOCAL_ONLY"');
  assert.ok(shopBanner > 0 && localOnlyBanner > 0, "both banners must exist");
  assert.ok(shopBanner < localOnlyBanner, "the shop banner must render before the connectivity one");
});

test("All Shops asks the server for its as-at date rather than computing one", () => {
  // A device with a wrong clock would otherwise silently shift which day the balance sheet is for.
  // An empty value means "today", decided server-side.
  assert.match(app, /normalizeReportDate\(dateTo\) \? \{ date_to: dateTo \} : \{\}/);
});

test("Orders is registered, has an icon of its own, and renders", () => {
  assert.match(app, /\["orders", "Orders"\]/);
  // Its own glyph rather than a borrowed one: orders are neither purchases nor sales, and a
  // duplicated icon in a sidebar is a nav item people click by mistake.
  assert.match(app, /orders: "parcel"/);
  assert.match(app, /activeView === "orders"/);
  assert.match(app, /if \(view === "orders"\) await Promise\.all\(/);
});

test("Orders is classified as working offline, because it does", () => {
  // The whole reason G7's order half is available now while its website half waits behind the
  // exposure gate. Listing it as backend-required would gate it on a cloud it never calls.
  const offlineLocal = app.match(/const offlineLocalDataViews = new Set\(\[([^\]]*)\]\)/);
  const backendRequired = app.match(/const offlineBackendRequiredViews = new Set\(\[([^\]]*)\]\)/);
  assert.match(offlineLocal[1], /orders/);
  assert.doesNotMatch(backendRequired[1], /"orders"/);
});

test("Orders reads the device, never the API", () => {
  // An API call here would quietly re-gate the one module that needs no cloud.
  const start = app.indexOf("const loadOrders = async");
  const end = app.indexOf("const takeOrder = async", start);
  assert.ok(start > 0 && end > start, "loadOrders must exist");
  const body = app.slice(start, end);
  assert.match(body, /listLocalCustomerOrders\(\)/);
  assert.doesNotMatch(body, /axios\./);
});

test("an order action is validated before it is attempted", () => {
  // The same check the board used to decide which buttons to show, so a visible button can never
  // be a move that is then refused.
  const start = app.indexOf("const advanceOrder = async");
  const body = app.slice(start, start + 1600);
  assert.match(body, /validateOrderAction\(/);
});

test("opening Orders loads the product list the order form needs", () => {
  // The order form picks items from `products`. Without them the "Choose an item" dropdown is
  // empty and the screen looks broken — and nothing else on the view needs products, which is
  // exactly why it was missed the first time.
  assert.match(app, /if \(view === "orders"\) await Promise\.all\(\[loadOrders\(\), loadProducts\(\)\]\)/);
});

test("an empty item list explains itself instead of showing a bare dropdown", () => {
  assert.match(app, /No items are available to order/);
});

test("Orders loads on the offline path as well as the online one", () => {
  // `navigate` dispatches down two separate branches and the local-data one returns early. A
  // loader placed only in the online branch never runs in LOCAL_ONLY — which stranded the one
  // module built to work offline. Both branches are asserted so they cannot drift apart again.
  const occurrences = app.match(/if \(view === "orders"\) await/g) || [];
  assert.equal(occurrences.length, 2, "orders must be dispatched on both the local and online paths");
  // The offline branch must not reach the API. Every other loader there is guarded, and
  // applyReferenceSnapshot has already filled `products` from the local snapshot.
  const localBranch = app.slice(app.indexOf("const localDataMode ="), app.indexOf("setSidebarOpen(false);\n    setActiveView(view);"));
  assert.doesNotMatch(localBranch, /if \(view === "orders"\) await Promise\.all\(\[loadOrders\(\), loadProducts\(\)\]\)/);
});

test("Orders has a safety net that does not depend on navigate", () => {
  // Re-anchored on the property rather than the exact condition when Report Center started
  // needing orders too. What matters is that the screen loads them itself, guarded so it cannot
  // double-load - not the precise shape of the view test, which now covers two views.
  const start = app.indexOf('if (activeView !== "orders"');
  assert.ok(start > 0, "the orders safety net must still be keyed on the orders view");
  const effect = app.slice(start, start + 260);
  assert.match(effect, /if \(ordersState\.loadState !== "idle"\) return;/, "and must not double-load");
  assert.match(effect, /loadOrders\(\);/, "and must actually load them");
});

test("Report Center loads orders itself rather than trusting another screen to have done it", () => {
  // Order reports are built from this device's SQLite. Reached without visiting the Orders screen
  // first, an unloaded list would render as zero orders - indistinguishable from a day nobody
  // ordered anything, which is the "errors must never render as zero" rule in CLAUDE.md.
  const start = app.indexOf('if (activeView !== "orders"');
  assert.ok(start > 0);
  assert.match(app.slice(start, start + 260), /activeView !== "reports"/);
});

test("an order report with unread orders says so instead of showing zeros", () => {
  // The pair that keeps a failed read from reading as a quiet day: no summary figures at all, and
  // an empty table that names the reason rather than claiming no records were found.
  assert.match(app, /return \[\["Orders", "-", true\], \["Status", orderReportsState\.notice/);
  assert.match(app, /isOrderReport && !orderReportsState\.ready\s*\n?\s*\? orderReportsState\.notice/);
});

test("an unloaded Orders screen does not claim to be loading", () => {
  // A permanent "Reading orders from this device..." that is reading nothing is a lie about what
  // the app is doing, and it is exactly what a missed loader looked like.
  assert.match(app, /Orders have not been loaded yet/);
});

test("POS refuses stock that orders have already promised", () => {
  // Without this the reservation is a note on another screen and the fruit gets sold anyway,
  // which is the whole failure reserve-on-order exists to prevent.
  const start = app.indexOf("const counterStock = describeCounterStock({");
  assert.ok(start > 0, "POS must consult the reservation before adding to the cart");
  const body = app.slice(start, start + 1400);
  assert.match(body, /reservedForProduct\(reservedIndex, product\.id\)/);
  // On-hand must be read with the same key form the reservation index uses. A raw lookup against
  // a canonically-keyed map returns undefined, which reads as zero stock and refuses a product
  // that is sitting on the shelf.
  assert.match(body, /onHand: productOnHand\(product\.id\)/);
  assert.match(body, /if \(counterStock\.status !== COUNTER_STOCK\.FREE\)/);
});

test("POS is given the orders it needs to check against", () => {
  // An empty list would refuse nothing and sell the same fruit twice — a guard that silently
  // passes is worse than no guard, because it reads as working.
  assert.match(app, /orders=\{ordersState\.orders\}/);
  const dispatches = app.match(/if \(view === "sales"\) await loadOrders\(\)/g) || [];
  assert.equal(dispatches.length, 2, "POS must load orders on both the local and online paths");
});

test("promised stock is shown on the cart line, not only on refusal", () => {
  // A refusal at the till happens with a customer standing there.
  assert.match(app, /reservedNote\(reservedIndex, item\.product_id, item\.unit\)/);
});

test("sending an order builds a POS cart instead of writing a sale directly", () => {
  // POS owns lot allocation, discounts, mandi tax, payment mode and printing. A second writer
  // that skipped those would be a second set of rules about money, and the one nobody exercises
  // daily is the one that quietly gets it wrong.
  const start = app.indexOf("buildOrderCartSeed(order,");
  assert.ok(start > 0, "sending must build a cart seed");
  const body = app.slice(start, start + 1800);
  assert.match(body, /setPosSeedCart\(\{/);
  assert.match(body, /lines: seed\.lines/);
  // The bill must reach the right ledger. Without the customer it is raised as a walk-in and a
  // credit order leaves no record of who owes for it.
  assert.match(body, /customer: \{/);
  assert.match(body, /await navigate\("sales"\)/);
});

test("an order that cannot be billed at all says so instead of opening an empty till", () => {
  // And the order must not be marked sent in that case: SENT releases the reservation and reads
  // as billed, so an order stranded there shows as done while its fruit is unaccounted for.
  assert.match(app, /This order was not sent: nothing on it can be billed/);
  const advance = app.slice(app.indexOf("const advanceOrder = async"), app.indexOf("const loadShopView = async"));
  const seedAt = advance.indexOf("buildOrderCartSeed(order,");
  const sendAt = advance.indexOf("await setLocalCustomerOrderStatus(");
  assert.ok(seedAt > 0 && sendAt > 0 && seedAt < sendAt, "the cart must be built before the order is marked sent");
});

test("a partly billable order is not silently billed short", () => {
  // Billing part of an order and reporting success under-charges the customer and leaves the
  // order looking complete.
  assert.match(app, /Order sent, and part of it is on the POS screen/);
});

test("the saved bill is linked back to its order", () => {
  // The storage layer treats a written sale_id as what makes an order irreversible. An order
  // billed but not linked would still offer "cancel" and could be billed a second time.
  const start = app.indexOf("if (pendingOrderBill) {");
  assert.ok(start > 0, "the sale handler must link the order");
  const body = app.slice(start, start + 1200);
  assert.match(body, /nextStatus: ORDER_STATUS\.SENT/);
  assert.match(body, /patch: \{ sale_id: saleId, invoice_no: invoiceNo \}/);
  // A failed link must never be silent: the sale is saved and cannot be undone.
  assert.match(body, /Do not bill it again/);
});

test("a seeded cart replaces the cart rather than merging into it", () => {
  // The operator arrived here by sending an order. Merging a half-typed walk-in sale into that
  // customer's bill would put somebody else's fruit on their invoice.
  const start = app.indexOf("const seedLines = Array.isArray(seedCart?.lines)");
  assert.ok(start > 0, "POS must accept a seeded cart");
  const body = app.slice(start, start + 1600);
  assert.match(body, /setCart\(seedLines\.map/);
  assert.match(body, /onSeedConsumed\?\.\(\)/);
});
