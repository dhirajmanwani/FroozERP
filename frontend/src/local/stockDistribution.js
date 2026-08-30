/**
 * Fruit moving from the warehouse to a shop.
 *
 * `docs/stock-distribution-decision.md` describes the real journey: a purchase manager buys in bulk,
 * it lands at a warehouse, a warehouse manager sends quantities out to the shops, and each shop then
 * sells only what is on its own shelf.
 *
 * The cloud already owns the machinery for the middle step -- `inventory_transfers` and the
 * `/api/v3/transfers` routes. What did not exist was anything a person could use, and anything that
 * turned its vocabulary into words a shopkeeper would say out loud. That is this module.
 *
 * ## Two sides, and only one of them may act at a time
 *
 * A consignment has a **source** (the warehouse sending it) and a **destination** (the shop getting
 * it). The server enforces that source-side actions come from the source's counter and
 * destination-side actions from the destination's -- `operationalV3.js`, `TRANSFER_ACTION_SCOPE_REJECTED`.
 *
 * That rule is the whole safety model of a transfer, so this module mirrors it rather than trusting
 * the screen to be careful: a button that should not exist is never offered, and if one were somehow
 * pressed the server refuses it anyway. Neither layer is load-bearing alone.
 *
 * ## Why the transition table is duplicated here
 *
 * It is copied from `TRANSFER_TRANSITIONS` in `backend/operationalV3.js`, and duplication is the
 * lesser evil: the alternative is a screen that offers a "Dispatch" button the server will refuse,
 * which teaches an operator that the app lies. A test pins the two tables against each other by
 * reading the backend source, so the copy cannot drift silently.
 */

import { canonicalInventoryId, inventoryIdsEqual } from "./stockInventory.js";

/** Mirrors `TRANSFER_TRANSITIONS` in backend/operationalV3.js. Pinned by test. */
export const TRANSFER_TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze({ submit: "APPROVAL_PENDING", cancel: "CANCELLED" }),
  APPROVAL_PENDING: Object.freeze({ approve: "APPROVED_RESERVED", reject: "REJECTED" }),
  APPROVED_RESERVED: Object.freeze({ dispatch: "DISPATCHED_IN_TRANSIT" }),
  DISPATCHED_IN_TRANSIT: Object.freeze({
    receive: "RECEIVED",
    partial_receive: "PARTIALLY_RECEIVED",
    discrepancy: "DISCREPANCY_RESOLUTION",
  }),
  PARTIALLY_RECEIVED: Object.freeze({
    receive: "RECEIVED",
    discrepancy: "DISCREPANCY_RESOLUTION",
  }),
  DISCREPANCY_RESOLUTION: Object.freeze({
    return: "RETURN_IN_TRANSIT",
    resolve: "CLOSED",
  }),
  RETURN_IN_TRANSIT: Object.freeze({ source_receive: "CLOSED" }),
  RECEIVED: Object.freeze({ close: "CLOSED" }),
});

/**
 * Which side of a consignment may perform each action.
 *
 * Mirrors the `sourceActions` list in `operationalV3.js`. Anything not named here is the
 * destination's -- the same default the server applies, written the same way round so the two
 * cannot disagree about an action added later.
 */
const SOURCE_ACTIONS = Object.freeze(new Set([
  "submit", "approve", "reject", "dispatch", "return", "source_receive", "close", "cancel",
]));

export const TRANSFER_SIDE = Object.freeze({
  SOURCE: "SOURCE",
  DESTINATION: "DESTINATION",
  BYSTANDER: "BYSTANDER",
});

/**
 * Plain words for each status, and for what happens next.
 *
 * The server's vocabulary is `APPROVED_RESERVED` and `DISPATCHED_IN_TRANSIT`. Nobody at a counter
 * says that. Each entry carries a `label` for a chip, and a `waitingOn` naming *who has the ball* --
 * which is the question an operator actually has when they look at a list of consignments.
 */
const STATUS_WORDS = Object.freeze({
  DRAFT: { label: "Not sent yet", waitingOn: TRANSFER_SIDE.SOURCE, tone: "neutral" },
  APPROVAL_PENDING: { label: "Waiting for approval", waitingOn: TRANSFER_SIDE.SOURCE, tone: "waiting" },
  APPROVED_RESERVED: { label: "Approved, stock held", waitingOn: TRANSFER_SIDE.SOURCE, tone: "waiting" },
  DISPATCHED_IN_TRANSIT: { label: "On the way", waitingOn: TRANSFER_SIDE.DESTINATION, tone: "moving" },
  PARTIALLY_RECEIVED: { label: "Part received", waitingOn: TRANSFER_SIDE.DESTINATION, tone: "attention" },
  RECEIVED: { label: "Received", waitingOn: TRANSFER_SIDE.SOURCE, tone: "done" },
  DISCREPANCY_RESOLUTION: { label: "Amount does not match", waitingOn: TRANSFER_SIDE.SOURCE, tone: "attention" },
  RETURN_IN_TRANSIT: { label: "Going back", waitingOn: TRANSFER_SIDE.SOURCE, tone: "moving" },
  CLOSED: { label: "Finished", waitingOn: null, tone: "done" },
  CANCELLED: { label: "Cancelled", waitingOn: null, tone: "done" },
  REJECTED: { label: "Refused", waitingOn: null, tone: "done" },
});

/** What each button says, and what it means. Imperative, and it names what will happen. */
const ACTION_WORDS = Object.freeze({
  submit: { label: "Send for approval", detail: "Ask for this consignment to be approved." },
  approve: { label: "Approve", detail: "Hold this stock for the shop. It stops being sellable here." },
  reject: { label: "Refuse", detail: "Turn this request down. Nothing is held." },
  dispatch: { label: "Dispatch", detail: "The goods have left. Stock comes off this shop's count now." },
  receive: { label: "Receive in full", detail: "Everything arrived. It joins this shop's stock." },
  partial_receive: { label: "Receive part", detail: "Some arrived. Record how much." },
  discrepancy: { label: "Amount does not match", detail: "Flag a difference for the sender to sort out." },
  return: { label: "Send back", detail: "Return the goods to where they came from." },
  source_receive: { label: "Take back in", detail: "The returned goods are back on this shelf." },
  resolve: { label: "Settle it", detail: "Agree the difference and close this consignment." },
  close: { label: "Close", detail: "Nothing further to do." },
  cancel: { label: "Cancel", detail: "Drop this consignment before it goes anywhere." },
});

const text = (value) => String(value ?? "").trim();
const rows = (value) => (Array.isArray(value) ? value : []);

/** A quantity, or `null` when the field is genuinely absent rather than zero. */
export const transferQuantity = (value) => {
  // `??` is wrong for these: a fully-rejected line legitimately carries 0, and a chain of `??`
  // would keep 0 while an explicit `Number.isFinite` check is what distinguishes "zero arrived"
  // from "nobody has said yet". CLAUDE.md names this one.
  //
  // The empty string is checked separately because `Number("")` is `0`, not `NaN`. Without this an
  // untouched quantity box would read as "zero arrived" -- which is a claim about the delivery, not
  // an admission that nobody has said yet, and it would close a consignment as fully short.
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Which side of this consignment is the counter standing on?
 *
 * Compared through `canonicalInventoryId`, never `Number()`. Location ids arrive as integers from
 * Postgres and as text from the local snapshot, and `"04"` is not `4`.
 */
export const transferSideFor = (transfer, scope) => {
  const here = canonicalInventoryId(scope?.operationalLocationId);
  if (here === "") return TRANSFER_SIDE.BYSTANDER;
  if (inventoryIdsEqual(transfer?.source_operational_location_id, here)) return TRANSFER_SIDE.SOURCE;
  if (inventoryIdsEqual(transfer?.destination_operational_location_id, here)) return TRANSFER_SIDE.DESTINATION;
  return TRANSFER_SIDE.BYSTANDER;
};

/**
 * The actions this counter may take on this consignment, right now.
 *
 * Two filters, and they are different questions. The transition table asks *is this move legal from
 * this status* -- a Dispatch on something already dispatched is not. `SOURCE_ACTIONS` asks *is this
 * my move to make* -- the shop does not approve its own consignment, and the warehouse does not
 * receive it.
 *
 * A counter with no location of its own is a bystander and gets nothing. That is deliberate: it is
 * the same "only a known scope can judge" rule the stock filter and the sync applier both follow,
 * and a device that does not know where it is standing must not be the one to say goods arrived.
 */
export const availableTransferActions = (transfer, scope) => {
  const side = transferSideFor(transfer, scope);
  if (side === TRANSFER_SIDE.BYSTANDER) return [];
  const legal = TRANSFER_TRANSITIONS[text(transfer?.status).toUpperCase()] || {};
  return Object.keys(legal)
    .filter((action) => (SOURCE_ACTIONS.has(action) ? side === TRANSFER_SIDE.SOURCE : side === TRANSFER_SIDE.DESTINATION))
    .map((action) => ({
      action,
      nextStatus: legal[action],
      label: ACTION_WORDS[action]?.label || action,
      detail: ACTION_WORDS[action]?.detail || "",
    }));
};

/**
 * One consignment, described for a person standing at a particular counter.
 *
 * `waitingOnYou` is the field the list sorts and filters on, because "what needs me" is the only
 * question worth asking of a board like this. An unknown status is reported as unknown rather than
 * guessed at -- a consignment whose state this build does not recognise is a newer server talking
 * to an older counter, and showing it as "Finished" would be a lie with stock behind it.
 */
export const describeTransfer = (transfer, scope) => {
  const status = text(transfer?.status).toUpperCase();
  const words = STATUS_WORDS[status] || null;
  const side = transferSideFor(transfer, scope);
  const actions = availableTransferActions(transfer, scope);
  return {
    id: canonicalInventoryId(transfer?.global_id ?? transfer?.id),
    number: text(transfer?.transfer_number) || "(no number)",
    status,
    known: Boolean(words),
    // Not "Finished", and not blank. A status this build has never heard of is a fact worth showing.
    label: words ? words.label : `Unknown status (${status || "none"})`,
    tone: words ? words.tone : "attention",
    side,
    from: text(transfer?.source_location_name) || text(transfer?.source_branch_id) || "Unknown",
    to: text(transfer?.destination_location_name) || text(transfer?.destination_branch_id) || "Unknown",
    waitingOnYou: Boolean(words) && words.waitingOn === side && actions.length > 0,
    actions,
  };
};

export const DISTRIBUTION_BOARD_STATUS = Object.freeze({
  READY: "READY",
  LOADING: "LOADING",
  ERROR: "ERROR",
  SCOPE_UNKNOWN: "SCOPE_UNKNOWN",
});

/**
 * The whole board: what is here, what needs this counter, and what to say when there is nothing.
 *
 * The empty cases are separated on purpose, and this is the same rule the stock filter follows.
 * "No consignments" and "this counter does not know which shop it is in" both produce an empty list,
 * and a screen that renders them identically tells a shopkeeper there is nothing to receive when in
 * fact nothing could be checked. CLAUDE.md: errors must never render as zero.
 */
export const resolveDistributionBoard = ({
  transfers = [],
  scope = null,
  loadState = "loaded",
  loadError = "",
} = {}) => {
  const base = { transfers: [], waiting: [], counts: { total: 0, waitingOnYou: 0, unknown: 0 } };

  if (loadState === "loading" || loadState === "idle") {
    return { ...base, status: DISTRIBUTION_BOARD_STATUS.LOADING, countLabel: "...", message: "" };
  }
  if (loadError) {
    return {
      ...base,
      status: DISTRIBUTION_BOARD_STATUS.ERROR,
      // Never "0". A failed load has no count, and printing one invents an answer.
      countLabel: "Unavailable",
      message: loadError,
    };
  }
  if (canonicalInventoryId(scope?.operationalLocationId) === "") {
    return {
      ...base,
      status: DISTRIBUTION_BOARD_STATUS.SCOPE_UNKNOWN,
      countLabel: "Unavailable",
      message: "This counter has not been told which shop it is in, so it cannot show consignments "
        + "or accept a delivery. Nothing has been lost. Ask the owner to assign this counter in "
        + "Settings, then reopen this screen.",
    };
  }

  const described = rows(transfers).map((transfer) => describeTransfer(transfer, scope));
  const waiting = described.filter((entry) => entry.waitingOnYou);
  return {
    status: DISTRIBUTION_BOARD_STATUS.READY,
    transfers: described,
    waiting,
    counts: {
      total: described.length,
      waitingOnYou: waiting.length,
      unknown: described.filter((entry) => !entry.known).length,
    },
    countLabel: String(described.length),
    message: "",
  };
};

/**
 * Is this a consignment the server will accept?
 *
 * Checked here so a warehouse manager is told what is wrong while they can still fix it, rather than
 * after a round trip. The server checks all of this again -- this is a courtesy, never the guard.
 */
export const validateDistributionDraft = ({ destinationLocationId, lines = [], sourceLocationId } = {}) => {
  const problems = [];
  const source = canonicalInventoryId(sourceLocationId);
  const destination = canonicalInventoryId(destinationLocationId);

  if (source === "") problems.push("This counter does not know which shop it is sending from.");
  if (destination === "") problems.push("Choose the shop this stock is going to.");
  if (source !== "" && destination !== "" && source === destination) {
    problems.push("Stock cannot be sent to the shop it is already in.");
  }

  const usable = rows(lines).filter((line) => {
    const quantity = transferQuantity(line?.requested_quantity ?? line?.quantity);
    return canonicalInventoryId(line?.product_id) !== ""
      && canonicalInventoryId(line?.source_lot_id) !== ""
      && quantity !== null
      && quantity > 0;
  });

  if (rows(lines).length === 0) {
    problems.push("Add at least one product to send.");
  } else if (usable.length !== rows(lines).length) {
    problems.push("Every line needs a product, a lot to take it from, and a quantity above zero.");
  }

  for (const line of usable) {
    const quantity = transferQuantity(line?.requested_quantity ?? line?.quantity);
    const available = transferQuantity(line?.available_quantity);
    // `available` may legitimately be 0 -- a lot already fully committed elsewhere -- so it is
    // compared only when it is a real number, never through a falsy check that would skip zero.
    if (available !== null && quantity > available) {
      problems.push(
        `${text(line?.product_name) || "A product"}: only ${available} available, ${quantity} asked for.`,
      );
    }
  }

  return { ok: problems.length === 0, problems, lines: usable };
};
