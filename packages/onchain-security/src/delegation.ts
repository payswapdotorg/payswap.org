/**
 * @payswap/onchain-security — scoped signing delegation (Work Order
 * P4-W1-002; AGENTS.md rule 9; INV-A01, INV-A02, INV-S02, INV-SC03).
 *
 * A SigningDelegation is the session-key / smart-account / scoped-signer
 * instrument through which delegated execution may reach a signing request.
 * It is built on the @payswap/trust substrate (Mandate + the
 * ScopedExecutionGrant discipline): attenuated (child ⊂ parent on every
 * dimension where the parent speaks), expiring (never outlives the parent
 * mandate), revocable (append-only, immediate, monotonic — mirroring the
 * trust package's ScopedGrantRegistry law).
 *
 * Attenuation dimensions validated at issue time against the parent
 * Mandate (rule 9 / INV-A01 — widening throws):
 *
 * - actions      ⊆ parent.actions;
 * - chains       ⊆ parent.rails (a chain IS an onchain rail value);
 * - assets       ⊆ parent.currencies (by symbol);
 * - destinations ⊆ parent.beneficiaries;
 * - spenders     — a NEW restricted dimension (the parent has none), so any
 *   supplied list is a pure narrowing;
 * - maxPerTransactionAmount ≤ parent.limits.perTransactionAmount;
 * - expiresAt    ≤ parent.expiresAt.
 *
 * Fail closed everywhere: revoked, expired and unknown delegations never
 * vouch for a signing request. Deterministic only: every status question is
 * answered `at` an explicitly supplied instant.
 */

import type { Mandate, MandateRef } from "@payswap/trust";
import type { ActionPattern, AmountSpec } from "@payswap/trust";
import { actionPatternCoveredBy, compareAmounts } from "@payswap/trust";
import { assertNoSecretMaterial } from "./secrets.js";
import type { ApprovalChangeRequest, AssetIdentity, ChainRef } from "./types.js";
import { sameAsset } from "./types.js";
import type { PreparedWrite } from "./write-intent.js";

/** Raised on any invalid delegation operation (issue, revoke, attenuation). */
export class SigningDelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningDelegationError";
  }
}

/** Raised when a child scope would widen the parent mandate (INV-A01). */
export class DelegationAttenuationError extends SigningDelegationError {
  constructor(message: string) {
    super(`Attenuation violation: ${message}`);
    this.name = "DelegationAttenuationError";
  }
}

/** The onchain narrowing applied by a signing delegation. */
export interface SigningDelegationScope {
  /** Trust action patterns (e.g. `onchain.transfer`); ⊆ parent actions. */
  readonly actions?: readonly ActionPattern[];
  /** Permitted chains; ⊆ parent rails when the parent restricts rails. */
  readonly chains?: readonly ChainRef[];
  /** Permitted assets; ⊆ parent currencies by symbol when restricted. */
  readonly assets?: readonly AssetIdentity[];
  /** Permitted destination addresses; ⊆ parent beneficiaries. */
  readonly destinations?: readonly string[];
  /** Permitted spender addresses for approval changes (pure narrowing). */
  readonly spenders?: readonly string[];
  /** Per-transaction value ceiling; ≤ the parent per-transaction limit. */
  readonly maxPerTransactionAmount?: AmountSpec;
}

/** Delegation method (FROZEN-ARCHITECTURE §12 smart-account session keys). */
export type SigningDelegationMethod = "session_key" | "smart_account" | "scoped_signer";

/** A narrow, expiring, revocable signing delegation derived from a mandate. */
export interface SigningDelegation {
  readonly id: string;
  readonly parentMandate: MandateRef;
  readonly granteeRef: string;
  readonly method: SigningDelegationMethod;
  readonly scope: SigningDelegationScope;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly conditions: readonly string[];
  /** Reference to the authorization decision that produced this delegation. */
  readonly decisionRef: string;
}

/** Append-only, immediate, monotonic revocation record. */
export interface SigningDelegationRevocation {
  readonly delegationId: string;
  readonly revokedAt: number;
  readonly reason: string;
}

export type SigningDelegationStatus = "ACTIVE" | "REVOKED" | "EXPIRED" | "UNKNOWN";

export interface IssueSigningDelegationParams {
  readonly delegationId: string;
  readonly parentMandate: Mandate;
  readonly granteeRef: string;
  readonly method: SigningDelegationMethod;
  readonly scope: SigningDelegationScope;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly conditions: readonly string[];
  readonly decisionRef: string;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new SigningDelegationError(`${label} must be a non-empty string`);
  }
}

function assertScopeAttenuated(
  dimension: string,
  child: readonly string[] | undefined,
  parent: readonly string[] | undefined,
): void {
  if (parent !== undefined && child !== undefined) {
    for (const value of child) {
      if (!parent.includes(value)) {
        throw new DelegationAttenuationError(
          `chains/'${dimension}' value '${value}' is not permitted by the parent mandate`,
        );
      }
    }
  }
}

/**
 * Derive a signing delegation from a parent Mandate, validating full
 * attenuation (INV-A01). The delegation is frozen and content of record;
 * the registry below owns its lifecycle.
 */
export function deriveSigningDelegation(params: IssueSigningDelegationParams): SigningDelegation {
  assertNoSecretMaterial(params, "signing delegation issue");
  requireNonEmpty(params.delegationId, "delegationId");
  requireNonEmpty(params.granteeRef, "granteeRef");
  requireNonEmpty(params.decisionRef, "decisionRef");
  const parent = params.parentMandate;
  if (params.parentMandate.id !== params.delegationId && params.delegationId.length === 0) {
    throw new SigningDelegationError("unreachable");
  }

  // actions ⊆ parent.actions
  if (params.scope.actions !== undefined) {
    if (params.scope.actions.length === 0) {
      throw new SigningDelegationError("scope.actions must not be empty when supplied");
    }
    for (const pattern of params.scope.actions) {
      const covered = parent.actions.some((parentPattern) =>
        actionPatternCoveredBy(pattern, parentPattern),
      );
      if (!covered) {
        throw new DelegationAttenuationError(
          `action pattern '${pattern}' is not covered by the parent mandate actions [${parent.actions.join(", ")}]`,
        );
      }
    }
  }

  // chains ⊆ parent.rails (chain-as-rail convention for onchain mandates)
  assertScopeAttenuated("chains", params.scope.chains, parent.rails);

  // assets ⊆ parent.currencies (by symbol)
  if (params.scope.assets !== undefined && parent.currencies !== undefined) {
    if (params.scope.assets.length === 0) {
      throw new SigningDelegationError("scope.assets must not be empty when supplied");
    }
    for (const asset of params.scope.assets) {
      if (!parent.currencies.includes(asset.symbol)) {
        throw new DelegationAttenuationError(
          `asset symbol '${asset.symbol}' is not a parent-mandate currency [${parent.currencies.join(", ")}]`,
        );
      }
    }
  }

  // destinations ⊆ parent.beneficiaries
  assertScopeAttenuated("destinations", params.scope.destinations, parent.beneficiaries);

  // spenders: a NEW dimension — any list is a pure narrowing of an unrestricted parent
  if (params.scope.spenders !== undefined && params.scope.spenders.length === 0) {
    throw new SigningDelegationError("scope.spenders must not be empty when supplied");
  }

  // maxPerTransactionAmount ≤ parent limit
  const cap = params.scope.maxPerTransactionAmount;
  const parentCap = parent.limits?.perTransactionAmount;
  if (cap !== undefined && parentCap !== undefined) {
    if (cap.currency !== parentCap.currency) {
      throw new DelegationAttenuationError(
        `per-transaction cap currency ${cap.currency} does not match the parent cap currency ${parentCap.currency}`,
      );
    }
    if (compareAmounts(cap, parentCap) > 0) {
      throw new DelegationAttenuationError(
        `per-transaction cap ${cap.minorUnits} ${cap.currency} exceeds the parent cap ${parentCap.minorUnits}`,
      );
    }
  }

  // expiry: strictly after grant, never outliving the parent
  if (params.expiresAt <= params.grantedAt) {
    throw new SigningDelegationError(
      "delegation must expire strictly after it was granted (narrow, expiring instrument)",
    );
  }
  if (params.expiresAt > parent.expiresAt) {
    throw new DelegationAttenuationError(
      `delegation expiry ${params.expiresAt} outlives the parent mandate expiry ${parent.expiresAt}`,
    );
  }

  return Object.freeze({
    id: params.delegationId,
    parentMandate: Object.freeze({ mandateId: parent.id, version: parent.version }),
    granteeRef: params.granteeRef,
    method: params.method,
    scope: Object.freeze(params.scope),
    grantedAt: params.grantedAt,
    expiresAt: params.expiresAt,
    conditions: Object.freeze([...params.conditions]),
    decisionRef: params.decisionRef,
  });
}

/**
 * In-memory signing-delegation registry. Deterministic (issue order), with
 * append-only immediate monotonic revocation — the same law as trust's
 * ScopedGrantRegistry. Never consults wall-clock time.
 */
export class SigningDelegationRegistry {
  readonly #delegations = new Map<string, SigningDelegation>();
  readonly #revocations = new Map<string, SigningDelegationRevocation>();
  readonly #revocationHistory: SigningDelegationRevocation[] = [];

  /** Issue (derive + register) a scoped signing delegation. */
  issue(params: IssueSigningDelegationParams): SigningDelegation {
    if (this.#delegations.has(params.delegationId)) {
      throw new SigningDelegationError(`delegation '${params.delegationId}' already exists`);
    }
    const delegation = deriveSigningDelegation(params);
    this.#delegations.set(delegation.id, delegation);
    return delegation;
  }

  /** Revoke immediately and monotonically; cannot be reversed or repeated. */
  revoke(delegationId: string, revokedAt: number, reason: string): SigningDelegationRevocation {
    const delegation = this.#delegations.get(delegationId);
    if (delegation === undefined) {
      throw new SigningDelegationError(`delegation '${delegationId}' is unknown`);
    }
    requireNonEmpty(reason, "revocation reason");
    if (this.#revocations.has(delegationId)) {
      throw new SigningDelegationError(
        `delegation '${delegationId}' is already revoked: revocation is monotonic and cannot be reversed or repeated`,
      );
    }
    if (revokedAt < delegation.grantedAt) {
      throw new SigningDelegationError(
        `revocation timestamp ${revokedAt} precedes the delegation issue at ${delegation.grantedAt}: revocations cannot be backdated`,
      );
    }
    const revocation: SigningDelegationRevocation = Object.freeze({
      delegationId,
      revokedAt,
      reason,
    });
    this.#revocations.set(delegationId, revocation);
    this.#revocationHistory.push(revocation);
    return revocation;
  }

  lookup(delegationId: string): SigningDelegation | undefined {
    return this.#delegations.get(delegationId);
  }

  /** Status at an instant: REVOKED beats EXPIRED; unknown ids are UNKNOWN (fail closed). */
  status(delegationId: string, at: number): SigningDelegationStatus {
    const delegation = this.#delegations.get(delegationId);
    if (delegation === undefined) {
      return "UNKNOWN";
    }
    const revocation = this.#revocations.get(delegationId);
    if (revocation !== undefined && at >= revocation.revokedAt) {
      return "REVOKED";
    }
    if (at >= delegation.expiresAt) {
      return "EXPIRED";
    }
    return "ACTIVE";
  }

  /** Append-only revocation history, in revocation order. */
  revocations(): readonly SigningDelegationRevocation[] {
    return [...this.#revocationHistory];
  }
}

/**
 * Does an ACTIVE delegation's scope cover a prepared write? Fail closed on
 * every dimension: an uncovered action, chain, asset, destination, spender
 * or per-transaction amount means NO.
 */
export function delegationCoversWrite(delegation: SigningDelegation, write: PreparedWrite): boolean {
  const scope = delegation.scope;
  if (scope.actions !== undefined) {
    const covered = scope.actions.some((pattern) => pattern === write.action || (pattern.endsWith("*") && write.action.startsWith(pattern.slice(0, -1))));
    if (!covered) {
      return false;
    }
  }
  if (scope.chains !== undefined && !scope.chains.includes(write.chain)) {
    return false;
  }
  const cap = scope.maxPerTransactionAmount;
  const transferAmount = write.transfer?.amount;
  if (cap !== undefined && transferAmount !== undefined) {
    if (transferAmount.currency !== cap.currency || compareAmounts(transferAmount, cap) > 0) {
      return false;
    }
  }
  if (scope.assets !== undefined && write.transfer !== undefined) {
    if (!scope.assets.some((asset) => sameAsset(asset, write.transfer!.asset))) {
      return false;
    }
  }
  if (scope.destinations !== undefined && write.transfer !== undefined) {
    if (!scope.destinations.includes(write.transfer.to)) {
      return false;
    }
  }
  if (scope.spenders !== undefined) {
    for (const approval of write.approvals) {
      if (!scope.spenders.includes(approval.spender)) {
        return false;
      }
    }
  }
  return true;
}

/** Convenience: the approval-change list must be covered as well (exact helper used by verify). */
export function approvalsCovered(
  scope: SigningDelegationScope,
  approvals: readonly ApprovalChangeRequest[],
): boolean {
  if (scope.spenders !== undefined) {
    return approvals.every((approval) => scope.spenders!.includes(approval.spender));
  }
  return true;
}
