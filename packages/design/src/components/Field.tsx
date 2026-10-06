"use client";

import {
  createContext,
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cx } from "../utils/cx.js";
import { useId } from "../hooks/useId.js";

/**
 * Wiring context shared by Field and its form controls (Input/Select). Field
 * owns the control's id so the label association, hint and error wiring work
 * without consumer-supplied ids; controls consume it when nested.
 */
export interface FieldContextValue {
  /** Id the nested control must take (label htmlFor target). */
  controlId: string;
  /** Id of the rendered hint, if any. */
  hintId?: string | undefined;
  /** Id of the rendered error message, if any. */
  errorId?: string | undefined;
  /** True while an error message is rendered (drives aria-invalid). */
  invalid: boolean;
  /** True while the field is dependent-disabled (a reason string is rendered). */
  disabled?: boolean;
  /** Id of the rendered dependent-disable reason, if any. */
  reasonId?: string | undefined;
}

export const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps extends HTMLAttributes<HTMLDivElement> {
  /** Programmatic id for the CONTROL (label htmlFor target); generated if omitted. */
  id?: string;
  /** Visible label text (always rendered — placeholder is never the only label). */
  label: ReactNode;
  /** Helper text wired via aria-describedby. */
  hint?: ReactNode;
  /**
   * Error message, rendered BELOW the field (contract 03 §2.12) — never
   * inline beside it. Rendering an error marks the control aria-invalid and
   * describes it — the message itself is the accessible error (never
   * color-alone). role=alert announces it when it appears (submit-time).
   */
  error?: ReactNode;
  /**
   * Clear-on-valid API (contract 03 §2.12 / 07 §3.3): invoked when the
   * control's value changes while an error is displayed — wire it to clear
   * (or re-run) validation so a stale error NEVER persists after the user
   * has edited the field. Fires once per error instance; re-arms when the
   * `error` prop changes.
   */
  onErrorClear?: () => void;
  /**
   * Dependent-disable WITH reason (contract 03 §2.12): the nested control
   * renders disabled and this human reason ("Select a customer above to
   * save a card") is shown below the field and wired into the control's
   * aria-describedby.
   */
  disabledReason?: string;
  /** Visual required marker on the label (controls accept native `required` directly). */
  required?: boolean;
  children?: ReactNode;
}

/**
 * Form field wrapper: label + control + hint + dependent-disable reason +
 * error, fully wired (htmlFor/id, aria-describedby, aria-invalid). The
 * control (Input/Select/MoneyInput) picks up the wiring from context, so
 * consumers never juggle ids. Errors always render BELOW the field and are
 * expected to be cleared on valid input via `onErrorClear` — the recorded
 * anti-pattern is a stale error persisting after re-validation.
 */
export function Field({
  id,
  label,
  hint,
  error,
  onErrorClear,
  disabledReason,
  required = false,
  className,
  children,
  onChange,
  onInput,
  ...rest
}: FieldProps) {
  const controlId = useId("ps-field", id);
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const reasonId = disabledReason ? `${controlId}-reason` : undefined;

  // Clear-on-valid: arm once per error instance so the first edit after an
  // error fires onErrorClear exactly once (React emits both `input` and
  // `change` for one keystroke on text controls).
  const clearArmedRef = useRef(false);
  useEffect(() => {
    clearArmedRef.current = true;
  }, [error]);

  const maybeClearError = (): void => {
    if (error && !disabledReason && clearArmedRef.current) {
      clearArmedRef.current = false;
      onErrorClear?.();
    }
  };

  return (
    <FieldContext.Provider
      value={{
        controlId,
        hintId,
        errorId,
        invalid: Boolean(error),
        disabled: Boolean(disabledReason),
        reasonId,
      }}
    >
      <div
        className={cx(
          "ps-field",
          error ? "ps-field--error" : null,
          disabledReason ? "ps-field--disabled" : null,
          className,
        )}
        onChange={(event) => {
          onChange?.(event);
          maybeClearError();
        }}
        onInput={(event) => {
          onInput?.(event);
          maybeClearError();
        }}
        {...rest}
      >
        <label className="ps-field__label" htmlFor={controlId}>
          {label}
          {required ? (
            <span className="ps-field__required" aria-hidden="true">
              *
            </span>
          ) : null}
          {required ? <span className="ps-sr-only">(required)</span> : null}
        </label>
        {children}
        {hint ? (
          <p id={hintId} className="ps-field__hint">
            {hint}
          </p>
        ) : null}
        {disabledReason ? (
          <p id={reasonId} className="ps-field__reason">
            {disabledReason}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} className="ps-field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}
