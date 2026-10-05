/**
 * The universal section frame (P4-W4-002): the same honest authentication
 * gate discipline as the certified CcSection, for the universal areas the
 * certified nav model does not carry (Accounts, Connections, Security,
 * Reports) and the outcome journey routes (Convert, Checkout). Gated
 * renders never run their data fetches (server-component children only
 * execute when rendered).
 */

import type { ReactNode } from "react";

import { CcAuthGate } from "@/components/cc/cc-auth-gate";
import { getServerCcState } from "@/lib/cc/server-state";
import type { ProductNavItemId } from "@payswap/ux";

export async function UniversalSection({
  /** The nearest certified nav item for the gate's preview derivation. */
  navItemId,
  children,
}: {
  readonly navItemId: ProductNavItemId;
  readonly children: ReactNode;
}) {
  const state = await getServerCcState();
  if (state.gated) {
    return <CcAuthGate navItemId={navItemId} state={state} />;
  }
  return <>{children}</>;
}

/** The honest empty state over the surface contract (§3.5 states). */
export function HonestAreaEmptyState({
  areaId,
  areaLabel,
  reason,
  nextActionKind,
  nextActionValue,
}: {
  readonly areaId: string;
  readonly areaLabel: string;
  readonly reason: string;
  readonly nextActionKind: "route" | "outcome";
  readonly nextActionValue: string;
}) {
  return (
    <section
      className="cc-empty-area"
      aria-labelledby={`cc-empty-${areaId}-heading`}
      data-area={areaId}
    >
      <h2 id={`cc-empty-${areaId}-heading`} className="cc-section-heading">
        {areaLabel}
      </h2>
      <div className="ps-empty" role="status">
        <p className="ps-empty__reason">{reason}</p>
        <a className="ps-empty__action" href={nextActionValue}>
          {nextActionKind === "outcome" ? "Start the next outcome action" : "Go to the next step"}
        </a>
      </div>
    </section>
  );
}
