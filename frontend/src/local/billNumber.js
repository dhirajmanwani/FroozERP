// The number printed on a POS bill: the bill's date as DDMMYY, then that day's running number on
// this computer -- "311026-001" is the first bill dated 31 Oct 2026. The owner asked for it on
// 31 Oct 2026 ("jo pehla bill banega din ka vo date ke hisaab se banega"). The next day starts
// again at 001.
//
// It is a label, not an identity. `offline_invoice_ref` stays the bill's unique key, because the
// cloud treats a second bill with the same reference as a resend and keeps only one of them. Two
// computers billing the same day can both make "311026-001"; the cloud then keeps the second as
// "311026-001-2" (backend/dailyBillNumber.js) rather than refuse it.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

const BILL_NO = /^(\d{6})-(\d{3,})(?:-\d+)?$/;

/** "2026-10-31" (or a timestamp starting with it) -> "311026"; "" when it is not a date. */
export const billDateCode = (billDate) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(billDate));
  if (!match) return "";
  const [, year, month, day] = match;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return "";
  return `${day}${month}${year.slice(2)}`;
};

/** { code: "311026", seq: 1 } for "311026-001" (and for the cloud's "311026-001-2"); else null. */
export const parseBillNo = (value) => {
  const match = BILL_NO.exec(text(value));
  if (!match) return null;
  return { code: match[1], seq: Number(match[2]) };
};

/**
 * The next number for a bill dated `billDate`: one past the highest running number among
 * `existing` (this computer's bills of that date, any of their numbers) and `floor` (the last
 * number this computer handed out that day, kept in case a bill is still being saved).
 * "" when the date cannot be read: the caller then keeps the bill's reference as its number
 * rather than print a made-up date.
 */
export const nextBillNo = ({ billDate, existing = [], floor = 0 } = {}) => {
  const code = billDateCode(billDate);
  if (!code) return "";
  let highest = Number.isFinite(Number(floor)) && Number(floor) > 0 ? Math.floor(Number(floor)) : 0;
  for (const value of Array.isArray(existing) ? existing : []) {
    const parsed = parseBillNo(value);
    if (parsed && parsed.code === code && parsed.seq > highest) highest = parsed.seq;
  }
  return `${code}-${String(highest + 1).padStart(3, "0")}`;
};

/** Every number a local bill row may carry, for `nextBillNo`'s `existing`. */
export const billNumbersOf = (rows) => (Array.isArray(rows) ? rows : []).flatMap((row) => {
  const invoice = row?.invoice || row || {};
  return [invoice.bill_no, invoice.server_invoice_no, invoice.invoice_no].map(text).filter(Boolean);
});

/** Where this computer remembers the last number it gave for a date (a floor, never the source). */
export const billNoFloorKey = (billDate) => `froozerp_bill_no_floor:${billDateCode(billDate)}`;

/** The number to show for a bill: the cloud's, else this computer's, else the bill's reference. */
export const displayBillNo = (invoice = {}) => text(invoice.server_invoice_no) || text(invoice.bill_no)
  || text(invoice.offline_invoice_ref) || text(invoice.invoice_no);
