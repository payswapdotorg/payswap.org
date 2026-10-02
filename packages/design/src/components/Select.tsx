import { useContext, type SelectHTMLAttributes } from "react";
import { cx } from "../utils/cx.js";
import { FieldContext } from "./Field.js";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /**
   * Marks the control invalid explicitly; derived from a surrounding Field's
   * error when omitted. Same contract as Input's `invalid`.
   */
  invalid?: boolean;
}

/**
 * Native select primitive (the honest default: real combobox semantics, OS
 * keyboard behavior, no reimplementation). Wires into a surrounding Field
 * exactly like Input. Options are passed as native <option> children.
 */
export function Select({
  invalid,
  className,
  id,
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
  ].filter(Boolean) as string[];
  const isInvalid = invalid ?? field?.invalid ?? false;

  return (
    <select
      id={controlId}
      className={cx("ps-select", isInvalid && "ps-select--invalid", className)}
      aria-invalid={isInvalid || undefined}
      aria-describedby={describedByParts.length > 0 ? describedByParts.join(" ") : undefined}
      {...rest}
    >
      {children}
    </select>
  );
}
