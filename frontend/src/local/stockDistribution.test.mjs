import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  DISTRIBUTION_BOARD_STATUS,
  TRANSFER_SIDE,
  TRANSFER_TRANSITIONS,
  availableTransferActions,
  describeTransfer,
  resolveDistributionBoard,
  transferQuantity,
  transferSideFor,
  validateDistributionDraft,
} from "./stockDistribution.js";
import { createCounterScope } from "./locationScope.js";

const WAREHOUSE = createCounterScope({ companyId: "1", branchId: "1", operationalLocationId: "10" });
const RATANADA = createCounterScope({ companyId: "1", branchId: "9", operationalLocationId: "90" });
const SOMEWHERE_ELSE = createCounterScope({ companyId: "1", branchId: "7", operationalLocationId: "70" });

const consignment = (overrides = {}) => ({
  id: 5,
  global_id: "transfer-5",
  transfer_number: "TR-1001",
  status: "DISPATCHED_IN_TRANSIT",
  source_operational_location_id: 10,
  destination_operational_location_id: 90,
  source_location_name: "Warehouse",
  destination_location_name: "Ratanada",
  ...overrides,
});

test("the transition table matches the server's, exactly", () => {
  // Duplicated deliberately -- a screen that offers a button the server will refuse teaches an
  // operator that the app lies. Duplication is only safe while something notices it drifting, and
  // this is that something: it reads the backend source rather than a copy of it.
  const backend = fs.readFileSync(new URL("../../../backend/operationalV3.js", import.meta.url), "utf8");
  const block = backend.slice(
    backend.indexOf("const TRANSFER_TRANSITIONS"),
    backend.indexOf("const cleanText"),
  );
  assert.ok(block.length > 100, "could not find TRANSFER_TRANSITIONS in operationalV3.js");

  for (const [status, moves] of Object.entries(TRANSFER_TRANSITIONS)) {
    assert.ok(block.includes(`${status}:`), `server has no ${status} status; our copy has drifted`);
    for (const [action, next] of Object.entries(moves)) {
      assert.ok(
        block.includes(`${action}: "${next}"`),
        `server does not map ${status} + ${action} to ${next}`,
      );
    }
  }

  // And the other direction, so a status the server gains does not sit unhandled in our copy.
  const serverStatuses = [...block.matchAll(/^ {2}([A-Z_]+): Object\.freeze/gm)].map((m) => m[1]);
  assert.ok(serverStatuses.length > 0, "could not parse the server's statuses");
  for (const status of serverStatuses) {
    assert.ok(
      Object.hasOwn(TRANSFER_TRANSITIONS, status),
      `the server can put a consignment in ${status} and this build would not know what it is`,
    );
  }
});

test("the warehouse dispatches and the shop receives, and neither does the other's job", () => {
  // The whole safety model of a transfer. The server enforces it too
  // (TRANSFER_ACTION_SCOPE_REJECTED); this mirrors it so a button that would be refused is never
  // offered in the first place. Neither layer is load-bearing on its own.
  const inTransit = consignment({ status: "DISPATCHED_IN_TRANSIT" });

  const shopActions = availableTransferActions(inTransit, RATANADA).map((entry) => entry.action);
  assert.ok(shopActions.includes("receive"), "the shop must be able to receive its own delivery");
  assert.ok(shopActions.includes("partial_receive"));

  const warehouseActions = availableTransferActions(inTransit, WAREHOUSE).map((entry) => entry.action);
  assert.deepEqual(
    warehouseActions,
    [],
    "the warehouse must not be able to mark goods received at a shop it is not standing in",
  );

  const approved = consignment({ status: "APPROVED_RESERVED" });
  assert.deepEqual(
    availableTransferActions(approved, WAREHOUSE).map((entry) => entry.action),
    ["dispatch"],
    "dispatch is the sender's move",
  );
  assert.deepEqual(
    availableTransferActions(approved, RATANADA),
    [],
    "a shop cannot dispatch stock to itself",
  );
});

test("a counter with no shop of its own is offered nothing at all", () => {
  // Same rule the stock filter and the sync applier follow: only a known scope may judge. A device
  // that does not know where it is standing must not be the one to say goods arrived.
  const unknown = createCounterScope({});
  assert.equal(transferSideFor(consignment(), unknown), TRANSFER_SIDE.BYSTANDER);
  assert.deepEqual(availableTransferActions(consignment(), unknown), []);
});

test("a third shop can look but not touch", () => {
  assert.equal(transferSideFor(consignment(), SOMEWHERE_ELSE), TRANSFER_SIDE.BYSTANDER);
  assert.deepEqual(availableTransferActions(consignment(), SOMEWHERE_ELSE), []);
});

test("location ids are matched as opaque text, never as numbers", () => {
  // "090" is not 90. Location ids arrive as integers from Postgres and as text from the local
  // snapshot, and a Number() comparison across that boundary is the pitfall CLAUDE.md records.
  const padded = consignment({ destination_operational_location_id: "090" });
  assert.equal(
    transferSideFor(padded, RATANADA),
    TRANSFER_SIDE.BYSTANDER,
    '"090" and "90" are different locations and must not be treated as one',
  );

  const textual = consignment({ destination_operational_location_id: "90" });
  assert.equal(transferSideFor(textual, RATANADA), TRANSFER_SIDE.DESTINATION);
});

test("a status this build has never heard of is reported, not dressed up as finished", () => {
  // A newer server talking to an older counter. Showing it as "Finished" would be a lie with real
  // stock behind it, and showing it blank would be worse.
  const described = describeTransfer(consignment({ status: "AWAITING_CUSTOMS" }), RATANADA);
  assert.equal(described.known, false);
  assert.match(described.label, /Unknown status/);
  assert.equal(described.waitingOnYou, false, "an unrecognised status cannot be claimed to need you");
  assert.deepEqual(described.actions, [], "and it must offer no buttons");
});

test("the board says which consignments are this counter's problem", () => {
  const board = resolveDistributionBoard({
    scope: RATANADA,
    transfers: [
      consignment({ id: 1, status: "DISPATCHED_IN_TRANSIT" }),
      consignment({ id: 2, status: "APPROVED_RESERVED" }),
      consignment({ id: 3, status: "CLOSED" }),
    ],
  });
  assert.equal(board.status, DISTRIBUTION_BOARD_STATUS.READY);
  assert.equal(board.counts.total, 3);
  assert.equal(board.counts.waitingOnYou, 1, "only the one in transit needs the shop to act");
  assert.equal(board.waiting[0].number, "TR-1001");
});

test("an unknown shop is a named state, never an empty board", () => {
  // The failure CLAUDE.md names, in this screen's clothing: "no consignments" and "this counter
  // cannot answer" both produce an empty list, and rendering them the same tells a shopkeeper
  // there is nothing to receive when nothing could be checked.
  const board = resolveDistributionBoard({ scope: createCounterScope({}), transfers: [] });
  assert.equal(board.status, DISTRIBUTION_BOARD_STATUS.SCOPE_UNKNOWN);
  assert.notEqual(board.countLabel, "0", "an unanswerable board must not report a count of zero");
  assert.equal(board.countLabel, "Unavailable");
  assert.match(board.message, /has not been told which shop/);
  assert.match(board.message, /Nothing has been lost/, "the operator must be told it is recoverable");
});

test("a failed load is not an empty board either", () => {
  const board = resolveDistributionBoard({ scope: RATANADA, loadError: "The service did not answer." });
  assert.equal(board.status, DISTRIBUTION_BOARD_STATUS.ERROR);
  assert.notEqual(board.countLabel, "0");
  assert.equal(board.message, "The service did not answer.");
});

test("a genuinely empty board still says zero, because zero is the truth", () => {
  // The counterpart to the two tests above, and the reason they are not just "never say zero":
  // a shop with no consignments has none, and hiding that behind a warning would be its own lie.
  const board = resolveDistributionBoard({ scope: RATANADA, transfers: [] });
  assert.equal(board.status, DISTRIBUTION_BOARD_STATUS.READY);
  assert.equal(board.countLabel, "0");
  assert.equal(board.message, "");
});

test("a draft is checked before it is sent, and every problem is named", () => {
  const bad = validateDistributionDraft({
    sourceLocationId: "10",
    destinationLocationId: "10",
    lines: [{ product_id: "p1", source_lot_id: "l1", requested_quantity: 5 }],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((problem) => /already in/.test(problem)));

  const empty = validateDistributionDraft({ sourceLocationId: "10", destinationLocationId: "90", lines: [] });
  assert.equal(empty.ok, false);
  assert.ok(empty.problems.some((problem) => /at least one product/.test(problem)));

  const good = validateDistributionDraft({
    sourceLocationId: "10",
    destinationLocationId: "90",
    lines: [{ product_id: "p1", source_lot_id: "l1", requested_quantity: 5 }],
  });
  assert.equal(good.ok, true, good.problems.join("; "));
  assert.equal(good.lines.length, 1);
});

test("sending more than the warehouse holds is refused, and zero available is still a number", () => {
  // `available_quantity` of 0 is a real answer -- a lot already fully committed elsewhere. A falsy
  // check would skip the comparison entirely and let the whole lot be sent twice.
  const over = validateDistributionDraft({
    sourceLocationId: "10",
    destinationLocationId: "90",
    lines: [{
      product_id: "p1",
      product_name: "Alphonso",
      source_lot_id: "l1",
      requested_quantity: 30,
      available_quantity: 0,
    }],
  });
  assert.equal(over.ok, false);
  assert.ok(
    over.problems.some((problem) => /Alphonso: only 0 available/.test(problem)),
    `expected the zero-available line to be refused, got: ${over.problems.join("; ")}`,
  );
});

test("a quantity of zero is kept and a missing quantity is not invented", () => {
  assert.equal(transferQuantity(0), 0, "zero received is a fact, not an absence");
  assert.equal(transferQuantity(null), null);
  assert.equal(transferQuantity(undefined), null);
  assert.equal(transferQuantity(""), null, "an empty box is nobody having answered yet");
  assert.equal(transferQuantity("4.5"), 4.5);
});

/**
 * The wiring, pinned.
 *
 * Source-text assertions, and the weaker kind of test on purpose: these call sites live inside a
 * 20k-line component that cannot be imported in isolation. They cannot prove the values are right;
 * they prove the field was not quietly dropped, which is the regression that actually happens --
 * the scope module shipped complete, tested and wired to nothing for a whole day.
 */
const appSource = () => fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("a purchase sends its destination under names the write adapter cannot overwrite", () => {
  const source = appSource();

  // `v3WriteAdapter` on the server unconditionally replaces `branch_id` and
  // `operational_location_id` in the body with the submitting device's own scope. A destination sent
  // under those names is gone before the handler runs, and the symptom is a field that appears to be
  // ignored with no error anywhere.
  assert.match(source, /destination_branch_id: purchaseDestination\.branch_id/);
  assert.match(source, /destination_operational_location_id: purchaseDestination\.operational_location_id/);
});

test("an untouched picker sends no destination at all", () => {
  // Not "send this counter's own ids", which would look equivalent and is not: the server treats a
  // named destination as a deliberate instruction and validates it, while absence means "here" and
  // costs no round trip. Every purchase entered before this field existed must keep behaving
  // exactly as it did.
  const source = appSource();
  assert.match(
    source,
    /\.\.\.\(purchaseDestination\s*\n?\s*\?\s*\{/,
    "the destination fields must be spread in conditionally, not always present",
  );
  assert.match(source, /:\s*\{\}\),/, "and the else branch must contribute nothing");
});

test("the picker is offered only when there is somewhere else to choose", () => {
  // A business with one location gets no field to get wrong.
  const source = appSource();
  assert.match(
    source,
    /\{distributionState\.destinations\.length > 0 && \(\s*\n?\s*<Field label="Goods received at">/,
    "the Goods received at field must be conditional on there being other locations",
  );
});

test("Purchase Entry loads the destinations it needs, without blocking on them", () => {
  const source = appSource();
  assert.match(
    source,
    /if \(view === "purchase"\) loadDistributionDestinations\(\);/,
    "opening Purchase Entry must fetch the location list",
  );
  // Deliberately not awaited: a purchase must still be enterable when this list cannot be fetched,
  // and without it the picker simply offers "this counter" -- the pre-picker behaviour.
  assert.doesNotMatch(
    source,
    /await loadDistributionDestinations\(\)/,
    "a failed location list must never stop somebody entering a purchase",
  );
});

// ---------------------------------------------------------------------------
// Asking another branch for stock
// ---------------------------------------------------------------------------

test("a request names products and quantities, and no lots at all", async () => {
  const { validateStockRequest } = await import("./stockDistribution.js");
  const good = validateStockRequest({
    sourceLocationId: "10",
    requesterLocationId: "90",
    lines: [{ product_id: "p1", requested_quantity: 10 }],
  });
  assert.equal(good.ok, true, good.problems.join("; "));
  assert.equal(good.lines.length, 1);
  assert.equal(
    Object.hasOwn(good.lines[0], "source_lot_id"),
    false,
    "a request must not carry a lot: the asking branch cannot see the other branch's crates",
  );
});

test("a shop cannot ask itself, and cannot ask without knowing who it is", async () => {
  const { validateStockRequest } = await import("./stockDistribution.js");
  const itself = validateStockRequest({
    sourceLocationId: "90",
    requesterLocationId: "90",
    lines: [{ product_id: "p1", requested_quantity: 5 }],
  });
  assert.equal(itself.ok, false);
  assert.ok(itself.problems.some((problem) => /cannot ask itself/.test(problem)));

  const nowhere = validateStockRequest({
    sourceLocationId: "10",
    requesterLocationId: "",
    lines: [{ product_id: "p1", requested_quantity: 5 }],
  });
  assert.equal(nowhere.ok, false);
  assert.ok(nowhere.problems.some((problem) => /does not know which shop/.test(problem)));
});

test("only the branch holding the fruit is asked to choose crates", async () => {
  const { pendingAllocationLines } = await import("./stockDistribution.js");
  const request = consignment({
    status: "APPROVAL_PENDING",
    items: [
      { id: 1, product_id: "p1", product_name: "Alphonso", source_lot_id: null, requested_quantity: "10" },
      { id: 2, product_id: "p2", product_name: "Banana", source_lot_id: 71, requested_quantity: "4" },
    ],
  });

  const forSource = pendingAllocationLines(request, WAREHOUSE);
  assert.equal(forSource.length, 1, "only the line with no crate needs choosing");
  assert.equal(forSource[0].productName, "Alphonso");
  assert.equal(forSource[0].requested, 10);

  assert.deepEqual(
    pendingAllocationLines(request, RATANADA),
    [],
    "the branch that asked cannot choose crates it cannot see",
  );
  assert.deepEqual(pendingAllocationLines(request, SOMEWHERE_ELSE), []);
});

test("crate choices are checked against the amount asked for and what each crate holds", async () => {
  const { validateAllocation } = await import("./stockDistribution.js");

  const over = validateAllocation({
    requested: 10,
    allocations: [{ source_lot_id: "71", quantity: 7 }, { source_lot_id: "72", quantity: 5 }],
  });
  assert.equal(over.ok, false);
  assert.ok(over.problems.some((problem) => /more than the 10 asked for/.test(problem)));

  // Zero available is a real answer, not an absent one -- a crate already promised elsewhere.
  const empty = validateAllocation({
    requested: 10,
    allocations: [{ source_lot_id: "71", lot_label: "Crate A", quantity: 4, available_quantity: 0 }],
  });
  assert.equal(empty.ok, false);
  assert.ok(
    empty.problems.some((problem) => /Crate A: only 0 available/.test(problem)),
    `expected the empty crate to be refused, got: ${empty.problems.join("; ")}`,
  );

  const split = validateAllocation({
    requested: 10,
    allocations: [
      { source_lot_id: "71", quantity: 6, available_quantity: 20 },
      { source_lot_id: "72", quantity: 4, available_quantity: 20 },
    ],
  });
  assert.equal(split.ok, true, split.problems.join("; "));
  assert.equal(split.total, 10);
  assert.equal(split.allocations.length, 2, "one request may be answered from several crates");
});

test("a request is not held back by stock this counter cannot see", async () => {
  // There is deliberately no availability check on a request. This counter cannot see the other
  // branch's stock, so any limit it showed would be a guess -- and a guess presented as a limit is
  // worse than no limit, because a person would believe it.
  const { validateStockRequest } = await import("./stockDistribution.js");
  const request = validateStockRequest({
    sourceLocationId: "10",
    requesterLocationId: "90",
    lines: [{ product_id: "p1", requested_quantity: 99999 }],
  });
  assert.equal(request.ok, true, "asking for more than exists is the other branch's call, not ours");
});

test("a request is sent as a request, and carries no lots", () => {
  const source = appSource();

  assert.match(
    source,
    /initiation_mode: "DESTINATION_REQUESTED"/,
    "asking must use the mode where the other branch approves",
  );
  // The request body names product and quantity only. A `source_lot_id` here would be a crate this
  // counter cannot see, and the server would refuse it -- but the more useful point is that the
  // form must not ask a person for something they cannot know.
  const request = source.slice(
    source.indexOf("const requestConsignment"),
    source.indexOf("const requestConsignment") + 1400,
  );
  assert.match(request, /requested_quantity: line\.requested_quantity/);
  assert.doesNotMatch(request, /source_lot_id/, "a request must not carry a lot");
});

test("the ask form offers products, and the send form offers lots", () => {
  // Offering an empty lot dropdown to somebody asking another shop for stock would look like a
  // fault rather than a rule. The two forms differ by exactly that column.
  const source = appSource();
  assert.match(
    source,
    /\{asking \? \(\s*\n(?:.*\n)*?.*Choose a product/,
    "the ask form must pick a product",
  );
  assert.match(source, /const asking = direction === "ASK";/);
});

test("approving a request draws the crate form instead of a bare Approve button", () => {
  // Two buttons that do different things under one word is the confusion this avoids.
  const source = appSource();
  assert.match(
    source,
    /\(option\.action === "approve" && toAllocate\.length > 0\) \? null : \(/,
    "the plain Approve button must be withheld while crates are still unchosen",
  );
  assert.match(source, /onClick=\{\(\) => approveWithCrates\(entry, toAllocate\)\}/);
});
