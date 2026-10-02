import type { Metadata } from "next";
import { Panel } from "@payswap/design";
import { PROVENANCE_STRENGTH_ORDER } from "@payswap/ux";

import { CcSection } from "@/components/cc/cc-section";
import { EvidenceJourneySurface } from "@/components/cc/evidence-journey-surface";

export const metadata: Metadata = {
  title: "Evidence",
};

/**
 * The Evidence section (P3-W2-002): the Evidence journey — evidence per
 * external financial action with provenance strength (INV-E04), artifact
 * inspection, strongest-first ordering. The strength order itself is
 * consumed from the certified contract (never restated from memory).
 */
export default async function EvidencePage() {
  return (
    <CcSection navItemId="evidence">
      <section aria-labelledby="cc-evidence-heading" className="cc-stack">
        <div>
          <h1 id="cc-evidence-heading" className="cc-section-heading">
            Evidence
          </h1>
          <p className="cc-section-intro">
            The evidence archive: authorization lineage and proof for every
            consequential financial effect. Provenance strength is derived —
            a browser-local artifact never renders stronger than its
            authenticated provenance (INV-E04).
          </p>
        </div>
        <Panel
          title="The provenance strength order (INV-E04)"
          description="Consumed verbatim from the certified contract — weakest to strongest. Evidence lists render strongest-first."
        >
          <ol className="cc-actions">
            {PROVENANCE_STRENGTH_ORDER.map((strength, index) => (
              <li key={strength} className="cc-actions__item">
                <span className="ps-mono ps-num">#{index + 1}</span>
                <span className="ps-mono">{strength}</span>
              </li>
            ))}
          </ol>
        </Panel>
        <EvidenceJourneySurface actionRef="viewer:current" artifacts={[]} />
      </section>
    </CcSection>
  );
}
