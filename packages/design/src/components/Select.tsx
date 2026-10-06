"use client";

import {
  useContext,
  type Ref,
  type SelectHTMLAttributes,
} from "react";
import { cx } from "../utils/cx.js";
import { FieldContext } from "./Field.js";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /**
   * Marks the control invalid explicitly; derived from a surrounding Field's
   * error when omitted. Same contract as Input's `invalid`.
   */
  invalid?: boolean;
  /** Ref to the underlying select element (React 19 ref-as-prop). */
  ref?: Ref<HTMLSelectElement>;
}

/**
 * Native select primitive (the honest default: real combobox semantics, OS
 * keyboard behavior, no reimplementation). Wires into a surrounding Field
 * exactly like Input — including the dependent-disable reason wiring.
 * Options are passed as native <option> children.
 */
export function Select({
  invalid,
  className,
  id,
  disabled,
  ref,
  children,
  "aria-describedby": consumerDescribedBy,
  ...rest
}: SelectProps) {
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
    <select
      id={controlId}
      ref={ref}
      className={cx("ps-select", isInvalid && "ps-select--invalid", className)}
      aria-invalid={isInvalid || undefined}
      aria-describedby={describedByParts.length > 0 ? describedByParts.join(" ") : undefined}
      disabled={isDisabled}
      {...rest}
    >
      {children}
    </select>
  );
}
