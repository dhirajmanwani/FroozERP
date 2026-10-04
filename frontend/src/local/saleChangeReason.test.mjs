import test from "node:test";
import assert from "node:assert/strict";

import {
  SALE_CHANGE_APPROVAL_GENERIC_MESSAGE,
  SALE_CHANGE_APPROVAL_MODE,
  SALE_CHANGE_APPROVAL_OFFLINE_MESSAGE,
  SALE_CHANGE_APPROVAL_UNREACHABLE_MESSAGE,
  SALE_CHANGE_REASONS,
  SALE_CHANGE_REASON_CODE,
  approvalErrorCode,
  composeSaleChangeReason,
  describeApprovalError,
  parseSaleChangeReason,
  resolveSaleChangeApprovalRoute,
  saleChangeNeedsApproval,
} from "./saleChangeReason.js";

test("the reason list is the contract's five labels, in order, and cannot be changed", () => {
  assert.deepEqual(SALE_CHANGE_REASONS.map((reason) => reason.label), [
    "Wrong item or rate",
    "Customer refused",
    "Duplicate bill",
    "Payment issue",
    "Other",
  ]);
  assert.deepEqual(SALE_CHANGE_REASONS.map((reason) => reason.code), [
    "WRONG_ITEM_OR_RATE",
    "CUSTOMER_REFUSED",
    "DUPLICATE_BILL",
    "PAYMENT_ISSUE",
    "OTHER",
  ]);
  assert.ok(Object.isFrozen(SALE_CHANGE_REASONS));
  assert.ok(SALE_CHANGE_REASONS.every((reason) => Object.isFrozen(reason)));
  assert.throws(() => { "use strict"; SALE_CHANGE_REASONS.push({ code: "X", label: "X" }); });
});

test("a fixed reason is stored as its label", () => {
  for (const reason of SALE_CHANGE_REASONS.filter((entry) => entry.code !== "OTHER")) {
    assert.deepEqual(composeSaleChangeReason({ code: reason.code }), { ok: true, reason: reason.label });
    // Typed text is ignored for a fixed reason.
    assert.deepEqual(composeSaleChangeReason({ code: reason.code, otherText: "ignored" }), { ok: true, reason: reason.label });
  }
});

test("Other is stored as 'Other: <trimmed text>' and refuses empty text", () => {
  assert.deepEqual(composeSaleChangeReason({ code: "OTHER", otherText: "  scale broke  " }), { ok: true, reason: "Other: scale broke" });
  assert.deepEqual(composeSaleChangeReason({ code: "OTHER", otherText: "   " }), { ok: false, message: "Type the reason for Other." });
  assert.deepEqual(composeSaleChangeReason({ code: "OTHER" }), { ok: false, message: "Type the reason for Other." });
  assert.deepEqual(composeSaleChangeReason({ code: "OTHER", otherText: 42 }), { ok: false, message: "Type the reason for Other." });
});

test("no code or an unknown code is refused", () => {
  assert.deepEqual(composeSaleChangeReason({}), { ok: false, message: "Choose a reason." });
  assert.deepEqual(composeSaleChangeReason(), { ok: false, message: "Choose a reason." });
  assert.deepEqual(composeSaleChangeReason({ code: "" }), { ok: false, message: "Choose a reason." });
  assert.deepEqual(composeSaleChangeReason({ code: "REFUND" }), { ok: false, message: "Choose a reason." });
  // A label is not a code.
  assert.deepEqual(composeSaleChangeReason({ code: "Duplicate bill" }), { ok: false, message: "Choose a reason." });
  assert.deepEqual(composeSaleChangeReason({ code: "other", otherText: "x" }), { ok: false, message: "Choose a reason." });
});

test("stored reasons parse back to the picker, including legacy free text", () => {
  assert.deepEqual(parseSaleChangeReason("Duplicate bill"), { code: "DUPLICATE_BILL", otherText: "" });
  assert.deepEqual(parseSaleChangeReason("  Payment issue "), { code: "PAYMENT_ISSUE", otherText: "" });
  assert.deepEqual(parseSaleChangeReason("customer refused"), { code: "CUSTOMER_REFUSED", otherText: "" });
  assert.deepEqual(parseSaleChangeReason("Other: scale broke"), { code: "OTHER", otherText: "scale broke" });
  assert.deepEqual(parseSaleChangeReason("Other:no space"), { code: "OTHER", otherText: "no space" });
  assert.deepEqual(parseSaleChangeReason("Other"), { code: "OTHER", otherText: "" });
  assert.deepEqual(parseSaleChangeReason("galat bill ban gaya"), { code: "OTHER", otherText: "galat bill ban gaya" });
  assert.deepEqual(parseSaleChangeReason(""), { code: "", otherText: "" });
  assert.deepEqual(parseSaleChangeReason(null), { code: "", otherText: "" });
  assert.deepEqual(parseSaleChangeReason(undefined), { code: "", otherText: "" });
});

test("compose and parse round-trip", () => {
  for (const reason of SALE_CHANGE_REASONS) {
    const composed = composeSaleChangeReason({ code: reason.code, otherText: "typed words" });
    assert.equal(composed.ok, true);
    const parsed = parseSaleChangeReason(composed.reason);
    assert.equal(parsed.code, reason.code);
    assert.equal(parsed.otherText, reason.code === SALE_CHANGE_REASON_CODE.OTHER ? "typed words" : "");
  }
});

test("only Owner and Admin skip approval; everything else fails closed", () => {
  for (const role of ["Owner", "owner", " ADMIN ", "Admin", "admin"]) assert.equal(saleChangeNeedsApproval(role), false, role);
  for (const role of ["Cashier", "Manager", "Staff", "", "   ", null, undefined, 1, {}, "Owner Assistant", "Administrator"]) {
    assert.equal(saleChangeNeedsApproval(role), true, String(role));
  }
});

test("approval route: none when not needed, whatever the connection", () => {
  assert.deepEqual(resolveSaleChangeApprovalRoute({ needsApproval: false, offlineMode: true, localOnly: true, cloudGateAllowed: false }), { mode: "NONE" });
  assert.equal(SALE_CHANGE_APPROVAL_MODE.NONE, "NONE");
});

test("approval route: cloud only when online, not LOCAL_ONLY, and the gate says yes", () => {
  assert.deepEqual(resolveSaleChangeApprovalRoute({ needsApproval: true, offlineMode: false, localOnly: false, cloudGateAllowed: true }), { mode: "CLOUD" });
});

test("approval route: offline, LOCAL_ONLY or a refusing gate is refused with the contract message", () => {
  const expected = "Cancelling or editing a bill needs Owner or Admin approval, and that needs a connection. Connect to the internet, or ask the Owner or Admin to do it on this counter.";
  assert.equal(SALE_CHANGE_APPROVAL_OFFLINE_MESSAGE, expected);
  const cases = [
    { needsApproval: true, offlineMode: true, localOnly: false, cloudGateAllowed: true },
    { needsApproval: true, offlineMode: false, localOnly: true, cloudGateAllowed: true },
    { needsApproval: true, offlineMode: false, localOnly: false, cloudGateAllowed: false },
    { needsApproval: true, offlineMode: false, localOnly: false },
    { needsApproval: true, offlineMode: false, localOnly: false, cloudGateAllowed: "yes" },
  ];
  for (const input of cases) assert.deepEqual(resolveSaleChangeApprovalRoute(input), { mode: "REFUSED", message: expected }, JSON.stringify(input));
});

test("approval route: a missing needsApproval fails closed", () => {
  assert.equal(resolveSaleChangeApprovalRoute({ offlineMode: true }).mode, "REFUSED");
  assert.equal(resolveSaleChangeApprovalRoute({ offlineMode: false, localOnly: false, cloudGateAllowed: true }).mode, "CLOUD");
  assert.equal(resolveSaleChangeApprovalRoute().mode, "REFUSED");
});

const axiosError = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), {
  isAxiosError: true,
  request: {},
  response: { status, data },
});

test("every contract error code has its own plain line that says nothing was saved", () => {
  const codes = [
    "APPROVER_CREDENTIALS_INVALID",
    "APPROVER_NOT_ALLOWED",
    "REQUESTER_NOT_ALLOWED",
    "APPROVAL_ATTEMPTS_LOCKED",
    "PASSWORD_RESET_REQUIRED",
    "SALE_CHANGE_APPROVAL_REQUIRED",
  ];
  const seen = new Set();
  for (const code of codes) {
    const fromAxios = describeApprovalError(axiosError(401, { code, message: "server words" }));
    const fromPlain = describeApprovalError({ code });
    assert.equal(fromAxios, fromPlain, code);
    assert.match(fromAxios, /Nothing was saved\.$/, code);
    assert.doesNotMatch(fromAxios, /\n/);
    assert.doesNotMatch(fromAxios, /server words/);
    assert.notEqual(fromAxios, SALE_CHANGE_APPROVAL_GENERIC_MESSAGE, code);
    seen.add(fromAxios);
  }
  assert.equal(seen.size, codes.length, "each code reads differently");
  assert.match(describeApprovalError({ code: "APPROVER_CREDENTIALS_INVALID" }), /username or password is wrong/);
  assert.match(describeApprovalError({ code: "APPROVAL_ATTEMPTS_LOCKED" }), /Too many/);
});

test("unknown errors and network failures still say nothing was saved", () => {
  assert.equal(
    describeApprovalError(axiosError(500, { code: "SOMETHING_ELSE", message: "boom" })),
    "The approval could not be completed. The server said: boom. (SOMETHING_ELSE, HTTP 500) Nothing was saved.",
  );
  assert.equal(
    describeApprovalError({ code: "APPROVAL_NOT_NEEDED" }),
    "The approval could not be completed. (APPROVAL_NOT_NEEDED) Nothing was saved.",
  );
  assert.equal(describeApprovalError(null), SALE_CHANGE_APPROVAL_GENERIC_MESSAGE);
  assert.equal(describeApprovalError("oops"), SALE_CHANGE_APPROVAL_GENERIC_MESSAGE);
  assert.equal(describeApprovalError(new Error("x")), SALE_CHANGE_APPROVAL_GENERIC_MESSAGE);
  const network = Object.assign(new Error("Network Error"), { isAxiosError: true, code: "ERR_NETWORK", request: {} });
  assert.equal(describeApprovalError(network), SALE_CHANGE_APPROVAL_UNREACHABLE_MESSAGE);
  for (const message of [SALE_CHANGE_APPROVAL_GENERIC_MESSAGE, SALE_CHANGE_APPROVAL_UNREACHABLE_MESSAGE]) {
    assert.match(message, /Nothing was saved\.$/);
  }
});

test("the error code is read from axios or plain shapes", () => {
  assert.equal(approvalErrorCode(axiosError(403, { code: " APPROVER_NOT_ALLOWED " })), "APPROVER_NOT_ALLOWED");
  assert.equal(approvalErrorCode({ data: { code: "REQUESTER_NOT_ALLOWED" } }), "REQUESTER_NOT_ALLOWED");
  assert.equal(approvalErrorCode({ code: "PASSWORD_RESET_REQUIRED" }), "PASSWORD_RESET_REQUIRED");
  assert.equal(approvalErrorCode(undefined), "");
  assert.equal(approvalErrorCode(axiosError(400, "not json")), "");
});

test("an unknown refusal says what the server said, so the counter can report it (4 Oct 2026)", () => {
  // An older server that does not know the "return" action answers this.
  const line = describeApprovalError(axiosError(400, {
    code: "APPROVAL_REQUEST_INVALID",
    message: "Say whether the bill is being cancelled, edited or returned, or a discount approved.",
  }));
  assert.match(line, /^The approval could not be completed\. The server said: Say whether .* approved\. \(APPROVAL_REQUEST_INVALID, HTTP 400\) Nothing was saved\.$/);
  assert.doesNotMatch(line, /\.\./);
  // A message that names a repository script is still turned into plain words.
  const scoped = describeApprovalError(axiosError(403, { code: "X", message: "Run scripts/bootstrap-first-counter.mjs first." }));
  assert.match(scoped, /Ask the maintainer to set up the first counter/);
  assert.doesNotMatch(scoped, /scripts\//);
  // No code and no words: the bare line, as before.
  assert.equal(describeApprovalError(axiosError(500, {})), "The approval could not be completed. (HTTP 500) Nothing was saved.");
});
