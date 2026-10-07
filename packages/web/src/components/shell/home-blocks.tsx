/**
 * The Home page blocks (UX-003, contract 09 §2 Home): Today card →
 * Recommendations → Develop card → Your overview — in that order, the Today
 * card FIRST even at zero (the zero-state teaches the fill path).
 *
 * Presentational + honest: every value arrives as real data or as an
 * explicit honest-empty marker; nothing fabricates a balance, a key, a
 * schedule or a metric. Balances are external observations (AGENTS rule 21)
 * — a rail with no recorded observation renders "—", never a zero that
 * claims one.
 */

import Link from "next/link";
import { MetricCard, RecommendationsCard } from "@payswap/design";

/** One rail's balance row (an OBSERVATION, never custody). */
export interface HomeRailBalance {
  /** Rail name ("Stripe", "Base (USDC)"). */
  readonly rail: string;
  /** Incoming amount ("12.50 USDC") or null when not observed. */
  readonly incoming: string | null;
  /** Available amount or null when not observed. */
  readonly available: string | null;
  /** Settlement cadence sentence ("Settle daily") or null when unscheduled. */
  readonly settlement: string | null;
}

export interface HomeTodayData {
  /** The connected rails with their observed balances (empty = honest zero). */
  readonly rails: readonly HomeRailBalance[];
  /** The next settlement sentence, or null when nothing is scheduled. */
  readonly nextSettlement: string | null;
}

/** The Withdraw action's target (the real payout journey). */
const WITHDRAW_HREF = "/app/payouts" as const;

export function HomeTodayCard({ data }: { readonly data: HomeTodayData }) {
  const hasRails = data.rails.length > 0;
  return (
    <section className="cc-card" aria-labelledby="cc-home-today-heading" data-testid="home-today">
      <div className="cc-card__head">
        <h2 id="cc-home-today-heading" className="cc-card__title">
          Today
        </h2>
        {/* The money-moving entry point routes to the real payout journey,
            which requires an explicit destination + withdrawal-scope
            confirmation before anything can be submitted (INV-F01 fail-closed
            law) — this link itself moves nothing. */}
        <Link className="ps-button ps-button--sm ps-button--secondary" href={WITHDRAW_HREF}>
          Withdraw
        </Link>
      </div>
      {hasRails ? (
        <div className="cc-tablewrap" role="region" aria-label="Balances per rail">
          <table className="ps-table">
            <thead>
              <tr>
                <th scope="col" className="ps-table__th">
                  Rail
                </th>
                <th scope="col" className="ps-table__th">
                  Incoming
                </th>
                <th scope="col" className="ps-table__th">
                  Available
                </th>
                <th scope="col" className="ps-table__th">
                  Settlement
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rails.map((rail) => (
                <tr key={rail.rail} className="ps-table__row">
                  <td className="ps-table__cell">{rail.rail}</td>
                  <td className="ps-table__cell ps-num">{rail.incoming ?? "—"}</td>
                  <td className="ps-table__cell ps-num">{rail.available ?? "—"}</td>
                  <td className="ps-table__cell">{rail.settlement ?? "Not scheduled"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="cc-empty" role="status" data-testid="home-today-empty">
          <p className="cc-empty__reason">
            No balances yet — balances appear here as your connected rails
            settle. Connecting a rail is the fill path, and nothing is
            simulated in the meantime.
          </p>
          <Link className="cc-empty__action" href="/connect">
            Connect your first rail
          </Link>
        </div>
      )}
      <p className="cc-card__meta" data-testid="home-today-schedule">
        {data.nextSettlement ?? (
          <>
            No settlement schedule yet — a schedule appears once a rail has a
            balance and a cadence.{" "}
            <Link href="/app/balances">Open Balances to manage the schedule</Link>.
          </>
        )}
      </p>
    </section>
  );
}

/** One recommendation: a one-sentence value prop + a single verb CTA. */
export interface HomeRecommendation {
  readonly id: string;
  readonly proposition: string;
  readonly ctaLabel: string;
  readonly ctaHref: string;
}

export function HomeRecommendations({
  recommendations,
}: {
  readonly recommendations: readonly HomeRecommendation[];
}) {
  return (
    <section
      className="cc-card"
      aria-labelledby="cc-home-recommendations-heading"
      data-testid="home-recommendations"
    >
      <div className="cc-card__head">
        <h2 id="cc-home-recommendations-heading" className="cc-card__title">
          Recommendations
        </h2>
      </div>
      <div className="cc-reco-grid">
        {recommendations.map((recommendation) => (
          <RecommendationsCard
            key={recommendation.id}
            proposition={recommendation.proposition}
            ctaLabel={recommendation.ctaLabel}
            ctaHref={recommendation.ctaHref}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The Develop card: publishable key + masked secret + [Go to API keys].
 * `keys === null` is the honest unconfigured state — no fake key material
 * is ever rendered, and a secret only ever appears masked (prefix + "…" +
 * last-4; reveal is an explicit action that never persists, and no full
 * secret enters the DOM here).
 */
export function HomeDevelopCard({
  keys,
}: {
  readonly keys: { readonly publishable: string; readonly maskedSecret: string } | null;
}) {
  return (
    <section className="cc-card" aria-labelledby="cc-home-develop-heading" data-testid="home-develop">
      <div className="cc-card__head">
        <h2 id="cc-home-develop-heading" className="cc-card__title">
          Develop
        </h2>
        <Link className="ps-button ps-button--sm ps-button--secondary" href="/app/developers">
          Go to API keys
        </Link>
      </div>
      {keys === null ? (
        <div className="cc-empty" role="status" data-testid="home-develop-empty">
          <p className="cc-empty__reason">
            No API keys yet — keys are issued per environment by the
            developers surface when it ships. Nothing is simulated here, and
            no secret ever renders unmasked.
          </p>
        </div>
      ) : (
        <dl className="cc-kv">
          <div className="cc-kv__row">
            <dt className="cc-kv__key">Publishable key</dt>
            <dd className="cc-kv__value ps-mono">{keys.publishable}</dd>
          </div>
          <div className="cc-kv__row">
            <dt className="cc-kv__key">Secret key</dt>
            <dd className="cc-kv__value ps-mono" data-testid="home-develop-secret">
              {keys.maskedSecret}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

/** One overview metric: honest data or the scaffold-empty truth. */
export interface HomeMetric {
  readonly title: string;
  readonly moreDetailsHref: string;
  readonly emptyLink: { readonly href: string; readonly label: string };
}

const OVERVIEW_METRICS: readonly HomeMetric[] = [
  {
    title: "Payments",
    moreDetailsHref: "/app/payments",
    emptyLink: { href: "/app/payments", label: "Start accepting" },
  },
  {
    title: "Gross volume",
    moreDetailsHref: "/app/reports",
    emptyLink: { href: "/app/reports", label: "How to fill this" },
  },
  {
    title: "Net volume",
    moreDetailsHref: "/app/reports",
    emptyLink: { href: "/app/reports", label: "How to fill this" },
  },
  {
    title: "Failed payments",
    moreDetailsHref: "/app/payments",
    emptyLink: { href: "/app/payments", label: "How to fill this" },
  },
  {
    title: "New customers",
    moreDetailsHref: "/app/customers",
    emptyLink: { href: "/app/customers", label: "How to fill this" },
  },
  {
    title: "Top customers",
    moreDetailsHref: "/app/customers",
    emptyLink: { href: "/app/customers", label: "How to fill this" },
  },
] as const;

/**
 * Your overview (contract 09 §2): metric cards with built-in comparison,
 * freshness labels, scaffold-rendered empties and [More details]. In this
 * deployment no authority records feed these metrics yet, so every card
 * renders its honest scaffold empty — the chart scaffold (axes visible) +
 * "No data" + a how-to-fill link, never a fabricated number, delta or
 * freshness stamp (freshness derives from data timestamps; with no data
 * there is nothing to stamp).
 */
export function HomeOverviewMetrics() {
  return (
    <section
      className="cc-card"
      aria-labelledby="cc-home-overview-heading"
      data-testid="home-overview"
    >
      <div className="cc-card__head">
        <h2 id="cc-home-overview-heading" className="cc-card__title">
          Your overview
        </h2>
      </div>
      <div className="cc-metric-grid">
        {OVERVIEW_METRICS.map((metric) => (
          <MetricCard
            key={metric.title}
            title={metric.title}
            emptyLink={metric.emptyLink}
            moreDetails={
              <Link className="cc-link" href={metric.moreDetailsHref}>
                More details
              </Link>
            }
            data-testid={`home-metric-${metric.title.toLowerCase().replace(/\s+/g, "-")}`}
          />
        ))}
      </div>
    </section>
  );
}
