/**
 * UX-004 — the honest read-state surfaces for the payments reads (server
 * components; contracts 07 §3 / 04 §4: no dead ends, no fabricated records).
 *
 * Every non-ok outcome of a payments-plane read renders HERE: the state names
 * exactly what is not configured or what answered, carries the verbatim
 * transport truth, and offers the best next hop. The unconfigured state
 * teaches the fill path with env-var NAMES only — never values.
 */

import Link from "next/link";
import { EmptyState, EnvironmentBanner } from "@payswap/design";

import { TEST_FIXTURES_ENV_VAR, type PaymentsReadResult } from "../_server/payments-plane.js";
import { API_BASE_URL_ENV_VAR } from "@/lib/api";

/** The non-ok half of a payments read (any T). */
export type PaymentsReadFailure = Exclude<PaymentsReadResult<unknown>, { status: "ok" }>;

export interface PaymentsReadStateProps {
  readonly result: PaymentsReadFailure;
  /** The single best next hop (never a dead end). */
  readonly nextHop: { readonly href: string; readonly label: string };
}

export function PaymentsReadState({ result, nextHop }: PaymentsReadStateProps) {
  if (result.status === "unconfigured") {
    return (
      <EmptyState
        title="Payments cannot load yet — nothing is configured"
        description={
          <>
            The authoritative PaySwap API runtime is not configured in this
            deployment (<span className="ps-mono">{API_BASE_URL_ENV_VAR}</span>),
            so there is no honest source of payment records to list — and none
            are fabricated in its place. For a clearly-marked test walkthrough,
            enable <span className="ps-mono">{TEST_FIXTURES_ENV_VAR}</span>:
            fixture records (<span className="ps-mono">pay_test_*</span> ids)
            render under the TEST marking, never as real money.
          </>
        }
        action={
          <Link href={nextHop.href} className="ps-button ps-button--md ps-button--primary">
            {nextHop.label}
          </Link>
        }
        teachingLine="Env-var names only — values never render on a surface."
        data-testid="payments-unconfigured-state"
      />
    );
  }
  if (result.status === "preview-no-session") {
    return (
      <EmptyState
        title="The marked preview carries no session"
        description={
          <>
            The API runtime is configured, but this view is the marked role
            preview — it holds no session, so no records are read and nothing
            renders as if it were yours. Sign in to read your payments from
            the authoritative API.
          </>
        }
        action={
          <Link href={nextHop.href} className="ps-button ps-button--md ps-button--primary">
            {nextHop.label}
          </Link>
        }
        data-testid="payments-preview-state"
      />
    );
  }
  const verbatim =
    result.status === "http-error"
      ? `The authoritative PaySwap API answered HTTP ${result.statusCode} — ${result.message}`
      : `The authoritative PaySwap API could not be reached — ${result.message}`;
  return (
    <div role="alert" className="ps-state ps-state--danger" data-testid="payments-read-error">
      <h3 className="ps-state__title">The payments read did not complete</h3>
      <p className="ps-state__description">
        {verbatim}. Nothing is fabricated in place of the records — the
        verbatim answer is the truth that rendered here.
      </p>
      <div className="ps-state__actions">
        <Link href={nextHop.href} className="ps-button ps-button--md ps-button--secondary">
          {nextHop.label}
        </Link>
      </div>
    </div>
  );
}

/**
 * The TEST-fixture source notice: renders whenever a surface serves the
 * clearly-marked test fixtures (contract 02 §9 — the marking is stated, never
 * implied). Paired with the EnvironmentBanner badge (env.test tokens).
 */
export function TestFixturesNotice() {
  return (
    <p className="cc-actions__reason" data-testid="test-fixtures-notice">
      <EnvironmentBanner environment="test" variant="badge" badgeLabel="Test mode" />{" "}
      Showing clearly-marked TEST records —{" "}
      <span className="ps-mono">{TEST_FIXTURES_ENV_VAR}</span> is enabled for
      this deployment. Fixture data (<span className="ps-mono">pay_test_*</span>{" "}
      ids), never real money.
    </p>
  );
}
