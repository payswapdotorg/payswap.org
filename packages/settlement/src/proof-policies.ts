/**
 * @payswap/settlement — proof policies (W1-004).
 *
 * SECURITY-EVIDENCE-RECOURSE "Proof policy": proof requirements depend on
 * amount, risk, rail, counterparty, jurisdiction, recourse, capability and
 * program. Levels (frozen vocabulary):
 *
 *   P0 assertion;
 *   P1 authenticated artifact/receipt;
 *   P2 provider-signed evidence;
 *   P3 independent destination observation;
 *   P4 multi-party corroboration plus bond;
 *   P5 native rail/ledger finality.
 *
 * - INV-E03: finality requires policy-required proof. `requiredProofLevel`
 *   derives the required level deterministically from the policy + risk
 *   context; `proofSatisfaction` compares the ACHIEVED level of an evidence
 *   chain (with INV-E04 capping applied) against it and refuses with a typed
 *   `InsufficientProofError` gap report when it is insufficient.
 * - Refund/dispute SYMMETRY (PAYMENT-OPERATING-PLANE "Refund/dispute flows
 *   use the corresponding reverse/recourse pathway"): the required proof
 *   level deliberately IGNORES the direction — a refund or dispute adjustment
 *   of amount X carries exactly the proof burden of a settlement of amount X
 *   on the same rail. `refundDisputeSymmetricLevels` exposes this so callers
 *   and tests can verify symmetry holds for every amount/risk combination.
 *
 * The network never upgrades weak evidence because an agent says it succeeded
 * — `proofSatisfaction` only ever measures the effective levels of the
 * presented evidence nodes (INV-E04 caps applied by `effectiveEvidenceLevel`).
 */

import { ValidationError } from "@payswap/protocol";
import type { CurrencyCode, Money } from "@payswap/protocol";
import type { EvidenceNode, EvidenceProvenance } from "./evidence-graph.js";

/** Frozen proof-level vocabulary (SECURITY-EVIDENCE-RECOURSE). */
export const PROOF_LEVELS = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;

export type ProofLevel = (typeof PROOF_LEVELS)[number];

/**
 * The strength-relevant shape of an evidence node. Structural (not the full
 * EvidenceNode) so the capping rule lives with the proof vocabulary while
 * the graph stays free of runtime imports from this module.
 */
export interface EvidenceStrength {
  readonly claimedLevel: ProofLevel;
  readonly provenance: EvidenceProvenance;
}

/** Rank of a proof level (P0 = 0 … P5 = 5). Deterministic, total. */
export function proofLevelRank(level: ProofLevel): number {
  const index = PROOF_LEVELS.indexOf(level);
  if (index < 0) {
    throw new ValidationError(`unknown proof level '${String(level)}'`);
  }
  return index;
}

/** The stronger of two proof levels. */
export function maxProofLevel(a: ProofLevel, b: ProofLevel): ProofLevel {
  return proofLevelRank(a) >= proofLevelRank(b) ? a : b;
}

/** The weaker of two proof levels. */
export function minProofLevel(a: ProofLevel, b: ProofLevel): ProofLevel {
  return proofLevelRank(a) <= proofLevelRank(b) ? a : b;
}

export function isProofLevel(value: unknown): value is ProofLevel {
  return typeof value === "string" && (PROOF_LEVELS as readonly string[]).includes(value);
}

/**
 * The direction of the consequential action being proven. Deliberately NOT
 * an input to the required level — refund/dispute symmetry.
 */
export type ProofDirection = "SETTLE" | "REFUND" | "DISPUTE";

/**
 * A risk-driven proof policy (INV-E03). All dimensions compose by taking the
 * STRONGEST requirement across: baseline, high-risk amount tier, rail
 * minimums and counterparty risk minimums.
 */
export interface ProofPolicy {
  readonly policyId: string;
  /** The single currency this policy prices risk in (no silent FX). */
  readonly currency: CurrencyCode;
  /** Required level for ordinary amounts. */
  readonly baselineLevel: ProofLevel;
  /** At/above this minor-unit amount the high-risk level applies. */
  readonly highRiskThresholdMinorUnits: bigint;
  readonly highRiskLevel: ProofLevel;
  /** Minimum level per rail kind, e.g. `OFF_NETWORK_CHECK: "P4"`. */
  readonly railMinimums: Readonly<Record<string, ProofLevel>>;
  /** Minimum level per counterparty risk class, e.g. `UNVERIFIED: "P3"`. */
  readonly counterpartyRiskMinimums: Readonly<Record<string, ProofLevel>>;
}

/** The risk context one proof requirement is evaluated against. */
export interface ProofContext {
  readonly direction: ProofDirection;
  readonly amount: Money;
  readonly rail?: string;
  readonly counterpartyRiskClass?: string;
}

/** Deterministic evaluation of the policy-required proof level (INV-E03). */
export function requiredProofLevel(
  policy: ProofPolicy,
  context: ProofContext,
): { readonly required: ProofLevel; readonly considered: readonly string[] } {
  validateProofPolicy(policy);
  if (context === null || typeof context !== "object") {
    throw new ValidationError("proof context must be a ProofContext object");
  }
  if (context.amount === null || typeof context.amount !== "object") {
    throw new ValidationError("proof context amount must be exact Money");
  }
  if (context.amount.currency !== policy.currency) {
    throw new ValidationError(
      `proof policy '${policy.policyId}' prices risk in ${policy.currency}; refusing to evaluate ${String(context.amount.currency)} risk without an explicit FX policy`,
      { policyCurrency: policy.currency, contextCurrency: String(context.amount.currency) },
    );
  }

  const considered: string[] = [`BASELINE:${policy.baselineLevel}`];
  let required: ProofLevel = policy.baselineLevel;
  if (context.amount.value >= policy.highRiskThresholdMinorUnits) {
    required = maxProofLevel(required, policy.highRiskLevel);
    considered.push(`HIGH_RISK_AMOUNT:${policy.highRiskLevel}`);
  }
  if (context.rail !== undefined) {
    const railMinimum = policy.railMinimums[context.rail];
    if (railMinimum !== undefined) {
      required = maxProofLevel(required, railMinimum);
      considered.push(`RAIL:${context.rail}:${railMinimum}`);
    }
  }
  if (context.counterpartyRiskClass !== undefined) {
    const counterpartyMinimum = policy.counterpartyRiskMinimums[context.counterpartyRiskClass];
    if (counterpartyMinimum !== undefined) {
      required = maxProofLevel(required, counterpartyMinimum);
      considered.push(`COUNTERPARTY:${context.counterpartyRiskClass}:${counterpartyMinimum}`);
    }
  }
  // NOTE: `context.direction` is deliberately ignored — refund/dispute
  // symmetry (a refund of amount X on rail R requires exactly the proof a
  // settlement of amount X on rail R requires).
  return Object.freeze({ required, considered: Object.freeze(considered) });
}

/**
 * INV-E04: the effective proof strength of an evidence node, given its
 * authenticated provenance. A UI/browser artifact NEVER proves more than:
 * - P0 (a bare assertion) when unauthenticated — a screenshot is an
 *   artifact, not proof of finality on its own;
 * - P1 (an authenticated artifact/receipt) when it carries authenticated
 *   provenance.
 * Every other provenance source is believed at its claimed level.
 */
export function effectiveEvidenceLevel(node: EvidenceStrength): ProofLevel {
  if (node === null || typeof node !== "object") {
    throw new ValidationError("evidence strength input is required");
  }
  if (node.provenance.source === "UI_BROWSER_ARTIFACT") {
    return minProofLevel(node.claimedLevel, node.provenance.authenticated ? "P1" : "P0");
  }
  return node.claimedLevel;
}

/** A claim stronger than the provenance can carry (adversarial detection). */
export function provenanceOverclaim(node: EvidenceStrength): boolean {
  return proofLevelRank(effectiveEvidenceLevel(node)) < proofLevelRank(node.claimedLevel);
}

/** Validate a proof policy (typed failures, never silent). */
export function validateProofPolicy(policy: ProofPolicy): void {
  if (policy === null || typeof policy !== "object") {
    throw new ValidationError("proof policy must be a ProofPolicy object");
  }
  if (typeof policy.policyId !== "string" || policy.policyId.length === 0) {
    throw new ValidationError("proof policy policyId must be a non-empty string");
  }
  if (typeof policy.currency !== "string" || policy.currency.length !== 3) {
    throw new ValidationError("proof policy currency must be an ISO-style code");
  }
  if (!isProofLevel(policy.baselineLevel) || !isProofLevel(policy.highRiskLevel)) {
    throw new ValidationError("proof policy levels must be declared proof levels");
  }
  if (typeof policy.highRiskThresholdMinorUnits !== "bigint" || policy.highRiskThresholdMinorUnits < 0n) {
    throw new ValidationError("proof policy highRiskThresholdMinorUnits must be a non-negative bigint");
  }
  if (policy.railMinimums === null || typeof policy.railMinimums !== "object") {
    throw new ValidationError("proof policy railMinimums must be a record");
  }
  for (const [rail, level] of Object.entries(policy.railMinimums)) {
    if (rail.length === 0 || !isProofLevel(level)) {
      throw new ValidationError("proof policy railMinimums must map non-empty rails to proof levels");
    }
  }
  if (policy.counterpartyRiskMinimums === null || typeof policy.counterpartyRiskMinimums !== "object") {
    throw new ValidationError("proof policy counterpartyRiskMinimums must be a record");
  }
  for (const [riskClass, level] of Object.entries(policy.counterpartyRiskMinimums)) {
    if (riskClass.length === 0 || !isProofLevel(level)) {
      throw new ValidationError(
        "proof policy counterpartyRiskMinimums must map non-empty risk classes to proof levels",
      );
    }
  }
}

/** Construct a validated, frozen proof policy. */
export function defineProofPolicy(input: {
  readonly policyId: string;
  readonly currency: CurrencyCode;
  readonly baselineLevel: ProofLevel;
  readonly highRiskThresholdMinorUnits: bigint;
  readonly highRiskLevel: ProofLevel;
  readonly railMinimums?: Readonly<Record<string, ProofLevel>>;
  readonly counterpartyRiskMinimums?: Readonly<Record<string, ProofLevel>>;
}): ProofPolicy {
  const policy: ProofPolicy = {
    policyId: input.policyId,
    currency: input.currency,
    baselineLevel: input.baselineLevel,
    highRiskThresholdMinorUnits: input.highRiskThresholdMinorUnits,
    highRiskLevel: input.highRiskLevel,
    railMinimums: input.railMinimums ?? {},
    counterpartyRiskMinimums: input.counterpartyRiskMinimums ?? {},
  };
  validateProofPolicy(policy);
  return Object.freeze({
    ...policy,
    railMinimums: Object.freeze({ ...policy.railMinimums }),
    counterpartyRiskMinimums: Object.freeze({ ...policy.counterpartyRiskMinimums }),
  });
}

/** The measured satisfaction of a proof requirement by an evidence chain. */
export interface ProofSatisfaction {
  readonly required: ProofLevel;
  readonly achieved: ProofLevel;
  readonly satisfied: boolean;
  readonly direction: ProofDirection;
  /** Empty when satisfied; each entry names one concrete gap (INV-E03). */
  readonly gaps: readonly string[];
}

/**
 * INV-E03 evaluation: does the presented evidence chain MEET the
 * policy-required proof level? The achieved level is the MAXIMUM effective
 * level over the chain, where effective levels apply the INV-E04 caps (a
 * UI/browser artifact never proves more than an assertion — or an
 * authenticated artifact when it carries authenticated provenance).
 */
export function proofSatisfaction(
  policy: ProofPolicy,
  context: ProofContext,
  evidence: readonly EvidenceNode[],
): ProofSatisfaction {
  const { required } = requiredProofLevel(policy, context);
  const gaps: string[] = [];
  if (!Array.isArray(evidence) || evidence.length === 0) {
    gaps.push("NO_EVIDENCE_PRESENTED");
  }
  let achieved: ProofLevel = "P0";
  for (const node of evidence) {
    if (node === null || typeof node !== "object") {
      throw new ValidationError("every presented evidence entry must be an EvidenceNode");
    }
    achieved = maxProofLevel(achieved, effectiveEvidenceLevel(node));
  }
  const satisfied = proofLevelRank(achieved) >= proofLevelRank(required);
  if (!satisfied) {
    gaps.push(`REQUIRED_${required}_ACHIEVED_${achieved}`);
  }
  return Object.freeze({
    required,
    achieved,
    satisfied,
    direction: context.direction,
    gaps: Object.freeze(gaps),
  });
}

/** INV-E03 violation: the policy-required proof level was not presented. */
export class InsufficientProofError extends ValidationError {
  constructor(
    message: string,
    details?: {
      readonly policyId: string;
      readonly required: ProofLevel;
      readonly achieved: ProofLevel;
      readonly gaps: readonly string[];
    },
  ) {
    super(message, details);
    this.name = "InsufficientProofError";
  }
}

/**
 * Refund/dispute symmetry support: the levels required for SETTLE, REFUND and
 * DISPUTE of the same amount on the same rail/counterparty context. They are
 * equal by construction (the evaluation ignores direction); this function
 * exists so callers and tests can verify symmetry holds — and fails loudly if
 * any future change breaks it.
 */
export function refundDisputeSymmetricLevels(
  policy: ProofPolicy,
  input: {
    readonly amount: Money;
    readonly rail?: string;
    readonly counterpartyRiskClass?: string;
  },
): {
  readonly settle: ProofLevel;
  readonly refund: ProofLevel;
  readonly dispute: ProofLevel;
  readonly symmetric: boolean;
} {
  const settle = requiredProofLevel(policy, { direction: "SETTLE", ...input }).required;
  const refund = requiredProofLevel(policy, { direction: "REFUND", ...input }).required;
  const dispute = requiredProofLevel(policy, { direction: "DISPUTE", ...input }).required;
  const symmetric = settle === refund && refund === dispute;
  if (!symmetric) {
    throw new ValidationError(
      "refund/dispute symmetry broken: required proof levels diverged across directions",
      { settle, refund, dispute },
    );
  }
  return Object.freeze({ settle, refund, dispute, symmetric });
}