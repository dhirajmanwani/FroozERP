/**
 * Words and figures for the back-office screens: Accounts, Reports, All Shops, Settings, Branches &
 * Counters and the shell around them (Phase 4 polish).
 *
 * Display decisions only. Nothing here changes what is saved, sent or worked out; it decides what
 * the owner and the staff read, so a report says when its filters are waiting for "Show report", a
 * backup says its size in KB or MB, and a saved percentage reads "0" rather than "0.000". Kept out
 * of App.jsx so each rule is tested on its own (`backOfficeScreens.test.mjs`).
 */
import { MISSING_VALUE } from "./productMaster.js";
import { NOTICE_TONE, makeNotice } from "./feedback.js";

const text = (value) => (value === null || value === undefined ? "" : String(value)).trim();

/**
 * True when the report's date range or search box no longer match what is on screen.
 *
 * A report's dates and search are sent with "Show report"; every other filter applies at once. So
 * the moment the range, the custom dates or the search differ from the last report shown, the
 * screen has to say that the figures below are still the old ones. `resolve` is the app's own
 * `resolveReportDateRange` (it throws on half-typed custom dates, which also counts as changed).
 * Before the first report is shown the search applies as it is typed, so it is not "changed" then.
 */
export const reportDraftPending = ({ range, customRange = {}, search = "" } = {}, applied = {}, resolve) => {
  const shown = applied && typeof applied === "object" ? applied : {};
  let draft;
  try {
    draft = typeof resolve === "function"
      ? resolve(range === "custom" ? { range, ...customRange } : { range })
      : { date_from: shown.date_from, date_to: shown.date_to };
  } catch {
    return true;
  }
  if (text(draft?.date_from) !== text(shown.date_from) || text(draft?.date_to) !== text(shown.date_to)) return true;
  if (shown.search !== undefined && text(search) !== text(shown.search)) return true;
  return false;
};

const STATEMENT_REPORTS = new Set(["profitLoss", "balanceSheet", "cashBook", "stockInventory"]);

/**
 * The results card's heading: the report's own name, and a small count beside it. The card used to
 * be titled "0 rows" in the display face, which named nothing. A statement (profit and loss, the
 * balance sheet, the cash book, stock on hand) has no row count worth showing.
 */
export const reportResultsHeading = ({ title = "", selectedReport = "", rowCount = 0 } = {}) => {
  const name = text(title) || "Report";
  if (STATEMENT_REPORTS.has(selectedReport)) return { title: name, count: "" };
  const count = Number(rowCount);
  if (!Number.isFinite(count) || count < 0) return { title: name, count: "" };
  const whole = Math.trunc(count);
  return { title: name, count: `${whole.toLocaleString("en-IN")} ${whole === 1 ? "row" : "rows"}` };
};

/** Print, PDF and Excel do nothing useful for a report with nothing in it, so they wait for rows. */
export const reportHasContent = ({ selectedReport = "", rowCount = 0, available = true } = {}) => {
  if (!available) return false;
  if (STATEMENT_REPORTS.has(selectedReport)) return true;
  const count = Number(rowCount);
  return Number.isFinite(count) && count > 0;
};

/**
 * A file's size as people say it: "540 KB", "1.2 MB". It was "5,52,736 bytes". Unknown or negative
 * is a dash, never "0 KB".
 */
export const formatFileSize = (bytes) => {
  if (bytes === null || bytes === undefined || text(bytes) === "") return MISSING_VALUE;
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return MISSING_VALUE;
  if (size < 1024) return `${Math.round(size)} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb).toLocaleString("en-IN")} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb).toLocaleString("en-IN")} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
};

/**
 * A saved percentage or rate, as a box shows it before anybody types: "0", "2.5", not the
 * database's "0.000" / "2.500". Only a stored value is tidied: what someone types is left alone.
 */
export const tidyStoredDecimal = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : value;
  const raw = String(value).trim();
  if (!/^-?\d+\.\d+$/.test(raw)) return value;
  return String(Number(raw));
};

/**
 * The notice under a settings card's Save button. `refreshed === false` means the save went
 * through but the screen could not read the saved values back, which is a warning, not a failure.
 */
export const settingsSavedNotice = (subject, refreshed) => {
  const what = text(subject) || "Settings";
  if (refreshed === false) {
    return makeNotice(NOTICE_TONE.WARNING, `${what} saved, but the screen could not show the saved values. Leave Settings and open it again.`);
  }
  return makeNotice(NOTICE_TONE.SUCCESS, `${what} saved.`);
};

/** A log's error column: the error, or a dash when there was none (it printed "-"). */
export const errorOrDash = (value) => text(value) || MISSING_VALUE;

/**
 * What a branch or counter rename/close dialog asks for, in one box instead of two prompts in a
 * row. Renaming needs the new name and a reason; closing only the reason.
 */
export const scopeChangeDialog = ({ kind = "branch", name = "", closing = false } = {}) => {
  const noun = kind === "counter" ? "counter" : "branch";
  const current = text(name) || `this ${noun}`;
  if (closing) {
    return {
      title: `Close ${noun} "${current}"?`,
      message: kind === "counter"
        ? "Bills already made at this counter stay in the books. Staff placed here will need another counter."
        : "Bills already made at this branch stay in the books. Its counters close with it.",
      label: `Why is this ${noun} being closed?`,
      confirmLabel: `Close ${noun}`,
      cancelLabel: `Keep ${noun} open`,
      tone: "danger",
    };
  }
  return {
    title: `Rename ${noun} "${current}"`,
    nameLabel: `New name for this ${noun}`,
    nameDefault: text(name),
    label: "Reason for the change",
    placeholder: "Example: the shop board was changed",
    confirmLabel: "Save new name",
  };
};

/**
 * Whether a shown figure is exactly zero ("₹0.00", "0", "−₹0.00"). A zero profit is neither a gain
 * nor a loss, so it is drawn plain: the green bold of a profit made "₹0.00" read as good news.
 */
export const isZeroFigure = (value) => {
  if (typeof value === "number") return value === 0;
  if (typeof value !== "string") return false;
  const digits = value.replace(/[₹,\s⁠]/g, "").replace(/^[-−+]/, "");
  return /^0+(\.0+)?$/.test(digits);
};

/** True for a shown figure below zero ("-₹1,900.00", "−₹5", -3). */
export const isNegativeFigure = (value) => {
  if (typeof value === "number") return Number.isFinite(value) && value < 0;
  if (typeof value !== "string") return false;
  return /^\s*[-−]\s*(?=[₹\d])/.test(value) && !isZeroFigure(value);
};
