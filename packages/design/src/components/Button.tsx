import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual variant. `danger` is for destructive confirmations only. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Transport-level loading only: disables the button, shows a spinner and
   * sets aria-busy. Loading NEVER implies success — the label stays so the
   * pending action remains legible, and the outcome is rendered by the
   * caller's state layer, never by this component.
   */
  loading?: boolean;
  /** Accessible label announced while loading (default "Loading"). */
  loadingLabel?: string;
  children?: ReactNode;
}

/**
 * PaySwap button primitive. Keyboard/focus: native button semantics; the
 * visible focus ring comes from the global `:focus-visible` rule in
 * tokens.css (2px solid ring, 2px offset — never removed).
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  loadingLabel = "Loading",
  disabled,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "ps-button",
        `ps-button--${variant}`,
        size === "sm" ? "ps-button--sm" : "ps-button--md",
        className,
      )}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className="ps-spinner" aria-hidden="true" />
      ) : null}
      {children}
      {loading ? <span className="ps-sr-only">{loadingLabel}</span> : null}
    </button>
  );
}
