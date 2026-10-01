/**
 * Network security epoch (W2-005; FROZEN-ARCHITECTURE §17; SECURITY-EVIDENCE-
 * RECOURSE.md "SecurityAdvisory can advance SecurityEpoch"; INV-S02, INV-A02).
 *
 * TWO epoch levels, deliberately composed and never duplicated:
 *
 * 1. NETWORK SecurityEpoch (this module): one monotonic counter for the whole
 *    network, advanced by security advisories (and any other immune-system
 *    response). Advancing it invalidates EVERY epoch-scoped authorization
 *    issued at a lower epoch — the global, advisory-driven hammer.
 *
 * 2. PER-PRINCIPAL credential epochs (@payswap/trust security-epoch.js,
 *    owned by W2-001 since Stage 0): each principal's credentials are stamped
 *    with the epoch at issuance; `checkEpoch` fails a principal whose
 *    credential epoch is behind the principal's current ledger epoch — the
 *    targeted, revocation-driven scalpel.
 *
 * `checkDelegatedSensitiveAction` runs BOTH: every sensitive delegated action
 * checks the network epoch (INV-S02) and, when the caller supplies the trust
 * epoch ledger, the acting principal's credential epoch (INV-A02). A stale
 * authorization can never authorize a sensitive action on either axis.
 *
 * Deterministic only: no ambient clock (callers pass `at`), no randomness;
 * monotonicity is enforced structurally.
 */

import type { EpochLedger, Principal } from "@payswap/trust";
import { checkEpoch, principalRef } from "@payswap/trust";

// ---------------------------------------------------------------------------
// Network security epoch
// ---------------------------------------------------------------------------

/**
 * One network-wide security epoch value with its advance metadata. `value`
 * starts at 0 (the implicit genesis epoch) and only ever increases.
 */
export interface SecurityEpoch {
  readonly value: bigint;
  /** When the epoch was advanced; never moves backwards (monotonic). */
  readonly advancedAt: number;
  readonly reason: string;
  /** The advisory that ordered the advance, when applicable. */
  readonly advisoryRef?: string;
}

/** Raised when an epoch advance is not strictly monotonic. */
export class NonMonotonicSecurityEpochError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonMonotonicSecurityEpochError";
  }
}

/**
 * Raised when an epoch-scoped authorization is stale relative to the current
 * network epoch (INV-S02: epoch is checked on every sensitive delegated
 * action; INV-A02: expired/revoked epochs cannot authorize sensitive actions).
 */
export class StaleAuthorizationEpochError extends Error {
  readonly authorizationRef: string;
  readonly issuedAtEpoch: bigint;
  readonly currentEpoch: bigint;

  constructor(
    authorizationRef: string,
    issuedAtEpoch: bigint,
    currentEpoch: bigint,
  ) {
    super(
      `Stale security epoch for authorization '${authorizationRef}': issued at epoch ${issuedAtEpoch}, current network epoch ${currentEpoch}`,
    );
    this.name = "StaleAuthorizationEpochError";
    this.authorizationRef = authorizationRef;
    this.issuedAtEpoch = issuedAtEpoch;
    this.currentEpoch = currentEpoch;
  }
}

/** Raised when an authorization is expired at evaluation time. */
export class AuthorizationExpiredError extends Error {
  readonly authorizationRef: string;
  readonly expiredAt: number;

  constructor(authorizationRef: string, expiredAt: number) {
    super(
      `Authorization '${authorizationRef}' expired at ${expiredAt} before the action was attempted`,
    );
    this.name = "AuthorizationExpiredError";
    this.authorizationRef = authorizationRef;
    this.expiredAt = expiredAt;
  }
}

/**
 * The network security epoch authority: monotonic counter + append-only
 * advance history (AGENTS.md rule 8: history is never rewritten).
 */
export class SecurityEpochAuthority {
  private current: SecurityEpoch = Object.freeze({
    value: 0n,
    advancedAt: 0,
    reason: "genesis: implicit epoch 0",
  });
  private readonly advanceHistory: SecurityEpoch[] = [this.current];

  /** Current network epoch (genesis epoch 0 until the first advance). */
  currentEpoch(): SecurityEpoch {
    return this.current;
  }

  /**
   * Advances the network epoch. The new value is strictly `previous + 1`;
   * `advancedAt` must never move backwards. Every epoch-scoped authorization
   * issued at a lower epoch becomes stale immediately (INV-S02).
   */
  advance(input: {
    reason: string;
    at: number;
    advisoryRef?: string;
  }): SecurityEpoch {
    if (input.reason.length === 0) {
      throw new NonMonotonicSecurityEpochError(
        "epoch advance reason must not be empty",
      );
    }
    if (input.at < this.current.advancedAt) {
      throw new NonMonotonicSecurityEpochError(
        `advancedAt ${input.at} is before the previous advance at ${this.current.advancedAt}`,
      );
    }
    const next: SecurityEpoch = Object.freeze({
      value: this.current.value + 1n,
      advancedAt: input.at,
      reason: input.reason,
      ...(input.advisoryRef === undefined
        ? {}
        : { advisoryRef: input.advisoryRef }),
    });
    this.current = next;
    this.advanceHistory.push(next);
    return next;
  }

  /** Append-only advance history, genesis first. */
  history(): readonly SecurityEpoch[] {
    return [...this.advanceHistory];
  }
}

// ---------------------------------------------------------------------------
// Epoch-scoped authorizations for sensitive delegated actions
// ---------------------------------------------------------------------------

/**
 * Sensitive action classes (SECURITY-EVIDENCE-RECOURSE.md "Delegation" /
 * signals). Every action in these classes MUST pass the epoch check; the list
 * is deliberately conservative — money movement, beneficiary/credential/
 * mandate changes and rail execution are the classes whose compromise is
 * consequential.
 */
export const SENSITIVE_ACTION_CLASSES = [
  "money_movement",
  "beneficiary_change",
  "credential_change",
  "mandate_change",
  "rail_execution",
] as const;

export type SensitiveActionClass = (typeof SENSITIVE_ACTION_CLASSES)[number];

export function isSensitiveActionClass(
  value: string,
): value is SensitiveActionClass {
  return (SENSITIVE_ACTION_CLASSES as readonly string[]).includes(value);
}

/**
 * An authorization for one sensitive delegated action, stamped with the
 * NETWORK epoch at which it was issued. When the network epoch advances past
 * `issuedAtEpoch`, this authorization is dead — no matter what else it says
 * (INV-S02, INV-A02).
 *
 * This is an immune-system CHECK contract, not an authority contract: the
 * signed approval artifact that creates real authority is owned by
 * @payswap/trust (INV-A03); the security layer only verifies epoch freshness
 * of whatever the trust plane already issued.
 */
export interface EpochScopedAuthorization {
  readonly authorizationRef: string;
  /** Principal (human or agent) the authorization was delegated to. */
  readonly principalRef: string;
  /** Acting agent key fingerprint, when the action is delegated to an agent. */
  readonly agentRef?: string;
  readonly actionClass: SensitiveActionClass;
  /** Network security epoch at issuance. */
  readonly issuedAtEpoch: bigint;
  /** Absolute expiry (deterministic: callers pass the evaluation time). */
  readonly expiresAt: number;
}

/** Result shape for the non-throwing variant of the epoch gate. */
export interface SensitiveActionEpochCheck {
  readonly authorizationRef: string;
  readonly allowed: boolean;
  readonly reason?: "stale_security_epoch" | "authorization_expired";
  readonly issuedAtEpoch: bigint;
  readonly currentEpoch: bigint;
}

function assertAuthorizationShape(
  authorization: EpochScopedAuthorization,
): void {
  if (authorization.authorizationRef.length === 0) {
    throw new Error("epoch-scoped authorization requires authorizationRef");
  }
  if (authorization.principalRef.length === 0) {
    throw new Error("epoch-scoped authorization requires principalRef");
  }
  if (!isSensitiveActionClass(authorization.actionClass)) {
    throw new Error(
      `unknown sensitive action class '${authorization.actionClass}'`,
    );
  }
}

/**
 * INV-S02 — the network-epoch gate for one sensitive delegated action.
 * Throws `StaleAuthorizationEpochError` when the authorization epoch is
 * behind the current network epoch, and `AuthorizationExpiredError` when the
 * authorization is expired at `at`. Deterministic: a pure function of
 * (authorization, authority state, at).
 */
export function checkSensitiveActionAuthorization(
  authorization: EpochScopedAuthorization,
  authority: SecurityEpochAuthority,
  at: number,
): void {
  assertAuthorizationShape(authorization);
  const current = authority.currentEpoch().value;
  if (authorization.issuedAtEpoch < current) {
    throw new StaleAuthorizationEpochError(
      authorization.authorizationRef,
      authorization.issuedAtEpoch,
      current,
    );
  }
  if (at > authorization.expiresAt) {
    throw new AuthorizationExpiredError(
      authorization.authorizationRef,
      authorization.expiresAt,
    );
  }
}

/** Non-throwing variant of the INV-S02 gate (same deterministic logic). */
export function evaluateSensitiveActionAuthorization(
  authorization: EpochScopedAuthorization,
  authority: SecurityEpochAuthority,
  at: number,
): SensitiveActionEpochCheck {
  try {
    checkSensitiveActionAuthorization(authorization, authority, at);
  } catch (error) {
    if (
      error instanceof StaleAuthorizationEpochError ||
      error instanceof AuthorizationExpiredError
    ) {
      return {
        authorizationRef: authorization.authorizationRef,
        allowed: false,
        reason:
          error instanceof StaleAuthorizationEpochError
            ? "stale_security_epoch"
            : "authorization_expired",
        issuedAtEpoch: authorization.issuedAtEpoch,
        currentEpoch: authority.currentEpoch().value,
      };
    }
    throw error;
  }
  return {
    authorizationRef: authorization.authorizationRef,
    allowed: true,
    issuedAtEpoch: authorization.issuedAtEpoch,
    currentEpoch: authority.currentEpoch().value,
  };
}

/**
 * The FULL delegated sensitive-action epoch gate (INV-S02 + INV-A02):
 *
 * 1. network epoch — the authorization must be issued at the CURRENT network
 *    security epoch (advisory-driven global invalidation);
 * 2. per-principal credential epoch — when a trust `EpochLedger` is
 *    supplied, the acting principal's credential epoch is checked through
 *    the trust plane's own `checkEpoch` (revocation-driven invalidation);
 * 3. temporal expiry at `at`.
 *
 * Throws StaleAuthorizationEpochError / AuthorizationExpiredError /
 * trust's StaleEpochError respectively. Fail-closed: any axis that cannot be
 * verified denies the action.
 */
export function checkDelegatedSensitiveAction(
  principal: Principal,
  authorization: EpochScopedAuthorization,
  authority: SecurityEpochAuthority,
  at: number,
  credentialEpochLedger?: EpochLedger,
): void {
  checkSensitiveActionAuthorization(authorization, authority, at);
  if (authorization.principalRef !== principalRef(principal)) {
    throw new Error(
      `authorization '${authorization.authorizationRef}' was delegated to '${authorization.principalRef}', not to the acting principal '${principalRef(principal)}'`,
    );
  }
  if (credentialEpochLedger !== undefined) {
    checkEpoch(principal, credentialEpochLedger);
  }
}
