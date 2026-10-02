/**
 * The Command Center section frame (P3-W2-002).
 *
 * Every /app section renders inside this server component: when the render
 * state is gated (no session, no role preference) the honest authentication
 * gate REPLACES the section content — and because server-component children
 * only execute when rendered, a gated page never runs its data fetches.
 * Under preview or authentication the section content renders as authored.
 */

import type { ReactNode } from "react";
import type { ProductNavItemId } from "@payswap/ux";

import { CcAuthGate } from "./cc-auth-gate";
import { getServerCcState } from "@/lib/cc/server-state";

export async function CcSection({
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
