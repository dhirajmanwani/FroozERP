"use strict";

/**
 * The number a POS bill is known by: its date as DDMMYY, then that day's running number --
 * "311026-001" is the first bill dated 31 Oct 2026, and the next day starts again at 001
 * (owner, 31 Oct 2026). Before this it was FZ-YYYYMMDD-<sales.id>, which never restarted.
 *
 * A counter makes its own number while offline (frontend/src/local/billNumber.js) and sends it as
 * `bill_no`; the cloud keeps it. A bill made here (the browser POS) is numbered here. `sales.invoice_no`
 * is unique, and two computers billing the same day can both make "311026-001": the later one is
 * kept as "311026-001-2" instead of being refused, because a refused sale would sit in the
 * counter's outbox forever. The bill's identity is still `offline_invoice_ref`/`global_id`; this is
 * only its label.
 */

const BILL_NO = /^(\d{6})-(\d{3,})$/;
const STORED_BILL_NO = /^(\d{6})-(\d{3,})(?:-\d+)?$/;
const MAX_SUFFIX = 50;

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/** "2026-10-31" -> "311026"; "" when the value does not start with a calendar date. */
const billDateCode = (dateKey) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(dateKey));
  if (!match) return "";
  const [, year, month, day] = match;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return "";
  return `${day}${month}${year.slice(2)}`;
};

/** A counter's `bill_no` when it is one ("311026-001"); "" for anything else. */
const readRequestedBillNo = (value) => {
  const candidate = text(value);
  return BILL_NO.test(candidate) && candidate.length <= 30 ? candidate : "";
};

/** The next number for `dateKey` among the bills already in the cloud. */
const nextCloudBillNo = async (client, dateKey) => {
  const code = billDateCode(dateKey);
  if (!code) return "";
  const result = await client.query(
    "SELECT invoice_no FROM sales WHERE invoice_no LIKE $1",
    [`${code}-%`]
  );
  let highest = 0;
  for (const row of result.rows || []) {
    const match = STORED_BILL_NO.exec(text(row.invoice_no));
    if (match && match[1] === code && Number(match[2]) > highest) highest = Number(match[2]);
  }
  return `${code}-${String(highest + 1).padStart(3, "0")}`;
};

/**
 * Stamps `saleId` with its bill number inside the caller's transaction and returns it.
 * `requested` is the counter's own number, if it sent one; otherwise the next one for the bill's
 * date is taken. `fallback` (the old FZ-... number) is used only when the date cannot be read.
 * Each attempt runs under a savepoint, so a number another transaction took a moment earlier moves
 * this bill on to the next suffix instead of failing the whole sale.
 */
const assignBillNo = async (client, { saleId, dateKey, requested = "", fallback }) => {
  const base = readRequestedBillNo(requested) || await nextCloudBillNo(client, dateKey);
  const candidates = base
    ? [base, ...Array.from({ length: MAX_SUFFIX - 1 }, (_, index) => `${base}-${index + 2}`)]
    : [];
  if (fallback) candidates.push(fallback);
  for (const candidate of candidates) {
    const taken = await client.query(
      "SELECT 1 FROM sales WHERE invoice_no = $1 AND id <> $2 LIMIT 1",
      [candidate, saleId]
    );
    if (taken.rows && taken.rows.length > 0) continue;
    await client.query("SAVEPOINT bill_no_claim");
    try {
      await client.query("UPDATE sales SET invoice_no = $1 WHERE id = $2", [candidate, saleId]);
      await client.query("RELEASE SAVEPOINT bill_no_claim");
      return candidate;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT bill_no_claim");
      if (error && error.code === "23505") continue;
      throw error;
    }
  }
  throw new Error(`No free bill number for sale ${saleId} (tried ${base || fallback} and ${MAX_SUFFIX} more).`);
};

module.exports = { assignBillNo, billDateCode, nextCloudBillNo, readRequestedBillNo };
