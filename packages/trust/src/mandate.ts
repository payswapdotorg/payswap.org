import type { MandateRef } from "./principal.js";

/**
 * Mandate / PermissionGrant contracts (FROZEN-ARCHITECTURE §5, §24).
 *
 * A Mandate defines allowed actions, resources, rails, currencies, countries,
 * beneficiaries, transaction and velocity limits, cost/spread limits, expiry,
 * escalation and proof requirements. A PermissionGrant is an issued mandate
 * instance with grant lineage, so every consequential financial effect has
 * authorization lineage (AGENTS.md rule 2).
 */

/**
 * Exact monetary amount: integer minor units as a decimal string.
 * Floating-point money is forbidden (INV-F01, AGENTS.md rule 3).
 *
 * CONSOLIDATION CANDIDATE (W2-002): align with @payswap/protocol
 */
export interface AmountSpec {
  readonly currency: string;
  readonly minorUnits: string;
}

/** Raised when an AmountSpec is structurally invalid or not comparable. */
export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

export function validateAmountSpec(amount: AmountSpec): void {
  if (!/^[A-Z]{3}$/.test(amount.currency)) {
    throw new InvalidAmountError(
      `currency must be a 3-letter uppercase code, got '${amount.currency}'`,
    );
  }
  if (!/^(0|[1-9][0-9]*)$/.test(amount.minorUnits)) {
    throw new InvalidAmountError(
      `minorUnits must be a non-negative integer decimal string, got '${amount.minorUnits}'`,
    );
  }
}

/** Exact comparison; amounts in different currencies are never comparable. */
export function compareAmounts(a: AmountSpec, b: AmountSpec): -1 | 0 | 1 {
  validateAmountSpec(a);
  validateAmountSpec(b);
  if (a.currency !== b.currency) {
    throw new InvalidAmountError(
      `cannot compare ${a.currency} with ${b.currency}: cross-currency comparison requires an FX quote`,
    );
  }
  const av = BigInt(a.minorUnits);
  const bv = BigInt(b.minorUnits);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

export const ACTION_WILDCARD = "*";

/**
 * Action pattern: an exact action id (e.g. `payments.initiate`) or a namespace
 * wildcard (e.g. `payments.*`). Deterministic matching semantics:
 * `prefix.*` matches every action that starts with `prefix.`.
 */
export type ActionPattern = string;

/** Raised when a pattern is structurally invalid. */
export class InvalidPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPatternError";
  }
}

export function validateActionPattern(pattern: ActionPattern): void {
  if (pattern.length === 0) {
    throw new InvalidPatternError("action pattern must not be empty");
  }
  const starIndex = pattern.indexOf(ACTION_WILDCARD);
  if (starIndex === -1) {
    return;
  }
  if (starIndex !== pattern.length - 1) {
    throw new InvalidPatternError(
      `wildcard is only allowed as the final character: '${pattern}'`,
    );
  }
  if (starIndex === 0) {
    throw new InvalidPatternError(
      `wildcard pattern must carry a non-empty prefix: '${pattern}'`,
    );
  }
}

export function matchesActionPattern(pattern: ActionPattern, action: string): boolean {
  validateActionPattern(pattern);
  if (action.includes(ACTION_WILDCARD)) {
    throw new InvalidPatternError(
      `concrete action must not contain a wildcard: '${action}'`,
    );
  }
  if (pattern.endsWith(ACTION_WILDCARD)) {
    return action.startsWith(pattern.slice(0, -1));
  }
  return pattern === action;
}

/** True when every action matched by `child` is also matched by `parent`. */
export function actionPatternCoveredBy(child: ActionPattern, parent: ActionPattern): boolean {
  validateActionPattern(child);
  validateActionPattern(parent);
  const childPrefix = child.endsWith(ACTION_WILDCARD) ? child.slice(0, -1) : undefined;
  const parentPrefix = parent.endsWith(ACTION_WILDCARD) ? parent.slice(0, -1) : undefined;
  if (childPrefix === undefined) {
    if (parentPrefix === undefined) {
      return child === parent;
    }
    return child.startsWith(parentPrefix);
  }
  if (parentPrefix === undefined) {
    return false;
  }
  return childPrefix.startsWith(parentPrefix);
}

/** Resource pattern: a type plus optional instance; absent id = every resource of the type. */
export interface ResourcePattern {
  readonly type: string;
  readonly resourceId?: string;
}

/** Concrete resource reference presented in an authorization request. */
export interface ResourceRef {
  readonly type: string;
  readonly resourceId?: string;
}

export function validateResourcePattern(pattern: ResourcePattern): void {
  if (pattern.type.length === 0) {
    throw new InvalidPatternError("resource pattern type must not be empty");
  }
  if (pattern.resourceId !== undefined && pattern.resourceId.length === 0) {
    throw new InvalidPatternError(
      `resource pattern id for type '${pattern.type}' must not be empty`,
    );
  }
}

export function matchesResourcePattern(pattern: ResourcePattern, resource: ResourceRef): boolean {
  validateResourcePattern(pattern);
  if (pattern.type !== resource.type) {
    return false;
  }
  if (pattern.resourceId === undefined) {
    return true;
  }
  return pattern.resourceId === resource.resourceId;
}

/** True when every resource matched by `child` is also matched by `parent`. */
export function resourcePatternCoveredBy(child: ResourcePattern, parent: ResourcePattern): boolean {
  validateResourcePattern(child);
  validateResourcePattern(parent);
  if (child.type !== parent.type) {
    return false;
  }
  if (parent.resourceId === undefined) {
    return true;
  }
  if (child.resourceId === undefined) {
    return false;
  }
  return parent.resourceId === child.resourceId;
}

/** Velocity limit: bounds count and value inside any sliding window of `windowMs`. */
export interface VelocityLimit {
  readonly windowMs: number;
  readonly maxCount?: number;
  readonly maxAmount?: AmountSpec;
}

/** Transaction and velocity limits. All money is exact (INV-F01). */
export interface MandateLimits {
  readonly perTransactionAmount?: AmountSpec;
  readonly velocity?: VelocityLimit;
}

/** Cost and FX spread caps. Spread is exact integer basis points. */
export interface CostCaps {
  readonly maxTotalCost?: AmountSpec;
  readonly maxFxSpreadBps?: bigint;
}

/**
 * Escalation policy applied when a limit would otherwise deny the action.
 * `deny` is the stronger policy: it forbids escalation entirely.
 */
export interface EscalationPolicy {
  readonly onLimitExceeded: "require_approval" | "deny";
  readonly approverRef?: string;
}

/** Proof levels (FROZEN-ARCHITECTURE §16). */
export const PROOF_LEVELS = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export type ProofLevel = (typeof PROOF_LEVELS)[number];

/** Required proof for a scope of the mandate's effects. */
export interface ProofRequirement {
  readonly proofLevel: ProofLevel;
  readonly scope?: string;
}

export function proofLevelRank(level: ProofLevel): number {
  const rank = PROOF_LEVELS.indexOf(level);
  if (rank < 0) {
    throw new InvalidPatternError(`unknown proof level '${level}'`);
  }
  return rank;
}

/**
 * Mandate: the complete, versioned statement of delegated power
 * (FROZEN-ARCHITECTURE §5). Optional scope dimensions are "unrestricted"
 * when absent; restricting them is always a narrowing operation.
 */
export interface Mandate {
  readonly id: string;
  readonly version: number;
  readonly grantor: string;
  readonly grantee: string;
  readonly actions: readonly ActionPattern[];
  readonly resources: readonly ResourcePattern[];
  readonly rails?: readonly string[];
  readonly currencies?: readonly string[];
  readonly countries?: readonly string[];
  readonly beneficiaries?: readonly string[];
  readonly limits?: MandateLimits;
  readonly costCaps?: CostCaps;
  readonly expiresAt: number;
  readonly escalation?: EscalationPolicy;
  readonly proofRequirements: readonly ProofRequirement[];
  /** Lineage to the mandate this one was attenuated from, when derived. */
  readonly parentMandate?: MandateRef;
}

/** Ancestry of a grant: root grant id plus the chain down to (excluding) this grant. */
export interface GrantLineage {
  readonly rootGrantId: string;
  readonly chain: readonly string[];
}

/** Issued mandate instance with grant lineage (INV-E01 authorization evidence). */
export interface PermissionGrant {
  readonly grantId: string;
  readonly mandate: Mandate;
  readonly grantorRef: string;
  readonly granteeRef: string;
  readonly issuedAt: number;
  readonly lineage: GrantLineage;
}

export interface IssueGrantParams {
  readonly grantId: string;
  readonly issuedAt: number;
  readonly rootGrantId?: string;
  readonly chain?: readonly string[];
}

/** Issue a grant for a mandate. The mandate itself is never mutated. */
export function issueGrant(mandate: Mandate, params: IssueGrantParams): PermissionGrant {
  if (params.grantId.length === 0) {
    throw new InvalidPatternError("grantId must not be empty");
  }
  return {
    grantId: params.grantId,
    mandate,
    grantorRef: mandate.grantor,
    granteeRef: mandate.grantee,
    issuedAt: params.issuedAt,
    lineage: {
      rootGrantId: params.rootGrantId ?? params.grantId,
      chain: params.chain ?? [],
    },
  };
}
