import {
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cx } from "../utils/cx.js";

export type ToastTone = "info" | "success" | "error";

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone: ToastTone;
  /** Auto-dismiss delay in ms. 0 disables auto-dismiss (manual only). */
  duration?: number;
  onDismiss?: () => void;
  /** Accessible label for the dismiss control (default "Dismiss"). */
  dismissLabel?: string;
  children: ReactNode;
}

export const TOAST_TONES: readonly ToastTone[] = ["info", "success", "error"];

/**
 * Single toast. info/success announce politely (role=status); errors are
 * assertive (role=alert). Auto-dismisses after `duration` (default 5000ms)
 * and PAUSES while focused or hovered — a user reading a toast keeps it
 * (focus-within and hover both freeze the countdown, resume restarts the
 * remaining time). Toasts report transport/UI facts; money outcomes come
 * from state, never from a toast alone.
 */
export function Toast({
  tone,
  duration = 5000,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
  children,
  onFocus,
  onBlur,
  onMouseEnter,
  onMouseLeave,
  ...rest
}: ToastProps) {
  const remainingRef = useRef(duration);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const dismiss = (): void => {
    clear();
    onDismiss?.();
  };

  const pause = (): void => {
    if (timerRef.current === null) {
      return;
    }
    remainingRef.current -= Date.now() - startedAtRef.current;
    if (remainingRef.current < 0) {
      remainingRef.current = 0;
    }
    clear();
  };

  const resume = (): void => {
    if (duration === 0 || remainingRef.current <= 0 || timerRef.current !== null) {
      return;
    }
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => dismiss(), remainingRef.current);
  };

  useEffect(() => {
    if (duration === 0) {
      return;
    }
    remainingRef.current = duration;
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => dismiss(), duration);
    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx("ps-toast", `ps-toast--${tone}`, className)}
      onFocus={(event) => {
        pause();
        onFocus?.(event);
      }}
      onBlur={(event) => {
        resume();
        onBlur?.(event);
      }}
      onMouseEnter={(event) => {
        pause();
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        resume();
        onMouseLeave?.(event);
      }}
      {...rest}
    >
      <div className="ps-toast__content">{children}</div>
      <button
        type="button"
        className="ps-toast__dismiss"
        onClick={dismiss}
        aria-label={dismissLabel}
      >
        <span aria-hidden="true">&#215;</span>
      </button>
    </div>
  );
}

export interface ToastViewportProps extends HTMLAttributes<HTMLDivElement> {
  /** Accessible name for the notifications region. */
  label?: string;
  children?: ReactNode;
}

/**
 * Toast container — exactly ONE per application (the reference's duplicate
 * live regions are a defect we do not adopt). Renders a labelled region;
 * toasts carry their own live semantics (status/alert).
 */
export function ToastViewport({
  label = "Notifications",
  className,
  children,
  ...rest
}: ToastViewportProps) {
  return (
    <div
      role="region"
      aria-label={label}
      className={cx("ps-toast-viewport", className)}
      {...rest}
    >
      {children}
    </div>
  );
}
