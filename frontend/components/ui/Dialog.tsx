/**
 * Modal dialogs.
 *
 * Portalled to `document.body` — the header and topbar use `backdrop-filter`, which makes them
 * containing blocks for fixed-position descendants and silently clips anything `position: fixed`
 * rendered inside them. This is the same trap the wallet chooser fell into.
 *
 * ## Focus
 *
 * Focus moves to the dialog on open and returns to whatever had it on close, and Tab is trapped
 * inside while it is open. Without that, a keyboard user tabs straight out of a modal into a page
 * they cannot see, which is worse than having no dialog at all.
 *
 * ## When to use which
 *
 * `success` for something irreversible that went right — a claim landing. `error` for something
 * the user must read before continuing. Neither should be used for progress: a dialog that says
 * "please wait" takes control away and gives nothing back.
 */

"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { IconCheckAnimated, IconClose } from "./Icons";

export type DialogTone = "success" | "error" | "info";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  tone = "info",
  title,
  children,
  onClose,
  primary,
  secondary,
  dismissible = true,
}: {
  open: boolean;
  tone?: DialogTone;
  title: string;
  children?: ReactNode;
  onClose: () => void;
  primary?: { label: string; onClick?: () => void };
  secondary?: { label: string; onClick?: () => void };
  /** Set false for a dialog that must be acknowledged with a button. */
  dismissible?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreTo.current = document.activeElement as HTMLElement | null;
    // Focus the panel itself rather than the first button: a dialog that opens with "Close"
    // focused invites dismissing it before reading it.
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    // The page behind must not scroll under the dialog.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, [open, dismissible, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={dismissible ? onClose : undefined}
    >
      <div
        ref={panelRef}
        className="dialog"
        data-tone={tone}
        role={tone === "error" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {dismissible && (
          <button className="dialog-dismiss" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        )}

        <span className="dialog-mark" aria-hidden="true">
          {tone === "success" ? (
            <IconCheckAnimated size={22} />
          ) : tone === "error" ? (
            <IconClose size={20} />
          ) : (
            <span className="dialog-dot" />
          )}
        </span>

        <h2 id="dialog-title">{title}</h2>

        {children && <div className="dialog-body">{children}</div>}

        {(primary || secondary) && (
          <div className="dialog-actions">
            {secondary && (
              <button
                className="btn btn-ghost"
                onClick={secondary.onClick ?? onClose}
              >
                {secondary.label}
              </button>
            )}
            {primary && (
              <button className="btn btn-primary" onClick={primary.onClick ?? onClose}>
                {primary.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The error dialog, built from a `FriendlyError`.
 *
 * The raw message goes in a `<details>` rather than being dropped. Someone debugging a real
 * problem still needs the selector and the arguments; they just should not be the first thing a
 * recipient sees when they are told they are not eligible.
 */
export function ErrorDialog({
  error,
  onClose,
}: {
  error: { title: string; detail: string; hint?: string; raw?: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={error !== null}
      tone="error"
      title={error?.title ?? ""}
      onClose={onClose}
      primary={{ label: "Close" }}
    >
      {error && (
        <>
          <p>{error.detail}</p>
          {error.hint && <p className="dialog-hint">{error.hint}</p>}
          {error.raw && error.raw !== error.detail && (
            <details className="dialog-details">
              <summary>Technical details</summary>
              <pre>
                <code>{error.raw}</code>
              </pre>
            </details>
          )}
        </>
      )}
    </Dialog>
  );
}
