import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  LOCATION_SCOPE_STATUS,
  LOT_SCOPE_MATCH,
  UNKNOWN_COUNTER_SCOPE,
  canonicalScopeId,
  classifyLotScope,
  counterMaySell,
  counterScopeMessage,
  createCounterScope,
  describeCounterScope,
  filterLotsForScope,
  lotBelongsToScope,
  lotScopeOf,
  resolveCounterScope,
  resolveScopedLots,
} from "./locationScope.js";
import {
  filterSellableProducts,
  hasSellableLocalInventory,
  productAvailableQuantity,
  resolveSellableProducts,
  selectLocalPosInventory,
} from "./posInventory.js";
import {
  canonicalInventoryId,
  groupInventoryLotsByProduct,
  resolveInventoryPresentation,
  summarizeInventoryLots,
} from "./stockInventory.js";

// The maintainer's own example, in fixture form: Ratanada holds 15 kg of apples, Main Branch holds
// 20, and one crate of 3 has never been distributed to anybody. A cashier standing in Ratanada must
// be able to bill 15 (plus, grudgingly, the untagged 3) and must never be able to bill Main
// Branch's 20 — that sale would take fruit off a shelf in another building, and print another
// shop's name and GST number on the bill.
const RATANADA = createCounterScope({ companyId: "1", branchId: "7", operationalLocationId: "7-front" });
const MAIN_BRANCH = createCounterScope({ companyId: "1", branchId: "9" });

const ratanadaApples = {
  id: "lot-ratanada",
  product_id: "apple",
  company_id: "1",
  branch_id: "7",
  operational_location_id: "7-front",
  remaining_qty: 15,
  balance_qty: 15,
  effective_cost_per_unit: 100,
  batch_status: "ACTIVE",
};
const mainBranchApples = {
  id: "lot-main",
  product_id: "apple",
  company_id: "1",
  branch_id: "9",
  remaining_qty: 20,
  balance_qty: 20,
  effective_cost_per_unit: 100,
  batch_status: "ACTIVE",
};
const undistributedApples = {
  id: "lot-untagged",
  product_id: "apple",
  remaining_qty: 3,
  balance_qty: 3,
  effective_cost_per_unit: 100,
  batch_status: "ACTIVE",
};

const allLots = () => [ratanadaApples, mainBranchApples, undistributedApples];
const products = () => [{ id: "apple", product_name: "Apple", active: true }];

test("a crate on another shop's shelf is not on this counter's shelf", () => {
  // The rule the whole module exists for. Main Branch's 20 kg must not appear in Ratanada's
  // sellable quantity, in Ratanada's lot list, or in Ratanada's tiles. Selling it is silent on the
  // day it happens and surfaces days later as a shortage nobody can trace.
  assert.equal(classifyLotScope(mainBranchApples, RATANADA), LOT_SCOPE_MATCH.FOREIGN);
  assert.equal(lotBelongsToScope(mainBranchApples, RATANADA), false);

  assert.equal(productAvailableQuantity("apple", allLots(), new Date(), RATANADA), 18);
  assert.deepEqual(
    filterLotsForScope(allLots(), RATANADA).map((lot) => lot.id),
    ["lot-ratanada", "lot-untagged"],
  );

  // And the same crate is Main Branch's own, seen from Main Branch. A filter that excluded
  // everything everywhere would pass the assertion above and be useless.
  assert.equal(classifyLotScope(mainBranchApples, MAIN_BRANCH), LOT_SCOPE_MATCH.MATCH);
  assert.equal(productAvailableQuantity("apple", allLots(), new Date(), MAIN_BRANCH), 23);
});

test("this counter's own stock stays sellable, so the filter cannot pass by hiding everything", () => {
  assert.equal(classifyLotScope(ratanadaApples, RATANADA), LOT_SCOPE_MATCH.MATCH);
  assert.equal(lotBelongsToScope(ratanadaApples, RATANADA), true);

  const sellable = filterSellableProducts(products(), allLots(), new Date(), RATANADA);
  assert.deepEqual(sellable.map((product) => product.id), ["apple"]);
  assert.equal(hasSellableLocalInventory({ products: products(), inventoryLots: allLots() }, RATANADA), true);

  // A counter holding nothing but another shop's fruit has nothing to sell — that is a true "none",
  // and it is a different fact from "I do not know which shop I am".
  const foreignOnly = { products: products(), inventoryLots: [mainBranchApples] };
  assert.equal(hasSellableLocalInventory(foreignOnly, RATANADA), false);
});

test("a row that names no shop is admitted, because absence is not evidence of foreignness", () => {
  // Rule 1, and the same rule `DevicePullScope::refusal_for_inventory_lot` applies: a lot written
  // before migration 013, or pulled from a server that does not send scope, has said nothing about
  // where it is. Refusing those would empty a working shop on the day it upgrades.
  assert.equal(classifyLotScope(undistributedApples, RATANADA), LOT_SCOPE_MATCH.UNSCOPED_ROW);

  const resolution = resolveScopedLots([ratanadaApples, undistributedApples], RATANADA);
  assert.equal(resolution.status, LOCATION_SCOPE_STATUS.SCOPED);
  assert.equal(resolution.counts.unscoped, 1);
  assert.equal(resolution.counts.matched, 1);

  // Admitted, but counted and named, so somebody can be told to distribute them.
  const untaggedOnly = resolveScopedLots([undistributedApples], RATANADA);
  assert.equal(untaggedOnly.status, LOCATION_SCOPE_STATUS.ROWS_UNSCOPED);
  assert.equal(untaggedOnly.lots.length, 1);
  assert.match(untaggedOnly.message, /not marked with a shop yet/);
  assert.match(untaggedOnly.message, /Distribute/);
});

test("an unknown counter scope is a named state, never a stock figure of zero", () => {
  // The failure this arm prevents: a cashier is told the apples are finished while a crate of them
  // sits between them and the customer. CLAUDE.md — "errors must never render as zero" — and it is
  // worse than showing too much, because an empty grid looks like an answer.
  const resolution = resolveScopedLots(allLots(), UNKNOWN_COUNTER_SCOPE);
  assert.equal(resolution.status, LOCATION_SCOPE_STATUS.SCOPE_UNKNOWN);
  assert.equal(resolution.usable, false);
  assert.equal(counterMaySell(resolution), false);
  // Fails closed: nothing is admitted, so no foreign crate can be billed even by a caller that
  // ignores the status entirely.
  assert.deepEqual(resolution.lots, []);

  const summary = summarizeInventoryLots(allLots(), UNKNOWN_COUNTER_SCOPE);
  assert.equal(summary.scopeUsable, false);
  assert.equal(summary.scopeStatus, LOCATION_SCOPE_STATUS.SCOPE_UNKNOWN);

  const presentation = resolveInventoryPresentation({
    loadState: "ready",
    rowCount: 0,
    filteredLotCount: 0,
    scopeStatus: summary.scopeStatus,
    scopeMessage: summary.scopeMessage,
  });
  assert.notEqual(presentation.countLabel, "0", "a device that does not know its shop has no stock figure to give");
  assert.notEqual(presentation.kind, "empty", "an unanswerable question must not present as an empty shelf");
  assert.equal(presentation.countLabel, "Unavailable");
  assert.equal(presentation.reason, LOCATION_SCOPE_STATUS.SCOPE_UNKNOWN);

  // POS asks the same question through its own door and must get the same answer.
  const pos = resolveSellableProducts({ products: products(), inventoryLots: allLots(), scope: UNKNOWN_COUNTER_SCOPE });
  assert.equal(pos.usable, false);
  assert.deepEqual(pos.products, []);
  assert.equal(pos.countLabel, "Unavailable");
  assert.equal(pos.status, LOCATION_SCOPE_STATUS.SCOPE_UNKNOWN);
});

test("the unknown-scope message tells a shopkeeper what to do, not what failed", () => {
  // The person reading this is behind a counter with a customer in front of them. "Scope resolution
  // failed" sends them nowhere; naming the next action and promising nothing is lost does.
  const message = counterScopeMessage(LOCATION_SCOPE_STATUS.SCOPE_UNKNOWN);
  assert.match(message, /has not been told which shop/);
  assert.match(message, /Nothing has been lost/);
  assert.match(message, /Settings/);
  assert.doesNotMatch(message, /undefined|null|error/i);
  assert.equal(describeCounterScope(UNKNOWN_COUNTER_SCOPE), "This device has not been told which shop it is in.");
  assert.equal(describeCounterScope(RATANADA), "Showing stock for branch 7, location 7-front only.");
});

test("a device holding only another shop's stock says so instead of blaming the filters", () => {
  // Zero is honest here — this shop really is holding none — but "no records match the selected
  // filters" would send an operator to clear filters that are not the problem. The fruit may have
  // been distributed to the wrong branch, and Stock Distribution is where that gets found.
  const summary = summarizeInventoryLots([mainBranchApples], RATANADA);
  assert.equal(summary.scopeStatus, LOCATION_SCOPE_STATUS.FOREIGN_ROWS_EXCLUDED);
  assert.equal(summary.scopeCounts.foreign, 1);

  const presentation = resolveInventoryPresentation({
    loadState: "ready",
    rowCount: 0,
    filteredLotCount: 0,
    scopeStatus: summary.scopeStatus,
    scopeMessage: summary.scopeMessage,
  });
  assert.equal(presentation.kind, "empty");
  assert.equal(presentation.countLabel, "0");
  assert.match(presentation.message, /belongs to another shop/);
  assert.match(presentation.message, /Stock Distribution/);
  assert.doesNotMatch(presentation.message, /match the selected filters/);
});

test("foreign rows that reached a working counter are hidden, counted and reported", () => {
  // Any number above zero here means a distribution or a sync guard is wrong upstream. The screen
  // still works — the counter's own figures are correct — so this informs rather than blocks.
  const summary = summarizeInventoryLots(allLots(), RATANADA);
  assert.equal(summary.scopeCounts.foreign, 1);
  const presentation = resolveInventoryPresentation({
    loadState: "ready",
    rowCount: 1,
    filteredLotCount: 2,
    scopeStatus: summary.scopeStatus,
    scopeMessage: summary.scopeMessage,
  });
  assert.equal(presentation.kind, "ready");
  assert.equal(presentation.countLabel, "1");
  assert.match(presentation.notice, /belonging to another shop/);
});

test("the tiles and the table are computed from one filtered set, never two", () => {
  // CLAUDE.md: if a panel's totals come from one collection and its table from another they will
  // eventually disagree, and the disagreement looks like data loss. Both go through the same
  // resolution, so 15 kg on the tile is the same 15 kg the rows add up to.
  const scoped = [ratanadaApples, mainBranchApples, undistributedApples, { ...ratanadaApples, id: "lot-ratanada-2", product_id: "banana", remaining_qty: 4, balance_qty: 4 }];
  const grouped = groupInventoryLotsByProduct(scoped, RATANADA);
  const summary = summarizeInventoryLots(scoped, RATANADA);

  const rowsInTable = [...grouped.values()].reduce((total, lots) => total + lots.length, 0);
  assert.equal(summary.lots, rowsInTable, "every lot the tiles count must be a lot the table shows");
  assert.equal(summary.products, grouped.size);
  assert.equal(summary.quantity, 22, "15 own + 3 untagged + 4 own, and none of Main Branch's 20");
  assert.equal(summary.stockValue, 2200);
  assert.equal(grouped.has("apple"), true);
  assert.equal(grouped.get("apple").some((lot) => lot.id === "lot-main"), false);
});

test("with no scope argument every existing caller behaves exactly as it did before", () => {
  // A required argument would have broken every call site at once; an absent one has to be
  // indistinguishable from the pre-scope module, or this change lands as a silent regression
  // everywhere it was not wired.
  const unfiltered = resolveScopedLots(allLots(), null);
  assert.equal(unfiltered.status, LOCATION_SCOPE_STATUS.UNFILTERED);
  assert.equal(unfiltered.lots.length, 3);
  assert.equal(counterMaySell(unfiltered), true);

  assert.equal(productAvailableQuantity("apple", allLots()), 38);
  assert.deepEqual(filterSellableProducts(products(), allLots()).map((product) => product.id), ["apple"]);
  assert.equal(hasSellableLocalInventory({ products: products(), inventoryLots: allLots() }), true);

  const summary = summarizeInventoryLots(allLots());
  assert.equal(summary.lots, 3);
  assert.equal(summary.products, 1);
  assert.equal(summary.quantity, 38);
  assert.equal(summary.scopeStatus, LOCATION_SCOPE_STATUS.UNFILTERED);
  assert.equal(summary.scopeUsable, true);
  assert.equal(groupInventoryLotsByProduct(allLots()).get("apple").length, 3);

  const selected = selectLocalPosInventory({ products: products(), inventory_lots: allLots() });
  assert.equal(selected.inventoryLots.length, 3);
  assert.equal(selected.scopeStatus, LOCATION_SCOPE_STATUS.UNFILTERED);
  assert.equal(selected.scopeUsable, true);

  // And an unfiltered presentation is byte-for-byte the old three states.
  assert.equal(resolveInventoryPresentation({ loadState: "loading", rowCount: 0 }).kind, "loading");
  assert.equal(resolveInventoryPresentation({ loadState: "ready", rowCount: 0 }).kind, "empty");
  assert.equal(resolveInventoryPresentation({ loadState: "ready", rowCount: 0 }).countLabel, "0");
  assert.equal(resolveInventoryPresentation({ loadState: "ready", rowCount: 17 }).kind, "ready");
  assert.equal(resolveInventoryPresentation({ loadState: "ready", rowCount: 0, filteredLotCount: 44 }).kind, "error");
});

test("POS narrows its lot list to the counter without narrowing the catalogue", () => {
  // Products are the company's list; only lots sit in a place. A product whose only stock is in
  // another shop drops out of the sellable list because its lots did, not because the catalogue was
  // filtered — which is what keeps "Apple: 0 available here" possible and truthful.
  const selected = selectLocalPosInventory({ products: products(), inventory_lots: allLots() }, {}, RATANADA);
  assert.equal(selected.products.length, 1);
  assert.deepEqual(selected.inventoryLots.map((lot) => lot.id), ["lot-ratanada", "lot-untagged"]);
  assert.equal(selected.scopeUsable, true);
  assert.equal(selected.scopeStatus, LOCATION_SCOPE_STATUS.FOREIGN_ROWS_EXCLUDED);

  const blind = selectLocalPosInventory({ products: products(), inventory_lots: allLots() }, {}, UNKNOWN_COUNTER_SCOPE);
  assert.deepEqual(blind.inventoryLots, []);
  assert.equal(blind.scopeUsable, false, "an empty POS lot list must carry the reason it is empty");
});

test("scope ids are compared as opaque text, across the SQLite/Postgres type boundary", () => {
  // SQLite stores branch_id as TEXT, Postgres as INTEGER, so a comparison necessarily crosses that
  // boundary and the only safe crossing is text. `"004"` and `4` are different entities; coercing
  // them together is what silently emptied the Inventory table once already.
  assert.equal(canonicalScopeId(7), "7");
  assert.equal(canonicalScopeId("7"), "7");
  assert.equal(canonicalScopeId(" 7 "), "7");
  assert.equal(canonicalScopeId(7.0), "7", "JSON 4.0 and JSON 4 are the same branch said two ways");
  assert.equal(canonicalScopeId("004"), "004");
  assert.notEqual(canonicalScopeId("004"), canonicalScopeId(4));

  // The same trim-to-text rule product ids use, pinned here so the two cannot drift apart.
  assert.equal(canonicalScopeId(" product-1 "), canonicalInventoryId(" product-1 "));

  // "unassigned" is the applier's placeholder for "the server said nothing" — not the name of a
  // shop. Treating it as one would make every unassigned row foreign to every counter.
  assert.equal(canonicalScopeId("unassigned"), "");
  assert.equal(canonicalScopeId("UNASSIGNED"), "");
  assert.equal(canonicalScopeId(""), "");
  assert.equal(canonicalScopeId(null), "");
  assert.equal(canonicalScopeId(undefined), "");
  assert.equal(canonicalScopeId(Number.NaN), "");
  assert.equal(canonicalScopeId(true), "");
  assert.equal(canonicalScopeId({ id: 7 }), "");

  // A device whose branch arrives as text still matches lots whose branch arrives as a number.
  const textCounter = createCounterScope({ branchId: "7" });
  assert.equal(classifyLotScope({ branch_id: 7 }, textCounter), LOT_SCOPE_MATCH.MATCH);
  assert.equal(classifyLotScope({ branch_id: "004" }, createCounterScope({ branchId: 4 })), LOT_SCOPE_MATCH.FOREIGN);
  assert.equal(classifyLotScope({ branch_id: "unassigned" }, textCounter), LOT_SCOPE_MATCH.UNSCOPED_ROW);
});

test("a lot's stated scope is read from either naming convention and never invented", () => {
  assert.deepEqual(lotScopeOf({ branch_id: "7", company_id: "1", operational_location_id: "7-front" }), {
    companyId: "1",
    branchId: "7",
    operationalLocationId: "7-front",
  });
  assert.deepEqual(lotScopeOf({ branchId: 7, companyId: 1 }), {
    companyId: "1",
    branchId: "7",
    operationalLocationId: "",
  });
  assert.deepEqual(lotScopeOf(null), { companyId: "", branchId: "", operationalLocationId: "" });
});

test("a counter's shop is the machine's, never the login's and never a guess", () => {
  // docs/stock-distribution-decision.md: selling binds to the shop the machine is in, because the
  // customer and the fruit are standing there. A login that follows a person between shops must not
  // move the shelf with them.
  const fromCanonical = resolveCounterScope({
    canonical_scope: { company_id: "1", branch_id: "7", operational_location_id: "7-front", source: "entitlement" },
    device_identity: { branch_id: "9" },
  });
  assert.equal(fromCanonical.known, true);
  assert.equal(fromCanonical.branchId, "7");
  assert.equal(fromCanonical.source, "entitlement");

  // A snapshot written before canonical_scope existed still resolves, from the approved identity.
  const fromIdentity = resolveCounterScope({ device_identity: { company_id: "1", branch_id: "9" } });
  assert.equal(fromIdentity.branchId, "9");
  assert.equal(fromIdentity.source, "device_identity");

  // Neither the user's branch nor the cached branch_context may stand in. branch_context defaults
  // to a hardcoded "1" when nothing is cached, and a counter that guesses its own shop is the
  // wrong-shop sale wearing a confident face.
  const guessed = resolveCounterScope({ user: { branch_id: "9" }, branch_context: { branch_id: "1" } });
  assert.equal(guessed.known, false);
  assert.equal(guessed.branchId, "");
  assert.equal(resolveCounterScope({}).known, false);
  assert.equal(resolveCounterScope().known, false);

  // A company with no branch is not a shelf: it cannot separate Ratanada from Main Branch.
  const companyOnly = resolveCounterScope({ canonical_scope: { company_id: "1", branch_id: null } });
  assert.equal(companyOnly.known, false);
  assert.equal(companyOnly.source, "unscoped");

  // Scope warnings are metadata trouble the Rust resolver returns as data; they must reach the
  // frontend without turning a usable scope into an unusable one.
  const conflicted = resolveCounterScope({
    canonical_scope: { branch_id: "7", warnings: [{ code: "DEVICE_SCOPE_CONFLICT" }] },
  });
  assert.equal(conflicted.known, true);
  assert.deepEqual(conflicted.warnings, [{ code: "DEVICE_SCOPE_CONFLICT" }]);
});

test("an unknown scope refuses to judge rather than calling them all foreign", () => {
  // Rule 2, and the applier's rule 2: a device that was never bootstrapped has no shelf to compare
  // against, and a check that cannot be evaluated must not be resolved as "guilty". The distinction
  // matters because UNDECIDABLE gets a sentence on screen and FOREIGN gets a hidden row.
  assert.equal(classifyLotScope(ratanadaApples, UNKNOWN_COUNTER_SCOPE), LOT_SCOPE_MATCH.UNDECIDABLE);
  assert.equal(classifyLotScope(ratanadaApples, null), LOT_SCOPE_MATCH.UNDECIDABLE);
  assert.equal(lotBelongsToScope(ratanadaApples, UNKNOWN_COUNTER_SCOPE), false);
  assert.equal(counterMaySell(resolveScopedLots(allLots(), UNKNOWN_COUNTER_SCOPE)), false);
});

test("the screen judges by the same rules as the sync applier that admitted the row", () => {
  // If the screen used a different rule than DevicePullScope::refusal_for_inventory_lot, one of the
  // two would be wrong about the same crate and neither would say so. These assertions fail if the
  // Rust guard is renamed or its stated rules are edited away, which is the moment to re-check this
  // module rather than months later.
  const rust = fs.readFileSync(new URL("../../../src-tauri/src/local_db.rs", import.meta.url), "utf8");
  assert.match(rust, /fn refusal_for_inventory_lot/);
  assert.match(rust, /fn canonical_scope_id/);
  assert.match(rust, /eq_ignore_ascii_case\("unassigned"\)/);
  assert.match(rust, /Only a stated scope can disagree/);
  assert.match(rust, /Only a known scope can judge/);
  // The snapshot must still emit the three scope fields on every lot; without them the frontend
  // cannot filter by shop even if it wants to, and every counter sees every counter's fruit.
  assert.match(rust, /"branch_id": row\.get::<_, Option<String>>/);
  assert.match(rust, /product_stock_by_scope/);
});

test("company-wide product stock is not a shelf figure and the scoped path never uses it", () => {
  // `products.current_stock` sums every location, which is right for an owner and wrong for a
  // cashier, and nothing in the name says which. Availability is derived from lots — which carry a
  // place — so a counter's figure can never come from the company-wide aggregate by accident.
  const catalogue = [{ id: "apple", product_name: "Apple", active: true, current_stock: 38 }];
  assert.equal(productAvailableQuantity("apple", allLots(), new Date(), RATANADA), 18);
  const pos = resolveSellableProducts({ products: catalogue, inventoryLots: allLots(), scope: RATANADA });
  assert.equal(pos.usable, true);
  assert.equal(pos.countLabel, "1");
  assert.equal(pos.products[0].current_stock, 38, "the catalogue row is passed through untouched");
});

test("the scope filter and the product join speak one id convention", () => {
  // The mismatch CLAUDE.md records: a scope filter written with canonicalInventoryId beside a
  // product match written with String(id) silently empties a table while every tile stays correct.
  // POS now matches products the way stockInventory and reservedStock do.
  const padded = [{ ...ratanadaApples, product_id: " apple " }];
  assert.equal(productAvailableQuantity("apple", padded, new Date(), RATANADA), 15);
  assert.equal(productAvailableQuantity("004", [{ ...ratanadaApples, product_id: "004" }], new Date(), RATANADA), 15);
  assert.equal(productAvailableQuantity(4, [{ ...ratanadaApples, product_id: "004" }], new Date(), RATANADA), 0);
  // A product row with no id must not match lots with no product id; "undefined" is not an entity.
  assert.equal(productAvailableQuantity(undefined, [{ ...ratanadaApples, product_id: undefined }], new Date(), RATANADA), 0);
});

test("a lot fully dispatched elsewhere keeps its zero without falling through to another field", () => {
  // CLAUDE.md: `??` does not fall through on 0, and several lot fields are legitimately zero. A lot
  // emptied by a distribution must read as 0 available on its own shelf, not borrow a sibling
  // field's number and appear sellable.
  const emptied = { ...ratanadaApples, remaining_qty: 0, balance_qty: 0 };
  assert.equal(productAvailableQuantity("apple", [emptied], new Date(), RATANADA), 0);
  const summary = summarizeInventoryLots([emptied], RATANADA);
  assert.equal(summary.quantity, 0);
  assert.equal(summary.lots, 1, "an empty lot is still this counter's row, not a hidden one");
  assert.equal(summary.scopeUsable, true);
});
