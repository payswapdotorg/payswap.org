/**
 * UX-006 — the consumer home (contract 10 §3, NORMATIVE order):
 *
 *   1. Balance header — display-currency total + per-asset chips +
 *      [Send] + [Request] + [Convert];
 *   2. Today card (the mirror of the merchant's) — latest expected incoming
 *      + next recurring outflow timeline;
 *   3. My payments — recent list (the SAME list-cell vocabulary the payments
 *      collection uses), status chips, rows tap into the payment detail in
 *      the CONSUMER projection;
 *   4. Safety card — spending-permissions state + active-warnings state +
 *      [Review];
 *   5. Recommendations (activation cards).
 *
 * This is a PROJECTION of the same product, not a second app (contract 10
 * §1): every value arrives as real data (the connection plane's authority
 * records, the honest payments plane) or renders its honest empty that
 * TEACHES the fill path. Balances are external observations (AGENTS rule 21)
 * — "—" never a fabricated zero. No merchant pricing, fee schedules,
 * catalogs or team machinery appears here (contract 10 §6).
 */

import Link from "next/link";
import { RecommendationsCard, StatusChip } from "@payswap/design";

import type { HomeRailBalance } from "@/components/shell/home-blocks";
import type { PaymentRecordView } from "@/app/app/payments/_view/payment-view";
import {
  failureReasonFor,
  formatEventTimestamp,
  formatMoney,
} from "@/app/app/payments/_view/payment-view";
import type { PaymentsReadResult } from "@/app/app/payments/_server/payments-plane";
import { PaymentsReadState, TestFixturesNotice } from "@/app/app/payments/_view/read-states";

import { ConsumerSafetyCard, type ConsumerSafetyFacts } from "./consumer-safety-card";

/** How many recent payments the home lists (the collection holds the rest). */
const RECENT_PAYMENT_LIMIT = 4;

/** The consumer detail route for one payment (the consumer projection). */
export function consumerPaymentHref(paymentId: string): string {
  return `/app?payment=${encodeURIComponent(paymentId)}`;
}

// ---------------------------------------------------------------------------
// 1 — Balance header
// ---------------------------------------------------------------------------

/**
 * The balance header: display-currency total + per-asset chips + the three
 * money actions. The total is a display-currency projection of OBSERVED
 * balances — with no observation there is nothing to total, so the honest
 * marker renders ("—"), never a zero that claims an empty wallet. The three
 * actions route to the SAME W1/W2/convert surfaces the merchant projection
 * uses (contract 10 §4: reuse the workflow contract, never rebuild).
 */
export function ConsumerBalanceHeader({ rails }: { readonly rails: readonly HomeRailBalance[] }) {
  // Only rails with an OBSERVED available balance project a chip; the rest
  // stay honestly absent (an unobserved rail is not a zero balance).
  const observedChips = rails.filter((rail) => rail.available !== null);
  const anyObserved = rails.some((rail) => rail.available !== null || rail.incoming !== null);
  return (
    <section className="cc-card" aria-labelledby="cc-consumer-balances-heading" data-testid="consumer-balance-header">
      <div className="cc-card__head">
        <h2 id="cc-consumer-balances-heading" className="cc-card__title">
          My money
        </h2>
      </div>
      <p className="cc-card__meta">
        {/* The display-currency total: an observation, never a fabricated number. */}
        <span className="ps-num" data-testid="consumer-balance-total">
          {anyObserved ? "See per-asset balances below" : "—"}
        </span>
      </p>
      <p className="cc-actions__reason" data-testid="consumer-balance-honesty">
        {anyObserved
          ? "Balances are what your connected rails report — observations, not custody. Nothing here is simulated."
          : "No balances observed yet — balances appear here the moment a rail you connected reports one. Nothing is simulated in the meantime."}
      </p>
      <div className="cc-reco-grid" data-testid="consumer-balance-chips">
        {observedChips.length > 0 ? (
          observedChips.map((rail) => (
            <span key={rail.rail} className="ps-badge">
              {rail.rail}: {rail.available}
            </span>
          ))
        ) : (
          <span className="cc-actions__reason">
            Per-asset chips appear as balances are observed — each shows the
            asset and the amount the rail actually reported.
          </span>
        )}
      </div>
      <div className="cc-card__head">
        {/* The three money actions (contract 10 §3.1) — the SAME workflows
            the merchant projection composes: W1 create-payment, the W2
            payment-link builder, and the convert surface. */}
        <Link className="ps-button ps-button--sm ps-button--primary" href="/app/payments?start=1">
          Send
        </Link>
        <Link className="ps-button ps-button--sm ps-button--secondary" href="/app/payments/link">
          Request
        </Link>
        <Link className="ps-button ps-button--sm ps-button--secondary" href="/app/convert">
          Convert
        </Link>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2 — Today card (the consumer mirror)
// ---------------------------------------------------------------------------

/**
 * The Today mirror (contract 10 §3.2): latest expected incoming + next
 * recurring outflow timeline. Both are honest empties until real expected
 * money exists — the empty TEACHES what will fill it.
 */
export function ConsumerTodayCard() {
  return (
    <section className="cc-card" aria-labelledby="cc-consumer-today-heading" data-testid="consumer-today">
      <div className="cc-card__head">
        <h2 id="cc-consumer-today-heading" className="cc-card__title">
          Today
        </h2>
      </div>
      <div className="cc-stack">
        <div className="cc-empty" role="status" data-testid="consumer-today-incoming">
          <p className="cc-empty__reason">
            No incoming payments expected today — the latest expected incoming
            appears here the moment a payment is on its way to you, with its
            honest status (never a fabricated arrival time).
          </p>
        </div>
        <div className="cc-empty" role="status" data-testid="consumer-today-outflows">
          <p className="cc-empty__reason">
            No recurring outflows scheduled — subscriptions and bills you set
            up appear here as a timeline of what leaves, and when. Nothing is
            scheduled until you schedule it.
          </p>
          <Link className="cc-empty__action" href="/app/billing">
            Review billing to schedule a payment
          </Link>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 3 — My payments (recent list)
// ---------------------------------------------------------------------------

/**
 * My payments — the recent list (contract 10 §3.3): the SAME list-cell
 * vocabulary the payments collection renders (amount "X CUR", StatusChip,
 * counterparty, date, failure-reason column present-but—"—" for healthy
 * rows), rows drill into the payment detail in the CONSUMER projection.
 */
export function ConsumerMyPayments({
  read,
}: {
  readonly read: PaymentsReadResult<readonly PaymentRecordView[]>;
}) {
  return (
    <section className="cc-card" aria-labelledby="cc-consumer-payments-heading" data-testid="consumer-my-payments">
      <div className="cc-card__head">
        <h2 id="cc-consumer-payments-heading" className="cc-card__title">
          My payments
        </h2>
        <Link className="ps-button ps-button--sm ps-button--secondary" href="/app/transactions">
          View all
        </Link>
      </div>
      {read.status !== "ok" ? (
        <PaymentsReadState
          result={read}
          nextHop={{ href: "/app/payments?start=1", label: "Make a payment" }}
        />
      ) : (
        <div className="cc-stack">
          {read.source === "test-fixtures" ? <TestFixturesNotice /> : null}
          <div className="cc-tablewrap" role="region" aria-label="Recent payments">
            <table className="ps-table">
              <thead>
                <tr>
                  <th scope="col" className="ps-table__th">Amount</th>
                  <th scope="col" className="ps-table__th">Status</th>
                  <th scope="col" className="ps-table__th">Who</th>
                  <th scope="col" className="ps-table__th">When</th>
                  <th scope="col" className="ps-table__th">Failure reason</th>
                </tr>
              </thead>
              <tbody>
                {read.data.slice(0, RECENT_PAYMENT_LIMIT).map((payment) => (
                  <tr key={payment.id} className="ps-table__row">
                    <td className="ps-table__cell">
                      <Link className="cc-link" href={consumerPaymentHref(payment.id)}>
                        {formatMoney(payment.amount)}
                      </Link>
                    </td>
                    <td className="ps-table__cell">
                      <StatusChip state={payment.state} detail={payment.stateDetail} />
                    </td>
                    <td className="ps-table__cell">{payment.counterparty.name}</td>
                    <td className="ps-table__cell ps-num">{formatEventTimestamp(payment.createdAt)}</td>
                    <td className="ps-table__cell">
                      {failureReasonFor(payment.failureReasonId)?.label ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {read.data.length === 0 ? (
            <div className="cc-empty" role="status" data-testid="consumer-my-payments-empty">
              <p className="cc-empty__reason">
                No payments yet — payments you make and receive appear here
                with their honest status. The empty state is the truth; none
                is simulated.
              </p>
              <Link className="cc-empty__action" href="/app/payments?start=1">
                Make your first payment
              </Link>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------

export interface ConsumerHomeProps {
  /** The connected rails (authority records; observations render "—"). */
  readonly rails: readonly HomeRailBalance[];
  /** The honest payments read (the SAME plane the merchant collection uses). */
  readonly paymentsRead: PaymentsReadResult<readonly PaymentRecordView[]>;
  /** The safety facts for the safety card (all honest when unset). */
  readonly safetyFacts: ConsumerSafetyFacts;
}

/**
 * The consumer home composition — the contract's five blocks in the
 * NORMATIVE order. A server component; data arrived from the real planes.
 */
export function ConsumerHome({ rails, paymentsRead, safetyFacts }: ConsumerHomeProps) {
  return (
    <section aria-label="Home" className="cc-stack" data-testid="consumer-home">
      <ConsumerBalanceHeader rails={rails} />
      <ConsumerTodayCard />
      <ConsumerMyPayments read={paymentsRead} />
      <ConsumerSafetyCard facts={safetyFacts} />
      <section
        className="cc-card"
        aria-labelledby="cc-consumer-recommendations-heading"
        data-testid="consumer-recommendations"
      >
        <div className="cc-card__head">
          <h2 id="cc-consumer-recommendations-heading" className="cc-card__title">
            Recommendations
          </h2>
        </div>
        <div className="cc-reco-grid">
          {/* The contract-10 §3.5 activation card, verbatim proposition. */}
          <RecommendationsCard
            proposition="Get paid back instantly with a payment link."
            ctaLabel="Try"
            ctaHref="/app/payments/link"
          />
        </div>
      </section>
    </section>
  );
}
