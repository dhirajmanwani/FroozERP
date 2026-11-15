// Phase 1 polish: the App.jsx call sites that wire the tested local helpers in. The helpers
// themselves are tested in their own suites; these assertions keep the wiring from silently
// falling out of App.jsx in a later edit.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const appCss = await readFile(new URL("../App.css", import.meta.url), "utf8");

test("Back/Forward runs the same loader path as the sidebar, without pushing history again", () => {
  assert.match(appSource, /navigateRef\.current\?\.\(requestedView, \{ fromHistory: true \}\)/);
  assert.match(appSource, /!posLeaveConfirmed && !fromHistory && shouldConfirmLeavingPos\(/);
  // navigate() pushes only when the address does not already name the view, which on Back/Forward it does.
  assert.match(appSource, /if \(currentUrlView !== view\) \{/);
  assert.match(appSource, /navigateRef\.current = navigate/);
});

test("tapping a lot adds what is left when less than one unit remains", () => {
  assert.match(appSource, /weighed \?\? lotTapQuantity\(\{ available: availableStock, inCart: getCartQuantityForLot\(lot\.id\) \}\)/);
});

test("waste and expense saves cannot run twice from a double click", () => {
  assert.match(appSource, /const \[wasteSaving, runWasteSave\] = useSaveInFlight\(\);\s*const saveWaste = \(\) => runWasteSave\(/);
  assert.match(appSource, /disabled=\{wasteSaving\} onClick=\{saveWaste\}/);
  assert.match(appSource, /const \[expenseSaving, runExpenseSave\] = useSaveInFlight\(\);\s*const saveExpense = \(\) => runExpenseSave\(/);
  assert.match(appSource, /disabled=\{expenseSaving\} onClick=\{saveExpense\}/);
});

test("the shell no longer interrupts with native alerts for no-access or a refresh after saving", () => {
  assert.doesNotMatch(appSource, /alert\("Your role does not have access/);
  assert.doesNotMatch(appSource, /alert\(refreshAfterSaveMessage/);
});

test("sign-in is a form: Enter submits and the username box has the focus", () => {
  const start = appSource.search(/<form\s+className="login-form"/);
  assert.ok(start > 0, "sign-in form missing");
  const form = appSource.slice(start, appSource.indexOf("</form>", start));
  assert.match(form, /onSubmit=/);
  assert.match(form, /autoFocus/);
  assert.match(form, /type="submit"/);
});

test("the fatal start-up screen has a way out and no hard-coded red", () => {
  const start = appSource.indexOf("const ConfirmedLocalRuntimeFailure");
  const screen = appSource.slice(start, appSource.indexOf("function App()", start));
  assert.match(screen, /window\.location\.reload\(\)/);
  assert.match(screen, /onClick=\{onExit\}/);
  assert.doesNotMatch(screen, /#7f0000/);
  assert.match(appSource, /<ConfirmedLocalRuntimeFailure message=\{[^}]+\} onExit=\{requestControlledExit\} exitModal=\{exitCodeModal\} \/>/);
  assert.match(appCss, /\.fatal-startup-message \{[^}]*white-space: pre-wrap;/);
});

test("the start-up screens speak plainly", () => {
  assert.doesNotMatch(appSource, /application shell/);
  assert.doesNotMatch(appSource, /after bounded recovery attempts/);
});

test("nothing important sits under the FROST launcher, and focus is visible on report rows", () => {
  assert.match(appCss, /\.erp-shell \.content-area \{\s*padding-bottom: calc\(62px \+ 2 \* 22px\);/);
  assert.match(appCss, /tr\.report-row-clickable:focus-visible/);
  assert.match(appSource, /className="report-row-clickable"[^>]*tabIndex=\{0\}|tabIndex=\{0\} onKeyDown=\{activateOnEnter\(/);
});
