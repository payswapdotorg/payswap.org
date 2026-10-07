/**
 * The Balances page anatomy (UX-003, contract 09 §2 Balances + workflow
 * contract 04 W5): header (total in display currency + Withdraw + Add funds
 * + Manage schedule + Add rail) → Incoming vs Available table per asset/rail
 * with "Settle <cadence>" as an INLINE STATUS (a schedule is a status, not
 * a setting) → tabs (Settlements · Top-ups · All activity · Statements &
 * reconciliation) with honest hub/empty content for unactivated tabs.
 *
 * The payout list keeps the W5 anatomy — Amount · Status · Rail · Expected
 * date · Net, with the failure-reason + retry affordances present in the
 * table's anatomy — and renders its honest empty until real settlement
 * records exist. Balances are external OBSERVATIONS (AGENTS rule 21):
 * "—" marks an unobserved value, never a zero that claims one, and no
 * custody is implied anywhere.
 */

import Link from "next/link";
import { Tabs } from "@payswap/design";

/** One asset-on-rail balance row (an OBSERVATION, never custody). */
export interface BalancesRailRow {
  /** Rail name ("Stripe", "Base"). */
  readonly rail: string;
  /** Asset label ("USDC", "EUR"). */
  readonly asset: string;
  /** Incoming amount ("12.50 USDC") or null when not observed. */
  readonly incoming: string | null;
  /** Available amount or null when not observed. */
  readonly available: string | null;
  /** Settlement cadence sentence ("Settle daily") or null when unscheduled. */
  readonly settlement: string | null;
}

/** Where each header action's real flow lives (no dead buttons). */
interface BalancesHeaderActionRoutes {
  /** The real payout journey (explicit destination + scope confirmation). */
  readonly withdraw: string;
  /** Funds arrive by connecting a funded rail (non-custodial). */
  readonly addFunds: string;
  /** Cadence configuration is account-level. */
  readonly manageSchedule: string;
  /** The connect flow. */
  readonly addRail: string;
}

const HEADER_ACTION_HREFS: BalancesHeaderActionRoutes = Object.freeze({
  withdraw: "/app/payouts", // the real payout journey (explicit destination + withdrawal-scope confirmation)
  addFunds: "/connect", // funds arrive by connecting a funded rail (non-custodial)
  manageSchedule: "/app/settings", // cadence configuration is account-level
  addRail: "/connect", // the connect flow
});

export function BalancesHeader({
  totalDisplay,
  displayCurrency,
}: {
  /** The honest total, or null when no balances/display currency exist yet. */
  readonly totalDisplay: string | null;
  readonly displayCurrency: string | null;
}) {
  return (
    <header className="cc-balances-header" data-testid="balances-header">
      <div>
        <h1 className="cc-section-heading">Balances</h1>
        <p className="cc-section-intro">
          Balances per rail, observed externally — never custodial. Incoming
          funds settle into available on each rail&apos;s schedule.
        </p>
        <p className="cc-balances-total ps-num" data-testid="balances-total">
          {totalDisplay ?? "—"}
          {displayCurrency !== null ? (
            <span className="cc-balances-total__currency"> {displayCurrency}</span>
          ) : null}
        </p>
        {totalDisplay === null ? (
          <p className="cc-card__meta">
            No balances recorded yet — the total and its display currency
            appear once a connected rail has an observed balance.
          </p>
        ) : null}
      </div>
      <div className="cc-balances-actions" role="group" aria-label="Balance actions">
        <Link className="ps-button ps-button--sm ps-button--primary" href={HEADER_ACTION_HREFS.withdraw}>
          Withdraw
        </Link>
        <Link className="ps-button ps-button--sm ps-button--secondary" href={HEADER_ACTION_HREFS.addFunds}>
          Add funds
        </Link>
        <Link className="ps-button ps-button--sm ps-button--secondary" href={HEADER_ACTION_HREFS.manageSchedule}>
          Manage schedule
        </Link>
        <Link className="ps-button ps-button--sm ps-button--secondary" href={HEADER_ACTION_HREFS.addRail}>
          Add rail
        </Link>
      </div>
    </header>
  );
}

export function BalancesRailTable({
  rows,
}: {
  readonly rows: readonly BalancesRailRow[];
}) {
  if (rows.length === 0) {
    return (
      <div className="cc-empty" role="status" data-testid="balances-rails-empty">
        <p className="cc-empty__reason">
          No rails connected yet — balances appear per asset and rail as your
          connected rails settle. Connecting a rail is the fill path; nothing
          is simulated in the meantime.
        </p>
        <Link className="cc-empty__action" href={HEADER_ACTION_HREFS.addRail}>
          Add a rail
        </Link>
      </div>
    );
  }
  return (
    <div className="cc-tablewrap" role="region" aria-label="Incoming vs Available per asset and rail">
      <table className="ps-table" data-testid="balances-rails-table">
        <thead>
          <tr>
            <th scope="col" className="ps-table__th">
              Rail
            </th>
            <th scope="col" className="ps-table__th">
              Asset
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
          {rows.map((row) => (
            <tr key={`${row.rail}-${row.asset}`} className="ps-table__row">
              <td className="ps-table__cell">{row.rail}</td>
              <td className="ps-table__cell">{row.asset}</td>
              <td className="ps-table__cell ps-num">{row.incoming ?? "—"}</td>
              <td className="ps-table__cell ps-num">{row.available ?? "—"}</td>
              {/* "Settle <cadence>" is an INLINE STATUS, not a setting (W5). */}
              <td className="ps-table__cell">
                <span className="cc-settle-status" data-testid="balances-settle-status">
                  {row.settlement ?? "Not scheduled"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The payout list: W5 anatomy with its honest empty (reason + retry present). */
function SettlementsPanel() {
  return (
    <div className="cc-stack">
      <div className="cc-tablewrap" role="region" aria-label="Settlements">
        <table className="ps-table" data-testid="balances-settlements-table">
          <thead>
            <tr>
              <th scope="col" className="ps-table__th">
                Amount
              </th>
              <th scope="col" className="ps-table__th">
                Status
              </th>
              <th scope="col" className="ps-table__th">
                Rail
              </th>
              <th scope="col" className="ps-table__th">
                Expected date
              </th>
              <th scope="col" className="ps-table__th">
                Net
              </th>
              <th scope="col" className="ps-table__th">
                Failure reason
              </th>
              <th scope="col" className="ps-table__th">
                <span className="ps-sr-only">Retry</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="ps-table__row">
              <td className="ps-table__cell ps-table__empty" colSpan={7}>
                <div className="cc-empty" role="status">
                  <p className="cc-empty__reason">
                    No settlements yet — settlements appear when a connected
                    rail has a balance and a schedule. Failed settlements keep
                    their row with a human reason and a retry affordance (the
                    columns stay, healthy or not).
                  </p>
                  <Link className="cc-empty__action" href={HEADER_ACTION_HREFS.addRail}>
                    Connect a rail to start settling
                  </Link>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BalancesTabs() {
  return (
    <Tabs
      label="Balance activity"
      defaultValue="settlements"
      items={[
        {
          id: "settlements",
          label: "Settlements",
          content: <SettlementsPanel />,
        },
        {
          id: "top-ups",
          label: "Top-ups",
          content: (
            <div className="cc-empty" role="status" data-testid="balances-topups-empty">
              <p className="cc-empty__reason">
                No top-ups yet — top-ups appear when you add funds to a
                connected rail. In a non-custodial system funds arrive by
                connecting a funded rail, never by us holding them.
              </p>
              <Link className="cc-empty__action" href={HEADER_ACTION_HREFS.addFunds}>
                Add funds
              </Link>
            </div>
          ),
        },
        {
          id: "all-activity",
          label: "All activity",
          content: (
            <div className="cc-empty" role="status" data-testid="balances-activity-empty">
              <p className="cc-empty__reason">
                No balance activity yet — every movement (settlement, top-up,
                withdrawal) will be listed here as it is observed.
              </p>
              <Link className="cc-empty__action" href="/app/activity">
                Open the full Activity feed
              </Link>
            </div>
          ),
        },
        {
          id: "statements",
          label: "Statements & reconciliation",
          content: (
            <div className="cc-empty" role="status" data-testid="balances-statements-empty">
              <p className="cc-empty__reason">
                Statements render monthly per rail once rails settle;
                reconciliation matches settlements to payments and lives with
                the reporting surfaces.
              </p>
              <Link className="cc-empty__action" href="/app/reports">
                Open Reports
              </Link>
            </div>
          ),
        },
      ]}
    />
  );
}
