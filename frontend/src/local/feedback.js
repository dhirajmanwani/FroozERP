/**
 * Telling people what happened, without a browser popup.
 *
 * The app answered most saves with `alert()`: a grey system box that blocks the whole window, says
 * the same thing for a success and a failure, and is gone the moment it is dismissed. Staff at a
 * counter learnt to click it away unread. These are the pieces the screens use instead:
 *
 * - a **notice** under the card's Save button (`SaveNotice` in App), shaped here;
 * - an in-app **confirm** and an in-app **reason** box (`ConfirmDialog`, `ReasonDialog`), queued
 *   here so any screen can `await` one and only one is ever on screen;
 * - a small **in-flight guard**, so a double click on Save saves once.
 *
 * Everything here is plain JavaScript so it can be tested with `node --test`; the React side only
 * draws what these functions decide.
 */

export const NOTICE_TONE = Object.freeze({
  SUCCESS: "success",
  ERROR: "error",
  WARNING: "warning",
});

const TONES = new Set(Object.values(NOTICE_TONE));

const text = (value) => (value === null || value === undefined ? "" : String(value)).trim();

/**
 * Loading and busy words end in one character, "…", not three full stops. Only a trailing run of
 * three or more dots is changed, so "Rs. 5" and a version like "1.0.76" are left alone.
 */
export const normalizeEllipsis = (value) => {
  const raw = value === null || value === undefined ? "" : String(value);
  return raw.replace(/\.{3,}(\s*)$/, "…$1");
};

/**
 * A notice, or null when there is nothing to say. `{ tone, text, field? }`: `field` names the
 * input the message is about, so the screen can point at it.
 */
export const makeNotice = (tone, message, field = "") => {
  const words = normalizeEllipsis(text(message));
  if (!words) return null;
  const safeTone = TONES.has(tone) ? tone : NOTICE_TONE.ERROR;
  const notice = { tone: safeTone, text: words };
  const fieldName = text(field);
  if (fieldName) notice.field = fieldName;
  return notice;
};

export const successNotice = (message) => makeNotice(NOTICE_TONE.SUCCESS, message);
export const warningNotice = (message, field) => makeNotice(NOTICE_TONE.WARNING, message, field);
export const errorNotice = (message, field) => makeNotice(NOTICE_TONE.ERROR, message, field);

const serverWords = (error) => {
  const data = error?.response?.data;
  if (typeof data === "string") return text(data);
  return text(data?.message) || text(data?.error);
};

/**
 * The notice for the outcome of a save.
 *
 * - `{ ok: true }` (or anything without an error) is a success with `success` as its words.
 * - An `Error`, an axios failure or `{ ok: false, error }` is an error: the server's own words when
 *   it answered, otherwise `failure`. A failure never borrows the success words.
 * - `{ ok: true, warning }` saved but something after the save did not (a refresh, a print): a
 *   warning, because the save itself must not be reported as failed.
 */
export const noticeFromResult = (result, { success = "Saved.", failure = "That could not be saved." } = {}) => {
  if (result instanceof Error || (result && typeof result === "object" && "isAxiosError" in result)) {
    return errorNotice(serverWords(result) || failure);
  }
  if (result && typeof result === "object" && result.ok === false) {
    const error = result.error;
    const words = text(result.message) || (error ? serverWords(error) : "") || failure;
    return errorNotice(words, result.field);
  }
  if (result && typeof result === "object" && text(result.warning)) {
    return warningNotice(result.warning);
  }
  if (result && typeof result === "object" && text(result.message)) {
    return successNotice(result.message);
  }
  return successNotice(success);
};

/**
 * How a notice is drawn: the class and the ARIA role. A failure is an alert (read out at once); a
 * success or a warning is a status (read out politely). These are the classes the app already
 * uses for the same three things, so nothing new is styled.
 */
export const noticePresentation = (notice) => {
  if (!notice || !text(notice.text)) return null;
  if (notice.tone === NOTICE_TONE.SUCCESS) return { className: "form-note stock-ok", role: "status" };
  if (notice.tone === NOTICE_TONE.WARNING) return { className: "warning-note", role: "status" };
  return { className: "error-banner", role: "alert" };
};

/**
 * A save that can only run once at a time. `begin()` answers false while one is running, so the
 * second click of a double click does nothing instead of saving the entry twice.
 */
export const createInFlightGuard = () => {
  let running = false;
  return {
    begin() {
      if (running) return false;
      running = true;
      return true;
    },
    end() {
      running = false;
    },
    get running() {
      return running;
    },
  };
};

/** The confirm box's settings with every gap filled. `tone` "danger" paints the confirm button red. */
export const confirmDialogOptions = (options = {}) => {
  const safe = options && typeof options === "object" ? options : { message: options };
  return {
    title: text(safe.title) || "Are you sure?",
    message: text(safe.message),
    confirmLabel: text(safe.confirmLabel) || "Continue",
    cancelLabel: text(safe.cancelLabel) || "Cancel",
    tone: safe.tone === "danger" ? "danger" : "default",
  };
};

/** The reason box's settings with every gap filled. A reason is required unless said otherwise. */
export const reasonDialogOptions = (options = {}) => {
  const safe = options && typeof options === "object" ? options : { title: options };
  return {
    title: text(safe.title) || "Give a reason",
    message: text(safe.message),
    label: text(safe.label) || "Reason",
    defaultValue: safe.defaultValue === undefined || safe.defaultValue === null ? "" : String(safe.defaultValue),
    placeholder: text(safe.placeholder),
    confirmLabel: text(safe.confirmLabel) || "Continue",
    cancelLabel: text(safe.cancelLabel) || "Cancel",
    required: safe.required !== false,
    tone: safe.tone === "danger" ? "danger" : "default",
  };
};

/**
 * What a reason box hands back for what was typed: `{ ok, value, error }`. Trimmed. An empty reason
 * is refused only when one is required, and then the box stays open and says so.
 */
export const reasonSubmission = (typed, { required = true } = {}) => {
  const value = text(typed);
  if (!value && required) return { ok: false, value: "", error: "Enter a reason to continue." };
  return { ok: true, value, error: "" };
};

/**
 * The in-app confirm and reason boxes, one at a time.
 *
 * `confirm(options)` resolves to true or false; `askReason(options)` to the reason, or null when
 * cancelled. A request made while another box is open waits its turn rather than covering it.
 * The host that draws the boxes reads `current()` and calls `settle(id, value)`.
 */
export const createDialogQueue = () => {
  const waiting = [];
  const listeners = new Set();
  let nextId = 1;
  // The same object until the box on screen changes: React's external-store reader compares it.
  let snapshot = null;
  const notify = () => {
    const head = waiting[0];
    snapshot = head ? Object.freeze({ id: head.id, kind: head.kind, options: head.options }) : null;
    listeners.forEach((listener) => listener());
  };
  const request = (kind, options) => new Promise((resolve) => {
    waiting.push({ id: nextId++, kind, options, resolve });
    if (waiting.length === 1) notify();
  });
  return {
    confirm: (options) => request("confirm", confirmDialogOptions(options)),
    askReason: (options) => request("reason", reasonDialogOptions(options)),
    current: () => snapshot,
    settle(id, value) {
      const head = waiting[0];
      if (!head || head.id !== id) return false;
      waiting.shift();
      if (head.kind === "confirm") head.resolve(value === true);
      else head.resolve(typeof value === "string" ? value : null);
      notify();
      return true;
    },
    /** Every open and waiting box answered "cancel" (sign-out, a screen that is going away). */
    cancelAll() {
      const pending = waiting.splice(0, waiting.length);
      pending.forEach((entry) => entry.resolve(entry.kind === "confirm" ? false : null));
      if (pending.length) notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
