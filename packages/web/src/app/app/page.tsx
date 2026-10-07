import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { getServerCcState } from "@/lib/cc/server-state";
import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import {
  HomeDevelopCard,
  HomeOverviewMetrics,
  HomeRecommendations,
  HomeTodayCard,
  type HomeRailBalance,
} from "@/components/shell/home-blocks";

export const metadata: Metadata = {
  title: "Home",
};

/**
 * The Command Center Home (UX-003, contract 09 §2): Today card first — even
 * at zero, the zero-state teaches the fill path — then Recommendations,
 * then the Develop card, then Your overview. Every value is honest: rails
 * derive from the connection plane's real records (an unauthenticated or
 * preview render claims none), balances are external observations, the
 * Develop card states the unconfigured truth until the API-keys plane
 * ships, and the overview metrics render their scaffold empties until
 * authority records feed them. No number on this page is invented.
 */
export default async function HomePage() {
  const state = await getServerCcState();
  const authenticated = state.session.status === "authenticated";

  // Rails: only an authenticated session has connection-plane records — a
  // preview role derives none (preview is never an authentication).
  const instances = authenticated
    ? getConnectionPlane().connectedInstancesFor(state.session.principal.principal)
    : [];
  const activeInstances = instances.filter((record) => record.state === "ACTIVE");

  // Balances are OBSERVATIONS: this deployment records none, so each
  // connected rail renders its unobserved truth ("—"), never a fabricated
  // amount.
  const rails: readonly HomeRailBalance[] = activeInstances.map((record) => ({
    rail: record.providerId,
    incoming: null,
    available: null,
    settlement: null,
  }));

  // Recommendations derive from real state: the first rail is the fill path
  // until one is active; Checkout is a live surface either way.
  const recommendations =
    activeInstances.length === 0
      ? [
          {
            id: "connect-first-rail",
            proposition:
              "Connect your first rail to accept and pay through the providers you already use — no code needed.",
            ctaLabel: "Connect a rail",
            ctaHref: "/connect",
          },
          {
            id: "setup-checkout",
            proposition:
              "Set up Checkout — embed a payment component and start accepting on your site.",
            ctaLabel: "Get started",
            ctaHref: "/app/checkout",
          },
        ]
      : [
          {
            id: "setup-checkout",
            proposition:
              "Set up Checkout — embed a payment component and start accepting on your site.",
            ctaLabel: "Get started",
            ctaHref: "/app/checkout",
          },
        ];

  return (
    <CcSection navItemId="overview">
      <section aria-label="Home" className="cc-stack" data-testid="home-page">
        <HomeTodayCard data={{ rails, nextSettlement: null }} />
        <HomeRecommendations recommendations={recommendations} />
        {/* Honest unconfigured state: no API-keys plane exists in this
            deployment, so the Develop card renders no key material at all
            (never a fake publishable/secret pair). */}
        <HomeDevelopCard keys={null} />
        <HomeOverviewMetrics />
      </section>
    </CcSection>
  );
}
