import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  errorOrDash,
  formatFileSize,
  isNegativeFigure,
  isZeroFigure,
  reportDraftPending,
  reportHasContent,
  reportResultsHeading,
  scopeChangeDialog,
  settingsSavedNotice,
  tidyStoredDecimal,
} from "./backOfficeScreens.js";
import { MISSING_VALUE } from "./productMaster.js";
import { NOTICE_TONE } from "./feedback.js";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");

/** One top-level function of App.jsx, from its declaration to the next one. */
const functionBody = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in App.jsx`);
  const next = app.indexOf("\nfunction ", start + 10);
  return app.slice(start, next < 0 ? undefined : next);
};

// --- Helpers ----------------------------------------------------------------------------------------

const fixedRange = ({ range }) => (range === "month"
  ? { date_from: "2026-11-01", date_to: "2026-11-15" }
  : { date_from: "2026-11-15", date_to: "2026-11-15" });

test("reportDraftPending: a range or search that differs from the shown report is waiting for Show report", () => {
  const applied = { date_from: "2026-11-15", date_to: "2026-11-15", search: "" };
  assert.equal(reportDraftPending({ range: "today", search: "" }, applied, fixedRange), false);
  assert.equal(reportDraftPending({ range: "month", search: "" }, applied, fixedRange), true);
  assert.equal(reportDraftPending({ range: "today", search: "apple" }, applied, fixedRange), true);
  assert.equal(reportDraftPending({ range: "today", search: "  " }, applied, fixedRange), false, "spaces are not a search");
});

test("reportDraftPending: half-typed custom dates count as changed; no shown search means search is live", () => {
  const throwing = () => { throw new Error("Choose both dates"); };
  assert.equal(reportDraftPending({ range: "custom", customRange: { date_from: "2026-11-01" } }, {}, throwing), true);
  const custom = (query) => ({ date_from: query.date_from, date_to: query.date_to });
  assert.equal(
    reportDraftPending({ range: "custom", customRange: { date_from: "2026-11-01", date_to: "2026-11-05" } }, { date_from: "2026-11-01", date_to: "2026-11-05" }, custom),
    false,
  );
  assert.equal(reportDraftPending({ range: "today", search: "kiwi" }, { date_from: "2026-11-15", date_to: "2026-11-15" }, fixedRange), false);
});

test("reportResultsHeading names the report and counts rows, never for a statement", () => {
  assert.deepEqual(reportResultsHeading({ title: "Discount Report", selectedReport: "discountReport", rowCount: 0 }), { title: "Discount Report", count: "0 rows" });
  assert.deepEqual(reportResultsHeading({ title: "Sales History", selectedReport: "salesHistory", rowCount: 1 }), { title: "Sales History", count: "1 row" });
  assert.equal(reportResultsHeading({ title: "Sales History", rowCount: 123456 }).count, "1,23,456 rows");
  assert.deepEqual(reportResultsHeading({ title: "Cash Book", selectedReport: "cashBook", rowCount: 12 }), { title: "Cash Book", count: "" });
  assert.equal(reportResultsHeading({ title: "", rowCount: Number.NaN }).title, "Report");
  assert.equal(reportResultsHeading({ title: "X", rowCount: -1 }).count, "");
});

test("reportHasContent: exports wait for rows; a statement always has content; unavailable never", () => {
  assert.equal(reportHasContent({ selectedReport: "discountReport", rowCount: 0 }), false);
  assert.equal(reportHasContent({ selectedReport: "discountReport", rowCount: 3 }), true);
  assert.equal(reportHasContent({ selectedReport: "profitLoss", rowCount: 0 }), true);
  assert.equal(reportHasContent({ selectedReport: "profitLoss", rowCount: 0, available: false }), false);
});

test("formatFileSize says sizes as people do, and unknown is a dash, not 0 KB", () => {
  assert.equal(formatFileSize(552736), "540 KB");
  assert.equal(formatFileSize(1258291), "1.2 MB");
  assert.equal(formatFileSize(5 * 1024), "5.0 KB");
  assert.equal(formatFileSize(900), "900 B");
  assert.equal(formatFileSize(3 * 1024 ** 3), "3.0 GB");
  assert.equal(formatFileSize("552736"), "540 KB");
  for (const unknown of [null, undefined, "", "abc", -5]) assert.equal(formatFileSize(unknown), MISSING_VALUE);
});

test("tidyStoredDecimal tidies a stored decimal and leaves typing alone", () => {
  assert.equal(tidyStoredDecimal("0.000"), "0");
  assert.equal(tidyStoredDecimal("2.500"), "2.5");
  assert.equal(tidyStoredDecimal(4), "4");
  assert.equal(tidyStoredDecimal("2."), "2.", "half-typed stays as typed");
  assert.equal(tidyStoredDecimal(""), "");
  assert.equal(tidyStoredDecimal(null), null);
});

test("settingsSavedNotice: success, or a warning when the saved values could not be read back", () => {
  const ok = settingsSavedNotice("Business identity", true);
  assert.equal(ok.tone, NOTICE_TONE.SUCCESS);
  assert.equal(ok.text, "Business identity saved.");
  const stale = settingsSavedNotice("Scale setting", false);
  assert.equal(stale.tone, NOTICE_TONE.WARNING);
  assert.match(stale.text, /^Scale setting saved, but/);
  assert.equal(settingsSavedNotice("", undefined).text, "Settings saved.");
});

test("errorOrDash prints a dash for no error", () => {
  assert.equal(errorOrDash(""), MISSING_VALUE);
  assert.equal(errorOrDash(null), MISSING_VALUE);
  assert.equal(errorOrDash("Disk full"), "Disk full");
});

test("scopeChangeDialog: rename asks name and reason in one box; close asks why, in the danger tone", () => {
  const rename = scopeChangeDialog({ kind: "branch", name: "Main Branch" });
  assert.equal(rename.title, 'Rename branch "Main Branch"');
  assert.equal(rename.nameLabel, "New name for this branch");
  assert.equal(rename.nameDefault, "Main Branch");
  assert.equal(rename.confirmLabel, "Save new name");
  assert.equal(rename.tone, undefined);
  const close = scopeChangeDialog({ kind: "counter", name: "Audit Counter", closing: true });
  assert.equal(close.title, 'Close counter "Audit Counter"?');
  assert.equal(close.tone, "danger");
  assert.equal(close.cancelLabel, "Keep counter open");
  assert.equal(close.nameLabel, undefined, "closing does not ask for a name");
  assert.equal(scopeChangeDialog({ closing: true }).title, 'Close branch "this branch"?');
});

test("isZeroFigure / isNegativeFigure read shown figures", () => {
  for (const zero of ["₹0.00", "0", "−₹0.00", "-₹0", 0]) assert.equal(isZeroFigure(zero), true, String(zero));
  for (const notZero of ["₹0.50", "₹10.00", 3, null]) assert.equal(isZeroFigure(notZero), false, String(notZero));
  for (const negative of ["-₹1,900.00", "−₹5", -3]) assert.equal(isNegativeFigure(negative), true, String(negative));
  for (const notNegative of ["₹5", "−₹0.00", 0, Number.NaN, "abc"]) assert.equal(isNegativeFigure(notNegative), false, String(notNegative));
});

// --- Wiring in App.jsx ------------------------------------------------------------------------------

test("App.jsx opens no browser alert, confirm or prompt boxes", () => {
  assert.doesNotMatch(app, /\balert\(|window\.confirm\(|window\.prompt\(/);
});

test("Reports: Show report is the primary button and says when filters wait for it", () => {
  assert.match(app, /const filtersPending = reportDraftPending\(\{ range, customRange, search \}, appliedQuery, resolveReportDateRange\);/);
  assert.match(app, /Filters changed — press \{label\}/);
  assert.match(app, /showReportButton\("Refresh stock", \{ tracksFilters: false \}\)/);
  assert.match(app, /const resultsHeading = reportResultsHeading\(\{ title: currentReport\.title, selectedReport, rowCount: rows\.length \}\);/);
  assert.match(app, /emptyReason=\{reportHasContent\(/);
  assert.match(app, /<ModuleCard\s+eyebrow="Report Center"\s+title="Choose a report"/);
});

test("Reports: print, PDF and Excel wait for rows, with the reason on the button", () => {
  const toolbar = functionBody("ReportToolbar");
  assert.match(toolbar, /emptyReason/);
  assert.match(toolbar, /const empty = Boolean\(emptyReason\);/);
  assert.ok((toolbar.match(/disabled=\{[^}]*\bempty\b[^}]*\}/g) || []).length >= 5, "Print, View PDF, PDF, Excel and WhatsApp are each held back");
});

test("Branches & Counters: rename and close go through one reason box; retire through a confirm", () => {
  assert.match(app, /const answer = await askScopeReason\(scopeChangeDialog\(\{ kind, name, closing \}\)\);/);
  assert.match(app, /const change = await askScopeChange\("branch", branch\.branch_name, !active\);/);
  assert.match(app, /const change = await askScopeChange\("counter", location\.location_name, !active\);/);
  assert.match(app, /retireDeviceConfirmText\(device\)\.split\("\\n\\n"\);\s*const retire = await confirmScope\(/);
});

test("Settings: landing has a heading and the Permission Matrix saves each role from its column", () => {
  assert.match(app, /<ModuleCard eyebrow="Settings" title="What do you want to set up\?"/);
  const matrix = functionBody("PermissionSettings");
  assert.match(matrix, /className="permission-role-head"/);
  assert.match(matrix, /onClick=\{\(\) => saveRole\(role\.role_name\)\}/);
  assert.match(matrix, /Not saved yet:/);
});

test("Settings: backups say sizes in KB/MB, errors as a dash, and the folder once", () => {
  const backup = functionBody("BackupSettings");
  assert.match(backup, /formatFileSize\(log\.backup_size\)/);
  assert.match(backup, /errorOrDash\(log\.error_message\)/);
  assert.equal((backup.match(/className="backup-folder"/g) || []).length, 1);
  assert.doesNotMatch(backup, /bytes/);
  assert.match(backup, /Backup Before Closing/);
});

test("Settings: updates show three facts with the rest folded under Technical details", () => {
  const updates = functionBody("UpdateCenterSection");
  assert.match(updates, /<details className="update-technical-details">/);
  assert.match(updates, /Technical details/);
  assert.doesNotMatch(updates, /window\.confirm/);
});

test("Settings: the weighing scale cannot be disconnected when nothing is connected", () => {
  const scale = functionBody("ScaleConnectionPanel");
  assert.match(scale, /SCALE_STATES\.OFF/);
  assert.match(scale, /Disconnect/);
});

test("Activation: one file chooser, labelled boxes and a single primary button", () => {
  const gate = functionBody("ActivationGate");
  assert.equal((gate.match(/type="file"/g) || []).length, 1);
  assert.equal((gate.match(/className="primary-button"/g) || []).length, 1);
  assert.match(gate, /<Field label="Activation text from the Owner">/);
});

test("All Shops: cash and bank below zero are drawn in the loss colour; zero profit is plain", () => {
  assert.match(app, /<SignedAmountCell format=\{money\} value=\{shop\.cash\} \/>/);
  assert.match(app, /<SignedAmountCell format=\{money\} value=\{shop\.bank\} \/>/);
  assert.match(app, /"profit-zero"/);
  assert.match(css, /\.profit-cell\.profit-zero \{/);
});

test("CSS: the FROST launcher clearance covers every screen but POS", () => {
  assert.match(css, /\.erp-shell \.content-area\[data-view\]:not\(\[data-view="sales"\]\)/);
});

test("CSS: Extra Large keeps the 920px table floor for POS and lifts it for the back office and Products", () => {
  assert.match(css, /table:not\(\.bill-table\) \{\s*min-width: max\(100%, 920px\);/);
  assert.match(css, /\[data-view="reports"\], \[data-view="accounts"\], \[data-view="settings"\], \[data-view="all-shops"\], \[data-view="branches"\]\) \.table-wrap table/);
  assert.match(css, /\.content-area\[data-view="products"\] :is\(\.product-entry-item-table, \.pm-lot-table\) table/);
});
