// The in-app replacements for the browser's alert, confirm and prompt boxes.
//
// - `SaveNotice`: the line under a card's Save button saying what happened.
// - `ConfirmDialog`: yes or no, built on the POS "leave this bill?" box (role=alertdialog, the safe
//   choice has the focus, Esc cancels).
// - `ReasonDialog`: a reason typed in, built on the bill-cancel box (a text area, Enter submits,
//   Shift+Enter starts a new line, Esc cancels, an empty required reason is refused in place).
// - `FeedbackDialogHost`: mounted once by App; draws whichever box is at the head of the queue.
//
// The decisions (tones, defaults, the queue) are in `local/feedback.js`, where they are tested.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { noticePresentation, reasonSubmission } from "./local/feedback";

export function SaveNotice({ notice, className = "" }) {
  const presentation = noticePresentation(notice);
  if (!presentation) return null;
  const classes = `${presentation.className} save-notice ${className}`.trim();
  return <p className={classes} role={presentation.role}>{notice.text}</p>;
}

const dialogKeyDown = (onCancel) => (event) => {
  if (event.key === "Escape") {
    event.stopPropagation();
    event.preventDefault();
    onCancel();
  }
};

export function ConfirmDialog({ options, onAnswer }) {
  const cancelRef = useRef(null);
  const danger = options.tone === "danger";
  useEffect(() => {
    // The safe choice holds the focus, so an Enter pressed out of habit changes nothing.
    cancelRef.current?.focus();
  }, []);
  return (
    <div className="modal-backdrop feedback-dialog-backdrop">
      <section
        aria-describedby={options.message ? "feedback-confirm-message" : undefined}
        aria-labelledby="feedback-confirm-title"
        aria-modal="true"
        className={`invoice-modal feedback-dialog ${danger ? "feedback-dialog-danger" : ""}`.trim()}
        onKeyDown={dialogKeyDown(() => onAnswer(false))}
        role="alertdialog"
      >
        <div className="feedback-dialog-body">
          <strong className="feedback-dialog-title" id="feedback-confirm-title">{options.title}</strong>
          {options.message && <p id="feedback-confirm-message">{options.message}</p>}
          <div className="button-row feedback-dialog-actions">
            <button className="secondary-button" ref={cancelRef} type="button" onClick={() => onAnswer(false)}>{options.cancelLabel}</button>
            <button className={danger ? "primary-button primary-button-danger" : "primary-button"} type="button" onClick={() => onAnswer(true)}>{options.confirmLabel}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function ReasonDialog({ options, onAnswer }) {
  const [value, setValue] = useState(options.defaultValue);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const danger = options.tone === "danger";
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // A suggested reason is selected, so typing replaces it and Enter keeps it.
    input.select();
  }, []);
  const submit = () => {
    const outcome = reasonSubmission(value, { required: options.required });
    if (!outcome.ok) {
      setError(outcome.error);
      inputRef.current?.focus();
      return;
    }
    onAnswer(outcome.value);
  };
  return (
    <div className="modal-backdrop feedback-dialog-backdrop">
      <section
        aria-labelledby="feedback-reason-title"
        aria-modal="true"
        className={`invoice-modal feedback-dialog ${danger ? "feedback-dialog-danger" : ""}`.trim()}
        onKeyDown={dialogKeyDown(() => onAnswer(null))}
        role="dialog"
      >
        <form
          className="feedback-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <strong className="feedback-dialog-title" id="feedback-reason-title">{options.title}</strong>
          {options.message && <p>{options.message}</p>}
          <label className="feedback-dialog-field">
            <span>{options.label}{options.required && <span aria-hidden="true" className="pm-required"> *</span>}</span>
            <textarea
              aria-invalid={error ? "true" : undefined}
              placeholder={options.placeholder || undefined}
              ref={inputRef}
              rows={3}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          {error && <p className="error-banner" role="alert">{error}</p>}
          <div className="button-row feedback-dialog-actions">
            <button className="secondary-button" type="button" onClick={() => onAnswer(null)}>{options.cancelLabel}</button>
            <button className={danger ? "primary-button primary-button-danger" : "primary-button"} type="submit">{options.confirmLabel}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function FeedbackDialogHost({ queue }) {
  const current = useSyncExternalStore(queue.subscribe, queue.current, queue.current);
  if (!current) return null;
  const answer = (value) => queue.settle(current.id, value);
  // Keyed by id so a second box after the first starts fresh (its own text, its own focus).
  if (current.kind === "confirm") return <ConfirmDialog key={current.id} options={current.options} onAnswer={answer} />;
  return <ReasonDialog key={current.id} options={current.options} onAnswer={answer} />;
}
