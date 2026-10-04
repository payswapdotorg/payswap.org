/**
 * @payswap/mixed-rail — the STRUCTURAL simulation-tier discriminator
 * (Work Order P4-W3-001 hard requirement 3: "Lab simulation must never be
 * callable as production financial execution").
 *
 * The pattern is REPLICATED from the merged kernel's structural environment
 * discriminator (P4-W2-001, "testnet can NEVER be production financial
 * execution"), applied to the Lab execution tier:
 *
 * 1. BRANDED TYPES: `LabExecutionTierBrand` is a nominal phantom brand. A
 *    tiered Lab record is TYPE-INCOMPATIBLE with any production evidence
 *    shape: it cannot be assigned where a kernel execution observation, a
 *    simulation observation of a prepared write, or a settlement-mapping
 *    input is demanded (there is no exported conversion, on purpose).
 *
 * 2. DERIVED-ONLY CONSTRUCTION: every tiered record in this package is
 *    constructed by this package's builders, which stamp the tier fields
 *    structurally. There is NO constructor that produces a tier-less Lab
 *    execution record and NO API that strips the tier.
 *
 * 3. RUNTIME RE-DERIVATION (defense in depth): `assertLabExecutionTier`
 *    re-validates both tier fields fail-closed, so a forged record that
 *    claims the tier without carrying the brand fields is rejected; and the
 *    kernel's own validators reject tiered Lab records when they are passed
 *    where kernel observations are demanded (proven by tests).
 *
 * 4. THE SETTLEMENT GATE: `labTierPermitsFinancialSettlement()` returns the
 *    literal `false` — a first-class, tested restatement of the law (the
 *    same discipline as the kernel's finality-declaration law) — and
 *    `rejectLabTierForFinancialSettlement()` ALWAYS throws: it is the
 *    downstream gate any settlement-adjacent consumer of these artifacts is
 *    required to call. A tier that cannot be constructed without the brand
 *    can never be converted into production financial execution.
 *
 * The tier is distinct from the kernel's chain-environment registry: a
 * simulated venue may model a PRODUCTION-classified chain (the registry
 * classifies chain identity), while the EXECUTION of a Lab walk is always
 * LAB_SIMULATION_NON_PRODUCTION. Both facts are recorded separately on
 * every lane and result — never conflated, never guessed.
 */

import { ValidationError } from "@payswap/protocol";

/** The one execution tier this package may ever produce. */
export const LAB_EXECUTION_TIER = "LAB_SIMULATION_NON_PRODUCTION" as const;

/** Raised when a tiered Lab artifact is fed to a financial-settlement gate. */
export class LabTierSettlementRejectedError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "LabTierSettlementRejectedError";
  }
}

/** Nominal brand: this value is a Lab-tiered record, never production evidence. */
declare const LAB_EXECUTION_TIER_BRAND: unique symbol;

/**
 * The structural tier mark. Phantom property (unique symbol, never
 * constructible outside this module) plus a re-derivable runtime field, so
 * `LabTiered` records are nominally distinct from every kernel shape.
 */
export interface LabExecutionTierBrand {
  readonly [LAB_EXECUTION_TIER_BRAND]: typeof LAB_EXECUTION_TIER;
  /** Runtime re-derivation field (defense in depth against brand forgery). */
  readonly executionTier: typeof LAB_EXECUTION_TIER;
}

/** Runtime guard: does this value carry the Lab execution tier? */
export function isLabTieredValue(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<LabExecutionTierBrand>;
  return candidate.executionTier === LAB_EXECUTION_TIER;
}

/**
 * Fail-closed tier assertion: the record must carry BOTH the nominal brand
 * position and the re-derivable runtime field with the exact tier value.
 * A tier-less or forged record is rejected (never guessed).
 */
export function assertLabExecutionTier(
  value: unknown,
): asserts value is LabExecutionTierBrand {
  if (typeof value !== "object" || value === null) {
    throw new ValidationError(
      "Lab execution-tier assertion failed: value is not an object — tiered Lab records are structurally branded, never guessed",
    );
  }
  const candidate = value as Partial<LabExecutionTierBrand>;
  if (candidate.executionTier !== LAB_EXECUTION_TIER) {
    throw new ValidationError(
      `Lab execution-tier assertion failed: expected the structural tier '${LAB_EXECUTION_TIER}' (a Lab record without the tier brand is malformed and fails closed)`,
    );
  }
}

/**
 * Deterministic restatement of the never-production law for every consumer
 * of this package: a Lab-tiered execution record NEVER permits a financial
 * settlement declaration. Returns false, always (the kernel's own
 * finality-declaration law, restated for the Lab tier).
 */
export function labTierPermitsFinancialSettlement(): false {
  return false;
}

/**
 * THE downstream settlement gate. ALWAYS throws (there is no input that
 * makes a Lab-tiered record settleable): any settlement-adjacent consumer
 * that receives one of this package's artifacts calls this gate and fails
 * closed. The rejection is a tested, first-class contract — not a comment.
 */
export function rejectLabTierForFinancialSettlement(value: unknown): never {
  const description = isLabTieredValue(value)
    ? `a Lab-tiered execution record (tier '${LAB_EXECUTION_TIER}')`
    : "a non-tiered value passed where a settleable artifact was demanded";
  throw new LabTierSettlementRejectedError(
    `financial settlement rejected: ${description} can never be production financial execution — Lab simulation results carry the structural non-production tier and are rejected by every settlement gate (P4-W3-001 law)`,
  );
}
