/**
 * The connected-capability instance views (P3-W1-002) — connected, expired
 * and revoked, with scope, authorization mode, expiry and reauth state all
 * visible (the work order's acceptance line).
 *
 * HONEST DATA CONTRACT: these views render AUTHORITY records only. An
 * instance id enters the product exclusively through a
 * `ConnectedCapabilityInstanceRecord` issued by the authoritative PaySwap
 * API (the W3-001 law: `applyConnectionAuthorizationOutcome` is the only
 * fold that produces the connected state). This web app is NOT the
 * authority and never mints a record — in this deployment there are none,
 * and the surrounding pages say so honestly instead of rendering these
 * views with fabricated data.
 */

import Link from "next/link";
import { KeyValue, Panel, StatusPill } from "@payswap/design";

import type { ConnectedCapabilityInstanceRecord } from "@payswap/ux";

/** The authorization-mode vocabulary of user connections. */
export type ConnectionAuthorizationMode =
  | "DELEGATED_OAUTH"
  | "CONNECTED_ACCOUNT"
  | "SCOPED_CREDENTIAL"
  | "BROWSER_SESSION";

const MODE_COPY: Readonly<Record<ConnectionAuthorizationMode, string>> = {
  DELEGATED_OAUTH:
    "Delegated OAuth — you authorized on the provider's own surface; PaySwap holds scoped tokens only, never your password.",
  CONNECTED_ACCOUNT:
    "Connected account — your provider account is linked with limited, visible permissions.",
  SCOPED_CREDENTIAL:
    "Scoped credential — a narrowly-scoped key, vault-referenced, rotatable and revocable.",
  BROWSER_SESSION:
    "Browser session — the providerless local-rail path: authorization happened in YOUR browser session; PaySwap holds only an opaque session reference, never your keys.",
};

/** The full, visible authorization facts of one connection (authority-issued). */
export interface ConnectionAuthorizationFacts {
  /** The authority's instance record (W3-001 shape). */
  readonly record: ConnectedCapabilityInstanceRecord;
  /** What the connection's scope grants (authority-declared). */
  readonly scopeGranted: readonly string[];
  /** What it explicitly excludes — always including withdrawal authority. */
  readonly scopeExplicitlyExcludes: readonly string[];
  readonly authorizationMode: ConnectionAuthorizationMode;
  /** RFC 3339 expiry (absent = no scheduled expiry). */
  readonly expiresAt?: string;
  /** Whether reauthorization is required, and why. */
  readonly reauthState: "NOT_REQUIRED" | "EXPIRED" | "STEP_UP_REQUIRED";
}

const STATE_TONE = {
  ACTIVE: "ok",
  EXPIRED: "attention",
  REVOKED: "disabled",
} as const;

const STATE_LABEL = {
  ACTIVE: "Connected",
  EXPIRED: "Expired — reauthorization required",
  REVOKED: "Revoked",
} as const;

function formatRfc3339(iso: string): string {
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return time.length === 5 ? `${date} ${time} UTC` : date;
}

export function ConnectedInstanceView({
  facts,
  providerDisplayName,
}: {
  readonly facts: ConnectionAuthorizationFacts;
  readonly providerDisplayName: string;
}) {
  const { record } = facts;
  return (
    <Panel
      title={`${providerDisplayName} — connected capability instance`}
      description="An authority-issued record: scope, authorization mode, expiry and reauth state are all visible."
      headingLevel={3}
      actions={
        <StatusPill tone={STATE_TONE[record.state]}>
          {STATE_LABEL[record.state]}
        </StatusPill>
      }
    >
      <KeyValue
        entries={[
          { key: "Instance", value: record.instanceId, mono: true },
          { key: "Provider", value: providerDisplayName },
          { key: "Connected at", value: formatRfc3339(record.connectedAt) },
          {
            key: "Authorization mode",
            value: MODE_COPY[facts.authorizationMode],
          },
          {
            key: "Expires at",
            value: facts.expiresAt !== undefined ? formatRfc3339(facts.expiresAt) : "No scheduled expiry",
          },
          {
            key: "Reauthorization",
            value:
              facts.reauthState === "NOT_REQUIRED"
                ? "Not required — the authorization is current."
                : facts.reauthState === "EXPIRED"
                  ? "Required — the authorization expired; the reauthorization journey resumes execution with lineage intact."
                  : "Required — a step-up was requested for a sensitive action; complete it on the trusted surface.",
          },
        ]}
      />
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4">
          <h4 className="text-sm font-semibold text-emerald-900">This connection&rsquo;s scope grants</h4>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6 text-emerald-950">
            {facts.scopeGranted.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-stone-300 bg-stone-100 p-4">
          <h4 className="text-sm font-semibold text-stone-900">
            This connection explicitly excludes
          </h4>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6 text-stone-800">
            {facts.scopeExplicitlyExcludes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
      {facts.reauthState !== "NOT_REQUIRED" ? (
        <div className="mt-5">
          <Link
            href="/reauth"
            className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
          >
            Start the reauthorization journey
          </Link>
        </div>
      ) : null}
    </Panel>
  );
}

/** The honest empty state while no authority record exists for the user. */
export function NoConnectedCapabilitiesState() {
  return (
    <Panel
      title="No connected capability instances"
      description="This is the honest state — not a failure, and not a hidden connection."
      headingLevel={3}
    >
      <p className="text-sm leading-6 text-stone-700">
        A connected capability instance can only ever come from the
        authoritative PaySwap API: the connection journey parks in
        awaiting-authorization and only an authority activation record
        produces the connected state. In this deployment the API session
        path and provider brokers are not yet wired, so there is honestly
        nothing here — catalogue availability was never a connection.
      </p>
    </Panel>
  );
}
