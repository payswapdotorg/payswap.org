import type {
  AmountSpec,
  Mandate,
  PermissionGrant,
  ResourceRef,
} from "./mandate.js";
import {
  amountSpecToMoney,
  compareAmounts,
  matchesActionPattern,
  matchesResourcePattern,
} from "./mandate.js";
import { add, compare } from "@payswap/protocol";
import type { ScopedExecutionGrant, ScopedGrantRegistry } from "./grants.js";
import { scopeCoversAction, scopeCoversResource } from "./grants.js";
import type { Principal } from "./principal.js";
import { principalRef } from "./principal.js";
import type { EpochLedger } from "./security-epoch.js";
import { StaleEpochError, checkEpoch } from "./security-epoch.js";

/**
 * Deterministic authorization evaluation (FROZEN-ARCHITECTURE §4, §5).
 *
 * evaluate() is a pure function: the same request, grants and epoch state
 * always produce the same decision. It never consults wall-clock time, random
 * sources or external systems. Fail-closed semantics: a mandate dimension
 * that cannot be verified from the request context is treated as NOT
 * permitted, never as permitted.
 */

/** Context evidence presented with an authorization request. */
export interface AuthorizationContext {
  readonly amount?: AmountSpec;
  readonly rail?: string;
  readonly country?: string;
  readonly beneficiary?: string;
}

/** A request for authorization of one action on one resource. */
export interface AuthorizationRequest {
  readonly principal: Principal;
  readonly action: string;
  readonly resource: ResourceRef;
  readonly context: AuthorizationContext;
  readonly requestHash: string;
  readonly requestedAt: number;
}

export type DenyReason =
  | "stale_security_epoch"
  | "mandate_expired"
  | "action_not_permitted"
  | "resource_not_permitted"
  | "scope_not_permitted"
  | "per_transaction_limit_currency_mismatch"
  | "per_transaction_limit_exceeded"
  | "velocity_count_exceeded"
  | "velocity_amount_exceeded"
  | "no_matching_grant"
  /** W2-002: scoped execution grants fail closed (see ./grants.ts). */
  | "scoped_grant_revoked"
  | "scoped_grant_expired";

/** What an approval artifact authorizes (INV-A03). */
export interface ApprovalScope {
  readonly actions: readonly string[];
  readonly resources: readonly ResourceRef[];
  readonly maxAmount?: AmountSpec;
}

/** Specification of the approval needed to proceed (AGENTS.md rule 10). */
export interface ApprovalSpec {
  readonly approverRef: string;
  readonly requestHash: string;
  readonly scope: ApprovalScope;
  readonly expiresAt: number;
}

export type AuthorizationDecision =
  | { readonly decision: "ALLOW"; readonly evidenceRefs: readonly string[] }
  | { readonly decision: "DENY"; readonly reason: DenyReason; readonly policyRefs: readonly string[] }
  | { readonly decision: "NEEDS_APPROVAL"; readonly approvalSpec: ApprovalSpec };

/** Prior authorized activity, used for deterministic velocity evaluation. */
export interface UsageRecord {
  readonly granteeRef: string;
  readonly occurredAt: number;
  readonly amount?: AmountSpec;
}

/**
 * Evaluation state: the epoch ledger, (optional) prior usage history and
 * (optional, W2-002) the scoped-grant registry consulted for the scoped
 * execution path. Absent registry ⇒ Stage-0 semantics unchanged (no scoped
 * gate). Supplied registry ⇒ every covering scoped execution grant must be
 * live at `requestedAt`, else fail closed (see ./grants.ts).
 */
export interface EpochState {
  readonly ledger: EpochLedger;
  readonly usage?: readonly UsageRecord[];
  readonly scopedGrants?: ScopedGrantRegistry;
}

/**
 * Signed approval artifact (INV-A03): identifies principal, agent, scope,
 * expiry and request hash. A chat message is not authority; only such a
 * signed artifact is (AGENTS.md rule 10).
 */
export interface SignedApprovalArtifact {
  readonly principal: string;
  readonly agentRef?: string;
  readonly scope: ApprovalScope;
  readonly expiry: number;
  readonly requestHash: string;
  readonly signature: string;
  readonly issuedAt: number;
}

type MandateOutcome =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: DenyReason; readonly rank: number }
  | { readonly kind: "needs_approval"; readonly approverRef: string };

function deny(reason: DenyReason, rank: number): MandateOutcome {
  return { kind: "deny", reason, rank };
}

function invariantRefs(reason: DenyReason): readonly string[] {
  switch (reason) {
    case "stale_security_epoch":
      return ["INV-A02", "INV-S02"];
    case "scoped_grant_revoked":
    case "scoped_grant_expired":
      return ["INV-A02", "INV-S02", "INV-E01"];
    case "per_transaction_limit_exceeded":
    case "velocity_count_exceeded":
    case "velocity_amount_exceeded":
      return ["INV-A01"];
    case "per_transaction_limit_currency_mismatch":
      return ["INV-F01", "INV-A01"];
    default:
      return ["INV-A01"];
  }
}

function limitOutcome(mandate: Mandate, reason: DenyReason, rank: number): MandateOutcome {
  if (mandate.escalation?.onLimitExceeded === "require_approval") {
    return {
      kind: "needs_approval",
      approverRef: mandate.escalation.approverRef ?? mandate.grantor,
    };
  }
  return deny(reason, rank);
}

function evaluateMandate(
  request: AuthorizationRequest,
  granteeRef: string,
  mandate: Mandate,
  usage: readonly UsageRecord[],
): MandateOutcome {
  const context = request.context;

  if (request.requestedAt >= mandate.expiresAt) {
    return deny("mandate_expired", 0);
  }
  if (!mandate.actions.some((pattern) => matchesActionPattern(pattern, request.action))) {
    return deny("action_not_permitted", 1);
  }
  if (!mandate.resources.some((pattern) => matchesResourcePattern(pattern, request.resource))) {
    return deny("resource_not_permitted", 2);
  }

  // Scope dimensions: fail closed when a restricted dimension has no evidence.
  if (mandate.rails !== undefined && (context.rail === undefined || !mandate.rails.includes(context.rail))) {
    return deny("scope_not_permitted", 3);
  }
  if (
    mandate.currencies !== undefined &&
    (context.amount === undefined || !mandate.currencies.includes(context.amount.currency))
  ) {
    return deny("scope_not_permitted", 3);
  }
  if (
    mandate.countries !== undefined &&
    (context.country === undefined || !mandate.countries.includes(context.country))
  ) {
    return deny("scope_not_permitted", 3);
  }
  if (
    mandate.beneficiaries !== undefined &&
    (context.beneficiary === undefined || !mandate.beneficiaries.includes(context.beneficiary))
  ) {
    return deny("scope_not_permitted", 3);
  }

  const limits = mandate.limits;

  // Per-transaction limit. An action without an amount carries no per-transaction
  // value to bound; a limit in a different currency can never bound this amount.
  const perTransaction = limits?.perTransactionAmount;
  if (perTransaction !== undefined && context.amount !== undefined) {
    if (context.amount.currency !== perTransaction.currency) {
      return deny("per_transaction_limit_currency_mismatch", 4);
    }
    if (compareAmounts(context.amount, perTransaction) > 0) {
      return limitOutcome(mandate, "per_transaction_limit_exceeded", 5);
    }
  }

  // Velocity limit over the sliding window ending at requestedAt.
  //
  // W2-002 CONSOLIDATION: the running sum and the bound are exact protocol
  // Money values (add/compare from @payswap/protocol); the local bigint
  // duplicate of exact-amount arithmetic was removed.
  const velocity = limits?.velocity;
  if (velocity !== undefined) {
    const windowStart = request.requestedAt - velocity.windowMs;
    const inWindow = usage.filter(
      (record) =>
        record.granteeRef === granteeRef &&
        record.occurredAt > windowStart &&
        record.occurredAt <= request.requestedAt,
    );
    if (velocity.maxCount !== undefined && inWindow.length + 1 > velocity.maxCount) {
      return limitOutcome(mandate, "velocity_count_exceeded", 6);
    }
    const maxAmount = velocity.maxAmount;
    if (maxAmount !== undefined && context.amount !== undefined) {
      if (context.amount.currency !== maxAmount.currency) {
        return deny("per_transaction_limit_currency_mismatch", 4);
      }
      let sum = amountSpecToMoney(context.amount);
      for (const record of inWindow) {
        if (record.amount !== undefined && record.amount.currency === maxAmount.currency) {
          sum = add(sum, amountSpecToMoney(record.amount));
        }
      }
      if (compare(sum, amountSpecToMoney(maxAmount)) > 0) {
        return limitOutcome(mandate, "velocity_amount_exceeded", 6);
      }
    }
  }

  return { kind: "allow" };
}

/**
 * W2-002 scoped-execution gate (fail closed, INV-A02/INV-E01).
 *
 * Considered only when the evaluation state carries a ScopedGrantRegistry.
 * A permission grant whose mandate has derived scoped execution grants
 * COVERING this request (action + resource) can only ALLOW when at least one
 * covering scoped grant is ACTIVE at `requestedAt`. When every covering
 * scoped grant is dead, the grant's scoped execution path is dead and the
 * mandate cannot authorize at this instant:
 *
 *   - some covering grant REVOKED at requestedAt → scoped_grant_revoked
 *     (REVOKED is the strongest death: revocation is immediate and monotonic);
 *   - otherwise every covering grant EXPIRED → scoped_grant_expired.
 *
 * Scoped grants that do NOT cover this request never gate it: a narrowing
 * instrument that names other actions/resources is not this request's
 * execution path. Returns the vouching ACTIVE grant so ALLOW decisions can
 * carry its reference as authorization evidence (INV-E01).
 */
/** Result of the scoped-execution gate: pass (with optional vouching grant) or fail-closed deny. */
type ScopedGateResult =
  | { readonly pass: true; readonly vouchingGrant?: ScopedExecutionGrant }
  | { readonly pass: false; readonly reason: DenyReason };

function scopedExecutionGate(
  request: AuthorizationRequest,
  registry: ScopedGrantRegistry,
  mandate: Mandate,
): ScopedGateResult {
  const derived = registry.listForMandate({
    mandateId: mandate.id,
    version: mandate.version,
  });
  const covering = derived.filter(
    (candidate) =>
      scopeCoversAction(candidate.scope, request.action) &&
      scopeCoversResource(candidate.scope, request.resource),
  );
  if (covering.length === 0) {
    return { pass: true }; // no scoped instrument narrows this request; mandate governs
  }
  const activeAt = (candidate: ScopedExecutionGrant): boolean =>
    registry.status(candidate.id, request.requestedAt) === "ACTIVE";
  const vouching = covering.find(activeAt);
  if (vouching !== undefined) {
    return { pass: true, vouchingGrant: vouching };
  }
  const revoked = covering.some(
    (candidate) => registry.status(candidate.id, request.requestedAt) === "REVOKED",
  );
  return { pass: false, reason: revoked ? "scoped_grant_revoked" : "scoped_grant_expired" };
}

/**
 * Deterministically evaluate an authorization request against grants and
 * epoch state (INV-A01, INV-A02, INV-A03, INV-S02).
 *
 * Decision precedence: ALLOW (first fully-authorizing grant in array order)
 * beats NEEDS_APPROVAL, which beats the most informative DENY. A stale
 * security epoch denies immediately, before any mandate is considered.
 */
export function evaluate(
  request: AuthorizationRequest,
  grants: readonly PermissionGrant[],
  epochState: EpochState,
): AuthorizationDecision {
  try {
    checkEpoch(request.principal, epochState.ledger);
  } catch (error) {
    if (error instanceof StaleEpochError) {
      return {
        decision: "DENY",
        reason: "stale_security_epoch",
        policyRefs: [`principal:${error.principalRef}`, ...invariantRefs("stale_security_epoch")],
      };
    }
    throw error;
  }

  const ref = principalRef(request.principal);
  const usage = epochState.usage ?? [];

  let firstNeedsApproval: ApprovalSpec | undefined;
  let bestDeny: { reason: DenyReason; rank: number; policyRefs: readonly string[] } | undefined;

  for (const grant of grants) {
    if (grant.granteeRef !== ref) {
      continue;
    }
    const mandateRef = `mandate:${grant.mandate.id}@${grant.mandate.version}`;
    const outcome = evaluateMandate(request, ref, grant.mandate, usage);
    if (outcome.kind === "allow") {
      const registry = epochState.scopedGrants;
      if (registry !== undefined) {
        const gate = scopedExecutionGate(request, registry, grant.mandate);
        if (!gate.pass) {
          // Scoped-execution rank 7 outranks every mandate deny rank, so a dead
          // scoped path is always the most informative deny in the final answer.
          if (bestDeny === undefined || 7 > bestDeny.rank) {
            bestDeny = {
              reason: gate.reason,
              rank: 7,
              policyRefs: [mandateRef, ...invariantRefs(gate.reason)],
            };
          }
          continue;
        }
        const vouching = gate.vouchingGrant;
        return {
          decision: "ALLOW",
          evidenceRefs: [
            `grant:${grant.grantId}`,
            mandateRef,
            `lineage:${[grant.lineage.rootGrantId, ...grant.lineage.chain, grant.grantId].join(">")}`,
            `request:${request.requestHash}`,
            ...(vouching !== undefined ? [`scopedGrant:${vouching.id}`] : []),
          ],
        };
      }
      return {
        decision: "ALLOW",
        evidenceRefs: [
          `grant:${grant.grantId}`,
          mandateRef,
          `lineage:${[grant.lineage.rootGrantId, ...grant.lineage.chain, grant.grantId].join(">")}`,
          `request:${request.requestHash}`,
        ],
      };
    }
    if (outcome.kind === "needs_approval") {
      if (firstNeedsApproval === undefined) {
        firstNeedsApproval = {
          approverRef: outcome.approverRef,
          requestHash: request.requestHash,
          scope: {
            actions: [request.action],
            resources: [request.resource],
            ...(request.context.amount !== undefined
              ? { maxAmount: request.context.amount }
              : {}),
          },
          expiresAt: grant.mandate.expiresAt,
        };
      }
      continue;
    }
    if (bestDeny === undefined || outcome.rank > bestDeny.rank) {
      bestDeny = {
        reason: outcome.reason,
        rank: outcome.rank,
        policyRefs: [mandateRef, ...invariantRefs(outcome.reason)],
      };
    }
  }

  if (firstNeedsApproval !== undefined) {
    return { decision: "NEEDS_APPROVAL", approvalSpec: firstNeedsApproval };
  }
  if (bestDeny !== undefined) {
    return { decision: "DENY", reason: bestDeny.reason, policyRefs: bestDeny.policyRefs };
  }
  return {
    decision: "DENY",
    reason: "no_matching_grant",
    policyRefs: [`principal:${ref}`],
  };
}

export type ApprovalVerificationReason =
  | "missing_signature"
  | "expired"
  | "request_hash_mismatch"
  | "principal_mismatch"
  | "action_out_of_scope"
  | "resource_out_of_scope"
  | "amount_currency_mismatch"
  | "amount_exceeds_approval";

export type ApprovalVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: ApprovalVerificationReason };

/**
 * Verify a signed approval artifact against a request (INV-A03).
 *
 * Binding checks, in deterministic order: signature presence, expiry,
 * request-hash binding, approving principal / supervised agent binding,
 * action scope, resource scope, amount bound. Cryptographic signature
 * verification itself belongs to the trusted-surface boundary (W3-002);
 * here the signature is an opaque non-empty field.
 */
export function verifyApprovalArtifact(
  artifact: SignedApprovalArtifact,
  request: AuthorizationRequest,
  now: number,
): ApprovalVerification {
  if (artifact.signature.length === 0) {
    return { valid: false, reason: "missing_signature" };
  }
  if (now >= artifact.expiry) {
    return { valid: false, reason: "expired" };
  }
  if (artifact.requestHash !== request.requestHash) {
    return { valid: false, reason: "request_hash_mismatch" };
  }
  if (artifact.agentRef !== undefined && principalRef(request.principal) !== artifact.agentRef) {
    return { valid: false, reason: "principal_mismatch" };
  }
  if (!artifact.scope.actions.includes(request.action)) {
    return { valid: false, reason: "action_out_of_scope" };
  }
  const resourceInScope = artifact.scope.resources.some(
    (scoped) =>
      scoped.type === request.resource.type &&
      scoped.resourceId === request.resource.resourceId,
  );
  if (!resourceInScope) {
    return { valid: false, reason: "resource_out_of_scope" };
  }
  const maxAmount = artifact.scope.maxAmount;
  const requestAmount = request.context.amount;
  if (maxAmount !== undefined && requestAmount !== undefined) {
    if (requestAmount.currency !== maxAmount.currency) {
      return { valid: false, reason: "amount_currency_mismatch" };
    }
    if (compareAmounts(requestAmount, maxAmount) > 0) {
      return { valid: false, reason: "amount_exceeds_approval" };
    }
  }
  return { valid: true };
}

/**
 * Canonical signing payload for an approval artifact. The trusted approval
 * surface (W3-002) signs exactly this serialization.
 */
export function approvalSigningPayload(artifact: SignedApprovalArtifact): string {
  const parts = [
    `principal:${artifact.principal}`,
    artifact.agentRef === undefined ? "agent:-" : `agent:${artifact.agentRef}`,
    `actions:${artifact.scope.actions.join(",")}`,
    `resources:${artifact.scope.resources
      .map((resource) => `${resource.type}${resource.resourceId === undefined ? "" : ":" + resource.resourceId}`)
      .join(",")}`,
    artifact.scope.maxAmount === undefined
      ? "maxAmount:-"
      : `maxAmount:${artifact.scope.maxAmount.currency}:${artifact.scope.maxAmount.minorUnits}`,
    `expiry:${artifact.expiry}`,
    `requestHash:${artifact.requestHash}`,
    `issuedAt:${artifact.issuedAt}`,
  ];
  return parts.join("|");
}
