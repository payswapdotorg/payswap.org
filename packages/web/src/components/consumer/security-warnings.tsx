/**
 * UX-006 — the security warnings list (contract 10 §5 → security contract
 * §4.4): active security notices rendered with an ATTACK EXPLANATION — the
 * message explains the attack, not the protocol ("This site is asking for a
 * signature that could move your funds…"), and says what to do.
 *
 * Honest by construction: warnings arrive from a real risk plane; with none
 * recorded, the honest empty renders (never an invented warning — risk
 * sections never fabricate, security contract §4.6).
 */

import { EmptyState } from "@payswap/design";

/** One active security warning (attack-explained, in human language). */
export interface SecurityWarningRecord {
  readonly id: string;
  readonly title: string;
  /**
   * The attack explanation: what is happening, what it could cost, and what
   * to do — plain words, no protocol jargon (security contract §4.4).
   */
  readonly explanation: string;
  /** The plain-language next action. */
  readonly action: string;
}

export function SecurityWarnings({
  warnings,
}: {
  readonly warnings: readonly SecurityWarningRecord[];
}) {
  if (warnings.length === 0) {
    return (
      <EmptyState
        title="No active warnings"
        description={
          <>
            The moment anything needs your attention — an unusual attempt to
            move money, a request that looks like a scam, a permission that
            changed — it appears here with an explanation of what is
            happening and what to do. Silence here means nothing is recorded,
            not that checks are off.
          </>
        }
        teachingLine="Risk insights are only available for live data — none is fabricated for test records."
        data-testid="safety-warnings-empty"
      />
    );
  }
  return (
    <ul className="cc-stack" data-testid="safety-warnings-list">
      {warnings.map((warning) => (
        <li key={warning.id} className="cc-card" data-testid={`safety-warning-${warning.id}`}>
          <p className="cc-card__title">{warning.title}</p>
          <p className="cc-actions__reason">{warning.explanation}</p>
          <p className="cc-card__meta">
            <strong>What to do:</strong> {warning.action}
          </p>
        </li>
      ))}
    </ul>
  );
}
