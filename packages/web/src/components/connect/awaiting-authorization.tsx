/**
 * The awaiting-authorization view (P3-W1-002) — the browser-session broker
 * pattern rendered honestly.
 *
 * What this state means: the connection initiation was accepted by the
 * PaySwap API and the connection is now parked awaiting the customer's
 * authorization on the provider-hosted surface. The app NEVER sees
 * credentials — the only value that ever returns is the opaque
 * `BrowserSessionRef`. Where the real provider broker is not wired (this
 * deployment), the honest not-bound state says so.
 */

import { KeyValue, Panel, StatusPill } from "@payswap/design";

import type { SerializedConnectionJourney } from "@/app/(auth)/_server/connection-plane";
import { AuthorizationSurfaceNotBoundState } from "./connection-flow";

export function AwaitingAuthorizationView({
  journey,
  providerDisplayName,
}: {
  readonly journey: SerializedConnectionJourney;
  readonly providerDisplayName: string;
}) {
  return (
    <Panel
      title={`${providerDisplayName} — awaiting your authorization`}
      description="The connection is parked in the authorization phase. Nothing is connected yet."
      headingLevel={3}
      actions={<StatusPill tone="attention">Awaiting authorization</StatusPill>}
    >
      <p className="text-sm leading-6 text-stone-700">
        You authorize on the provider&rsquo;s own authorization surface —
        never here. PaySwap receives back only an opaque browser-session
        reference; your credentials never cross into PaySwap, in either
        direction.
      </p>
      <div className="mt-4">
        <KeyValue
          entries={[
            ...(journey.initiationIntentId !== undefined
              ? [{ key: "Initiation intent", value: journey.initiationIntentId, mono: true }]
              : []),
            ...(journey.approval !== undefined
              ? [
                  { key: "Approval request", value: journey.approval.requestHash, mono: true },
                  { key: "Approval expires at", value: journey.approval.expiresAt },
                ]
              : []),
            ...(journey.browserSessionRef !== undefined
              ? [
                  {
                    key: "Browser session reference",
                    value: journey.browserSessionRef,
                    mono: true,
                  },
                ]
              : []),
            {
              key: "What completes this",
              value:
                "Your authorization on the provider surface, confirmed by an authority activation record — the only path to a connected capability instance.",
            },
          ]}
        />
      </div>
      <div className="mt-5">
        <AuthorizationSurfaceNotBoundState honestState={journey.authorizationSurface.honestState} />
      </div>
    </Panel>
  );
}
