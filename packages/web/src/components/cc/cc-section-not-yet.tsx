/**
 * The honest not-yet-available section (P3-W2-002).
 *
 * The certified navigation model carries 16 sections; Wave 2 implements the
 * eight core ones plus this honest treatment for the rest: the section
 * EXISTS (no dead navigation — the route resolves, the nav item works), its
 * certified summary and bound journeys render, and the state says exactly
 * why the surface is not yet live in this deployment. Nothing is stubbed
 * with fake content.
 */

import Link from "next/link";
import type { ProductNavItemId } from "@payswap/ux";
import { journeysForNavItem, navItemById } from "@payswap/ux";
import { PRODUCT_NAVIGATION } from "@payswap/ux";
import { EmptyState, KeyValue, Panel } from "@payswap/design";

const JOURNEY_LABELS: Readonly<Record<string, string>> = {
  "connect-provider": "ConnectProvider — provider connections",
  pay: "Pay — payments to recipients",
  collect: "Collect — payment requests",
  payout: "Payout — withdrawals to explicit destinations",
  "reconcile-payment-outcome": "Reconcile — UNKNOWN outcome resolution",
  evidence: "Evidence — proof inspection",
  reauthorize: "Reauthorize — fresh authorization with lineage",
};

export function CcSectionNotYetAvailable({ navItemId }: { readonly navItemId: ProductNavItemId }) {
  const item = navItemById(navItemId, PRODUCT_NAVIGATION);
  const journeys = journeysForNavItem(navItemId);
  return (
    <section aria-labelledby={`cc-${navItemId}-heading`} className="cc-stack">
      <div>
        <h1 id={`cc-${navItemId}-heading`} className="cc-section-heading">
          {item.label}
        </h1>
        <p className="cc-section-intro">{item.summary}</p>
      </div>
      <EmptyState
        title="Not yet live in this deployment"
        description="This section's data surfaces derive from authority records through the session plane, which is not yet wired. The section renders honestly now — with its certified summary and journey bindings — and fills with real state when the plane ships. Nothing here is simulated."
        action={
          <Link className="ps-button ps-button--sm ps-button--secondary" href="/app">
            Back to Overview
          </Link>
        }
      />
      <KeyValue
        entries={[
          { key: "Navigation group", value: item.group },
          { key: "Route", value: item.route, mono: true },
          {
            key: "Requires capabilities",
            value:
              item.requiresCapabilities.length === 0
                ? "none — visible to every authenticated role"
                : item.requiresCapabilities.join(" (any-of) "),
            mono: item.requiresCapabilities.length > 0,
          },
        ]}
      />
      {journeys.length > 0 ? (
        <Panel
          title="Journeys bound to this section"
          description="The certified journey contracts this surface will drive (consumed from the navigation binding)."
        >
          <ul className="cc-actions">
            {journeys.map((journeyId) => (
              <li key={journeyId} className="cc-actions__item">
                <span className="ps-mono">{journeyId}</span>
                <span className="cc-actions__reason">
                  {JOURNEY_LABELS[journeyId] ?? journeyId}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </section>
  );
}
