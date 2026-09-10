/**
 * Whether this device should ask the cloud for a full copy of the shop's data.
 *
 * ## The trap this closes
 *
 * The reference bootstrap is the only thing that fills a device from the cloud, and `syncService`
 * asked for it on one condition:
 *
 *     bootstrap_protocol: cursor === "0" ? "reference-v1" : undefined
 *
 * Applying a bootstrap stores the server's high watermark as the cursor. From then on the device
 * asks only for changes *after* that point, read from `sync_change_log` -- and a shop's existing
 * products, suppliers and lots are older than that log. They arrive by bootstrap or not at all.
 *
 * So a bootstrap that returned zero rows was a one-way door. On 2026-09-09 the shop's DELL walked
 * through it: every business row on the cloud had `company_id NULL`, the bootstrap matched none of
 * them, sent nothing, and recorded the watermark anyway. The device was left with a valid session,
 * a healthy cloud, an approved assignment, no error anywhere, and no way through any screen in the
 * app to ask again. Repairing the cloud changed nothing by itself, because the device had stopped
 * asking the question whose answer held the data. It took a script against the local database to
 * reopen it.
 *
 * ## The rule
 *
 * A device holding a cursor and no reference rows at all is in a state that cannot arise from a
 * bootstrap that worked. Either it never ran, or it ran and delivered nothing. Both are answered
 * the same way: ask again.
 *
 * The cost is that a genuinely empty shop -- a new install with no products entered yet -- asks on
 * every pull until somebody adds something. That is a handful of SELECTs and a SHARE-mode lock on
 * three tables per pull, and it stops the moment a single product exists. A device that sits empty
 * is a device where something is wrong, which is exactly when retrying is what you want; the
 * alternative is the state above, where nothing retries and nothing says so.
 */

/**
 * The count as a number, or `null` when there is no count to read.
 *
 * Deliberately not `Number(value)`: that turns `null`, `""` and `false` into 0, which is the one
 * answer this decision must never invent.
 */
const numericOrUnknown = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** A cursor that means "this device has never been filled". */
const isUnstartedCursor = (cursor) => {
  const text = String(cursor ?? "").trim();
  return text === "" || text === "0";
};

/**
 * @param {{ cursor?: string, referenceRows?: number }} status
 * @returns {{ bootstrap: boolean, reason: string }}
 */
export function decideReferenceBootstrap({ cursor, referenceRows } = {}) {
  if (isUnstartedCursor(cursor)) {
    return { bootstrap: true, reason: "NEVER_BOOTSTRAPPED" };
  }
  // Read the count without letting "no count" become zero. `Number(null)` and `Number("")` are
  // both 0, and `null` is precisely what `localDatabase.js` sends when the status could not be
  // read -- an older build, a failed call. Coercing that to an empty device would make a working
  // counter re-transfer the whole shop on every single pull. Only a real number, or a string that
  // actually contains one, counts; everything else is "unknown", and unknown never bootstraps.
  //
  // This is the same shape as the `??`-does-not-fall-through-on-0 rule in CLAUDE.md, and the first
  // version of this file got it wrong in exactly that way.
  const rows = numericOrUnknown(referenceRows);
  if (rows !== null && rows <= 0) {
    return { bootstrap: true, reason: "BOOTSTRAP_DELIVERED_NOTHING" };
  }
  return { bootstrap: false, reason: "ALREADY_FILLED" };
}

/** The value `GET /api/sync/pull` expects for `bootstrap_protocol`, or undefined. */
export function bootstrapProtocolFor(status, protocol = "reference-v1") {
  return decideReferenceBootstrap(status).bootstrap ? protocol : undefined;
}
