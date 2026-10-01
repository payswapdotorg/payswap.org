import { ValidationError } from '@payswap/protocol';

/**
 * @payswap/participation — evidence references and proof levels (W3-004).
 *
 * FROZEN-ARCHITECTURE §16 proof levels, restated as a shared participation
 * primitive so contribution records, program proof requirements and
 * leaderboard evidence-strength declarations all speak one vocabulary.
 * INV-E03 (finality requires policy-required proof) is consumed downstream:
 * a program declares the minimum proof level its contribution events must
 * carry before rewards may accrue/finalize.
 */

/** Proof levels P0..P5 (FROZEN §16), strictly ordered by strength. */
export type ProofLevel = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

/** The closed, ordered set of proof levels. */
export const PROOF_LEVELS: readonly ProofLevel[] = Object.freeze([
  'P0',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
]);

const PROOF_LEVEL_RANK: ReadonlyMap<ProofLevel, number> = new Map<ProofLevel, number>(
  PROOF_LEVELS.map((level, index) => [level, index]),
);

/** Reference to one piece of evidence backing a contribution or attribution. */
export interface EvidenceReference {
  /** What kind of evidence this is (e.g. `rail_receipt`, `signed_attestation`). */
  readonly kind: string;
  /** Stable locator (id, hash or URI) of the underlying artifact. */
  readonly locator: string;
  /** Declared proof strength of the referenced artifact. */
  readonly level: ProofLevel;
}

/** Rank of a proof level for comparisons (P0 weakest … P5 strongest). */
export function proofLevelRank(level: ProofLevel): number {
  const rank = PROOF_LEVEL_RANK.get(level);
  if (rank === undefined) {
    // Unreachable for the closed set; kept for noUncheckedIndexedAccess safety.
    return -1;
  }
  return rank;
}

/** True when `level` meets or exceeds `required`. */
export function proofLevelMeets(level: ProofLevel, required: ProofLevel): boolean {
  return proofLevelRank(level) >= proofLevelRank(required);
}

/** Highest proof level among the references, or undefined when none. */
export function strongestEvidenceLevel(
  evidence: readonly EvidenceReference[],
): ProofLevel | undefined {
  let strongest: ProofLevel | undefined;
  for (const reference of evidence) {
    if (strongest === undefined || proofLevelRank(reference.level) > proofLevelRank(strongest)) {
      strongest = reference.level;
    }
  }
  return strongest;
}

/** Validate one evidence reference (throws ValidationError on bad shape). */
export function assertEvidenceReference(reference: EvidenceReference, label: string): void {
  if (reference === null || typeof reference !== 'object') {
    throw new ValidationError(`${label} must be an EvidenceReference object`, { label });
  }
  if (typeof reference.kind !== 'string' || reference.kind.length === 0) {
    throw new ValidationError(`${label}.kind must be a non-empty string`, { label });
  }
  if (reference.kind.length > 128) {
    throw new ValidationError(`${label}.kind exceeds 128 characters`, { label });
  }
  if (typeof reference.locator !== 'string' || reference.locator.length === 0) {
    throw new ValidationError(`${label}.locator must be a non-empty string`, { label });
  }
  if (reference.locator.length > 512) {
    throw new ValidationError(`${label}.locator exceeds 512 characters`, { label });
  }
  if (!PROOF_LEVELS.includes(reference.level)) {
    throw new ValidationError(`${label}.level must be one of P0..P5`, {
      level: reference.level,
    });
  }
}
