/**
 * The security gate view (P4-W4-002 §3.4): the BLOCK/ALLOW/UNKNOWN gate
 * vocabulary rendered in people language — human headline first, the
 * person-actionable explanation, typed drill-down one explicit step away
 * (progressive disclosure: <details> never a raw dump), evidence refs
 * always visible. Consumes the @payswap/surface fold of the REAL
 * @payswap/onchain-security GateDecision — verdicts preserved verbatim.
 */

import type { GateDecision } from "@payswap/onchain-security";
import { foldGateDecision } from "@payswap/surface";

export function SecurityGateView({ decision }: { readonly decision: GateDecision }) {
  const view = foldGateDecision(decision);
  return (
    <section
      className={`cc-gate cc-gate--${view.tone}`}
      aria-labelledby={`cc-gate-${view.verdict.toLowerCase()}-heading`}
      data-verdict={view.verdict}
    >
      <h3 id={`cc-gate-${view.verdict.toLowerCase()}-heading`} className="cc-gate__headline">
        {view.headline}
      </h3>
      <p className="cc-gate__explanation">{view.explanation}</p>
      <details className="cc-gate__drilldown">
        <summary>The typed security detail</summary>
        <ul className="cc-gate__reasons">
          {view.drilldown.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </details>
      {view.evidenceRefs.length > 0 ? (
        <p className="cc-gate__evidence">
          Evidence: {view.evidenceRefs.join(", ")}
        </p>
      ) : (
        <p className="cc-gate__evidence cc-gate__evidence--none">
          No evidence references recorded for this evaluation.
        </p>
      )}
    </section>
  );
}
