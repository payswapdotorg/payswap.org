/**
 * The local-rail browser-authorization panel (P3-W3-002) — the providerless
 * local rail's FIRST-CLASS connection entry (the BROWSER_SESSION mode).
 *
 * The Stellar-testnet local rail has no provider API-credential model: a
 * "connection" is the user-authorized browser-session path. This panel states
 * exactly that before the flow begins, carries the recorded testnet evidence
 * (never upgraded to a live claim), and renders the two honest phases of the
 * browser-authorization boundary:
 *
 * - BROKER NOT BOUND (this deployment): the honest not-yet state — the
 *   browser authorization surface cannot be opened yet, so NOTHING is minted.
 * - BROKER BOUND (deployment wiring): the full flow renders — the customer
 *   authorizes in THEIR browser session, only the opaque BrowserSessionRef
 *   returns (folded exclusively via `attachBrowserSession` server-side), and
 *   the connection completes solely through an authority activation record.
 *
 * Credentials (Stellar keypairs included) never cross into PaySwap in either
 * phase — the recorded custody model is account-scoped keypairs held by the
 * operator outside this app.
 */

import Link from "next/link";

import { KeyValue, Panel, StatusPill } from "@payswap/design";

import type { AuthorizationSurfaceState } from "@/app/(auth)/_server/connection-plane";
import type { CatalogueProviderStatus } from "@/app/(auth)/_server/connection-catalogue";
import { AuthorizationSurfaceNotBoundState } from "./connection-flow";

export function LocalRailAuthorization({
  status,
  authorizationSurface,
  browserSessionRef,
}: {
  /** The catalogue status (LOCAL_RAIL kind, BROWSER_SESSION mode, evidence). */
  readonly status: CatalogueProviderStatus;
  readonly authorizationSurface: AuthorizationSurfaceState;
  /** The opaque broker reference on the journey, once a real broker attached. */
  readonly browserSessionRef?: string;
}) {
  return (
    <Panel
      title={`${status.displayName} — the browser-authorization path`}
      description="The providerless local rail has no provider credential model: the connection IS your browser authorization."
      headingLevel={3}
      actions={<StatusPill tone="ok">BROWSER_SESSION mode</StatusPill>}
    >
      <p className="text-sm leading-6 text-stone-700">
        There is no provider surface to hand credentials to and no vault slot
        to fill: you authorize the local-rail connection in{" "}
        <strong>your own browser session</strong>, and the only value that
        ever returns to PaySwap is an opaque browser-session reference. Your
        keys — the account-scoped keypairs the recorded custody model names —
        never cross into PaySwap, in either direction.
      </p>
      <div className="mt-4">
        <KeyValue
          entries={[
            { key: "Authorization mode", value: status.userConnectionMode, mono: true },
            { key: "Status", value: status.statusLine },
            ...status.evidenceLines.map((line, index) => ({
              key: `Evidence ${index + 1}`,
              value: line,
            })),
          ]}
        />
      </div>
      <ol className="mt-5 list-decimal space-y-2 pl-5 text-sm leading-6 text-stone-700">
        <li>
          Begin the connection review below — the catalogue still authorizes
          nothing (connection scope stays distinct from withdrawal scope).
        </li>
        <li>
          Initiate the connection against the authoritative PaySwap API; the
          journey parks in the authorization phase.
        </li>
        <li>
          Authorize in your browser session. The rail&rsquo;s broker returns
          only the opaque <span className="ps-mono text-xs">BrowserSessionRef</span>{" "}
          — folded server-side through the W3-001 contract, never minted by
          this app.
        </li>
        <li>
          The connected capability instance exists only when an authority
          activation record confirms your authorization — the same law as
          every provider.
        </li>
      </ol>
      {browserSessionRef !== undefined ? (
        <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4">
          <h4 className="text-sm font-semibold text-emerald-900">
            Browser authorization recorded (opaque reference)
          </h4>
          <p className="mt-1 text-sm leading-6 text-emerald-950">
            <span className="ps-mono text-xs">{browserSessionRef}</span> — an
            opaque session reference from the broker boundary, never
            credential material. The connection still completes only through
            an authority activation record.
          </p>
        </div>
      ) : null}
      <div className="mt-5">
        {authorizationSurface.brokerBound ? (
          <Panel title="Open the browser authorization" headingLevel={4}>
            <p className="text-sm leading-6 text-stone-700">
              A local-rail broker is bound in this deployment: the
              authorization surface opens in your browser session, and only
              the opaque reference returns. This branch renders when the
              broker boundary reports itself bound — the app itself never
              fabricates the reference.
            </p>
          </Panel>
        ) : (
          <AuthorizationSurfaceNotBoundState
            honestState={authorizationSurface.honestState}
          />
        )}
      </div>
      <p className="mt-5 text-sm leading-6 text-stone-600">
        The local rail is honest about its reach: the recorded testnet proof
        (GHS → USDC → KES) is evidence the rail works — it is not a live-funds
        claim, and no balance is ever rendered from it. See{" "}
        <Link
          href="/capabilities"
          className="font-semibold text-emerald-800 underline"
        >
          the public capabilities explorer
        </Link>{" "}
        for the recorded evidence with dates.
      </p>
    </Panel>
  );
}
