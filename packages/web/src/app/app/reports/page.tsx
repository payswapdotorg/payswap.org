import type { Metadata } from "next";

import { universalAreaById } from "@payswap/surface";

import { UniversalSection } from "@/components/universal/universal-section";

export const metadata: Metadata = { title: "Reports" };

/**
 * The Reports area (P4-W4-002 §3.2): reporting over evidence-backed
 * records — every figure traceable to its evidence. No reportable records
 * exist in this deployment yet → the designed honest empty state with the
 * real next action (the activity ledger); never a fabricated sample
 * report and never a dead button.
 */
export default async function ReportsPage() {
  return (
    <UniversalSection navItemId="payments">
      <ReportsArea />
    </UniversalSection>
  );
}

async function ReportsArea() {
  const area = universalAreaById("reports");
  return (
    <section aria-labelledby="cc-reports-heading" className="cc-stack">
      <div>
        <h1 id="cc-reports-heading" className="cc-section-heading">
          Reports
        </h1>
        <p className="cc-section-intro">{area.purpose}</p>
      </div>
      <div className="ps-empty" role="status" data-area="reports">
        <p className="ps-empty__reason">{area.emptyState.reason}</p>
        <a className="ps-empty__action" href={area.emptyState.nextAction.value}>
          Open the activity ledger
        </a>
      </div>
      <div className="cc-reports-contract">
        <h2 className="cc-section-heading">What a PaySwap report is</h2>
        <ul>
          <li>
            Every figure traces to an evidence record — a report line without
            evidence lineage is a bug, not a style choice.
          </li>
          <li>
            UNKNOWN outcomes are reported as UNKNOWN — never folded into
            failure or success columns to make a total look cleaner.
          </li>
          <li>
            Test-mode and testnet activity is reported separately and visibly —
            it never mixes into live totals.
          </li>
        </ul>
      </div>
    </section>
  );
}
