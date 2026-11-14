// The app's one queue of in-app confirm and reason boxes, and the hooks screens use to reach it.
//
// The rules live in `local/feedback.js` (tested); `feedbackDialogs.jsx` draws the box at the head
// of the queue. Kept apart from the components so that file exports components only.
//
//   const confirm = useConfirm();
//   if (!(await confirm({ title, message, confirmLabel, tone: "danger" }))) return;
//
//   const askReason = useAskReason();
//   const reason = await askReason({ title, label, defaultValue });
//   if (reason === null) return;

import { createContext, useCallback, useContext, useState } from "react";
import { createDialogQueue, createInFlightGuard, noticeFromResult } from "./local/feedback";

/** The app's own queue. App mounts one `FeedbackDialogHost` for it. */
export const appDialogQueue = createDialogQueue();

export const FeedbackDialogContext = createContext(appDialogQueue);

/** `confirm(options)` → Promise<boolean>. */
export const useConfirm = () => useContext(FeedbackDialogContext).confirm;

/** `askReason(options)` → Promise<string | null>; null when cancelled. */
export const useAskReason = () => useContext(FeedbackDialogContext).askReason;

/**
 * The notice under a card's Save button: `[notice, show, clear]`. `show` takes a notice or a save
 * result (see `noticeFromResult`); call `clear` from the card's inputs so the notice goes on the
 * next edit.
 */
export const useSaveNotice = () => {
  const [notice, setNotice] = useState(null);
  const show = useCallback((value, words) => {
    if (value && typeof value === "object" && "tone" in value && "text" in value) setNotice(value);
    else setNotice(noticeFromResult(value, words));
  }, []);
  const clear = useCallback(() => setNotice(null), []);
  return [notice, show, clear];
};

/**
 * `[saving, run]`: `run(task)` runs the save once; a second call while it is running does nothing.
 * `saving` is for the button: disabled, and "Saving…" on it.
 */
export const useSaveInFlight = () => {
  const [guard] = useState(createInFlightGuard);
  const [saving, setSaving] = useState(false);
  const run = useCallback(async (task) => {
    if (!guard.begin()) return undefined;
    setSaving(true);
    try {
      return await task();
    } finally {
      guard.end();
      setSaving(false);
    }
  }, [guard]);
  return [saving, run];
};
