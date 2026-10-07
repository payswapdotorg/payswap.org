import type { Metadata } from "next";

import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { getServerCcState } from "@/lib/cc/server-state";
import { ShellSection } from "@/components/shell/shell-section";
import {
  BalancesHeader,
  BalancesRailTable,
  BalancesTabs,
  type BalancesRailRow,
} from "@/components/shell/balances-blocks";

export const metadata: Metadata = {
  title: "Balances",
};

/**
 * The Balances surface (UX-003, contract 09 §2 Balances + workflow contract
 * 04 W5): the header (total in display currency + Withdraw + Add funds +
 * Manage schedule + Add rail), the Incoming vs Available table per
 * asset/rail with "Settle <cadence>" as an inline status, and the
 * Settlements · Top-ups · All activity · Statements & reconciliation tabs
 * with honest hub/empty content. Rails derive from the connection plane's
 * real records; balance amounts are external OBSERVATIONS (none recorded in
 * this deployment — "—", never a fabricated zero or custody claim).
 */
export default async function BalancesPage() {
  return (
    <ShellSection
      route="/app/balances"
      title="Balances"
      intro="Balances per rail, incoming versus available, with each rail's settlement schedule — external observations, never custody."
    >
      <BalancesArea />
    </ShellSection>
  );
}

async function BalancesArea() {
  // ShellSection has already gated: this renders only for authenticated (or
  // marked-preview) visitors. The session context decides which.
  const state = await getServerCcState();
  const authenticated = state.session.status === "authenticated";
  const instances = authenticated
    ? getConnectionPlane().connectedInstancesFor(state.session.principal.principal)
    : [];
  const activeInstances = instances.filter((record) => record.state === "ACTIVE");

  const rows: readonly BalancesRailRow[] = activeInstances.map((record) => ({
    rail: record.providerId,
    asset: "—",
    incoming: null,
    available: null,
    settlement: null,
  }));

  return (
    <section aria-label="Balances" className="cc-stack" data-testid="balances-page">
      <BalancesHeader totalDisplay={null} displayCurrency={null} />
      <BalancesRailTable rows={rows} />
      <BalancesTabs />
    </section>
  );
}
