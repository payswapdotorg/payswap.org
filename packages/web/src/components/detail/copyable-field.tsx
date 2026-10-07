"use client";

/**
 * UX-004 — the copy affordance for object identifiers (contract 05 §2.4/§4).
 *
 * Copy-on-click with a toast confirmation. ONLY identifiers travel through
 * this component: secrets never enter a copy affordance (the data source
 * masks them upstream; a masked display value can be passed via `display`
 * while `value` carries the public identifier). The toast is a confirmation
 * (contract 03 §3: toasts are for confirmations, never errors) — a failed
 * copy renders an honest inline status instead of a fake "Copied".
 */

import { useState } from "react";
import { Button, Toast } from "@payswap/design";

export interface CopyableFieldProps {
  /** Row label (rendered by the surrounding KeyValue, this is the a11y name). */
  readonly label: string;
  /** The value copied to the clipboard (a public identifier, never a secret). */
  readonly value: string;
  /** Visible text (defaults to the value; may be shorter/masked display). */
  readonly display?: string;
  /** Test hook. */
  readonly testId?: string;
}

export function CopyableField({ label, value, display, testId }: CopyableFieldProps) {
  const [state, setState] = useState<"idle" | "copied" | "unavailable">("idle");

  async function copy(): Promise<void> {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      setState("unavailable");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("unavailable");
    }
  }

  return (
    <span className="cc-copyable" data-testid={testId}>
      <span className="ps-mono">{display ?? value}</span>
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void copy();
        }}
      >
        Copy
      </Button>
      {state === "copied" ? (
        <Toast tone="success" onDismiss={() => setState("idle")}>
          {label} copied
        </Toast>
      ) : null}
      {state === "unavailable" ? (
        <span role="status" className="cc-actions__reason">
          Clipboard is unavailable in this browser — the value is selected above.
        </span>
      ) : null}
    </span>
  );
}
