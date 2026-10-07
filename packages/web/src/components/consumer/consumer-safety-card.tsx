/**
 * UX-006 — the consumer safety card (contract 10 §3.4): the home's window
 * into the safety center — the spending-permissions state, the
 * active-warnings state, and [Review].
 *
 * Honest by construction: the facts arrive from the safety planes; when no
 * plane records anything, the card states that plainly (never a fabricated
 * permission count or an invented warning). [Review] routes to /app/safety.
 */

import Link from "next/link";

export interface ConsumerSafetyFacts {
  /**
   * The granted spending-permission records (human-scoped rows for the
   * center); empty is the honest zero-record state.
   */
  readonly permissions: readonly {
    readonly id: string;
    readonly grantee: string;
    readonly scopeSentence: string;
  }[];
  /**
   * The active security-warning records (attack-explained notices for the
   * center); empty is the honest none-active state.
   */
  readonly warnings: readonly {
    readonly id: string;
    readonly title: string;
    readonly explanation: string;
  }[];
}

export function ConsumerSafetyCard({ facts }: { readonly facts: ConsumerSafetyFacts }) {
  return (
    <section className="cc-card" aria-labelledby="cc-consumer-safety-heading" data-testid="consumer-safety-card">
      <div className="cc-card__head">
        <h2 id="cc-consumer-safety-heading" className="cc-card__title">
          Safety
        </h2>
        <Link className="ps-button ps-button--sm ps-button--secondary" href="/app/safety">
          Review
        </Link>
      </div>
      <div className="cc-stack">
        <p className="cc-actions__reason" data-testid="consumer-safety-permissions">
          {facts.permissions.length > 0
            ? `${facts.permissions.length} spending ${facts.permissions.length === 1 ? "permission" : "permissions"} granted — each names who can spend and how much.`
            : "No spending permissions granted — when you allow a service to spend on your behalf, it appears here in plain words, and you can revoke it at any time."}
        </p>
        <p className="cc-actions__reason" data-testid="consumer-safety-warnings">
          {facts.warnings.length > 0
            ? `${facts.warnings.length} active ${facts.warnings.length === 1 ? "warning" : "warnings"} — each explains, in plain words, what is happening and what to do.`
            : "No active warnings — the moment anything needs your attention, it appears here with an explanation of what it means and what to do."}
        </p>
      </div>
    </section>
  );
}
