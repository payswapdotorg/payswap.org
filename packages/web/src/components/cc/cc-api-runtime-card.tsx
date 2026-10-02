/**
 * The honest API-runtime card (P3-W2-002).
 *
 * Renders ONE server-fetched read-only API outcome — health or capabilities
 * — with the truth and nothing but it: a live response renders its payload
 * verbatim; an unconfigured/network/http outcome renders its honest
 * explanation (the API's own error envelope shown verbatim, including its
 * real session requirement), with the refresh action as the only recovery
 * path. Never a fabricated success, never a silent fallback.
 */

import type { ReactNode } from "react";
import { KeyValue, Panel, StatusPill } from "@payswap/design";

import type { CcApiResult } from "@/lib/cc/api-server";
import { describeCcApiOutcome } from "@/lib/cc/api-server";
import { CcErrorRetry } from "./cc-error-retry";
import { CcRefreshButton } from "./cc-refresh-button";

export function CcApiRuntimeCard<T>({
  title,
  description,
  result,
  okTone = "ok",
  renderData,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly result: CcApiResult<T>;
  readonly okTone?: "ok" | "unknown";
  readonly renderData: (data: T) => ReactNode;
}) {
  const narrative = describeCcApiOutcome(result);
  return (
    <Panel
      title={title}
      description={description}
      actions={<CcRefreshButton />}
    >
      {result.status === "ok" ? (
        <div className="cc-stack">
          <p>
            <StatusPill tone={okTone}>{narrative.headline}</StatusPill>
          </p>
          {renderData(result.data)}
        </div>
      ) : result.status === "unconfigured" || result.status === "network-error" ? (
        <CcErrorRetry title={narrative.headline} description={narrative.detail} />
      ) : (
        <div className="cc-stack">
          <p>
            <StatusPill tone="attention">{narrative.headline}</StatusPill>
          </p>
          <p className="cc-section-intro">{narrative.detail}</p>
          <p className="cc-section-intro">
            This is the authoritative API&apos;s real, verbatim answer — the
            deployed runtime authenticates every endpoint (health included),
            and the web session plane is not yet wired in this deployment.
            The response is rendered as received; nothing is inferred from
            it and no state is fabricated in its place.
          </p>
          {result.error !== undefined ? (
            <KeyValue
              entries={[
                { key: "Category", value: result.error.category },
                { key: "Code", value: result.error.code, mono: true },
                { key: "Message", value: result.error.message },
              ]}
            />
          ) : null}
        </div>
      )}
    </Panel>
  );
}
