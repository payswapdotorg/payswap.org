"use client";

import { useContext, type InputHTMLAttributes } from "react";
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
}

/**
 * Text input primitive. Wires itself into a surrounding Field (id,
 * aria-describedby, aria-invalid) so label/hint/error associations are
 * automatic. Aria wiring is additive: consumer-passed aria-describedby is
 * preserved alongside the field's hint/error ids.
 */
export function Input({
  invalid,
  className,
  id,
  type = "text",
  "aria-describedby": consumerDescribedBy,
  ...rest
}: InputProps) {
  const field = useContext(FieldContext);
  const controlId = id ?? field?.controlId;
  const describedByParts = [
    typeof consumerDescribedBy === "string" ? consumerDescribedBy : null,
    field?.hintId,
    field?.errorId,
  ].filter(Boolean) as string[];
  const isInvalid = invalid ?? field?.invalid ?? false;

  return (
    <input
      id={controlId}
      type={type}
      className={cx("ps-input", isInvalid && "ps-input--invalid", className)}
      aria-invalid={isInvalid || undefined}
      aria-describedby={describedByParts.length > 0 ? describedByParts.join(" ") : undefined}
      {...rest}
    />
  );
}
