/**
 * The Command Center quick actions (P3-W2-002): the product's journeys as
 * verb-first entry points, derived from the certified journey/navigation
 * bindings — every action navigates to a real journey surface (law 4: no
 * dead actions; the surfaces themselves state their honest unavailable
 * reasons where the session/connection planes are not wired).
 */

import Link from "next/link";
import type { ProductRole } from "@payswap/ux";
import { Card, CardMeta, Panel } from "@payswap/design";

import { derivePaletteActions } from "@/lib/cc/palette";

const ACTION_HINTS: Readonly<Record<string, string>> = {
  "action-pay": "Capability selection from connected instances only — route review before any submission.",
  "action-collect": "Request creation where a connected capability permits; the share reference is opaque.",
  "action-payout":
    "Explicit destination required, withdrawal-scoped authorization — fail-closed by contract.",
  "action-connect": "The connection flows ship with the authentication plane (parallel work stream).",
  "action-evidence": "Evidence per external action, provenance strength strongest-first (INV-E04).",
  "action-capabilities": "Provider health and coverage, truthful from recorded evidence + the live API.",
  "action-settings": "Session state, role preference and the deployment-scope note.",
};

export function CcQuickActions({ role }: { readonly role: ProductRole | null }) {
  const actions = derivePaletteActions(role);
  return (
    <Panel
      title="Quick actions"
      description="The product journeys, one click away. Each surface renders its honest current state — nothing is pre-filled or pretended."
    >
      <div className="cc-grid">
        {actions.map((action) => (
          <Card key={action.id} raised>
            <h3 className="ps-card__title">
              <Link href={action.href}>{action.label}</Link>
            </h3>
            <CardMeta>
              <span>{ACTION_HINTS[action.id] ?? action.group}</span>
            </CardMeta>
          </Card>
        ))}
      </div>
    </Panel>
  );
}
