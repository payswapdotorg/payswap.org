import type { MandateRef } from "./principal.js";
import type {
  ActionPattern,
  AmountSpec,
  Mandate,
  ResourcePattern,
} from "./mandate.js";
import {
  actionPatternCoveredBy,
  compareAmounts,
  matchesActionPattern,
  matchesResourcePattern,
  resourcePatternCoveredBy,
  validateActionPattern,
  validateResourcePattern,
} from "./mandate.js";
import type { Principal } from "./principal.js";
import type { EpochLedger } from "./security-epoch.js";
import { StaleEpochError, checkEpoch } from "./security-epoch.js";

/**
 * Scoped execution grants (W2-002).
 *
 * A ScopedExecutionGrant is a NARROW, EXPIRING, REVOCABLE execution instrument
 * derived from a mandate (FROZEN-ARCHITECTURE §5, §20). Where a PermissionGrant
 * carries the full mandate lineage, a scoped grant is what an executor actually
 * presents at the moment of a sensitive delegated action:
 *
 * - narrow:  every dimension of `scope` must be covered by the parent mandate
 *            (validated at issue time when the mandate is supplied — an issue
 *            request that would widen fails closed and is rejected);
 * - expiring: `expiresAt` is strictly after `grantedAt` and never outlives the
 *            parent mandate;
 * - revocable: `revoke` is immediate and monotonic — once revoked, a grant can
 *            never authorize again, the revocation record is append-only and
 *            cannot be backdated or reversed.
 *
 * Revoked, expired or unresolvable scoped grants FAIL CLOSED everywhere:
 * `evaluate()` (see authorization.ts) denies the underlying permission grant
 * when its scoped execution path is dead, and `checkScopedGrant()` (the
 * sensitive-action guard, INV-S02) refuses to vouch for the grant.
 *
 * `conditions` are labels the issuing decision bound to this grant
 * (`decisionRef` identifies that decision). They are recorded for provenance
 * and replay; condition enforcement is owned by the decision pipeline, not by
 * this registry.
 */

/** Raised on any invalid scoped-grant operation (issue, revoke, lookup). */
export class ScopedGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopedGrantError";
  }
}

/**
 * The narrowing applied by a scoped grant. An absent dimension inherits the
 * parent mandate verbatim; a supplied dimension must be a subset of the parent
 * mandate's authority (checked at issue time when the mandate is supplied).
 */
export interface ScopedGrantScope {
  readonly actions?: readonly ActionPattern[];
  readonly resources?: readonly ResourcePattern[];
  readonly rails?: readonly string[];
  readonly currencies?: readonly string[];
  readonly countries?: readonly string[];
  readonly beneficiaries?: readonly string[];
  /** Narrowing per-transaction value ceiling (same currency, not wider). */
  readonly maxPerTransactionAmount?: AmountSpec;
}

/** A narrow, expiring, revocable execution grant derived from a mandate. */
export interface ScopedExecutionGrant {
  readonly id: string;
  readonly mandateRef: MandateRef;
  readonly scope: ScopedGrantScope;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly conditions: readonly string[];
  readonly decisionRef: string;
}

export interface IssueScopedGrantParams {
  readonly grantId: string;
  readonly mandateRef: MandateRef;
  /** Absent dimensions inherit the parent mandate. */
  readonly scope?: ScopedGrantScope;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly conditions: readonly string[];
  /** Reference to the authorization decision that produced this grant. */
  readonly decisionRef: string;
  /**
   * When supplied, `scope`/`expiresAt` are validated to be a genuine
   * narrowing of this mandate (fail closed). `mandateRef` must identify it.
   */
  readonly parentMandate?: Mandate;
}

/** Append-only revocation record: immediate, monotonic, never reversible. */
export interface ScopedGrantRevocation {
  readonly grantId: string;
  readonly revokedAt: number;
  readonly reason: string;
}

/** Lifecycle status of a scoped grant id at a given instant. */
export type ScopedGrantStatus = "ACTIVE" | "REVOKED" | "EXPIRED" | "UNKNOWN";

/** Result of the fail-closed sensitive-action guard (INV-S02). */
export type ScopedGrantCheck =
  | { readonly ok: true; readonly grant: ScopedExecutionGrant }
  | {
      readonly ok: false;
      readonly status: ScopedGrantStatus | "STALE_SECURITY_EPOCH";
      readonly reason: string;
    };

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new ScopedGrantError(`${label} must not be empty`);
  }
}

function validateScopeStructural(scope: ScopedGrantScope): void {
  if (scope.actions !== undefined) {
    if (scope.actions.length === 0) {
      throw new ScopedGrantError("scope.actions must not be empty when supplied");
    }
    for (const pattern of scope.actions) {
      validateActionPattern(pattern);
    }
  }
  if (scope.resources !== undefined) {
    if (scope.resources.length === 0) {
      throw new ScopedGrantError("scope.resources must not be empty when supplied");
    }
    for (const pattern of scope.resources) {
      validateResourcePattern(pattern);
    }
  }
  for (const dimension of ["rails", "currencies", "countries", "beneficiaries"] as const) {
    const values = scope[dimension];
    if (values !== undefined) {
      if (values.length === 0) {
        throw new ScopedGrantError(`scope.${dimension} must not be empty when supplied`);
      }
      for (const value of values) {
        requireNonEmpty(value, `scope.${dimension} entry`);
      }
    }
  }
}

function assertScopeCoveredByMandate(scope: ScopedGrantScope, mandate: Mandate): void {
  if (scope.actions !== undefined) {
    for (const pattern of scope.actions) {
      const covered = mandate.actions.some((parent) => actionPatternCoveredBy(pattern, parent));
      if (!covered) {
        throw new ScopedGrantError(
          `scoped grant action pattern '${pattern}' is not covered by the parent mandate [${mandate.actions.join(", ")}]`,
        );
      }
    }
  }
  if (scope.resources !== undefined) {
    for (const pattern of scope.resources) {
      const covered = mandate.resources.some((parent) => resourcePatternCoveredBy(pattern, parent));
      if (!covered) {
        throw new ScopedGrantError(
          `scoped grant resource pattern '${pattern.type}' is not covered by the parent mandate`,
        );
      }
    }
  }
  for (const dimension of ["rails", "currencies", "countries", "beneficiaries"] as const) {
    const child = scope[dimension];
    if (child !== undefined) {
      const parent = mandate[dimension];
      if (parent !== undefined) {
        for (const value of child) {
          if (!parent.includes(value)) {
            throw new ScopedGrantError(
              `scoped grant ${dimension} '${value}' is not permitted by the parent mandate`,
            );
          }
        }
      }
    }
  }
  const cap = scope.maxPerTransactionAmount;
  const parentCap = mandate.limits?.perTransactionAmount;
  if (cap !== undefined) {
    if (parentCap !== undefined) {
      if (cap.currency !== parentCap.currency) {
        throw new ScopedGrantError(
          `scoped grant per-transaction cap currency ${cap.currency} does not match the parent cap currency ${parentCap.currency}`,
        );
      }
      if (compareAmounts(cap, parentCap) > 0) {
        throw new ScopedGrantError(
          "scoped grant per-transaction cap exceeds the parent mandate cap",
        );
      }
    }
  }
}

/**
 * In-memory scoped-grant registry. Deterministic: issue order defines the
 * listing order; revocation history is append-only. The registry never
 * consults wall-clock time — every status question is answered `at` an
 * explicitly supplied instant.
 */
export class ScopedGrantRegistry {
  readonly #grants = new Map<string, ScopedExecutionGrant>();
  readonly #revocations = new Map<string, ScopedGrantRevocation>();
  readonly #revocationHistory: ScopedGrantRevocation[] = [];
  readonly #byMandate = new Map<string, ScopedExecutionGrant[]>();

  /** Issue a scoped execution grant (validating narrowing when the mandate is supplied). */
  issue(params: IssueScopedGrantParams): ScopedExecutionGrant {
    requireNonEmpty(params.grantId, "grantId");
    if (this.#grants.has(params.grantId)) {
      throw new ScopedGrantError(`scoped grant '${params.grantId}' already exists`);
    }
    requireNonEmpty(params.mandateRef.mandateId, "mandateRef.mandateId");
    if (params.mandateRef.version < 1) {
      throw new ScopedGrantError("mandateRef.version must be >= 1");
    }
    requireNonEmpty(params.decisionRef, "decisionRef");
    if (params.expiresAt <= params.grantedAt) {
      throw new ScopedGrantError(
        "scoped grant must expire strictly after it was granted (narrow, expiring instrument)",
      );
    }
    for (const condition of params.conditions) {
      requireNonEmpty(condition, "condition");
    }
    const scope = params.scope ?? {};
    validateScopeStructural(scope);
    const parent = params.parentMandate;
    if (parent !== undefined) {
      if (parent.id !== params.mandateRef.mandateId || parent.version !== params.mandateRef.version) {
        throw new ScopedGrantError(
          "parentMandate does not match mandateRef: the scoped grant must derive from the supplied mandate",
        );
      }
      if (params.expiresAt > parent.expiresAt) {
        throw new ScopedGrantError(
          "scoped grant expiry outlives the parent mandate (a child instrument can never outlive its mandate)",
        );
      }
      assertScopeCoveredByMandate(scope, parent);
    }
    const grant: ScopedExecutionGrant = Object.freeze({
      id: params.grantId,
      mandateRef: Object.freeze({ ...params.mandateRef }),
      scope: Object.freeze({ ...scope }),
      grantedAt: params.grantedAt,
      expiresAt: params.expiresAt,
      conditions: Object.freeze([...params.conditions]),
      decisionRef: params.decisionRef,
    });
    this.#grants.set(grant.id, grant);
    const key = mandateKey(grant.mandateRef);
    const existing = this.#byMandate.get(key);
    if (existing === undefined) {
      this.#byMandate.set(key, [grant]);
    } else {
      existing.push(grant);
    }
    return grant;
  }

  /**
   * Revoke a scoped grant. Immediate: from `revokedAt` onward the grant can
   * never authorize. Monotonic: the append-only revocation record cannot be
   * reversed, re-dated or re-issued; revoking an unknown or already-revoked
   * grant throws.
   */
  revoke(grantId: string, revokedAt: number, reason: string): ScopedGrantRevocation {
    const grant = this.#grants.get(grantId);
    if (grant === undefined) {
      throw new ScopedGrantError(`scoped grant '${grantId}' is unknown`);
    }
    requireNonEmpty(reason, "revocation reason");
    if (this.#revocations.has(grantId)) {
      throw new ScopedGrantError(
        `scoped grant '${grantId}' is already revoked: revocation is monotonic and cannot be reversed or repeated`,
      );
    }
    if (revokedAt < grant.grantedAt) {
      throw new ScopedGrantError(
        `revocation timestamp ${revokedAt} precedes the grant issue at ${grant.grantedAt}: revocations cannot be backdated`,
      );
    }
    const revocation: ScopedGrantRevocation = Object.freeze({
      grantId,
      revokedAt,
      reason,
    });
    this.#revocations.set(grantId, revocation);
    this.#revocationHistory.push(revocation);
    return revocation;
  }

  /** The grant with this id, when issued by this registry. */
  lookup(grantId: string): ScopedExecutionGrant | undefined {
    return this.#grants.get(grantId);
  }

  /**
   * Status of a scoped grant at an instant. Deterministic precedence:
   * REVOKED (from `revokedAt` on) beats EXPIRED (from `expiresAt` on); an id
   * never issued by this registry is UNKNOWN — which callers must treat as
   * fail-closed, never as authority.
   */
  status(grantId: string, at: number): ScopedGrantStatus {
    const grant = this.#grants.get(grantId);
    if (grant === undefined) {
      return "UNKNOWN";
    }
    const revocation = this.#revocations.get(grantId);
    if (revocation !== undefined && at >= revocation.revokedAt) {
      return "REVOKED";
    }
    if (at >= grant.expiresAt) {
      return "EXPIRED";
    }
    return "ACTIVE";
  }

  /** All scoped grants derived from one mandate, in issue order. */
  listForMandate(mandateRef: MandateRef): readonly ScopedExecutionGrant[] {
    return [...(this.#byMandate.get(mandateKey(mandateRef)) ?? [])];
  }

  /** Append-only revocation history, in revocation order. */
  revocations(): readonly ScopedGrantRevocation[] {
    return [...this.#revocationHistory];
  }
}

function mandateKey(ref: MandateRef): string {
  return `${ref.mandateId}@${ref.version}`;
}

/**
 * Fail-closed sensitive-action guard for scoped execution grants
 * (INV-A02/INV-S02: the security epoch is checked on every sensitive
 * delegated action; revoked/expired/unknown grants never vouch for one).
 *
 * Returns `{ ok: true }` ONLY when the grant is issued by the registry and
 * ACTIVE at `at`, and — when `principal` and `ledger` are supplied — the
 * principal's credential epoch is current. Any other combination returns a
 * refusal carrying the exact status; nothing is best-effort.
 */
export function checkScopedGrant(
  grantId: string,
  registry: ScopedGrantRegistry,
  at: number,
  principal?: Principal | undefined,
  ledger?: EpochLedger | undefined,
): ScopedGrantCheck {
  const status = registry.status(grantId, at);
  if (status === "UNKNOWN") {
    return {
      ok: false,
      status,
      reason: `scoped grant '${grantId}' was never issued: unresolvable references never vouch for authority`,
    };
  }
  if (status === "REVOKED") {
    return {
      ok: false,
      status,
      reason: `scoped grant '${grantId}' is revoked: revoked grants fail closed everywhere`,
    };
  }
  if (status === "EXPIRED") {
    return {
      ok: false,
      status,
      reason: `scoped grant '${grantId}' expired at ${registry.lookup(grantId)?.expiresAt ?? "?"}: expired grants fail closed everywhere`,
    };
  }
  if (principal !== undefined || ledger !== undefined) {
    if (principal === undefined || ledger === undefined) {
      throw new ScopedGrantError(
        "checkScopedGrant requires principal and ledger together: the epoch cannot be verified from half the inputs (fail closed)",
      );
    }
    try {
      checkEpoch(principal, ledger);
    } catch (error) {
      if (error instanceof StaleEpochError) {
        return {
          ok: false,
          status: "STALE_SECURITY_EPOCH",
          reason: `principal credential epoch is stale for scoped grant '${grantId}' (INV-A02/INV-S02)`,
        };
      }
      throw error;
    }
  }
  const grant = registry.lookup(grantId);
  if (grant === undefined) {
    // Unreachable (status was ACTIVE), but fail closed rather than assume.
    return {
      ok: false,
      status: "UNKNOWN",
      reason: `scoped grant '${grantId}' disappeared from the registry`,
    };
  }
  return { ok: true, grant };
}

/**
 * Structural predicate: does this action lie inside a scope's action
 * narrowing? Used by authorization evaluation when a permission grant's
 * scoped-execution paths are considered.
 */
export function scopeCoversAction(scope: ScopedGrantScope, action: string): boolean {
  if (scope.actions === undefined) {
    return true;
  }
  return scope.actions.some((pattern) => matchesActionPattern(pattern, action));
}

/**
 * Structural predicate: does this resource lie inside a scope's resource
 * narrowing?
 */
export function scopeCoversResource(scope: ScopedGrantScope, resource: {
  readonly type: string;
  readonly resourceId?: string;
}): boolean {
  if (scope.resources === undefined) {
    return true;
  }
  return scope.resources.some((pattern) => matchesResourcePattern(pattern, resource));
}
