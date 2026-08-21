/**
 * Telling "this lot cost nothing" apart from "we do not know what this lot cost yet".
 *
 * ## The bug this exists for
 *
 * Stock can arrive before the supplier's bill does. The cloud records that —
 * `inventory_batches.purchase_bill_status` is `BILL_PENDING` until the bill is completed — but the
 * SQLite sync arm dropped the field and took the cost as
 * `effective_cost_per_unit ?? purchase_rate ?? 0.0`. A lot awaiting its bill and a lot that
 * genuinely cost nothing became the same row, and `dashboardSnapshot.js` multiplied that zero
 * straight into stock value.
 *
 * Measured on the 2026-08-15 device snapshot: **7 lots holding 215.550 units — 18.2% of the
 * 1183.550 units on hand — contributed ₹0 to a ₹282,275.00 valuation**, and 41.45 units had
 * already been sold from them at zero cost and booked as 100% margin.
 *
 * `CLAUDE.md`: "Errors must never render as zero." The total was not wrong-looking, which is worse
 * — nothing prompted anyone to check it.
 *
 * ## Three states, not two
 *
 * `UNKNOWN` is a real answer and not a synonym for `FINAL`. Every lot cached before migration 019
 * has `purchase_bill_status = NULL`, because the device was never told. Folding that into `FINAL`
 * would restore the exact bug — a silently-zero lot counted as priced — and folding it into
 * `PROVISIONAL` would flag years of correctly-priced history as unpriced. It is reported as what it
 * is, and it resolves itself as those lots next sync.
 *
 * ## Do not use the lot number
 *
 * Lot numbers are minted `PENDING-${Date.now()}-${purchase.id}` and bill completion never rewrites
 * `batch_no`, so the prefix outlives the condition. Of 49 prefixed lots on that snapshot, **39
 * already carried a real cost**. A filter on the prefix would be wrong about roughly 80% of them.
 * This module reads the status field and nothing else.
 */

export const LOT_COST_STATUS = Object.freeze({
  /** The supplier's bill is in; the cost is real. */
  FINAL: "FINAL",
  /** Stock arrived, bill has not. Any cost on this row is a placeholder. */
  PROVISIONAL: "PROVISIONAL",
  /** This device has never been told. Not the same as FINAL, and must not be treated as it. */
  UNKNOWN: "UNKNOWN",
});

const text = (value) => (typeof value === "string" ? value.trim().toUpperCase() : "");

const finiteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * What a lot's cost status is, read from the synced field alone.
 *
 * @param {object} lot a lot from the reference snapshot
 * @returns {string} one of `LOT_COST_STATUS`
 */
export const lotCostStatus = (lot) => {
  const status = text(lot?.purchase_bill_status);
  if (status === "BILL_PENDING") return LOT_COST_STATUS.PROVISIONAL;
  if (status === "BILL_COMPLETED") return LOT_COST_STATUS.FINAL;
  return LOT_COST_STATUS.UNKNOWN;
};

/** True when this lot's cost is a placeholder and must not be counted as value. */
export const isProvisionalLot = (lot) => lotCostStatus(lot) === LOT_COST_STATUS.PROVISIONAL;

/**
 * Split stock into what can be valued and what cannot.
 *
 * The maintainer's ruling: **one honest headline total, with a visible note for the rest.** Not a
 * separate subtotal competing with it, and emphatically not a single number quietly missing 18% of
 * the stock. A total nobody can trust is worse than a total with a caveat attached.
 *
 * `UNKNOWN` lots are still valued, because refusing to value years of history the moment this
 * shipped would be a worse lie than the one being fixed — but they are counted and reported, so the
 * caveat is visible rather than assumed away.
 *
 * @param {Array<object>} lots
 * @returns {{valuedTotal: number, valuedUnits: number, provisionalUnits: number,
 *   provisionalLotCount: number, unknownLotCount: number, hasUnvaluedStock: boolean}}
 */
export const summariseLotCostStatus = (lots = []) => {
  const summary = {
    valuedTotal: 0,
    valuedUnits: 0,
    provisionalUnits: 0,
    provisionalLotCount: 0,
    unknownLotCount: 0,
    hasUnvaluedStock: false,
  };
  for (const lot of Array.isArray(lots) ? lots : []) {
    const quantity = finiteNumber(lot?.remaining_qty ?? lot?.balance_qty);
    const status = lotCostStatus(lot);
    if (status === LOT_COST_STATUS.PROVISIONAL) {
      summary.provisionalUnits += quantity;
      summary.provisionalLotCount += 1;
      continue;
    }
    if (status === LOT_COST_STATUS.UNKNOWN) summary.unknownLotCount += 1;
    const cost = finiteNumber(lot?.effective_cost_per_unit ?? lot?.purchase_rate ?? lot?.cost_rate);
    summary.valuedTotal += quantity * cost;
    summary.valuedUnits += quantity;
  }
  summary.hasUnvaluedStock = summary.provisionalLotCount > 0;
  return summary;
};

/**
 * The note shown beside the stock value, or `""` when the total is complete.
 *
 * Says what is missing and why, in the words a shopkeeper would use — "awaiting bill", not
 * "BILL_PENDING". Quantities keep three decimals to match the rest of the app.
 */
export const provisionalStockNote = (summary) => {
  if (!summary || !summary.hasUnvaluedStock) return "";
  const units = finiteNumber(summary.provisionalUnits).toFixed(3);
  const lots = finiteNumber(summary.provisionalLotCount);
  return `${units} units in ${lots} lot${lots === 1 ? "" : "s"} are awaiting a supplier bill `
    + "and are not included in this value.";
};
