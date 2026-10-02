"use client";

/**
 * The Command Center refresh control (P3-W2-002): re-runs the server render
 * (router.refresh) so the real API endpoints are fetched again — the honest
 * recovery path for a read-only server-fetched panel. Never a fabricated
 * client-side state.
 */

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button } from "@payswap/design";

export function CcRefreshButton({
  label = "Refresh from the API",
  children,
}: {
  readonly label?: string;
  readonly children?: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={busy}
      loadingLabel="Refreshing"
      onClick={() => {
        setBusy(true);
        router.refresh();
        // The refresh is fire-and-forget server re-render; release the
        // spinner on the next tick so the button never sticks busy.
        window.setTimeout(() => {
          setBusy(false);
        }, 1200);
      }}
    >
      {children ?? label}
    </Button>
  );
}
