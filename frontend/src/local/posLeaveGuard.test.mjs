import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { POS_LEAVE_PROMPT, shouldConfirmLeavingPos } from "./posLeaveGuard.js";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("leaving POS asks only when a bill is in progress", () => {
  assert.equal(shouldConfirmLeavingPos({ activeView: "sales", nextView: "customers", cartLines: 3 }), true);
  assert.equal(shouldConfirmLeavingPos({ activeView: "sales", nextView: null, cartLines: 1 }), true, "Back/Forward lead somewhere else");
  assert.equal(shouldConfirmLeavingPos({ activeView: "sales", nextView: "customers", cartLines: 0 }), false, "an empty cart leaves freely");
  assert.equal(shouldConfirmLeavingPos({ activeView: "sales", nextView: "sales", cartLines: 3 }), false, "refreshing POS is not leaving it");
  assert.equal(shouldConfirmLeavingPos({ activeView: "orders", nextView: "customers", cartLines: 3 }), false);
  assert.equal(shouldConfirmLeavingPos({}), false);
});

test("the question is the owner's wording, with Stay and Leave", () => {
  assert.equal(POS_LEAVE_PROMPT.title, "Leave POS?");
  assert.equal(POS_LEAVE_PROMPT.message, "The bill in progress will be cleared.");
  assert.equal(POS_LEAVE_PROMPT.stay, "Stay");
  assert.equal(POS_LEAVE_PROMPT.leave, "Leave");
});

test("navigate asks before it does anything else, and only an answered dialog skips the question", () => {
  const start = app.indexOf("const navigate = async (view, { posLeaveConfirmed = false } = {}) => {");
  assert.ok(start > 0, "navigate takes the confirmation flag");
  const head = app.slice(start, start + 700);
  assert.match(head, /if \(!posLeaveConfirmed && shouldConfirmLeavingPos\(\{ activeView, nextView: view, cartLines: posWork\.cartLines \}\)\) \{/);
  assert.ok(head.indexOf("shouldConfirmLeavingPos(") < head.indexOf("hasModuleAccess(view)"), "asked first");
  assert.match(app, /navigateRef\.current\?\.\(target\.view, \{ posLeaveConfirmed: true \}\)/);
});

test("the Back and Forward buttons ask too, and the dialog is in-app, never a browser box", () => {
  assert.match(app, /setPosLeavePrompt\(\{ history: "back" \}\) : window\.history\.back\(\)/);
  assert.match(app, /setPosLeavePrompt\(\{ history: "forward" \}\) : window\.history\.forward\(\)/);
  const start = app.indexOf("function PosLeaveDialog(");
  assert.ok(start > 0);
  const body = app.slice(start, app.indexOf("\n}\n", start));
  assert.match(body, /POS_LEAVE_PROMPT\.title/);
  assert.match(body, /autoFocus className="primary-button" type="button" onClick=\{onStay\}/, "Stay is the default");
  assert.doesNotMatch(body, /window\.confirm|alert\(/);
});
