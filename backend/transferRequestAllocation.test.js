"use strict";

/**
 * Asking another branch for stock, and the branch that holds it choosing which crates to send.
 *
 * The maintainer ruled that branches may request stock from each other, with the branch holding the
 * fruit deciding whether to accept. The engine already had that direction --
 * `initiation_mode = 'DESTINATION_REQUESTED'`, where the *source* performs approve and reject. What
 * it did not have was a way to write the request down: `source_lot_id` was `NOT NULL`, so the asking
 * branch had to name a lot belonging to the other branch, which its device deliberately cannot see.
 * The stock scoping that makes a counter safe is exactly what made the request unfillable.
 *
 * So a request now names a product and a quantity. The approver names the crates -- and may split
 * one request across several, because "send me 10 kg" is answered from whatever crates are open.
 *
 * ## The failure this file mostly exists to prevent
 *
 * `applyTransferStockEffect` reads its items with an **inner join** to `inventory_batches` on
 * `source_lot_id`. A row with no lot does not fail that query -- it vanishes from it. So an
 * unallocated line would not raise anything; the transfer would advance through approve and
 * dispatch having moved no fruit at all, and report success. The shortage would surface days later
 * at the receiving branch with nothing to explain it. Several tests below exist for that one shape.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { applyTransferStockEffect } = require("./operationalV3");

const TRANSFER = Object.freeze({
  id: 9,
  company_id: 1,
  source_branch_id: 3,
  source_operational_location_id: 30,
  destination_branch_id: 1,
  destination_operational_location_id: 10,
  transfer_number: "TR-9",
});

const context = { user_id: 1, device_id: "DEVICE-1", company_id: 1 };

/**
 * A client that models the one predicate that matters: which lines still have no crate.
 *
 * Answering every `inventory_transfer_items` query with the same row is what made an earlier
 * fixture claim an already-allocated line was unallocated. The stub distinguishes them.
 */
const scriptedClient = ({ unallocated = [], allocated = [], lots = {}, globalIds = {}, aliasedIds = [] } = {}) => {
  const statements = [];
  let pending = unallocated.length;
  return {
    statements,
    inserted: [],
    query: async function (text, values) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      statements.push({ sql, values: values || [] });

      if (sql.includes("COUNT(*)") && sql.includes("source_lot_id IS NULL")) {
        return { rows: [{ pending }] };
      }
      // Snapshot references: `globalIds` maps a lot's global id to its row id, and `aliasedIds`
      // lists rows with no global id, which the desktop names `inventory-lot-<id>`.
      if (sql.startsWith("SELECT id FROM inventory_batches WHERE global_id")) {
        return { rows: globalIds[values[0]] && values[1] === TRANSFER.company_id ? [{ id: globalIds[values[0]] }] : [] };
      }
      if (sql.startsWith("SELECT id FROM inventory_batches WHERE id")) {
        return { rows: aliasedIds.includes(values[0]) && values[1] === TRANSFER.company_id ? [{ id: values[0] }] : [] };
      }
      if (sql.includes("source_lot_id IS NULL")) {
        return { rows: unallocated };
      }
      if (sql.startsWith("UPDATE inventory_transfer_items SET source_lot_id")) {
        pending = Math.max(pending - 1, 0);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO inventory_transfer_items")) {
        this.inserted.push(values);
        return { rows: [{ id: 900 + this.inserted.length }] };
      }
      if (sql.includes("FROM inventory_batches ib") && sql.includes("LEFT JOIN stock_reservations")) {
        const lot = lots[Number(values[0])];
        return { rows: lot ? [lot] : [] };
      }
      if (sql.includes("FROM inventory_transfer_items ti")) {
        return { rows: allocated };
      }
      if (sql.includes("FROM stock_reservations")) return { rows: [{ reserved: "0" }] };
      return { rows: [{ id: 1 }] };
    },
  };
};

const approve = (client, body = {}) =>
  applyTransferStockEffect(client, TRANSFER, "approve", body, context, "key-1");

test("approving a request with no crate chosen is refused, not quietly skipped", async () => {
  // The headline case. The items query is an inner join on the lot, so an unallocated line is
  // invisible to it -- without an explicit refusal the transfer would approve, reserve nothing,
  // dispatch nothing, and say it worked.
  const client = scriptedClient({ unallocated: [{ id: 50, product_id: 276, requested_quantity: "10" }] });

  await assert.rejects(
    approve(client, { items: [] }),
    (error) => error.code === "TRANSFER_ALLOCATION_REQUIRED",
    "an unallocated request line must refuse approval by name",
  );
});

test("the approver names the crates, and one request can be split across several", async () => {
  // "Send me 10 kg" answered from two open crates -- 6 from one, 4 from another. Each crate carries
  // its own purchase cost into the receiving branch's margin, so they cannot be merged into one row.
  const client = scriptedClient({
    unallocated: [{ id: 50, product_id: 276, requested_quantity: "10" }],
    allocated: [{ id: 50, source_lot_id: 71, product_id: 276, requested_quantity: "6", remaining_qty: "20" }],
    lots: {
      71: { id: 71, effective_cost_per_unit: "80.5", available: "20" },
      72: { id: 72, effective_cost_per_unit: "95.0", available: "20" },
    },
  });

  await approve(client, {
    items: [{
      item_id: 50,
      allocations: [
        { source_lot_id: 71, quantity: 6 },
        { source_lot_id: 72, quantity: 4 },
      ],
    }],
  });

  const rewrite = client.statements.find((entry) => entry.sql.startsWith("UPDATE inventory_transfer_items SET source_lot_id"));
  assert.ok(rewrite, "the request line must be rewritten to the first crate");
  assert.deepEqual(rewrite.values, [50, 71, 6, "80.5"], "and must carry that crate's own cost");

  assert.equal(client.inserted.length, 1, "the second crate becomes its own line");
  assert.deepEqual(
    client.inserted[0],
    [9, 276, 72, 4, "95.0"],
    "the extra line keeps the transfer, the product, its own crate, its own quantity and its own cost",
  );
});

test("crates adding up to more than was asked for are refused", async () => {
  const client = scriptedClient({
    unallocated: [{ id: 50, product_id: 276, requested_quantity: "10" }],
    lots: { 71: { id: 71, effective_cost_per_unit: "80", available: "50" } },
  });

  await assert.rejects(
    approve(client, { items: [{ item_id: 50, allocations: [{ source_lot_id: 71, quantity: 11 }] }] }),
    (error) => error.code === "TRANSFER_ALLOCATION_EXCEEDS_REQUEST",
  );
});

test("a crate belonging to somewhere else cannot be allocated", async () => {
  // The lot lookup is bound to the transfer's own source company, branch and location, so an
  // approver cannot reach into another shop's shelf to fill a request.
  const client = scriptedClient({
    unallocated: [{ id: 50, product_id: 276, requested_quantity: "10" }],
    lots: {},
  });

  await assert.rejects(
    approve(client, { items: [{ item_id: 50, allocations: [{ source_lot_id: 999, quantity: 5 }] }] }),
    (error) => error.code === "TRANSFER_ALLOCATION_INVALID",
  );

  const lookup = client.statements.find((entry) => entry.sql.includes("LEFT JOIN stock_reservations"));
  assert.deepEqual(
    lookup.values,
    [999, 276, 1, 3, 30],
    "the lot must be checked against the transfer's source company, branch and location",
  );
});

test("a crate that no longer holds the quantity is refused", async () => {
  // Between asking and approving, the source branch may have sold the fruit. `available` is
  // remaining minus live reservations, so a crate already promised elsewhere cannot be promised
  // twice.
  const client = scriptedClient({
    unallocated: [{ id: 50, product_id: 276, requested_quantity: "10" }],
    lots: { 71: { id: 71, effective_cost_per_unit: "80", available: "3" } },
  });

  await assert.rejects(
    approve(client, { items: [{ item_id: 50, allocations: [{ source_lot_id: 71, quantity: 5 }] }] }),
    (error) => error.code === "TRANSFER_STOCK_UNAVAILABLE",
  );
});

test("a line left with no crate stops the whole transfer moving", async () => {
  // The backstop for every path that is not approve. If a line somehow reaches dispatch with no
  // crate, the inner join drops it and that quantity moves nowhere -- silently. This refuses by
  // name instead.
  const client = scriptedClient({
    unallocated: [],
    allocated: [{ id: 51, source_lot_id: 71, product_id: 276, requested_quantity: "5", reserved_quantity: "5", remaining_qty: "20" }],
  });
  // One line still unallocated, which only the COUNT query reports.
  client.query = async function (text, values) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    if (sql.includes("COUNT(*)") && sql.includes("source_lot_id IS NULL")) return { rows: [{ pending: 1 }] };
    if (sql.includes("FROM inventory_transfer_items ti")) {
      return { rows: [{ id: 51, source_lot_id: 71, product_id: 276, requested_quantity: "5", reserved_quantity: "5", remaining_qty: "20" }] };
    }
    if (sql.includes("FROM stock_reservations")) return { rows: [{ reserved: "0" }] };
    return { rows: [{ id: 1 }] };
  };

  await assert.rejects(
    applyTransferStockEffect(client, TRANSFER, "dispatch", {}, context, "key-2"),
    (error) => error.code === "TRANSFER_NOT_ALLOCATED",
    "a partly-allocated transfer must not dispatch",
  );
});

test("an already-allocated transfer is untouched by any of this", async () => {
  // The back-compatibility guarantee. A warehouse sending its own stock names its crates up front,
  // exactly as before, and must not be asked to allocate anything.
  const client = scriptedClient({
    unallocated: [],
    allocated: [{ id: 50, source_lot_id: 70, product_id: 276, requested_quantity: "10", remaining_qty: "12" }],
  });

  await approve(client, { items: [{ item_id: 50, approved_quantity: 10 }] });

  assert.equal(
    client.statements.filter((entry) => entry.sql.startsWith("UPDATE inventory_transfer_items SET source_lot_id")).length,
    0,
    "nothing should be re-allocated",
  );
  assert.ok(
    client.statements.some((entry) => entry.sql.includes("INSERT INTO stock_reservations")),
    "and the stock should still be reserved",
  );
});

test("crates named by the approver's snapshot ids are resolved, not parsed", async () => {
  // The approving desktop picks crates from its own snapshot, which names a lot by its global id (a
  // uuid, which may start with a digit) or `inventory-lot-<id>`. parseInt read the first as a stray
  // number and nulled the second, so a real allocation was refused as "choose a lot".
  const uuid = "71f3c2d0-0000-4000-8000-000000000071";
  const client = scriptedClient({
    unallocated: [{ id: 50, product_id: 276, requested_quantity: "10" }],
    allocated: [{ id: 50, source_lot_id: 71, product_id: 276, requested_quantity: "6", remaining_qty: "20" }],
    lots: {
      71: { id: 71, effective_cost_per_unit: "80.5", available: "20" },
      72: { id: 72, effective_cost_per_unit: "95.0", available: "20" },
    },
    globalIds: { [uuid]: 71 },
    aliasedIds: [72],
  });

  await approve(client, {
    items: [{
      item_id: 50,
      allocations: [
        { source_lot_id: uuid, quantity: 6 },
        { source_lot_id: "inventory-lot-72", quantity: 4 },
      ],
    }],
  });

  const rewrite = client.statements.find((entry) => entry.sql.startsWith("UPDATE inventory_transfer_items SET source_lot_id"));
  assert.deepEqual(rewrite.values, [50, 71, 6, "80.5"], "the uuid resolves to its own lot, not lot #71 by accident of digits");
  assert.deepEqual(client.inserted[0], [9, 276, 72, 4, "95.0"]);
  const lookups = client.statements.filter((entry) => entry.sql.startsWith("SELECT id FROM inventory_batches"));
  // uuid by global id; the alias first by global id (none), then as a row with no global id.
  assert.equal(lookups.length, 3);
  assert.ok(lookups.every((entry) => entry.values[1] === TRANSFER.company_id), "lookups are company-scoped");
});

test("a crate reference that names no lot is refused by name, not dropped", async () => {
  // Dropping it would approve less than the approver chose, and say nothing.
  const client = scriptedClient({
    unallocated: [{ id: 50, product_id: 276, requested_quantity: "10" }],
    lots: { 71: { id: 71, effective_cost_per_unit: "80", available: "20" } },
  });

  await assert.rejects(
    approve(client, {
      items: [{
        item_id: 50,
        allocations: [
          { source_lot_id: 71, quantity: 6 },
          { source_lot_id: "71abc-not-a-lot", quantity: 4 },
        ],
      }],
    }),
    (error) => error.code === "TRANSFER_ALLOCATION_INVALID",
  );
  assert.equal(
    client.statements.filter((entry) => entry.sql.startsWith("UPDATE inventory_transfer_items SET source_lot_id")).length,
    0,
    "nothing is allocated when one crate cannot be found",
  );
});

test("crates adding up to exactly the request are accepted despite float arithmetic", async () => {
  // 0.1 + 0.2 is 0.30000000000000004 in floating point, which refused an exact allocation of 0.3 as
  // "more than was asked for". Quantities carry three decimals and are compared there.
  const client = scriptedClient({
    unallocated: [{ id: 50, product_id: 276, requested_quantity: "0.3" }],
    allocated: [{ id: 50, source_lot_id: 71, product_id: 276, requested_quantity: "0.1", remaining_qty: "20" }],
    lots: {
      71: { id: 71, effective_cost_per_unit: "80", available: "20" },
      72: { id: 72, effective_cost_per_unit: "90", available: "20" },
    },
  });

  await approve(client, {
    items: [{
      item_id: 50,
      allocations: [
        { source_lot_id: 71, quantity: 0.1 },
        { source_lot_id: 72, quantity: 0.2 },
      ],
    }],
  });
  assert.equal(client.inserted.length, 1);
});
