"use client";

import {
  useContext,
  type InputHTMLAttributes,
  type Ref,
} from "react";
import { cx } from "../utils/cx.js";
import { FieldContext } from "./Field.js";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /**
   * Marks the control invalid explicitly. When nested in a Field with an
   * error, invalidity is derived from the field (context wins only when this
   * prop is omitted). Invalid controls render the danger border and
   * aria-invalid — the error text itself always comes from the Field.
   */
  invalid?: boolean;
  /** Ref to the underlying input element (React 19 ref-as-prop). */
  ref?: Ref<HTMLInputElement>;
}

/**
 * Text input primitive. Wires itself into a surrounding Field (id,
 * aria-describedby, aria-invalid) so label/hint/error associations are
 * automatic. Aria wiring is additive: consumer-passed aria-describedby is
 * preserved alongside the field's hint/error ids. A Field carrying a
 * `disabledReason` disables the control from context (explicit `disabled`
 * on the Input always wins).
 */
export function Input({
  invalid,
  className,
  id,
  type = "text",
  disabled,
  ref,
  "aria-describedby": consumerDescribedBy,
  ...rest
}: InputProps) {
  const field = useContext(FieldContext);
  const controlId = id ?? field?.controlId;
  const describedByParts = [
    typeof consumerDescribedBy === "string" ? consumerDescribedBy : null,
    field?.hintId,
    field?.errorId,
    field?.reasonId,
  ].filter(Boolean) as string[];
  const isInvalid = invalid ?? field?.invalid ?? false;
  const isDisabled = disabled ?? field?.disabled ?? undefined;

  return (
    <input
      id={controlId}
      type={type}
      ref={ref}
      className={cx("ps-input", isInvalid && "ps-input--invalid", className)}
      aria-invalid={isInvalid || undefined}
      aria-describedby={describedByParts.length > 0 ? describedByParts.join(" ") : undefined}
      disabled={isDisabled}
      {...rest}
    />
  );
}
