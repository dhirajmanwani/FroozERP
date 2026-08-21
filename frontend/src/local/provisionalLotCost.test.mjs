import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  LOT_COST_STATUS,
  isProvisionalLot,
  lotCostStatus,
  provisionalStockNote,
  summariseLotCostStatus,
} from "./provisionalLotCost.js";
import { buildLocalDashboardSnapshot } from "./dashboardSnapshot.js";

/**
 * Validated against the measured 2026-08-15 device snapshot recorded in
 * `docs/backlog-1.0.72.md`, rather than against invented numbers — the backlog entry says
 * explicitly that a fix should be checked against those figures and not by mutating the data.
 */
const MEASURED = {
  totalUnits: 1183.55,
  zeroCostUnits: 215.55,
  zeroCostLots: 7,
  stockValue: 282275.0,
};

test("a lot awaiting its bill is not the same as a lot that cost nothing", () => {
  // The whole bug in one assertion. Both rows carry cost 0; only one of them is a fact.
  assert.equal(lotCostStatus({ purchase_bill_status: "BILL_PENDING" }), LOT_COST_STATUS.PROVISIONAL);
  assert.equal(lotCostStatus({ purchase_bill_status: "BILL_COMPLETED" }), LOT_COST_STATUS.FINAL);
});

test("never having been told is its own state, not FINAL", () => {
  // Every lot cached before migration 019 has NULL here. Folding that into FINAL restores the exact
  // bug — a silently-zero lot counted as priced.
  for (const value of [null, undefined, "", "   ", 0, {}]) {
    assert.equal(
      lotCostStatus({ purchase_bill_status: value }),
      LOT_COST_STATUS.UNKNOWN,
      `${JSON.stringify(value)} must not read as FINAL`,
    );
  }
  assert.equal(lotCostStatus({}), LOT_COST_STATUS.UNKNOWN);
  assert.equal(lotCostStatus(null), LOT_COST_STATUS.UNKNOWN);
});

test("the status is read from the field, never from the lot number", () => {
  // Lot numbers are minted `PENDING-...` and bill completion never rewrites them, so the prefix
  // outlives the condition: 39 of 49 prefixed lots on the measured snapshot already had real costs.
  const completedButStillPrefixed = {
    batch_no: "PENDING-1723800000000-412",
    lot_name: "PENDING-1723800000000-412",
    purchase_bill_status: "BILL_COMPLETED",
    remaining_qty: 10,
    purchase_rate: 55,
  };
  assert.equal(isProvisionalLot(completedButStillPrefixed), false, "the prefix must not decide this");
  const summary = summariseLotCostStatus([completedButStillPrefixed]);
  assert.equal(summary.valuedTotal, 550, "a real cost behind a stale prefix must still be valued");
});

test("case and whitespace from the wire do not change the answer", () => {
  assert.equal(lotCostStatus({ purchase_bill_status: " bill_pending " }), LOT_COST_STATUS.PROVISIONAL);
  assert.equal(lotCostStatus({ purchase_bill_status: "Bill_Completed" }), LOT_COST_STATUS.FINAL);
});

// -----------------------------------------------------------------------------------------------
// The measured reproduction
// -----------------------------------------------------------------------------------------------

test("the measured snapshot: unvalued stock is reported, not silently dropped from the total", () => {
  // 7 lots / 215.550 units contributed Rs 0 to a Rs 282,275 valuation while presenting as ordinary
  // priced stock. The total is now honest and the shortfall is stated.
  const provisional = Array.from({ length: MEASURED.zeroCostLots }, (unused, index) => ({
    id: `pending-${index}`,
    remaining_qty: MEASURED.zeroCostUnits / MEASURED.zeroCostLots,
    purchase_rate: 0,
    purchase_bill_status: "BILL_PENDING",
  }));
  const priced = [{
    id: "priced",
    remaining_qty: MEASURED.totalUnits - MEASURED.zeroCostUnits,
    purchase_rate: MEASURED.stockValue / (MEASURED.totalUnits - MEASURED.zeroCostUnits),
    purchase_bill_status: "BILL_COMPLETED",
  }];

  const summary = summariseLotCostStatus([...priced, ...provisional]);
  assert.equal(summary.provisionalLotCount, MEASURED.zeroCostLots);
  assert.ok(Math.abs(summary.provisionalUnits - MEASURED.zeroCostUnits) < 0.001);
  assert.ok(Math.abs(summary.valuedTotal - MEASURED.stockValue) < 0.01, "priced stock still totals correctly");
  assert.equal(summary.hasUnvaluedStock, true);

  const note = provisionalStockNote(summary);
  assert.match(note, /215\.550 units/);
  assert.match(note, /7 lots/);
  assert.doesNotMatch(note, /BILL_PENDING|PROVISIONAL/, "the note must read as plain language");
});

test("a zero-cost lot whose bill IS complete is still valued at zero", () => {
  // Gifted or sample stock is legitimately free. The fix must not turn a real zero into a caveat.
  const summary = summariseLotCostStatus([
    { remaining_qty: 20, purchase_rate: 0, purchase_bill_status: "BILL_COMPLETED" },
  ]);
  assert.equal(summary.valuedTotal, 0);
  assert.equal(summary.hasUnvaluedStock, false, "a genuine zero is not an unknown");
  assert.equal(provisionalStockNote(summary), "");
});

test("nothing awaiting a bill means no note at all", () => {
  // The common case must stay clean; a permanent caveat trains people to ignore it.
  const summary = summariseLotCostStatus([
    { remaining_qty: 5, purchase_rate: 10, purchase_bill_status: "BILL_COMPLETED" },
  ]);
  assert.equal(provisionalStockNote(summary), "");
  assert.equal(summary.valuedTotal, 50);
});

test("history from before migration 019 is still valued, and counted", () => {
  // Refusing to value years of correctly-priced history the moment this shipped would be a worse
  // lie than the one being fixed — but it is reported so the caveat is visible.
  const summary = summariseLotCostStatus([{ remaining_qty: 10, purchase_rate: 7 }]);
  assert.equal(summary.valuedTotal, 70);
  assert.equal(summary.unknownLotCount, 1);
  assert.equal(summary.hasUnvaluedStock, false);
});

test("malformed lots cannot corrupt the total or throw", () => {
  const summary = summariseLotCostStatus([
    null,
    undefined,
    {},
    { remaining_qty: "abc", purchase_rate: "xyz", purchase_bill_status: "BILL_COMPLETED" },
    { remaining_qty: 10, purchase_rate: 5, purchase_bill_status: "BILL_COMPLETED" },
  ]);
  assert.equal(summary.valuedTotal, 50);
  assert.equal(Number.isFinite(summary.valuedTotal), true);
  assert.doesNotThrow(() => summariseLotCostStatus(null));
  assert.doesNotThrow(() => summariseLotCostStatus("not an array"));
});

// -----------------------------------------------------------------------------------------------
// The dashboard, which is where the wrong number was actually shown
// -----------------------------------------------------------------------------------------------

test("the dashboard excludes provisional stock from stockValue and carries the note", () => {
  const snapshot = buildLocalDashboardSnapshot({
    inventoryLots: [
      { id: "a", product_id: "1", remaining_qty: 100, purchase_rate: 10, purchase_bill_status: "BILL_COMPLETED" },
      { id: "b", product_id: "2", remaining_qty: 215.55, purchase_rate: 0, purchase_bill_status: "BILL_PENDING" },
    ],
    sales: [],
  });
  assert.equal(snapshot.metrics.stockValue, 1000, "only priced stock is valued");
  assert.match(snapshot.metrics.stockValueNote, /215\.550 units/);
  assert.equal(snapshot.metrics.provisionalStockLots, 1);
});

test("provisional stock is still stock on hand, it just has no value yet", () => {
  // It is physically in the shop. Dropping it from quantities as well would trade an understated
  // value for an understated stock count, which is not an improvement.
  const snapshot = buildLocalDashboardSnapshot({
    inventoryLots: [
      { id: "b", product_id: "2", product_name: "Apple", remaining_qty: 215.55, purchase_rate: 0, purchase_bill_status: "BILL_PENDING" },
    ],
    sales: [],
  });
  assert.equal(snapshot.metrics.stockValue, 0);
  assert.equal(snapshot.metrics.provisionalStockUnits, 215.55, "the units are still counted");
});

test("the sync arm and the snapshot both carry the field, or none of this works", () => {
  // The chain is Rust -> snapshot -> here. A break anywhere upstream makes every lot read UNKNOWN
  // and silently restores the original behaviour, which no frontend test would notice.
  const rust = fs.readFileSync(new URL("../../../src-tauri/src/local_db.rs", import.meta.url), "utf8");
  assert.match(rust, /optional_text\(&change\.payload, "purchase_bill_status"\)/, "sync must carry it");
  assert.match(rust, /"purchase_bill_status": row\.get::<_, Option<String>>/, "the snapshot must emit it");
  const migration = fs.readFileSync(
    new URL("../../../src-tauri/migrations/sqlite/019_provisional_lot_cost_status.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /ALTER TABLE local_inventory_lots ADD COLUMN purchase_bill_status TEXT/);
});
