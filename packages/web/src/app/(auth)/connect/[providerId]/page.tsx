import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { KeyValue, Panel, StatusPill, UnknownState } from "@payswap/design";

import { AwaitingAuthorizationView } from "@/components/connect/awaiting-authorization";
import { ConnectionFlowActions } from "@/components/connect/connection-flow";
import { ConnectionScopeReview } from "@/components/connect/connection-scope";
import { catalogueStatusById } from "@/app/(auth)/_server/connection-catalogue";
import { getConnectionPlane, type ConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { currentWebSessionContext } from "@/lib/session/server";

export const metadata: Metadata = {
  title: "Connection review",
  description:
    "Review the connection scope (connection scope vs withdrawal scope — connection never implies withdrawal), initiate the connection, and authorize on the provider's own surface. Credentials never cross into PaySwap.",
};

export const dynamic = "force-dynamic";

/**
 * /connect/[providerId] — the connection initiation flow (P3-W1-002):
 * choose → review scope → initiate → awaiting-authorization, with the
 * honest not-wired/not-bound states where this deployment has no API
 * session or provider broker.
 */
export default async function ProviderConnectionPage({
  params,
}: {
  params: Promise<{ providerId: string }>;
}) {
  const { providerId } = await params;
  const status = catalogueStatusById(providerId);
  if (status === undefined) {
    notFound();
  }
  const context = await currentWebSessionContext();

  if (!context.configured) {
    return (
      <AuthGate
        heading={`Connect ${status.displayName}`}
        body="The identity plane is not configured in this deployment, so no authenticated connection flow can start here."
        missingEnvVars={context.missingEnvVars}
      />
    );
  }
  if (!context.session.valid) {
    return (
      <AuthGate
        heading={`Connect ${status.displayName}`}
        body="Sign in to start a connection journey. The provider's honest status is public; the connection flow is authenticated."
        signInHref={`/signin?next=%2Fconnect%2F${encodeURIComponent(providerId)}`}
      />
    );
  }

  const principalRef = context.session.view.principalRef;
  const plane = getConnectionPlane();
  const journey = plane.journeyFor(principalRef, providerId);

  return (
    <section
      aria-labelledby={`connect-${providerId}-heading`}
      className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14"
    >
      <h1 id={`connect-${providerId}-heading`} className="text-3xl font-bold tracking-tight text-stone-900">
        Connect {status.displayName}
      </h1>

      <div className="mt-8 flex flex-col gap-8">
        <Panel title="Honest provider status" description="From the recorded evidence — never upgraded." headingLevel={2}>
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone={status.statusKind === "BLOCKED" ? "blocked" : status.statusKind === "NOT_CONNECTED_NO_CREDENTIAL" ? "attention" : "ok"}>
              {status.statusLine}
            </StatusPill>
          </div>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-stone-600">
            {status.evidenceLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Panel>

        <ConnectionScopeReview
          providerDisplayName={status.displayName}
          isLocalRail={status.isLocalRail}
        />

        {journey === undefined ? (
          status.statusKind === "BLOCKED" ? (
            <Panel title="This provider is not connectable" headingLevel={3}>
              <p className="text-sm leading-6 text-stone-700">
                The BLOCKED status is the honest datum from the probe record —
                beginning a connection here would be pretending. When a fresh
                probe record changes the status, this page changes with it.
              </p>
            </Panel>
          ) : (
            <Panel
              title="Begin the connection"
              description="Folds the journey from browsing to initiating — the catalogue still authorizes nothing."
              headingLevel={3}
            >
              <ConnectionFlowActions providerId={providerId} csrfToken={context.csrfToken ?? ""} mode="select" />
            </Panel>
          )
        ) : (
          <JourneyStateView
            journey={journey}
            providerId={providerId}
            providerDisplayName={status.displayName}
            csrfToken={context.csrfToken ?? ""}
          />
        )}
      </div>
    </section>
  );
}

function JourneyStateView({
  journey,
  providerId,
  providerDisplayName,
  csrfToken,
}: {
  readonly journey: NonNullable<ReturnType<ConnectionPlane["journeyFor"]>>;
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly csrfToken: string;
}) {
  switch (journey.stateName) {
    case "idle":
    case "browsing":
      return (
        <Panel title="Choose this provider from the catalogue" headingLevel={3}>
          <ConnectionFlowActions providerId={providerId} csrfToken={csrfToken} mode="select" />
        </Panel>
      );
    case "initiating":
      return <InitiatingView journey={journey} providerId={providerId} csrfToken={csrfToken} />;
    case "awaiting-authorization":
      return <AwaitingAuthorizationView journey={journey} providerDisplayName={providerDisplayName} />;
    case "connected-capability-instance":
    case "expired":
    case "revoked":
      return (
        <Panel
          title={`Connection journey: ${journey.stateName}`}
          description="This state can only be produced by an authority activation record from the PaySwap API — the web app never mints one."
          headingLevel={3}
        >
          <KeyValue
            entries={[
              { key: "State", value: journey.stateName, mono: true },
              {
                key: "What this means here",
                value:
                  "In this deployment there is no path that issues authority activation records to web sessions yet — this state, if ever observed, must be backed by the authoritative API's record. The connected-instance views render scope, authorization mode, expiry and reauth state when a record exists.",
              },
            ]}
          />
        </Panel>
      );
  }
}

function InitiatingView({
  journey,
  providerId,
  csrfToken,
}: {
  readonly journey: NonNullable<ReturnType<ConnectionPlane["journeyFor"]>>;
  readonly providerId: string;
  readonly csrfToken: string;
}) {
  const attempt = journey.apiAttempt;
  if (attempt.kind === "not-attempted") {
    return (
      <Panel
        title="Initiate the connection"
        description="POSTs the connection-initiate command to the authoritative PaySwap API and folds the verbatim response."
        headingLevel={3}
      >
        <ConnectionFlowActions providerId={providerId} csrfToken={csrfToken} mode="initiate" />
      </Panel>
    );
  }
  if (attempt.kind === "unconfigured") {
    return (
      <UnknownState
        title="PaySwap API runtime not configured"
        description="The API runtime is not configured in this deployment (NEXT_PUBLIC_PAYSWAP_API_URL), so there is nothing to initiate against yet. Nothing was connected — this is the honest not-yet state."
      />
    );
  }
  if (attempt.kind === "network-error") {
    return (
      <UnknownState
        title="The PaySwap API could not be reached"
        description={`Network outcome, surfaced verbatim: ${attempt.message}. The initiation was NOT folded into a connection — the journey stays in initiating.`}
      />
    );
  }
  // answered
  if (attempt.outcome === "ERROR") {
    const notWired =
      attempt.statusCode === 401 ||
      attempt.statusCode === 403;
    return (
      <UnknownState
        title={
          notWired
            ? "API session not yet wired in this deployment"
            : `The PaySwap API answered HTTP ${attempt.statusCode}`
        }
        description={
          <>
            The initiation was attempted for real and the API&rsquo;s answer
            is recorded verbatim on the journey:{" "}
            <span className="ps-mono text-xs">
              {attempt.verbatimError?.code ?? "unknown"}
            </span>{" "}
            ({attempt.verbatimError?.category ?? "—"}):{" "}
            {attempt.verbatimError?.message ?? `HTTP ${attempt.statusCode}`}.
            {notWired ? (
              <>
                {" "}
                The deployed PaySwap API authenticates with its own session
                tokens and has no public issuance path yet — so a web-session
                principal cannot initiate. Nothing was connected.
              </>
            ) : null}
          </>
        }
      />
    );
  }
  if (attempt.outcome === "GRANTED" || attempt.outcome === "APPROVAL_REQUIRED") {
    // The fold moved the journey to awaiting-authorization; this branch is
    // defensive (the page renders the awaiting view from the journey state).
    return (
      <Panel title="Initiation answered" headingLevel={3}>
        <p className="text-sm leading-6 text-stone-700">
          The API answered {attempt.outcome}. See the authorization phase
          below.
        </p>
      </Panel>
    );
  }
  return null;
}

function AuthGate({
  heading,
  body,
  missingEnvVars,
  signInHref = "/signin",
}: {
  readonly heading: string;
  readonly body: string;
  readonly missingEnvVars?: readonly string[];
  readonly signInHref?: string;
}) {
  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-3xl font-bold tracking-tight text-stone-900">{heading}</h1>
      <div className="mt-8 max-w-2xl">
        <Panel title="Authentication required" headingLevel={2}>
          <p className="text-sm leading-6 text-stone-700">{body}</p>
          {missingEnvVars !== undefined && missingEnvVars.length > 0 ? (
            <ul className="mt-3 list-inside list-disc font-mono text-sm text-stone-700">
              {missingEnvVars.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-5">
            <Link
              href={signInHref}
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
            >
              Sign in
            </Link>
          </div>
        </Panel>
      </div>
    </section>
  );
}
