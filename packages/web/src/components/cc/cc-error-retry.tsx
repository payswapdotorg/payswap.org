"use client";

/**
 * The honest retry (P3-W2-002): ErrorState whose retry re-runs the server
 * render — the only recovery path for a server-fetched panel. Client-side
 * only because the retry handler needs the router.
 */

import { useRouter } from "next/navigation";
import { ErrorState } from "@payswap/design";

export function CcErrorRetry({
  title,
  description,
  retryLabel = "Retry",
}: {
  readonly title: string;
  readonly description: string;
  readonly retryLabel?: string;
}) {
  const router = useRouter();
  return (
    <ErrorState
      title={title}
      description={description}
      retryLabel={retryLabel}
      onRetry={() => {
        router.refresh();
      }}
    />
  );
}
