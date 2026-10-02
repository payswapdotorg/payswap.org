import { createContext, type HTMLAttributes, type ReactNode } from "react";
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
   * Error message. Rendering an error marks the control aria-invalid and
   * describes it — the message itself is the accessible error (never
   * color-alone). role=alert announces it when it appears (submit-time).
   */
  error?: ReactNode;
  /** Visual required marker on the label (controls accept native `required` directly). */
  required?: boolean;
  children?: ReactNode;
}

/**
 * Form field wrapper: label + control + hint + error, fully wired
 * (htmlFor/id, aria-describedby, aria-invalid). The control (Input/Select)
 * picks up the wiring from context, so consumers never juggle ids.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  className,
  children,
  ...rest
}: FieldProps) {
  const controlId = useId("ps-field", id);
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;

  return (
    <FieldContext.Provider
      value={{ controlId, hintId, errorId, invalid: Boolean(error) }}
    >
      <div
        className={cx("ps-field", error ? "ps-field--error" : null, className)}
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
        {error ? (
          <p id={errorId} className="ps-field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}
