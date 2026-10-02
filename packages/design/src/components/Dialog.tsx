"use client";

import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../utils/cx.js";
import { useId } from "../hooks/useId.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";

export interface DialogProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Open state — the dialog only mounts while open (no hidden DOM noise). */
  open: boolean;
  /** Called on Escape, scrim click, or the Close button. */
  onClose: () => void;
  /** Dialog title (rendered as h2; the dialog is labelled by it). */
  title: ReactNode;
  /** Optional description wired via aria-describedby. */
  description?: ReactNode;
  /** Footer content (actions). */
  footer?: ReactNode;
  /** Whether a visible Close button renders in the header (default true — the reference pattern). */
  showCloseButton?: boolean;
  /** Accessible label for the Close button (default "Close"). */
  closeLabel?: string;
  /** Whether a scrim click closes (default true). */
  closeOnScrimClick?: boolean;
}

/**
 * Modal dialog: role=dialog + aria-modal, labelled title, described body,
 * focus trap with restore (useFocusTrap), Escape to close, body scroll lock
 * while open. Destructive confirmations pair this with the `danger` Button
 * variant — the dialog itself never decides semantics.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  showCloseButton = true,
  closeLabel = "Close",
  closeOnScrimClick = true,
  id,
  className,
  children,
  onKeyDown,
  ...rest
}: DialogProps) {
  const baseId = useId("ps-dialog", id);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
    onKeyDown?.(event);
  };

  return (
    <div className="ps-dialog-layer">
      <div
        className="ps-dialog-scrim"
        onClick={closeOnScrimClick ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
        aria-describedby={description ? `${baseId}-description` : undefined}
        className={cx("ps-dialog", className)}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        {...rest}
      >
        <div className="ps-dialog__header">
          <h2 id={`${baseId}-title`} className="ps-dialog__title">
            {title}
          </h2>
          {showCloseButton ? (
            <button
              type="button"
              className="ps-dialog__close"
              onClick={onClose}
              aria-label={closeLabel}
            >
              <span aria-hidden="true">&#215;</span>
            </button>
          ) : null}
        </div>
        {description ? (
          <p id={`${baseId}-description`} className="ps-dialog__description">
            {description}
          </p>
        ) : null}
        {children ? <div className="ps-dialog__body">{children}</div> : null}
        {footer ? <div className="ps-dialog__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
