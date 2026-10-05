/**
 * The outcome launcher (P4-W4-002 §3.1): the five outcome-level actions —
 * Pay / Receive / Move / Convert / Checkout — as the universal interface's
 * PRIMARY surface. Each card renders the outcome line (the simple view)
 * with the advanced disclosure one explicit step away (<details>), and
 * links to the action's REAL journey route (never a dead button).
 *
 * The capability state comes from the @payswap/surface registry fold over
 * the deployment's ACTUAL configured facts — an undispatchable action
 * says exactly that, with its typed prerequisite, instead of pretending.
 */

import {
  OUTCOME_REGISTRY,
  outcomeCapabilityBoard,
  type OutcomeDeploymentContext,
} from "@payswap/surface";

const OUTCOME_HREF: Readonly<Record<string, string>> = Object.freeze({
  pay: "/app/payments?start=1",
  receive: "/app/collections?start=1",
  move: "/app/payouts?start=1",
  convert: "/app/convert",
  checkout: "/app/checkout",
} as const);

export function OutcomeLauncher({
  deployment,
}: {
  readonly deployment: OutcomeDeploymentContext;
}) {
  const board = outcomeCapabilityBoard(deployment);
  return (
    <nav aria-labelledby="cc-outcomes-heading" className="cc-outcomes">
      <h2 id="cc-outcomes-heading" className="cc-section-heading">
        What would you like to do?
      </h2>
      <ul className="cc-outcomes__grid">
        {board.map(({ action, state }) => (
          <li key={action.id} className="cc-outcome-card" data-dispatchable={state.dispatchable}>
            <a className="cc-outcome-card__link" href={OUTCOME_HREF[action.id] ?? "/app"}>
              <span className="cc-outcome-card__label">{action.label}</span>
              <span className="cc-outcome-card__line">{action.outcomeLine}</span>
              {state.dispatchable ? (
                <span className="cc-outcome-card__state cc-outcome-card__state--ready">
                  Ready — opens the real journey
                </span>
              ) : (
                <span className="cc-outcome-card__state cc-outcome-card__state--blocked">
                  Not dispatchable in this deployment — the honest reason below
                </span>
              )}
            </a>
            {!state.dispatchable && state.missingPrerequisite !== undefined ? (
              <details className="cc-outcome-card__prerequisite">
                <summary>Why this is not dispatchable yet</summary>
                <p>{state.missingPrerequisite}</p>
              </details>
            ) : null}
            <details className="cc-outcome-card__advanced">
              <summary>What the advanced view discloses</summary>
              <ul>
                {action.advancedDisclosure.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export const OUTCOME_ACTION_REGISTRY = OUTCOME_REGISTRY;
