/**
 * @payswap/recourse — the transaction recourse policy (W1-006).
 *
 * SECURITY-EVIDENCE-RECOURSE "Recourse": a RecoursePolicy is FROZEN when the
 * intent is initiated. It declares, up front:
 * - the protection mechanisms available to a claimant on that transaction
 *   (native reversal, authorized pullback, escrow, bond, guarantee, explicit
 *   credit, hybrid);
 * - the claim window [opensAt, closesAt] during which a dispute may be filed;
 * - the evidence requirements every claim MUST present (required evidence
 *   node kinds + minimum effective proof levels).
 *
 * Enforcement (acceptance criteria of W1-006):
 * - IMMUTABLE AFTER INITIATION: the policy record is deeply frozen and the
 *   registry rejects any re-declaration of the same transaction with
 *   different content (`RecoursePolicyImmutableError`). Identical replay is
 *   idempotent (deterministic replay safety). There is NO update API.
 * - CLAIM WINDOWS ARE ENFORCED AT CLAIM TIME: `enforceClaimWindow` throws
 *   before `opensAt` (`ClaimWindowNotOpenError`) and after `closesAt`
 *   (`ClaimWindowClosedError`).
 * - EVIDENCE REQUIREMENTS ARE ENFORCED AT CLAIM TIME:
 *   `enforceEvidenceRequirements` verifies every declared requirement is met
 *   by at least one presented evidence node of a required kind whose
 *   EFFECTIVE level (INV-E04 provenance caps, consumed from
 *   @payswap/settlement) meets the declared minimum. The network never
 *   upgrades weak evidence because an agent says it succeeded.
 *
 * Money is exact (INV-F01); all timestamps come from an injected
 * ProtocolClock; no ambient entropy or timers.
 */

import { ValidationError } from '@payswap/protocol';
import type { PaySwapErrorDetails, CurrencyCode, Money, TimestampMs } from '@payswap/protocol';
import { effectiveEvidenceLevel } from '@payswap/settlement';
import type { EvidenceNode, EvidenceNodeKind, ProofLevel } from '@payswap/settlement';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The recourse mechanisms a transaction may declare
 * (SECURITY-EVIDENCE-RECOURSE "Recourse" mechanism list).
 */
export const RECOURSE_MECHANISMS = Object.freeze([
  'NATIVE_RAIL_REVERSAL',
  'AUTHORIZED_PULLBACK',
  'ESCROW',
  'BOND',
  'GUARANTEE',
  'EXPLICIT_CREDIT',
  'HYBRID',
] as const);

export type RecourseMechanism = (typeof RECOURSE_MECHANISMS)[number];

/** Window during which a recourse claim (dispute) may be filed. */
export interface RecourseClaimWindow {
  readonly opensAt: TimestampMs;
  readonly closesAt: TimestampMs;
}

/**
 * One declared evidence requirement: a claim must present at least one
 * evidence node whose kind is one of `requiredKinds` and whose EFFECTIVE
 * proof level (INV-E04 provenance caps) is at least `minimumProofLevel`.
 */
export interface RecourseEvidenceRequirement {
  readonly requirementId: string;
  readonly description: string;
  readonly requiredKinds: readonly EvidenceNodeKind[];
  readonly minimumProofLevel: ProofLevel;
}

/** The immutable recourse policy attached to one transaction at initiation. */
export interface RecoursePolicy {
  readonly policyId: string;
  /** The transaction this policy governs (linked by id — never embedded). */
  readonly transactionRef: string;
  readonly currency: CurrencyCode;
  readonly mechanisms: readonly RecourseMechanism[];
  readonly claimWindow: RecourseClaimWindow;
  readonly evidenceRequirements: readonly RecourseEvidenceRequirement[];
  readonly initiatedAt: TimestampMs;
  /** Always `1n` — policies are immutable; amendments are new versions (W1-006 has none). */
  readonly version: bigint;
}

/** Draft form supplied to `initiateRecoursePolicy` (no id/timestamp yet). */
export interface RecoursePolicyDraft {
  readonly transactionRef: string;
  readonly currency: CurrencyCode;
  readonly mechanisms: readonly RecourseMechanism[];
  readonly claimWindow: RecourseClaimWindow;
  readonly evidenceRequirements: readonly RecourseEvidenceRequirement[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** W1-006 acceptance: the policy is immutable after initiation. */
export class RecoursePolicyImmutableError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'RecoursePolicyImmutableError';
  }
}

/** No recourse policy was declared for the referenced transaction. */
export class NoRecoursePolicyError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'NoRecoursePolicyError';
  }
}

/** A claim was filed before the declared claim window opens. */
export class ClaimWindowNotOpenError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'ClaimWindowNotOpenError';
  }
}

/** A claim was filed after the declared claim window closed. */
export class ClaimWindowClosedError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'ClaimWindowClosedError';
  }
}

/** A claim did not present the evidence the policy requires. */
export class MissingDisputeEvidenceError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'MissingDisputeEvidenceError';
  }
}

// ---------------------------------------------------------------------------
// Validation + initiation
// ---------------------------------------------------------------------------

const MECHANISM_SET: ReadonlySet<string> = new Set<string>(RECOURSE_MECHANISMS);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateClaimWindow(window: RecourseClaimWindow, label: string): void {
  if (window === null || typeof window !== 'object') {
    throw new ValidationError(`${label} must be a RecourseClaimWindow object`);
  }
  if (typeof window.opensAt !== 'bigint' || typeof window.closesAt !== 'bigint') {
    throw new ValidationError(`${label} bounds must be bigint TimestampMs`);
  }
  if (window.closesAt < window.opensAt) {
    throw new ValidationError(`${label} closes before it opens`, { label });
  }
}

function validateEvidenceRequirements(
  requirements: readonly RecourseEvidenceRequirement[],
): void {
  if (!Array.isArray(requirements)) {
    throw new ValidationError('evidenceRequirements must be an array');
  }
  const seen = new Set<string>();
  for (const [index, requirement] of requirements.entries()) {
    if (requirement === null || typeof requirement !== 'object') {
      throw new ValidationError(`evidenceRequirements[${index}] must be a RecourseEvidenceRequirement`);
    }
    if (!isNonEmptyString(requirement.requirementId)) {
      throw new ValidationError(`evidenceRequirements[${index}].requirementId must be a non-empty string`);
    }
    if (seen.has(requirement.requirementId)) {
      throw new ValidationError('duplicate evidence requirement id', {
        requirementId: requirement.requirementId,
      });
    }
    seen.add(requirement.requirementId);
    if (!isNonEmptyString(requirement.description)) {
      throw new ValidationError('evidence requirement description must be a non-empty string');
    }
    if (
      !Array.isArray(requirement.requiredKinds) ||
      requirement.requiredKinds.length === 0
    ) {
      throw new ValidationError('evidence requirement must declare at least one required kind', {
        requirementId: requirement.requirementId,
      });
    }
    for (const kind of requirement.requiredKinds) {
      if (
        typeof kind !== 'string' ||
        !['AUTHORIZATION', 'EXECUTION', 'OUTCOME', 'RECONCILIATION', 'PROOF', 'RECEIPT'].includes(kind)
      ) {
        throw new ValidationError('evidence requirement declares an unknown evidence kind', {
          requirementId: requirement.requirementId,
          kind: String(kind),
        });
      }
    }
    if (
      typeof requirement.minimumProofLevel !== 'string' ||
      !['P0', 'P1', 'P2', 'P3', 'P4', 'P5'].includes(requirement.minimumProofLevel)
    ) {
      throw new ValidationError('evidence requirement minimumProofLevel must be a declared proof level', {
        requirementId: requirement.requirementId,
      });
    }
  }
}

function freezeRequirement(
  requirement: RecourseEvidenceRequirement,
): RecourseEvidenceRequirement {
  return Object.freeze({
    requirementId: requirement.requirementId,
    description: requirement.description,
    requiredKinds: Object.freeze([...requirement.requiredKinds]),
    minimumProofLevel: requirement.minimumProofLevel,
  });
}

function freezePolicy(policy: RecoursePolicy): RecoursePolicy {
  return Object.freeze({
    policyId: policy.policyId,
    transactionRef: policy.transactionRef,
    currency: policy.currency,
    mechanisms: Object.freeze([...policy.mechanisms]),
    claimWindow: Object.freeze({
      opensAt: policy.claimWindow.opensAt,
      closesAt: policy.claimWindow.closesAt,
    }),
    evidenceRequirements: Object.freeze(policy.evidenceRequirements.map(freezeRequirement)),
    initiatedAt: policy.initiatedAt,
    version: policy.version,
  });
}

/** Deterministic canonical rendering of a policy (immutability comparisons). */
export function canonicalRecoursePolicy(policy: RecoursePolicy): string {
  const mechanisms = [...policy.mechanisms].sort().join(',');
  const requirements = policy.evidenceRequirements
    .map(
      (requirement) =>
        `${requirement.requirementId}:${[...requirement.requiredKinds].sort().join('+')}` +
        `@${requirement.minimumProofLevel}`,
    )
    .sort()
    .join(',');
  return (
    `recourse-policy|id:${policy.policyId}|tx:${policy.transactionRef}` +
    `|currency:${policy.currency}|mechanisms:[${mechanisms}]` +
    `|window:${policy.claimWindow.opensAt.toString()}..${policy.claimWindow.closesAt.toString()}` +
    `|requirements:[${requirements}]|initiatedAt:${policy.initiatedAt.toString()}` +
    `|version:${policy.version.toString()}`
  );
}

/**
 * Declare the recourse policy of a transaction AT INITIATION. The returned
 * record is deeply frozen; there is no mutation path. Validation:
 * - transactionRef non-empty;
 * - currency is a non-empty string;
 * - at least one declared mechanism, all from the frozen vocabulary;
 * - claim window well-formed and not already closed at initiation (a policy
 *   whose window is closed at declaration could never produce a valid claim);
 * - evidence requirements well-formed with unique ids.
 */
export function initiateRecoursePolicy(
  draft: RecoursePolicyDraft,
  deps: { readonly now: TimestampMs },
): RecoursePolicy {
  if (draft === null || typeof draft !== 'object') {
    throw new ValidationError('draft must be a RecoursePolicyDraft object');
  }
  if (typeof deps?.now !== 'bigint') {
    throw new ValidationError('deps.now must be a bigint TimestampMs');
  }
  if (!isNonEmptyString(draft.transactionRef)) {
    throw new ValidationError('draft.transactionRef must be a non-empty string');
  }
  if (typeof draft.currency !== 'string' || draft.currency.length === 0) {
    throw new ValidationError('draft.currency must be a non-empty CurrencyCode');
  }
  if (!Array.isArray(draft.mechanisms) || draft.mechanisms.length === 0) {
    throw new ValidationError('a recourse policy must declare at least one mechanism');
  }
  const mechanisms: RecourseMechanism[] = [];
  for (const mechanism of draft.mechanisms) {
    if (typeof mechanism !== 'string' || !MECHANISM_SET.has(mechanism)) {
      throw new ValidationError('recourse mechanism is not in the frozen vocabulary', {
        mechanism: String(mechanism),
      });
    }
    const declared = mechanism as RecourseMechanism;
    if (!mechanisms.includes(declared)) {
      mechanisms.push(declared);
    }
  }
  validateClaimWindow(draft.claimWindow, 'draft.claimWindow');
  if (draft.claimWindow.closesAt < deps.now) {
    throw new ValidationError(
      'claim window must not be already closed at initiation — the policy would be unclaimable',
      { closesAt: draft.claimWindow.closesAt.toString(), now: deps.now.toString() },
    );
  }
  validateEvidenceRequirements(draft.evidenceRequirements);

  return freezePolicy({
    policyId: `RCP:${draft.transactionRef}`,
    transactionRef: draft.transactionRef,
    currency: draft.currency,
    mechanisms,
    claimWindow: draft.claimWindow,
    evidenceRequirements: draft.evidenceRequirements,
    initiatedAt: deps.now,
    version: 1n,
  });
}

// ---------------------------------------------------------------------------
// The policy registry (immutability enforcement point)
// ---------------------------------------------------------------------------

/**
 * One immutable policy per transaction (W1-006 acceptance). Re-declaring the
 * same transaction with IDENTICAL content is an idempotent replay; ANY
 * difference throws `RecoursePolicyImmutableError` — post-initiation mutation
 * is rejected. There is no update or removal API.
 */
export class RecoursePolicyRegistry {
  readonly #byTransaction = new Map<string, RecoursePolicy>();

  /** Register a policy. Fails closed on any post-initiation mutation attempt. */
  register(policy: RecoursePolicy): RecoursePolicy {
    if (policy === null || typeof policy !== 'object') {
      throw new ValidationError('policy must be a RecoursePolicy object');
    }
    validateClaimWindow(policy.claimWindow, 'policy.claimWindow');
    validateEvidenceRequirements(policy.evidenceRequirements);
    const frozen = freezePolicy(policy);
    const existing = this.#byTransaction.get(frozen.transactionRef);
    if (existing !== undefined) {
      if (canonicalRecoursePolicy(existing) !== canonicalRecoursePolicy(frozen)) {
        throw new RecoursePolicyImmutableError(
          `the recourse policy of transaction '${frozen.transactionRef}' is immutable after initiation`,
          {
            transactionRef: frozen.transactionRef,
            registeredPolicyId: existing.policyId,
            attemptedPolicyId: frozen.policyId,
          },
        );
      }
      return existing; // idempotent replay of the identical policy
    }
    this.#byTransaction.set(frozen.transactionRef, frozen);
    return frozen;
  }

  /** The policy of one transaction, when declared. */
  forTransaction(transactionRef: string): RecoursePolicy | undefined {
    return this.#byTransaction.get(transactionRef);
  }

  /** The policy of one transaction; throws `NoRecoursePolicyError` when absent. */
  requireForTransaction(transactionRef: string): RecoursePolicy {
    const policy = this.#byTransaction.get(transactionRef);
    if (policy === undefined) {
      throw new NoRecoursePolicyError(
        `no recourse policy was declared at initiation for transaction '${transactionRef}' — claims require a declared policy`,
        { transactionRef },
      );
    }
    return policy;
  }

  /** All registered policies in registration order (audit view). */
  all(): readonly RecoursePolicy[] {
    return Object.freeze([...this.#byTransaction.values()]);
  }
}

// ---------------------------------------------------------------------------
// Claim-time enforcement (windows + evidence requirements)
// ---------------------------------------------------------------------------

/** Pure check: is `now` inside the policy's claim window? */
export function isWithinClaimWindow(policy: RecoursePolicy, now: TimestampMs): boolean {
  return now >= policy.claimWindow.opensAt && now <= policy.claimWindow.closesAt;
}

/**
 * ENFORCE the declared claim window at claim time. Throws
 * `ClaimWindowNotOpenError` before the window opens and `ClaimWindowClosedError`
 * after it closes (W1-006 acceptance: unenforced claim windows are forbidden).
 */
export function enforceClaimWindow(policy: RecoursePolicy, now: TimestampMs): void {
  if (typeof now !== 'bigint') {
    throw new ValidationError('now must be a bigint TimestampMs');
  }
  if (now < policy.claimWindow.opensAt) {
    throw new ClaimWindowNotOpenError(
      `the claim window of policy '${policy.policyId}' is not open yet`,
      {
        policyId: policy.policyId,
        opensAt: policy.claimWindow.opensAt.toString(),
        now: now.toString(),
      },
    );
  }
  if (now > policy.claimWindow.closesAt) {
    throw new ClaimWindowClosedError(
      `the claim window of policy '${policy.policyId}' has closed`,
      {
        policyId: policy.policyId,
        closesAt: policy.claimWindow.closesAt.toString(),
        now: now.toString(),
      },
    );
  }
}

/**
 * ENFORCE the declared evidence requirements at claim time (W1-006
 * acceptance). A requirement is satisfied when at least one presented node's
 * kind is one of its `requiredKinds` AND the node's EFFECTIVE level — after
 * INV-E04 provenance caps consumed from @payswap/settlement — meets the
 * declared minimum. Weak evidence never upgrades because it claims strength.
 * Throws `MissingDisputeEvidenceError` listing every unmet requirement.
 */
export function enforceEvidenceRequirements(
  policy: RecoursePolicy,
  presented: readonly EvidenceNode[],
): void {
  if (!Array.isArray(presented)) {
    throw new ValidationError('presented must be an array of EvidenceNode');
  }
  const gaps: string[] = [];
  for (const requirement of policy.evidenceRequirements) {
    const satisfied = presented.some(
      (node) =>
        requirement.requiredKinds.includes(node.kind) &&
        proofLevelRank(effectiveEvidenceLevel(node)) >=
          proofLevelRank(requirement.minimumProofLevel),
    );
    if (!satisfied) {
      gaps.push(requirement.requirementId);
    }
  }
  if (gaps.length > 0) {
    throw new MissingDisputeEvidenceError(
      `the presented evidence does not satisfy the declared requirements of policy '${policy.policyId}'`,
      { policyId: policy.policyId, unmetRequirements: gaps },
    );
  }
}

/** Rank of a proof level, consumed locally for threshold comparisons. */
function proofLevelRank(level: ProofLevel): number {
  return ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'].indexOf(level);
}

/** Structural helper: is the disputed amount compatible with the policy? */
export function assertClaimCurrency(policy: RecoursePolicy, amount: Money): void {
  if (amount === null || typeof amount !== 'object') {
    throw new ValidationError('amount must be exact Money');
  }
  if (amount.currency !== policy.currency) {
    throw new ValidationError(
      `policy '${policy.policyId}' prices recourse in ${policy.currency}; refusing ${String(amount.currency)} claims without an explicit FX policy`,
      { policyCurrency: policy.currency, claimCurrency: String(amount.currency) },
    );
  }
}
