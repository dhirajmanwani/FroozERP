import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  NOTICE_TONE,
  confirmDialogOptions,
  createDialogQueue,
  createInFlightGuard,
  errorNotice,
  makeNotice,
  noticeFromResult,
  noticePresentation,
  normalizeEllipsis,
  reasonDialogOptions,
  reasonSubmission,
  successNotice,
  warningNotice,
} from "./feedback.js";

const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const dialogsSource = await readFile(new URL("../feedbackDialogs.jsx", import.meta.url), "utf8");

test("a notice has a tone and words, and nothing to say is no notice", () => {
  assert.deepEqual(successNotice("Saved."), { tone: "success", text: "Saved." });
  assert.deepEqual(errorNotice("Enter a name.", "name"), { tone: "error", text: "Enter a name.", field: "name" });
  assert.deepEqual(warningNotice("Saved, but the list did not refresh."), { tone: "warning", text: "Saved, but the list did not refresh." });
  assert.equal(makeNotice("success", "   "), null);
  assert.equal(makeNotice("success", null), null);
  assert.equal(makeNotice("shouting", "x").tone, NOTICE_TONE.ERROR, "an unknown tone is never shown as a success");
});

test("ellipsis: three dots at the end become one character, nothing else changes", () => {
  assert.equal(normalizeEllipsis("Saving..."), "Saving…");
  assert.equal(normalizeEllipsis("Loading every shop...."), "Loading every shop…");
  assert.equal(normalizeEllipsis("Saving…"), "Saving…");
  assert.equal(normalizeEllipsis("Version 1.0.76"), "Version 1.0.76");
  assert.equal(normalizeEllipsis("Rs. 5 off"), "Rs. 5 off");
  assert.equal(normalizeEllipsis("Wait... then save"), "Wait... then save", "only a trailing run");
  assert.equal(normalizeEllipsis(undefined), "");
});

test("noticeFromResult: success, server refusal, local failure, saved-with-warning", () => {
  assert.deepEqual(noticeFromResult({ ok: true }, { success: "Password changed." }), { tone: "success", text: "Password changed." });
  assert.deepEqual(noticeFromResult(undefined, { success: "Saved." }), { tone: "success", text: "Saved." });
  const refused = Object.assign(new Error("Request failed with status code 400"), { response: { data: { message: "Current password is wrong." } } });
  assert.deepEqual(noticeFromResult(refused, { failure: "Unable to change password" }), { tone: "error", text: "Current password is wrong." });
  assert.deepEqual(noticeFromResult(new Error("Network Error"), { failure: "Could not save." }), { tone: "error", text: "Could not save." },
    "no server words: the screen's own sentence, never a raw library message");
  assert.deepEqual(noticeFromResult({ ok: false, message: "Enter a code.", field: "code" }), { tone: "error", text: "Enter a code.", field: "code" });
  assert.deepEqual(noticeFromResult({ ok: true, warning: "Saved, but the list did not refresh." }).tone, "warning");
  assert.notEqual(noticeFromResult({ ok: false }, { success: "Saved." }).text, "Saved.", "a failure never borrows the success words");
});

test("each tone is drawn with the class and role the app already uses", () => {
  assert.deepEqual(noticePresentation(successNotice("ok")), { className: "form-note stock-ok", role: "status" });
  assert.deepEqual(noticePresentation(errorNotice("no")), { className: "error-banner", role: "alert" });
  assert.deepEqual(noticePresentation(warningNotice("hm")), { className: "warning-note", role: "status" });
  assert.equal(noticePresentation(null), null);
});

test("the in-flight guard lets one save through at a time", () => {
  const guard = createInFlightGuard();
  assert.equal(guard.begin(), true);
  assert.equal(guard.running, true);
  assert.equal(guard.begin(), false, "the second click of a double click is refused");
  guard.end();
  assert.equal(guard.begin(), true, "free again once the first save finished");
});

test("confirm and reason options fill every gap, and a reason is required by default", () => {
  assert.deepEqual(confirmDialogOptions({ message: "Delete it?" }), {
    title: "Are you sure?", message: "Delete it?", confirmLabel: "Continue", cancelLabel: "Cancel", tone: "default",
  });
  assert.equal(confirmDialogOptions({ tone: "danger" }).tone, "danger");
  assert.equal(confirmDialogOptions({ tone: "loud" }).tone, "default");
  const reason = reasonDialogOptions({ title: "Why?", defaultValue: "Expense updated" });
  assert.equal(reason.required, true);
  assert.equal(reason.defaultValue, "Expense updated");
  assert.equal(reasonDialogOptions({ required: false }).required, false);
});

test("an empty reason is refused only when one is required", () => {
  assert.deepEqual(reasonSubmission("  wrong rate  "), { ok: true, value: "wrong rate", error: "" });
  assert.equal(reasonSubmission("   ").ok, false);
  assert.match(reasonSubmission("").error, /reason/i);
  assert.deepEqual(reasonSubmission("", { required: false }), { ok: true, value: "", error: "" });
});

test("the dialog queue shows one box at a time and answers each in order", async () => {
  const queue = createDialogQueue();
  let changes = 0;
  const stop = queue.subscribe(() => { changes += 1; });
  const first = queue.confirm({ title: "Leave?", tone: "danger" });
  const second = queue.askReason({ title: "Why?" });
  const shown = queue.current();
  assert.equal(shown.kind, "confirm");
  assert.equal(shown.options.tone, "danger");
  assert.equal(queue.current(), shown, "the same snapshot until the box changes");
  assert.equal(queue.settle(shown.id + 99, true), false, "a stale answer is ignored");
  assert.equal(queue.settle(shown.id, true), true);
  assert.equal(await first, true);
  const reasonBox = queue.current();
  assert.equal(reasonBox.kind, "reason");
  queue.settle(reasonBox.id, "Rate was wrong");
  assert.equal(await second, "Rate was wrong");
  assert.equal(queue.current(), null);
  assert.ok(changes >= 3);
  stop();
});

test("cancel answers false and null, and cancelAll empties the queue", async () => {
  const queue = createDialogQueue();
  const confirmAnswer = queue.confirm({});
  queue.settle(queue.current().id, "yes");
  assert.equal(await confirmAnswer, false, "only a real true confirms");
  const a = queue.confirm({});
  const b = queue.askReason({});
  queue.cancelAll();
  assert.equal(await a, false);
  assert.equal(await b, null);
  assert.equal(queue.current(), null);
});

test("the boxes follow the existing dialog patterns and are mounted once", () => {
  assert.match(dialogsSource, /role="alertdialog"/);
  assert.match(dialogsSource, /event\.key === "Escape"/, "Esc cancels");
  assert.match(dialogsSource, /cancelRef\.current\?\.focus\(\)/, "the safe choice has the focus");
  assert.match(dialogsSource, /event\.key === "Enter" && !event\.shiftKey/, "Enter submits a reason");
  assert.equal((appSource.match(/<FeedbackDialogHost /g) || []).length >= 1, true);
  assert.match(appSource, /queue=\{appDialogQueue\}/);
});
