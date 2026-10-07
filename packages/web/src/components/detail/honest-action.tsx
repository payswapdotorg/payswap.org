"use client";

/**
 * UX-004 — the honest not-yet action: a real button whose effect is not yet
 * wired through the authoritative API. Clicking states the truth inline
 * (never a toast-only outcome, never a fabricated success, never a dead
 * button): what is unavailable, why, and the best next hop.
 */

import { useState } from "react";
import { Button } from "@payswap/design";

export interface HonestNotYetActionProps {
  readonly label: string;
  /** The honest explanation rendered after the click. */
  readonly message: string;
  readonly variant?: "primary" | "secondary";
  readonly size?: "sm" | "md";
}

export function HonestNotYetAction({
  label,
  message,
  variant = "secondary",
  size = "sm",
}: HonestNotYetActionProps) {
  const [open, setOpen] = useState(false);
  return (
    <span className="cc-stack">
      <Button
        size={size}
        variant={variant}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {open ? (
        <p role="status" className="cc-actions__reason">
          {message}
        </p>
      ) : null}
    </span>
  );
}
