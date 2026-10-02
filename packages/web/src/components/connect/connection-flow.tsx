"use client";

/**
 * The connection-flow actions (P3-W1-002) — the client half of the connect
 * journey. Every button is REAL: it calls the session+CSRF-gated API route
 * which performs the W3-001 contract folds server-side, then refreshes the
 * server-rendered state. The client NEVER holds journey state it made up.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button, UnknownState } from "@payswap/design";

import { sessionFetchJson } from "@/lib/api-client";

type FlowAction = "select" | "initiate";

export function ConnectionFlowActions({
  providerId,
  csrfToken,
  mode,
}: {
  readonly providerId: string;
  readonly csrfToken: string;
  /** Which contract action this control performs. */
  readonly mode: FlowAction;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const path =
        mode === "select"
          ? "/api/connect/select"
          : `/api/connect/${encodeURIComponent(providerId)}/initiate`;
      const result = await sessionFetchJson<{ status?: string; message?: string }>(path, {
        method: "POST",
        body: mode === "select" ? { providerId } : {},
        csrfToken,
      });
      if (result.status === "ok" || (result.status === "http-error" && result.statusCode === 404 && mode === "initiate" && result.body?.status === "not-found")) {
        // 404 on initiate means no journey is in initiating — refresh shows
        // the honest state (e.g. the choice was never made).
        router.refresh();
        return;
      }
      if (result.status === "http-error") {
        setError(
          result.message ?? `The request failed (HTTP ${result.statusCode}) — nothing was connected.`,
        );
        return;
      }
      setError(`Could not reach the connection service: ${result.message}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <Button
        variant="primary"
        loading={pending}
        loadingLabel={mode === "select" ? "Opening the connection review" : "Initiating"}
        onClick={run}
      >
        {mode === "select" ? "Begin the connection review" : "Initiate the connection"}
      </Button>
      <div aria-live="polite">
        {error !== null ? (
          <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm leading-6 text-red-900">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The honest authorization-surface state (browser-session broker boundary). */
export function AuthorizationSurfaceNotBoundState({
  honestState,
}: {
  readonly honestState: string;
}) {
  return (
    <UnknownState
      title="Authorization surface not yet bound to this deployment"
      description={
        <>
          {honestState}
          <br />
          <br />
          The browser-session broker pattern is unchanged: when a broker is
          bound, you will authorize on the provider&rsquo;s own surface and
          only an opaque browser-session reference returns to PaySwap —
          credentials never cross, in either direction.
        </>
      }
    />
  );
}
