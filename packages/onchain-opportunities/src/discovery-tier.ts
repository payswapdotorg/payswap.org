/**
 * @payswap/onchain-opportunities — the STRUCTURAL discovery-never-
 * authorization discriminator (Work Order P4-W3-002 hard requirement 1:
 * "Discovery/recommendation is NEVER authorization — opportunities carry NO
 * authority to execute; the existing authorization path (the W1-002 kernel:
 * prepare → simulate → policy → authorize → pre-broadcast recheck) is the
 * ONLY route to execution").
 *
 * The pattern is REPLICATED from the merged kernel's structural tier
 * discriminators (onchain-adapters "testnet can NEVER be production
 * financial execution" and mixed-rail "Lab simulation is never production
 * settlement"), applied to opportunity discovery:
 *
 * 1. BRANDED TYPES: `OpportunityDiscoveryBrand` is a nominal phantom brand.
 *    A tiered discovery record is TYPE-INCOMPATIBLE with any kernel
 *    authorization surface: it cannot be assigned where an OnchainWriteRequest,
 *    a PreparedWrite, a SigningRequest or a settlement input is demanded
 *    (there is no exported conversion, on purpose).
 *
 * 2. DERIVED-ONLY CONSTRUCTION: every opportunity in this package is
 *    constructed by `discoverOpportunity`, which stamps the tier fields
 *    structurally. There is NO constructor that produces a tier-less
 *    opportunity and NO API that strips the tier.
 *
 * 3. RUNTIME RE-DERIVATION (defense in depth): `assertDiscoveryTier`
 *    re-validates the tier field fail-closed, so a forged record that claims
 *    discovery without carrying the brand field is rejected; and the REAL
 *    kernel validators reject tiered discovery records when they are passed
 *    where kernel write requests or observations are demanded (proven by
 *    tests against the merged kernel, never by lookalikes).
 *
 * 4. THE EXECUTION GATE: `discoveryPermitsExecution()` returns the literal
 *    `false` — a first-class, tested restatement of the law — and
 *    `rejectDiscoveryForExecution()` ALWAYS throws: it is the downstream gate
 *    any execution-adjacent consumer of a discovery result is required to
 *    call. An opportunity that cannot be constructed without the discovery
 *    tier can never be converted into execution authority.
 */

import { ValidationError } from "@payswap/protocol";

/** The one discovery tier this package may ever produce. */
export const DISCOVERY_TIER = "DISCOVERY_NEVER_AUTHORIZATION" as const;

/** Raised when a tiered discovery artifact is fed to an execution gate. */
export class DiscoveryExecutionRejectedError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryExecutionRejectedError";
  }
}

/** Nominal brand: this value is a discovery record, never execution authority. */
declare const DISCOVERY_TIER_BRAND: unique symbol;

/**
 * The structural discovery mark. Phantom property (unique symbol, never
 * constructible outside this module) plus a re-derivable runtime field, so
 * tiered discovery records are nominally distinct from every kernel
 * authorization shape.
 */
export interface OpportunityDiscoveryBrand {
  readonly [DISCOVERY_TIER_BRAND]: typeof DISCOVERY_TIER;
  /** Runtime re-derivation field (defense in depth against brand forgery). */
  readonly discoveryTier: typeof DISCOVERY_TIER;
}

/** Runtime guard: does this value carry the opportunity discovery tier? */
export function isDiscoveryTieredValue(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<OpportunityDiscoveryBrand>;
  return candidate.discoveryTier === DISCOVERY_TIER;
}

/**
 * Fail-closed tier assertion: the record must carry the re-derivable runtime
 * tier field with the exact tier value. A tier-less or forged record is
 * rejected (never guessed).
 */
export function assertDiscoveryTier(
  value: unknown,
): asserts value is OpportunityDiscoveryBrand {
  if (typeof value !== "object" || value === null) {
    throw new ValidationError(
      "discovery tier assertion failed: value is not an object — tiered discovery records are structurally branded, never guessed",
    );
  }
  const candidate = value as Partial<OpportunityDiscoveryBrand>;
  if (candidate.discoveryTier !== DISCOVERY_TIER) {
    throw new ValidationError(
      `discovery tier assertion failed: expected the structural tier '${DISCOVERY_TIER}' (a discovery record without the tier brand is malformed and fails closed)`,
    );
  }
}

/**
 * Deterministic restatement of the discovery-never-authorization law for
 * every consumer of this package: a discovered opportunity NEVER permits
 * execution. Returns false, always (the kernel's authority-path law,
 * restated for the discovery tier).
 */
export function discoveryPermitsExecution(): false {
  return false;
}

/**
 * THE downstream execution gate. ALWAYS throws (there is no input that makes
 * a discovered opportunity executable): any execution-adjacent consumer that
 * receives one of this package's artifacts calls this gate and fails closed.
 * The rejection is a tested, first-class contract — not a comment. Execution
 * authority exists ONLY on the W1-002 kernel path
 * (prepare → simulate → policy → authorize → pre-broadcast recheck), which
 * this package never imports, never wraps and never re-implements.
 */
export function rejectDiscoveryForExecution(value: unknown): never {
  const description = isDiscoveryTieredValue(value)
    ? `a tiered discovery record (tier '${DISCOVERY_TIER}')`
    : "a non-tiered value passed where execution authority was demanded";
  throw new DiscoveryExecutionRejectedError(
    `execution rejected: ${description} carries no authority to execute — discovery/recommendation is never authorization, and the only route to execution is the W1-002 kernel path (prepare → simulate → policy → authorize → pre-broadcast recheck) (P4-W3-002 law)`,
  );
}
