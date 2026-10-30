/**
 * Rules for the Expenses screen's register.
 *
 * An expense is in the books unless it was cancelled. The form used to carry an "Active" box, and an
 * expense saved with it unticked was stored `active = false` with `status = 'ACTIVE'`: the register
 * read the status and said Active, while the total tile and every report (Dashboard, P&L, balance
 * sheet: `active IS DISTINCT FROM FALSE`) left the money out. The box is gone; cancelling, which
 * records a reason, is the only way out of the books. A row stored that way before still reads as
 * what the reports do with it: Cancelled.
 */

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export const expenseRecordStatus = (expense) => (
  expense?.status === "CANCELLED" || expense?.active === false ? "CANCELLED" : "ACTIVE"
);

/** The money the reports count for these rows: every row that is not cancelled. */
export const expenseTotalExcludingCancelled = (expenses = []) => round2(
  (Array.isArray(expenses) ? expenses : [])
    .filter((expense) => expenseRecordStatus(expense) === "ACTIVE")
    .reduce((sum, expense) => {
      const amount = Number(expense?.amount);
      return Number.isFinite(amount) ? sum + amount : sum;
    }, 0),
);
