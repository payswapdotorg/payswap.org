import type { Metadata } from "next";
import { cookies } from "next/headers";
import { EnvironmentBanner } from "@payswap/design";

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
import { currentWebSessionContext } from "@/lib/session/server";
import {
  CC_PROJECTION_COOKIE,
  effectiveSidebarProjection,
  parseProjectionPreference,
} from "@/lib/cc/session-seam";
import {
  listPaymentsFor,
  paymentById,
  paymentsPlaneInput,
  paymentsWorldLabel,
} from "@/app/app/payments/_server/payments-plane";
import { PaymentsReadState } from "@/app/app/payments/_view/read-states";
import { PaymentNotFound } from "@/components/detail/payment-not-found";

import { ConsumerHome } from "@/components/consumer/consumer-home";
import { ConsumerPaymentDetail } from "@/components/consumer/consumer-payment-detail";
import { ConsumerTabBar } from "@/components/consumer/consumer-tabbar";
import { MyContacts } from "@/components/consumer/my-contacts";
import { MyRequests } from "@/components/consumer/my-requests";
import { ProjectionSwitch } from "@/components/consumer/projection-switch";

export const metadata: Metadata = {
  title: "Home",
};

/** The consumer-projection collection views mounted on this route. */
type ConsumerView = "home" | "contacts" | "requests";

/**
 * The Command Center Home — now with the UX-006 PROJECTION BRANCH (contract
 * 10): the SAME account, two projections.
 *
 * - MERCHANT (the default, unchanged composition — contract 09 §2): Today
 *   card first, Recommendations, Develop, Your overview. Every value is
 *   honest: rails derive from the connection plane's real records, balances
 *   are external observations, and no number on this page is invented.
 * - CONSUMER (the `ps-cc-projection` cookie, or a consumer-default role —
 *   contract 10 §3): Balance header → Today mirror → My payments → Safety
 *   card → Recommendations, with the consumer's collections (?view=) and the
 *   payment detail in the consumer projection (?payment=).
 *
 * The projection is a view derivation ONLY (the same law as the role
 * preference): it never authenticates, never grants authority and never
 * unlocks session-scoped data — preview mode keeps its honest marking.
 */
export default async function HomePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const view: ConsumerView =
    params.view === "contacts" ? "contacts" : params.view === "requests" ? "requests" : "home";
  const paymentId =
    typeof params.payment === "string" && params.payment !== "" ? params.payment : null;
  return (
    <CcSection navItemId="overview">
      <HomeSection view={view} paymentId={paymentId} />
    </CcSection>
  );
}

async function HomeSection({
  view,
  paymentId,
}: {
  readonly view: ConsumerView;
  readonly paymentId: string | null;
}) {
  const state = await getServerCcState();
  const store = await cookies();
  const projectionPreference = parseProjectionPreference(store.get(CC_PROJECTION_COOKIE)?.value);
  const projection = effectiveSidebarProjection(state.navRole, projectionPreference);

  if (projection === "consumer") {
    return <ConsumerSurfaces state={state} view={view} paymentId={paymentId} />;
  }
  return <MerchantComposition state={state} />;
}

// ---------------------------------------------------------------------------
// The merchant composition (UX-003, contract 09 §2 — INTACT)
// ---------------------------------------------------------------------------

async function MerchantComposition({ state }: { readonly state: Awaited<ReturnType<typeof getServerCcState>> }) {
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
    <section aria-label="Home" className="cc-stack" data-testid="home-page">
      {/* The projection control (contract 10 §6 — same account, two
          projections): mounted at page level so the round-trip works from
          either side. The composition below it is the merchant home,
          unchanged. */}
      <ProjectionSwitch projection="merchant" />
      <HomeTodayCard data={{ rails, nextSettlement: null }} />
      <HomeRecommendations recommendations={recommendations} />
      {/* Honest unconfigured state: no API-keys plane exists in this
          deployment, so the Develop card renders no key material at all
          (never a fake publishable/secret pair). */}
      <HomeDevelopCard keys={null} />
      <HomeOverviewMetrics />
    </section>
  );
}

// ---------------------------------------------------------------------------
// The consumer surfaces (UX-006, contract 10 — the projection branch)
// ---------------------------------------------------------------------------

async function ConsumerSurfaces({
  state,
  view,
  paymentId,
}: {
  readonly state: Awaited<ReturnType<typeof getServerCcState>>;
  readonly view: ConsumerView;
  readonly paymentId: string | null;
}) {
  const context = await currentWebSessionContext();
  const sessioned = context.configured && context.session.valid;
  const principalRef = sessioned ? context.session.view.principalRef : null;

  // Rails: only an authenticated session has connection-plane records — a
  // preview projection derives none (the projection is never an
  // authentication; the honest preview marking stays on).
  const instances =
    sessioned && state.session.status === "authenticated"
      ? getConnectionPlane().connectedInstancesFor(state.session.principal.principal)
      : [];
  const rails: readonly HomeRailBalance[] = instances
    .filter((record) => record.state === "ACTIVE")
    .map((record) => ({
      rail: record.providerId,
      incoming: null,
      available: null,
      settlement: null,
    }));

  // The payment detail in the consumer projection (?payment=<id>): the SAME
  // honest payments plane the merchant detail reads through.
  if (paymentId !== null) {
    const input = paymentsPlaneInput(principalRef);
    const result = await paymentById(input, paymentId);
    if (result.status === "ok") {
      return (
        <section aria-label="Payment" className="cc-stack" data-testid="consumer-payment-page">
          <ConsumerTabBar active="activity" />
          {result.data.environment === "test" ? (
            <p className="cc-actions__reason" data-testid="consumer-payment-test-marking">
              <EnvironmentBanner environment="test" variant="badge" badgeLabel="Test mode" />{" "}
              Test record — nothing here touches real money.
            </p>
          ) : null}
          <ConsumerPaymentDetail
            payment={result.data}
            worldLabel={paymentsWorldLabel(input)}
          />
        </section>
      );
    }
    if (result.status === "not-found") {
      return (
        <section aria-label="Payment" className="cc-stack">
          <ConsumerTabBar active="activity" />
          <PaymentNotFound paymentId={paymentId} worldLabel={paymentsWorldLabel(input)} />
        </section>
      );
    }
    return (
      <section aria-label="Payment" className="cc-stack">
        <ConsumerTabBar active="activity" />
        <PaymentsReadState
          result={result}
          nextHop={{ href: "/app", label: "Back to Home" }}
        />
      </section>
    );
  }

  // The consumer collections mounted on this route (the customers → contacts
  // and catalog → requests projections, contract 10 §2). No data plane
  // records either collection in this deployment — both render their honest
  // empties, never a fabricated record.
  if (view === "contacts") {
    return (
      <section aria-label="My contacts" className="cc-stack" data-testid="consumer-contacts-page">
        <ConsumerTabBar active="contacts" />
        <MyContacts contacts={[]} />
      </section>
    );
  }
  if (view === "requests") {
    return (
      <section aria-label="My requests" className="cc-stack" data-testid="consumer-requests-page">
        <ConsumerTabBar />
        <MyRequests requests={[]} />
      </section>
    );
  }

  // The consumer home (contract 10 §3): the SAME honest payments plane feeds
  // the recent list.
  const paymentsRead = await listPaymentsFor(paymentsPlaneInput(principalRef));
  return (
    <section aria-label="Home" className="cc-stack" data-testid="consumer-page">
      <ConsumerTabBar active="home" />
      <ProjectionSwitch projection="consumer" />
      <ConsumerHome rails={rails} paymentsRead={paymentsRead} safetyFacts={{ permissions: [], warnings: [] }} />
    </section>
  );
}
