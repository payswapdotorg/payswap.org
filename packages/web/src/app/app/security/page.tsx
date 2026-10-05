import type { Metadata } from "next";

import { universalAreaById } from "@payswap/surface";
import type { GateDecision } from "@payswap/onchain-security";

import { UniversalSection } from "@/components/universal/universal-section";
import { SecurityGateView } from "@/components/universal/security-gate-view";

export const metadata: Metadata = { title: "Security" };

/**
 * The Security area (P4-W4-002 §3.4): human-readable warnings and blocks —
 * the BLOCK/ALLOW/UNKNOWN gate vocabulary as people language with typed
 * drill-down. The page renders the vocabulary presentation contract over
 * REAL gate decision shapes; live gate records appear here as journeys
 * evaluate them (none recorded in this deployment → the designed honest
 * empty state, never a fabricated incident list).
 */

const EXAMPLE_GATE: GateDecision = {
  decision: "BLOCK",
  reasons: [
    {
      dimension: "spender_approval",
      code: "unlimited_allowance",
      message:
        "The contract would grant unlimited USDC spending authority to an untrusted spender.",
      invariantRefs: ["INV-SC02", "rule-27"],
    },
  ],
  checks: [
    {
      dimension: "spender_approval",
      outcome: "block",
      code: "unlimited_allowance",
      detail: "approval is unbounded",
    },
  ],
  evidenceRefs: ["evidence:simulation:gate-example"],
};

export default async function SecurityPage() {
  return (
    <UniversalSection navItemId="payments">
      <SecurityArea />
    </UniversalSection>
  );
}

async function SecurityArea() {
  const area = universalAreaById("security");
  return (
    <section aria-labelledby="cc-security-heading" className="cc-stack">
      <div>
        <h1 id="cc-security-heading" className="cc-section-heading">
          Security
        </h1>
        <p className="cc-section-intro">{area.purpose}</p>
      </div>
      <div className="ps-empty" role="status" data-area="security">
        <p className="ps-empty__reason">{area.emptyState.reason}</p>
        <a className="ps-empty__action" href={area.emptyState.nextAction.value}>
          Read the public security page
        </a>
      </div>
      <div className="cc-security-vocabulary">
        <h2 className="cc-section-heading">How security decisions are presented</h2>
        <p>
          Every security outcome is one of three words — blocked, allowed, or
          not yet decided — and each renders with the reason in people
          language, the typed detail one explicit step away, and the evidence
          references behind it. This is the presentation law for every
          journey surface, not a separate security application.
        </p>
        <h3 className="cc-security-example-heading">A blocked action looks like this</h3>
        <SecurityGateView decision={EXAMPLE_GATE} />
        <p className="cc-security-note">
          The example above renders the REAL gate fold over a typed BLOCK
          decision — deterministic blocks are final for the request; no
          setting, agent or optimization overrides them. Live gate records
          appear here as real journeys evaluate them.
        </p>
      </div>
    </section>
  );
}
