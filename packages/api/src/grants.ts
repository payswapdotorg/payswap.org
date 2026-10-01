/**
 * @payswap/api — scoped execution grants (W3-002).
 *
 * Wraps @payswap/trust authorization evaluation:
 * - a ScopedExecutionGrant is issued ONLY from an ALLOW decision (deterministic
 *   re-evaluation via trust `evaluate()`) or from an approved NEEDS_APPROVAL
 *   flow (a verified, unexpired, unconsumed SignedApprovalArtifact — INV-A03);
 * - every grant carries its authorization lineage
 *   `AuthorizationLineage { decisionRef, approvalArtifactRef?, grantRef }`:
 *   approved actions CARRY their lineage (W3-002 acceptance; INV-E01);
 * - revoked/expired authority fails closed: epoch staleness is re-checked at
 *   issuance (INV-A02), approval artifacts are verified for real signature,
 *   expiry and request binding (trust `verifyApprovalArtifact` + the approval
 *   service's HMAC verification), and artifacts are single-redemption.
 *
 * No financial finality is declared here: a grant authorizes execution, it
 * never settles anything (AGENTS.md rule 5).
 */

import type { IdFactory, PaySwapErrorDetails, ProtocolClock } from '@payswap/protocol';
import { PaySwapError } from '@payswap/protocol';
import type {
  AmountSpec,
  AuthorizationDecision,
  AuthorizationRequest,
  EpochLedger,
  PermissionGrant,
  Principal,
  ResourceRef,
  SignedApprovalArtifact,
} from '@payswap/trust';
import { checkEpoch, evaluate, matchesActionPattern, matchesResourcePattern, principalRef, verifyApprovalArtifact } from '@payswap/trust';

import type { ApprovalService } from './approvals.js';

/** Authorization lineage: how this grant came to exist (INV-E01). */
export interface AuthorizationLineage {
  /** Reference to the authorization decision that produced the grant. */
  readonly decisionRef: string;
  /** Present iff the grant was issued from an approved NEEDS_APPROVAL flow (INV-A03). */
  readonly approvalArtifactRef?: string;
  /** This grant's own reference. */
  readonly grantRef: string;
}

/** The execution scope a grant authorizes: one action, one resource, one amount bound. */
export interface GrantScope {
  readonly action: string;
  readonly resource: ResourceRef;
  readonly amount?: AmountSpec;
}

/** A scoped, short-lived execution credential with full authorization lineage. */
export interface ScopedExecutionGrant {
  readonly grantId: string;
  readonly tenantId: string;
  readonly principal: Principal;
  readonly scope: GrantScope;
  readonly lineage: AuthorizationLineage;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Adjudication outcome: exactly one of grant issued / needs approval / denied. */
export type AdjudicationResult =
  | {
      readonly kind: 'GRANT_ISSUED';
      readonly grant: ScopedExecutionGrant;
      readonly decision: Extract<AuthorizationDecision, { decision: 'ALLOW' }>;
    }
  | {
      readonly kind: 'NEEDS_APPROVAL';
      readonly decision: Extract<AuthorizationDecision, { decision: 'NEEDS_APPROVAL' }>;
    }
  | {
      readonly kind: 'DENIED';
      readonly decision: Extract<AuthorizationDecision, { decision: 'DENY' }>;
    };

/** Raised when a grant is requested without an authorizing decision. */
export class GrantNotAuthorizedError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'GRANT_NOT_AUTHORIZED', category: 'POLICY_BLOCKED', message, details });
  }
}

/** Raised when an approval artifact cannot back grant issuance (fail closed). */
export class ApprovalArtifactRejectedError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'APPROVAL_ARTIFACT_REJECTED', category: 'AUTHORIZATION_REQUIRED', message, details });
  }
}

export interface GrantAuthorityDeps {
  readonly clock: ProtocolClock;
  readonly ids: IdFactory;
  /** The mandate-backed permission grants backing deterministic evaluation. */
  readonly grants: readonly PermissionGrant[];
  readonly epochLedger: EpochLedger;
  /** Trusted approval surface used to verify approval artifacts (real signatures). */
  readonly approvals: ApprovalService;
}

export interface AdjudicateInput {
  readonly tenantId: string;
  readonly principal: Principal;
  readonly request: AuthorizationRequest;
}

export interface IssueFromApprovalInput {
  readonly tenantId: string;
  readonly principal: Principal;
  readonly request: AuthorizationRequest;
  readonly approvalArtifactRef: string;
}

/** Fallback grant authority window when the allowing mandate cannot be identified. */
const DEFAULT_GRANT_TTL_MS = 300_000;

/**
 * The grant authority: deterministic authorization evaluation + scoped grant
 * issuance. One instance owns one grants configuration and one epoch ledger;
 * all timing comes from the injected clock, all ids from the injected factory.
 */
export class GrantAuthority {
  readonly #clock: ProtocolClock;
  readonly #ids: IdFactory;
  readonly #grants: readonly PermissionGrant[];
  readonly #epochLedger: EpochLedger;
  readonly #approvals: ApprovalService;
  readonly #issued = new Map<string, ScopedExecutionGrant>();

  constructor(deps: GrantAuthorityDeps) {
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#grants = deps.grants;
    this.#epochLedger = deps.epochLedger;
    this.#approvals = deps.approvals;
  }

  /**
   * Deterministically evaluate an authorization request and, on ALLOW, issue
   * the scoped execution grant carrying its authorization lineage.
   */
  adjudicate(input: AdjudicateInput): AdjudicationResult {
    // INV-A02: fail closed immediately on a stale credential epoch, before
    // any mandate is considered (evaluate() performs the same check; doing it
    // first makes the failure mode explicit for grant issuance).
    checkEpoch(input.principal, this.#epochLedger);
    const decision = evaluate(input.request, this.#grants, { ledger: this.#epochLedger });
    if (decision.decision === 'ALLOW') {
      const grant = this.#issueGrant(
        input.tenantId,
        input.principal,
        input.request,
        `decision:${input.request.requestHash}`,
        undefined,
      );
      return { kind: 'GRANT_ISSUED', grant, decision };
    }
    if (decision.decision === 'NEEDS_APPROVAL') {
      return { kind: 'NEEDS_APPROVAL', decision };
    }
    return { kind: 'DENIED', decision };
  }

  /**
   * Issue a grant from an APPROVED NEEDS_APPROVAL flow. The approval artifact
   * must be known, genuinely signed (HMAC verified), unexpired, bound to this
   * exact request (trust verifyApprovalArtifact), and unconsumed. Any failure
   * fails closed with ApprovalArtifactRejectedError.
   */
  issueFromApproval(input: IssueFromApprovalInput): ScopedExecutionGrant {
    const artifact = this.#approvals.signedArtifactByRef(input.approvalArtifactRef);
    if (artifact === undefined) {
      throw new ApprovalArtifactRejectedError(
        `unknown approval artifact reference: ${input.approvalArtifactRef}`,
        { approvalArtifactRef: input.approvalArtifactRef, reason: 'UNKNOWN_ARTIFACT' },
      );
    }
    const signatureCheck = this.#approvals.verifySignedApproval(artifact);
    if (!signatureCheck.valid) {
      throw new ApprovalArtifactRejectedError(
        `approval artifact rejected: ${signatureCheck.reason}`,
        { approvalArtifactRef: input.approvalArtifactRef, reason: signatureCheck.reason },
      );
    }
    // INV-A02: revoked authority (raised epoch) fails closed before the
    // artifact is honored.
    checkEpoch(input.principal, this.#epochLedger);
    const nowMs = this.#nowMs();
    const binding = verifyApprovalArtifact(artifact, input.request, nowMs);
    if (!binding.valid) {
      throw new ApprovalArtifactRejectedError(
        `approval artifact rejected: ${binding.reason}`,
        { approvalArtifactRef: input.approvalArtifactRef, reason: binding.reason },
      );
    }
    if (!this.#approvals.markArtifactConsumed(input.approvalArtifactRef)) {
      throw new ApprovalArtifactRejectedError(
        `approval artifact already consumed: ${input.approvalArtifactRef} (artifacts are single-redemption)`,
        { approvalArtifactRef: input.approvalArtifactRef, reason: 'ARTIFACT_CONSUMED' },
      );
    }
    return this.#issueGrant(
      input.tenantId,
      input.principal,
      input.request,
      `decision:${input.request.requestHash}`,
      input.approvalArtifactRef,
      artifact.expiry,
    );
  }

  getGrant(grantId: string): ScopedExecutionGrant | undefined {
    return this.#issued.get(grantId);
  }

  #issueGrant(
    tenantId: string,
    principal: Principal,
    request: AuthorizationRequest,
    decisionRef: string,
    approvalArtifactRef: string | undefined,
    authorityExpiryMs?: number,
  ): ScopedExecutionGrant {
    const grantId = this.#ids.mintId('grant');
    const grantRef = `grant:${grantId}`;
    const issuedAtMs = this.#nowMs();
    // The grant lives no longer than its authority: the approval window when
    // issued from an artifact, else the tightest matching mandate expiry
    // (Stage-1 approximation of the allowing mandate; evaluate() re-checks
    // the true window on every adjudication, so a stale window can never
    // authorize anything).
    const authorityWindow = authorityExpiryMs ?? this.#mandateWindowFor(principal, request);
    const expiresAt = authorityWindow ?? issuedAtMs + DEFAULT_GRANT_TTL_MS;
    const scope: GrantScope = {
      action: request.action,
      resource: { ...request.resource },
      ...(request.context.amount === undefined ? {} : { amount: request.context.amount }),
    };
    const grant: ScopedExecutionGrant = Object.freeze({
      grantId,
      tenantId,
      principal,
      scope,
      lineage: Object.freeze({
        decisionRef,
        ...(approvalArtifactRef === undefined ? {} : { approvalArtifactRef }),
        grantRef,
      }),
      issuedAt: issuedAtMs,
      expiresAt,
    });
    this.#issued.set(grantId, grant);
    return grant;
  }

  #mandateWindowFor(principal: Principal, request: AuthorizationRequest): number | undefined {
    const ref = principalRef(principal);
    let window: number | undefined;
    for (const grant of this.#grants) {
      const mandate = grant.mandate;
      if (mandate.grantee !== ref) {
        continue;
      }
      const actionMatches = mandate.actions.some((pattern) => matchesActionPattern(pattern, request.action));
      const resourceMatches = mandate.resources.some((pattern) => matchesResourcePattern(pattern, request.resource));
      if (actionMatches && resourceMatches && (window === undefined || mandate.expiresAt < window)) {
        window = mandate.expiresAt;
      }
    }
    return window;
  }

  #nowMs(): number {
    return Number(this.#clock.now());
  }
}
