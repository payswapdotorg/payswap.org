/**
 * The Capabilities section content (P3-W2-002): truthful provider/capability
 * health. Everything here is either the REAL /v1/capabilities response, the
 * recorded coverage evidence with dates, or the certified honest-state
 * contract's own four-state distinction — nothing is inferred, upgraded or
 * invented. Balances are framed as external-funds OBSERVATIONS (never
 * custody), with the recorded probe datum as the real example.
 */

import Link from "next/link";
import { Card, CardMeta, CardTitle, Panel, StatusPill } from "@payswap/design";
import type { HonestStateView } from "@payswap/ux";
import { renderTerminalHonestView } from "@payswap/ux";

import { CcConnectionSummary } from "./cc-connection-summary";
import { coverage } from "@/lib/coverage";

const TONE_BY_HONEST_TONE: Readonly<Record<HonestStateView["tone"], "ok" | "attention" | "unknown" | "failed">> = {
  positive: "ok",
  neutral: "unknown",
  attention: "attention",
  negative: "failed",
};

/** The operator four-state distinction — rendered from the contract itself. */
const FOUR_STATES = [
  { state: "FAILED", label: "Provider failure" },
  { state: "UNKNOWN", label: "UNKNOWN — reconciling" },
  { state: "COMPLIANCE_BLOCKED", label: "Compliance block" },
  { state: "NO_VIABLE_ROUTE", label: "No viable route" },
] as const;

export function CcCapabilitiesContent() {
  const mtn = coverage.mtnMomo;
  return (
    <div className="cc-stack">
      <Panel
        title="The four-state distinction"
        description="Provider failure, UNKNOWN, compliance block and NO_VIABLE_ROUTE stay visually and semantically distinct — rendered below verbatim from the certified honest-state contract (headline + guidance are the contract's own)."
      >
        <div className="cc-grid">
          {FOUR_STATES.map(({ state, label }) => {
            const view = renderTerminalHonestView(state);
            return (
              <Card key={state} raised>
                <CardTitle>{label}</CardTitle>
                <p>
                  <StatusPill tone={TONE_BY_HONEST_TONE[view.tone]}>{view.uiState}</StatusPill>
                </p>
                <p className="cc-actions__reason">
                  <strong>{view.headline}.</strong> {view.guidance}
                </p>
                <CardMeta>
                  <span className="ps-mono">terminal state: {state}</span>
                </CardMeta>
              </Card>
            );
          })}
        </div>
      </Panel>

      <Panel
        title="Balances are external observations — never custody"
        description="PaySwap holds no funds. A provider balance rendered anywhere in this product is an OBSERVATION of money that lives at the provider, recorded with its provenance."
      >
        <div className="cc-stack">
          <p className="cc-section-intro">
            The recorded probe observed a test-mode external balance of{" "}
            <span className="ps-mono ps-num">6,978,366</span> USD minor units
            on the network operator&apos;s Stripe account (probe{" "}
            <span className="ps-mono">{coverage.probedAt}</span>, test mode).
            That number is shown here only as the honest example of the
            framing: it belongs to the provider account it was observed on,
            is bound to its provenance and date, and is never a PaySwap
            balance. No viewer balance is rendered — none exists.
          </p>
          {mtn !== undefined ? (
            <p className="cc-section-intro">
              Recorded non-connection example, verbatim from the release
              record — MTN MoMo: <StatusPill tone="blocked">BLOCKED</StatusPill>{" "}
              <span className="cc-actions__reason">{mtn.detail ?? mtn.verdict}</span>
            </p>
          ) : null}
        </div>
      </Panel>

      <CcConnectionSummary />

      <Panel
        title="Your connected capability instances"
        description="Connected instances enter this product exclusively through authority activation records — the provider catalogue is never executable authority (catalogue options are comparison-only in the Pay journey)."
      >
        <div className="cc-stack">
          <p className="cc-section-intro">
            No connected capability instances exist for this viewer yet — the
            connection plane (browser-authorized provider connections) ships
            with the authentication plane as the parallel work stream. When
            it lands, this list renders your instances with their health,
            coverage and honest limitations, derived from authority records.
          </p>
          <div className="cc-gate-links">
            <Link href="/connect">Connect a provider (the connection flows)</Link>
            <span className="cc-actions__reason">
              — linked by route string; the route resolves when the parallel
              plane merges.
            </span>
          </div>
        </div>
      </Panel>
    </div>
  );
}
