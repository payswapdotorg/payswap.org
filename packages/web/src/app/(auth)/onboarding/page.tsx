import type { Metadata } from "next";
import Link from "next/link";

import { Panel, StatusPill } from "@payswap/design";

import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { currentWebSessionContext } from "@/lib/session/server";
import { coverage } from "@/lib/coverage";

export const metadata: Metadata = {
  title: "Onboarding",
  description:
    "Your real position: identity, provider connections, capability review — derived from your live session and the honest state of connections. No fake progress.",
};

export const dynamic = "force-dynamic";

interface OnboardingStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly state: "DONE" | "IN_PROGRESS" | "PENDING" | "NOT_POSSIBLE_YET";
  readonly detail: readonly string[];
  readonly cta?: { readonly href: string; readonly label: string };
}

/**
 * /onboarding — the real multi-step flow (P3-W1-002): identity → provider
 * connection intro → capability review → done. Every step's state is
 * derived from REAL state (session + connection journeys + evidence);
 * nothing is pre-marked done and no progress is invented.
 */
export default async function OnboardingPage() {
  const context = await currentWebSessionContext();

  const signedIn = context.configured && context.session.valid;
  const journeys = signedIn
    ? getConnectionPlane().journeysFor(context.session.view.principalRef)
    : [];
  const hasJourney = journeys.length > 0;
  const hasConnected = journeys.some(
    (journey) => journey.stateName === "connected-capability-instance",
  );

  const steps: readonly OnboardingStep[] = [
    {
      id: "identity",
      title: "1. Identity",
      description: "Who you are to this app — a real, server-issued session.",
      state: signedIn ? "DONE" : context.configured ? "PENDING" : "NOT_POSSIBLE_YET",
      detail: signedIn
        ? [
            `Signed in as ${context.session.view.displayName} (${context.session.view.email}).`,
            "This identity is not financial authority — balances, intents and authority live exclusively in the PaySwap API.",
          ]
        : context.configured
          ? ["No session is active. Sign in to begin onboarding for real."]
          : [
              `The identity plane is not configured in this deployment (${context.configured ? "" : context.missingEnvVars.join(", ")} — env var names only). Onboarding cannot start here.`,
            ],
      cta: signedIn
        ? undefined
        : context.configured
          ? { href: "/signin?next=%2Fonboarding", label: "Sign in" }
          : undefined,
    },
    {
      id: "connection",
      title: "2. Provider connection",
      description:
        "Connect a payment provider through the explicit authorization flow — connection scope never includes withdrawal authority.",
      state: hasConnected
        ? "DONE"
        : hasJourney
          ? "IN_PROGRESS"
          : signedIn
            ? "PENDING"
            : "NOT_POSSIBLE_YET",
      detail: hasJourney
        ? journeys.map(
            (journey) =>
              `${journey.providerId}: ${journey.stateName}${
                journey.apiAttempt.kind === "answered" && journey.apiAttempt.outcome === "ERROR"
                  ? ` (API answered ${journey.apiAttempt.statusCode})`
                  : ""
              }`,
          )
        : [
            "No connection journeys yet. Browse the catalogue — every provider's honest status is shown, and availability is never connected capability.",
            "In this deployment the PaySwap API session path and provider brokers are not yet wired: journeys park honestly at the not-wired/not-bound states instead of pretending to connect.",
          ],
      cta: signedIn ? { href: "/connect", label: "Browse the provider catalogue" } : undefined,
    },
    {
      id: "capabilities",
      title: "3. Capability review",
      description:
        "What your connections actually support — read from real connection state, never from catalogue availability.",
      state: hasConnected ? "DONE" : signedIn ? (hasJourney ? "IN_PROGRESS" : "PENDING") : "NOT_POSSIBLE_YET",
      detail: hasConnected
        ? [
            "Your connected capability instances define what you can do — scope, authorization mode, expiry and reauth state are visible on each connection.",
          ]
        : [
            "You have no connected capability instances, so you have no connection-derived capabilities yet — that is the honest state, not an error.",
            `The platform-level provider evidence (probe ${coverage.probedAt.slice(0, 10)}, release ${coverage.releaseId}) is public on the capabilities page.`,
          ],
      cta: { href: "/capabilities", label: "See the public provider evidence" },
    },
    {
      id: "done",
      title: "4. Done",
      description: "Onboarding completes when a real connected capability exists.",
      state: hasConnected ? "DONE" : "NOT_POSSIBLE_YET",
      detail: hasConnected
        ? ["A connected capability instance exists — onboarding is complete for real."]
        : [
            "Honestly not complete: no connected capability instance exists (it can only come from the authoritative PaySwap API). Onboarding does not mark itself done without one.",
          ],
    },
  ];

  return (
    <section aria-labelledby="onboarding-heading" className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 id="onboarding-heading" className="text-3xl font-bold tracking-tight text-stone-900">
        Onboarding
      </h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-stone-600">
        Your position, derived from your live session and the honest state of
        connections. No step is marked done that is not done.
      </p>
      <ol className="mt-8 list-none space-y-5 p-0">
        {steps.map((step) => (
          <li key={step.id}>
            <Panel title={step.title} description={step.description} headingLevel={2}>
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill tone={stepStateTone(step.state)}>{stepStateLabel(step.state)}</StatusPill>
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-stone-700">
                {step.detail.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {step.cta !== undefined ? (
                <div className="mt-4">
                  <Link
                    href={step.cta.href}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
                  >
                    {step.cta.label}
                  </Link>
                </div>
              ) : null}
            </Panel>
          </li>
        ))}
      </ol>
    </section>
  );
}

function stepStateTone(state: OnboardingStep["state"]): "ok" | "attention" | "disabled" | "unknown" {
  switch (state) {
    case "DONE":
      return "ok";
    case "IN_PROGRESS":
      return "unknown";
    case "PENDING":
      return "attention";
    case "NOT_POSSIBLE_YET":
      return "disabled";
  }
}

function stepStateLabel(state: OnboardingStep["state"]): string {
  switch (state) {
    case "DONE":
      return "Done — for real";
    case "IN_PROGRESS":
      return "In progress";
    case "PENDING":
      return "Not started";
    case "NOT_POSSIBLE_YET":
      return "Not possible yet (honest state)";
  }
}
