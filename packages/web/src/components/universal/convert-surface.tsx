/**
 * The Convert outcome journey surface (P4-W4-002 §3.1 "Convert").
 *
 * Progressive disclosure, per the Stripe research (workflow-patterns.md /
 * component-patterns.md): the SIMPLE view is the outcome line — the
 * request summary and what the compiled route plan honestly says; the
 * ADVANCED view (explicit drill-down) carries every plan, leg by leg,
 * with verbatim ineligibility reasons and exclusions.
 *
 * Honesty law: this surface renders what the deployment ACTUALLY has. It
 * folds a REAL route-compiler compilation when one was produced
 * server-side; with no onchain lane/venue observations configured (the
 * deployment fact today) it renders the typed NOT-DISPATCHABLE state with
 * its prerequisite — never a fabricated route, never a dead button (the
 * drill-downs are real disclosures, the next-action links resolve).
 */

import type { ConvertPreviewView, OutcomeDeploymentContext } from "@payswap/surface";
import { convertRequestSummary, outcomeActionById } from "@payswap/surface";
import type { RouteCompilationDisclosureSource } from "@payswap/surface";
import { foldRouteCompilation } from "@payswap/surface";

import { ModeIndicator } from "./mode-indicator";
import { SecurityGateView } from "./security-gate-view";
import type { GateDecision } from "@payswap/onchain-security";

export interface ConvertSurfaceProps {
  /** The deployment facts the capability fold runs over. */
  readonly deployment: OutcomeDeploymentContext;
  /** A REAL compilation result produced server-side, if one exists. */
  readonly compilation?: RouteCompilationDisclosureSource;
  /** The request the compilation was produced for (display only). */
  readonly request?: {
    readonly sourceCurrency: string;
    readonly targetCurrency: string;
    readonly amountMinorUnits: bigint;
  };
  /** The security gates the route legs actually evaluated (if any). */
  readonly gateDecisions?: readonly GateDecision[];
}

export function ConvertJourneySurface({
  deployment,
  compilation,
  request,
  gateDecisions,
}: ConvertSurfaceProps) {
  const action = outcomeActionById("convert");
  const capability = action.capability(deployment);
  const view: ConvertPreviewView | null =
    compilation !== undefined ? foldRouteCompilation(compilation) : null;

  return (
    <section aria-labelledby="cc-convert-heading" className="cc-stack">
      <div>
        <h2 id="cc-convert-heading" className="cc-section-heading">
          Convert
        </h2>
        <p className="cc-section-intro">{action.outcomeLine}</p>
      </div>
      <ModeIndicator testOrLive="TEST" onchain testnet modeLocked />
      {request !== undefined ? (
        <p className="cc-convert-request" data-testid="convert-request">
          {convertRequestSummary({
            sourceCurrency: request.sourceCurrency,
            targetCurrency: request.targetCurrency,
            amountMinorUnits: request.amountMinorUnits,
          })}
        </p>
      ) : null}
      {capability.dispatchable && view !== null ? (
        <div className="cc-convert-result" data-nothing-executable={view.nothingExecutable}>
          <p className="cc-convert-outcome" data-testid="convert-outcome">
            {view.outcomeLine}
          </p>
          <dl className="cc-convert-counts">
            <dt>Plans</dt>
            <dd>{view.counts.totalPlans}</dd>
            <dt>Executable now</dt>
            <dd>{view.counts.executable}</dd>
            <dt>Provider-native baselines</dt>
            <dd>{view.counts.baselines}</dd>
            <dt>Ineligible (reasons disclosed)</dt>
            <dd>{view.counts.ineligible}</dd>
            <dt>Excluded shapes</dt>
            <dd>{view.counts.excludedShapes}</dd>
          </dl>
          <details className="cc-convert-advanced">
            <summary>Every plan, leg by leg</summary>
            <ul className="cc-convert-plans">
              {view.plans.map((plan) => (
                <li key={plan.planId} data-candidate-status={plan.candidateStatus}>
                  <p>
                    <strong>{plan.shapeId}</strong> — {plan.candidateStatus} ·{" "}
                    {plan.compositionClass}
                  </p>
                  <p className="cc-convert-legchain">{plan.legChain.join(" → ")}</p>
                  <p className="cc-convert-baseline-note">{plan.baselineNote}</p>
                  {plan.ineligibilityReasons.length > 0 ? (
                    <ul className="cc-convert-reasons">
                      {plan.ineligibilityReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
            {view.exclusions.length > 0 ? (
              <div className="cc-convert-exclusions">
                <h3>Excluded shapes (never silently dropped)</h3>
                <ul>
                  {view.exclusions.map((exclusion) => (
                    <li key={exclusion.shapeId}>
                      {exclusion.shapeId}: {exclusion.reasons.join("; ")}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </details>
        </div>
      ) : (
        <div className="cc-convert-unavailable" role="status">
          <h3>No compiled conversion to show — and none invented</h3>
          <p>{capability.missingPrerequisite}</p>
          <details className="cc-convert-journey-contract">
            <summary>What this journey walks when inputs exist</summary>
            <ul>
              {action.advancedDisclosure.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>
              The fold itself is the versioned @payswap/surface contract — the
              same one a future extension or mobile app consumes.
            </p>
          </details>
        </div>
      )}
      {gateDecisions !== undefined && gateDecisions.length > 0 ? (
        <div className="cc-convert-gates">
          <h3>The security gates this route evaluated</h3>
          {gateDecisions.map((decision, index) => (
            <SecurityGateView key={index} decision={decision} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
