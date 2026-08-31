/**
 * Whose shelf is this fruit on?
 *
 * Ratanada holds 15 kg of apples; Main Branch holds 20. A cashier standing in Ratanada must be able
 * to bill, and to see, only Ratanada's 15. `docs/stock-distribution-decision.md` states the rule
 * this module exists to enforce:
 *
 * > **A counter may sell only what is physically on its own shelf.**
 *
 * Selling another shop's crate is not a cosmetic error. Main Branch's shelf ends up holding less
 * than its screen says, Ratanada's screen holds less than its shelf, and the printed bill carries
 * the wrong shop's name and GST number. Every part of that is silent on the day it happens and only
 * surfaces days later as an unexplained shortage that nobody can trace.
 *
 * ## Why one module rather than a `branchId` argument threaded through two files
 *
 * The decision "does this row belong to this counter?" is one decision, and it has more states than
 * a boolean can carry: the counter may not know which shop it is in, and a row may not say which
 * shop it came from. Those two are different facts, they need different words on screen, and if
 * each caller re-derives them from a bare id the wordings drift and the states quietly collapse
 * into "0 in stock". So the decision lives here, once, tested, and `posInventory.js` and
 * `stockInventory.js` ask it rather than re-implement it.
 *
 * ## The three rules the comparison follows
 *
 * These deliberately mirror `DevicePullScope::refusal_for_inventory_lot` in
 * `src-tauri/src/local_db.rs`. The sync applier already decides which lots may land on this device;
 * if the screen used a different rule than the applier, one of the two would be wrong about the
 * same crate, and neither would say so.
 *
 * 1. **Only a stated scope can disagree.** A lot that carries no `branch_id` and no
 *    `operational_location_id` is admitted. Absence is not evidence of foreignness — it is a row
 *    written before migration 013, or pulled from a server that does not send scope. Refusing those
 *    would empty a working shop on the day it upgrades, which is the "lost sale that looks like an
 *    empty shop" failure. They are admitted *and counted*, so the screen can say they are untagged.
 * 2. **Only a known scope can judge.** A device that was never bootstrapped has no shelf to compare
 *    against. It does not get to call anything foreign — see the unknown-scope note below for what
 *    it does instead.
 * 3. **Scope ids are opaque text, never numbers.** SQLite stores `branch_id` as TEXT, Postgres as
 *    INTEGER, and the Rust applier stamps the literal `"unassigned"` when the server said nothing.
 *    So a branch comparison necessarily crosses that boundary and the only safe crossing is text.
 *    `"004"` and `4` are different entities; coercing them together is what silently emptied the
 *    Inventory table once already (CLAUDE.md, "Canonical IDs").
 *
 * ## What a counter shows when it does not know which shop it is in
 *
 * Three options, and two of them are wrong:
 *
 * - **Show everything.** The cashier bills Main Branch's crate from Ratanada. Wrong shop on the
 *   bill, two shelves wrong, silent for days. This is the failure the whole feature exists to stop,
 *   so an unknown scope must never fall back to "no filter".
 * - **Show nothing.** The grid is empty and the tile says `0`. The cashier tells a customer the
 *   apples are finished while a crate of them sits between them. This is CLAUDE.md's "errors must
 *   never render as zero", and it is arguably worse than the first because it looks like an answer.
 * - **Show neither, and say why.** No stock figure and no sellable list — a named state that says
 *   the device has not been told which shop it is in and what to do about it.
 *
 * This module takes the third. Concretely: the data path **fails closed** (an unknown scope admits
 * no rows, so no foreign crate can ever be billed), and every presentation derived from it is
 * required to render that emptiness as `SCOPE_UNKNOWN` with an "Unavailable" count — never as `0`.
 * `resolveInventoryPresentation` in `stockInventory.js` carries that arm. Failing closed is the
 * deliberate half of the choice: if a caller forgets to read the status, the visible consequence is
 * a screen that shows nothing, which someone reports within the hour, rather than a wrong-shop sale
 * that nobody notices until stocktake.
 *
 * A counter's scope is **the machine's**, never the login's. `docs/stock-distribution-decision.md`
 * settles this: selling binds to the shop the machine is in, because the customer and the fruit are
 * standing there and no login can change that. So `resolveCounterScope` reads the device's
 * entitlement/assignment/identity and refuses to fall back to `user.branch_id`, and it refuses
 * `branch_context` too — that field defaults to a hardcoded `"1"` when the key is missing, and a
 * guessed shop is precisely the wrong-shop sale wearing a confident face.
 */

/** How a lot's scope compares to the counter's. */
export const LOT_SCOPE_MATCH = Object.freeze({
  /** The lot states a shelf-level scope and it is this counter's. */
  MATCH: "MATCH",
  /** The lot states a scope and it is somebody else's. Excluded, and counted. */
  FOREIGN: "FOREIGN",
  /** The lot states no shelf-level scope at all. Admitted under rule 1, and counted. */
  UNSCOPED_ROW: "UNSCOPED_ROW",
  /** This counter does not know its own scope, so the question cannot be answered. */
  UNDECIDABLE: "UNDECIDABLE",
});

/** The headline fact about a filtered collection. Counts stay available for the rest. */
export const LOCATION_SCOPE_STATUS = Object.freeze({
  /** No scope was supplied, so nothing was filtered. This is the pre-scope behaviour, named. */
  UNFILTERED: "UNFILTERED",
  /** The counter knows its shop and the rows were filtered normally. */
  SCOPED: "SCOPED",
  /** The counter does not know its shop. Nothing may be shown or sold. Never render as zero. */
  SCOPE_UNKNOWN: "SCOPE_UNKNOWN",
  /** Rows were admitted only because they state no shop. Usable, but somebody should tag them. */
  ROWS_UNSCOPED: "ROWS_UNSCOPED",
  /** Another shop's rows reached this device and were excluded. Something upstream is wrong. */
  FOREIGN_ROWS_EXCLUDED: "FOREIGN_ROWS_EXCLUDED",
});

/**
 * One scope id, canonicalised the way the Rust applier canonicalises it.
 *
 * The JS twin of `canonical_scope_id` in `src-tauri/src/local_db.rs`, and it must stay a twin: if
 * the applier admits a row onto this device and the screen then calls the same row foreign, the
 * crate is invisible in both places at once.
 *
 * - Text is trimmed and otherwise left alone. `"004"` stays `"004"` — a different entity from `4`.
 * - An integer-valued number renders as an integer, because a JSON `4.0` and a JSON `4` are the
 *   same branch said two ways and `"4"` vs `"4.0"` would refuse a legitimate row.
 * - `"unassigned"` is the applier's placeholder for "the server said nothing", so it means *no
 *   scope stated*, not the name of a shop.
 * - Everything else — null, undefined, empty, objects — is no scope stated.
 *
 * Never `Number()` on either side of a comparison. `canonicalInventoryId` in `stockInventory.js` is
 * the same trim-to-text rule for product ids; `locationScope.test.mjs` pins the two together so a
 * later edit cannot let them drift apart.
 */
export const canonicalScopeId = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    // JS already renders an integer-valued float without its fraction — `String(4.0) === "4"` —
    // which is the same normalisation the Rust twin does explicitly. No branch is needed here, and
    // a branch whose arms are identical reads as if one of them were meant to differ.
    return String(value);
  }
  if (typeof value === "boolean") return "";
  if (typeof value === "object") return "";
  const text = String(value).trim();
  if (!text) return "";
  if (text.toLowerCase() === "unassigned") return "";
  return text;
};

const scopeIdsEqual = (left, right) => {
  const a = canonicalScopeId(left);
  const b = canonicalScopeId(right);
  return a !== "" && a === b;
};

/** A counter scope, in the one shape everything downstream expects. */
const buildScope = ({ companyId, branchId, locationName, operationalLocationId, source, warnings }) => {
  const company = canonicalScopeId(companyId);
  const branch = canonicalScopeId(branchId);
  const location = canonicalScopeId(operationalLocationId);
  // A shelf is a branch at minimum. Company alone cannot separate Ratanada from Main Branch, so a
  // company-only scope is not a shelf and is not "known" — same conclusion the Rust resolver
  // reaches when it drops back to `source = "unscoped"` with no branch.
  const known = branch !== "";
  return Object.freeze({
    companyId: company,
    branchId: branch,
    operationalLocationId: location,
    // The name a person reads. Never derived from the id: "Counter 40" looks like a name and is
    // not one, and somebody shown it would believe the device was set up when it was not.
    locationName: typeof locationName === "string" ? locationName.trim() : "",
    known,
    source: known ? String(source || "explicit") : "unscoped",
    warnings: Object.freeze([...(Array.isArray(warnings) ? warnings : [])]),
  });
};

/** An explicit scope, for callers that already hold the three ids. */
export const createCounterScope = ({
  companyId = "",
  branchId = "",
  locationName = "",
  operationalLocationId = "",
  source = "explicit",
  warnings = [],
} = {}) => buildScope({ companyId, branchId, locationName, operationalLocationId, source, warnings });

/** The scope of a counter that has not been told which shop it is in. */
export const UNKNOWN_COUNTER_SCOPE = buildScope({ source: "unscoped" });

/**
 * What shop is this machine standing in?
 *
 * Reads the reference snapshot's `canonical_scope` first — that field is computed by
 * `canonical_snapshot_scope_at` from the device's entitlement, then its assignment, then its
 * approved identity, and it is deliberately the same answer the sync pull enforces. Falling back to
 * `device_identity.branch_id` covers a snapshot written before `canonical_scope` existed.
 *
 * It stops there. `user.branch_id` is not consulted, because selling binds to the machine and not
 * to the login; `branch_context` is not consulted, because it defaults to a hardcoded branch `"1"`
 * when nothing has been cached, and a counter that guesses its own shop is exactly the failure this
 * file exists to prevent. When neither device source answers, the honest result is "unknown", and
 * unknown has its own arm on screen.
 */
export const resolveCounterScope = (input = {}) => {
  const snapshot = input && typeof input === "object" ? input : {};
  const canonical = snapshot.canonical_scope && typeof snapshot.canonical_scope === "object"
    ? snapshot.canonical_scope
    : (snapshot.canonicalScope && typeof snapshot.canonicalScope === "object" ? snapshot.canonicalScope : null);
  const identity = snapshot.device_identity && typeof snapshot.device_identity === "object"
    ? snapshot.device_identity
    : (snapshot.deviceIdentity && typeof snapshot.deviceIdentity === "object" ? snapshot.deviceIdentity : null);

  const warnings = Array.isArray(canonical?.warnings) ? canonical.warnings : [];

  if (canonical && canonicalScopeId(canonical.branch_id ?? canonical.branchId) !== "") {
    return buildScope({
      companyId: canonical.company_id ?? canonical.companyId,
      branchId: canonical.branch_id ?? canonical.branchId,
      operationalLocationId: canonical.operational_location_id ?? canonical.operationalLocationId,
      locationName: canonical.location_name ?? canonical.locationName,
      source: canonical.source || "canonical_scope",
      warnings,
    });
  }
  if (identity && canonicalScopeId(identity.branch_id ?? identity.branchId) !== "") {
    return buildScope({
      companyId: identity.company_id ?? identity.companyId,
      branchId: identity.branch_id ?? identity.branchId,
      operationalLocationId: identity.operational_location_id ?? identity.operationalLocationId,
      source: "device_identity",
      warnings,
    });
  }
  return buildScope({ source: "unscoped", warnings });
};

/** The scope a lot states about itself. Empty strings mean "this row does not say". */
export const lotScopeOf = (lot) => {
  const row = lot && typeof lot === "object" ? lot : {};
  return {
    companyId: canonicalScopeId(row.company_id ?? row.companyId),
    branchId: canonicalScopeId(row.branch_id ?? row.branchId),
    operationalLocationId: canonicalScopeId(row.operational_location_id ?? row.operationalLocationId),
  };
};

/**
 * How this lot stands to this counter.
 *
 * Comparison happens only where **both** sides state a value — the `if let (Some(device),
 * Some(incoming))` shape of the Rust guard. A lot that names only a company it shares with this
 * counter has said nothing about which shelf it is on, so it counts as unscoped rather than as a
 * match; a lot that names a *different* company is foreign, because that much is decidable.
 */
export const classifyLotScope = (lot, scope) => {
  const counter = scope && typeof scope === "object" ? scope : UNKNOWN_COUNTER_SCOPE;
  if (!counter.known) return LOT_SCOPE_MATCH.UNDECIDABLE;
  const row = lotScopeOf(lot);

  const disagrees = (
    (row.companyId !== "" && counter.companyId !== "" && row.companyId !== counter.companyId)
    || (row.branchId !== "" && counter.branchId !== "" && row.branchId !== counter.branchId)
    || (row.operationalLocationId !== "" && counter.operationalLocationId !== ""
      && row.operationalLocationId !== counter.operationalLocationId)
  );
  if (disagrees) return LOT_SCOPE_MATCH.FOREIGN;

  const shelfConfirmed = (
    scopeIdsEqual(row.branchId, counter.branchId)
    || scopeIdsEqual(row.operationalLocationId, counter.operationalLocationId)
  );
  return shelfConfirmed ? LOT_SCOPE_MATCH.MATCH : LOT_SCOPE_MATCH.UNSCOPED_ROW;
};

/** May this counter act on this lot? True for its own rows and for rows that state no shelf. */
export const lotBelongsToScope = (lot, scope) => {
  const verdict = classifyLotScope(lot, scope);
  return verdict === LOT_SCOPE_MATCH.MATCH || verdict === LOT_SCOPE_MATCH.UNSCOPED_ROW;
};

const asRows = (value) => (Array.isArray(value) ? value : []);

const scopeLabel = (scope) => {
  if (!scope?.known) return "this counter";
  const parts = [`branch ${scope.branchId}`];
  if (scope.operationalLocationId) parts.push(`location ${scope.operationalLocationId}`);
  return parts.join(", ");
};

/** A short, human phrase naming the counter's shop, for banners and filter chips. */
export const describeCounterScope = (scope) => (
  scope?.known
    ? `Showing stock for ${scopeLabel(scope)} only.`
    : "This device has not been told which shop it is in."
);

/**
 * Filter a lot list to one counter, and say what happened while doing it.
 *
 * The four outcomes are separate facts and the result keeps them separate, because collapsing any
 * two of them produces a screen that lies:
 *
 * - filtered normally (`SCOPED`);
 * - the counter's own scope is unknown, so the filter could not be evaluated (`SCOPE_UNKNOWN`) —
 *   `lots` is empty here, and a caller that renders that emptiness as "0 in stock" instead of as
 *   this status has reintroduced the bug this module was written to prevent;
 * - the rows carry no scope at all (`ROWS_UNSCOPED`) — they are shown, because absence is not
 *   evidence of foreignness, but somebody has to distribute them to a shop;
 * - another shop's rows were present and excluded (`FOREIGN_ROWS_EXCLUDED`) — `counts.foreign` is
 *   the number, and any number above zero means a distribution or a sync guard is wrong upstream.
 *
 * `status` is the single most urgent of these; `counts` always carries all of them, so a collection
 * that is both partly untagged and partly foreign reports both.
 */
export const resolveScopedLots = (lots, scope) => {
  const rows = asRows(lots);
  if (scope === null || scope === undefined) {
    // Back-compatibility, named rather than implicit: every caller that has not been given a scope
    // yet sees exactly what it saw before this module existed.
    return {
      status: LOCATION_SCOPE_STATUS.UNFILTERED,
      lots: rows,
      usable: true,
      scopeKnown: false,
      scope: null,
      counts: { total: rows.length, matched: 0, unscoped: 0, foreign: 0, excluded: 0 },
      foreignExcluded: 0,
      message: "",
    };
  }

  const counter = typeof scope === "object" ? scope : UNKNOWN_COUNTER_SCOPE;
  if (!counter.known) {
    return {
      status: LOCATION_SCOPE_STATUS.SCOPE_UNKNOWN,
      lots: [],
      usable: false,
      scopeKnown: false,
      scope: counter,
      counts: { total: rows.length, matched: 0, unscoped: 0, foreign: 0, excluded: rows.length },
      foreignExcluded: 0,
      message: counterScopeMessage(LOCATION_SCOPE_STATUS.SCOPE_UNKNOWN),
    };
  }

  const kept = [];
  let matched = 0;
  let unscoped = 0;
  let foreign = 0;
  for (const lot of rows) {
    const verdict = classifyLotScope(lot, counter);
    if (verdict === LOT_SCOPE_MATCH.FOREIGN) {
      foreign += 1;
      continue;
    }
    if (verdict === LOT_SCOPE_MATCH.MATCH) matched += 1;
    else unscoped += 1;
    kept.push(lot);
  }

  let status = LOCATION_SCOPE_STATUS.SCOPED;
  if (foreign > 0) status = LOCATION_SCOPE_STATUS.FOREIGN_ROWS_EXCLUDED;
  else if (rows.length > 0 && matched === 0 && unscoped > 0) status = LOCATION_SCOPE_STATUS.ROWS_UNSCOPED;

  return {
    status,
    lots: kept,
    usable: true,
    scopeKnown: true,
    scope: counter,
    counts: { total: rows.length, matched, unscoped, foreign, excluded: foreign },
    foreignExcluded: foreign,
    message: counterScopeMessage(status, { counts: { matched, unscoped, foreign }, scope: counter }),
  };
};

/** Just the rows, for call sites that only want the filtered list. */
export const filterLotsForScope = (lots, scope) => resolveScopedLots(lots, scope).lots;

/**
 * What a shopkeeper should be told, in words that name the next action.
 *
 * Not "scope resolution failed". The person reading this is behind a counter with a customer in
 * front of them and needs to know whether to go and count crates, ring the owner, or carry on.
 */
export function counterScopeMessage(status, { counts = {}, scope = null } = {}) {
  const foreign = Number(counts.foreign) || 0;
  const unscoped = Number(counts.unscoped) || 0;
  const matched = Number(counts.matched) || 0;
  switch (status) {
    case LOCATION_SCOPE_STATUS.SCOPE_UNKNOWN:
      return "This device has not been told which shop it is in, so it cannot show stock or take a sale — the figures would be another shop's. Nothing has been lost. Ask the owner to assign this counter to a branch and location in Settings, then reopen the app.";
    case LOCATION_SCOPE_STATUS.FOREIGN_ROWS_EXCLUDED:
      return matched + unscoped === 0
        ? `Every stock record on this device belongs to another shop, so nothing here can be sold from ${scopeLabel(scope)}. Either this shop has not been sent any stock yet, or a distribution went to the wrong branch — check Stock Distribution before telling a customer the item is finished.`
        : `${foreign} stock record${foreign === 1 ? "" : "s"} belonging to another shop ${foreign === 1 ? "was" : "were"} hidden. They should not have reached this counter; report it if it keeps happening.`;
    case LOCATION_SCOPE_STATUS.ROWS_UNSCOPED:
      return `${unscoped} stock record${unscoped === 1 ? " is" : "s are"} not marked with a shop yet, so ${unscoped === 1 ? "it is" : "they are"} being shown here. Distribute ${unscoped === 1 ? "it" : "them"} to a branch so each counter sees only its own stock.`;
    default:
      return "";
  }
}

/**
 * May this counter sell at all?
 *
 * A separate question from "which rows may it sell", because the answer when the shop is unknown is
 * not an empty list — it is "do not take money on this machine until somebody says where it is".
 */
export const counterMaySell = (resolution) => {
  if (!resolution || typeof resolution !== "object") return true;
  return resolution.usable !== false;
};
