/**
 * @payswap/onchain-opportunities — Lab registration of opportunity families
 * as SEARCHABLE CAPABILITIES (Work Order P4-W3-002 hard requirement 4:
 * "Opportunities are searchable by the Lab — compose with the P4-W3-001 Lab
 * surfaces (Organization/Strategy/Capability search): opportunity families
 * register as searchable capabilities; the Lab's never-production-execution
 * law extends to discovery results").
 *
 * REPOSITORY LAW (INV-L01): no other package's src/** imports the Lab
 * runtime — every Lab consumer drives it from the TEST layer. This module
 * therefore declares ONLY the provider-neutral, pure-data registration
 * surface: the six family capability descriptors, the deterministic
 * capability ids the Lab harness compiles into CapabilityDefinition
 * fixtures, and the non-production constraint every Lab-side composition of
 * discovery results MUST carry. The actual Lab composition (search index,
 * plug-in registry, candidate organizations) lives in this package's TEST
 * harness (test/opportunity-lab-harness.ts), exactly like the mixed-rail
 * (P4-W3-001) pattern.
 *
 * Every descriptor carries `discoveryAuthority: "NONE"` as a FIRST-CLASS
 * field: registering a family as searchable is discovery, never
 * authorization — the Lab search's own executable-block law (INV-C05: a
 * catalogue entry with no connected instance is REJECTED and can never
 * produce an executable block) composes with this package's structural
 * discovery tier unchanged.
 */

import { ValidationError } from "@payswap/protocol";
import { assertNoGuaranteeLanguage } from "./vocabulary.js";
import { isOpportunityFamily } from "./model.js";
import type { OpportunityFamily } from "./model.js";

/**
 * The non-production constraint every Lab-side composition of discovery
 * results carries as a domain hard constraint (the P4-W3-001
 * never-production-execution law, extended to opportunity discovery results:
 * a discovery result is not production execution, not a payment rail and
 * not settlement — and never becomes one inside the Lab).
 */
export const OPPORTUNITY_DISCOVERY_NON_PRODUCTION_CONSTRAINT =
  "OPPORTUNITY_DISCOVERY_IS_NOT_PRODUCTION_EXECUTION" as const;

/** Deterministic Lab capability id of one opportunity family. */
export function opportunityFamilyCapabilityId(family: OpportunityFamily): string {
  return `opportunity-capability:${family}`;
}

/**
 * One opportunity family's SEARCHABLE CAPABILITY descriptor: pure data the
 * test-layer Lab harness compiles into a CapabilityDefinition and registers
 * in the Lab search index. Carries NO execution authority of any kind — the
 * `discoveryAuthority: "NONE"` field is structural and validated.
 */
export interface OpportunityFamilyCapability {
  /** Deterministic: `opportunity-capability:${family}`. */
  readonly capabilityId: string;
  readonly family: OpportunityFamily;
  /** Vocabulary-scanned human summary (searchable text). */
  readonly summary: string;
  /** Additional searchable terms (family synonyms). */
  readonly searchableTerms: readonly string[];
  /** First-class: registering a capability NEVER authorizes execution. */
  readonly discoveryAuthority: "NONE";
}

/** The frozen family summaries (vocabulary-scanned, estimate-language only). */
const FAMILY_SUMMARIES: Readonly<Record<OpportunityFamily, string>> = Object.freeze({
  liquidity:
    "liquidity provisioning opportunities: observed pool fee yields and incentive components with evidence-backed estimates and uncertainty bounds",
  lending:
    "lending supply opportunities: observed supply rates with evidence-backed estimates, withdrawal liquidity and exit-path disclosure",
  staking:
    "staking opportunities: observed staking yields with unbonding lock-up disclosure and evidence-backed estimates",
  incentives:
    "incentive program opportunities: rebates, airdrops and reward programs with verified evidence chains and reserved budgets only",
  arbitrage:
    "cross-venue price-difference observations: two-sided venue quotes with exact spread estimates net of observed costs",
  other:
    "policy-approved strategy opportunities: each carries an explicit policy approval reference before eligibility",
});

/** The frozen family searchable-term sets. */
const FAMILY_SEARCHABLE_TERMS: Readonly<Record<OpportunityFamily, readonly string[]>> =
  Object.freeze({
    liquidity: Object.freeze(["pool", "provisioning", "fee yield", "lp"]),
    lending: Object.freeze(["supply", "supply-side", "lend", "apy"]),
    staking: Object.freeze(["stake", "unbonding", "yield"]),
    incentives: Object.freeze(["rebate", "airdrop", "rewards", "program"]),
    arbitrage: Object.freeze(["price difference", "spread", "cross-venue"]),
    other: Object.freeze(["policy-approved", "strategy"]),
  });

/**
 * Builds one family capability descriptor (deterministic: same family in,
 * same descriptor out; the summary and searchable terms are frozen constants).
 */
export function opportunityFamilyCapability(
  family: OpportunityFamily,
): OpportunityFamilyCapability {
  if (!isOpportunityFamily(family)) {
    throw new ValidationError(
      `an opportunity family capability requires one of the six families (got '${String(family)}')`,
    );
  }
  const summary = FAMILY_SUMMARIES[family];
  const capability: OpportunityFamilyCapability = Object.freeze({
    capabilityId: opportunityFamilyCapabilityId(family),
    family,
    summary,
    searchableTerms: Object.freeze([...FAMILY_SEARCHABLE_TERMS[family]]),
    discoveryAuthority: "NONE",
  });
  // The vocabulary law applies to Lab-searchable surfaces too.
  assertNoGuaranteeLanguage(summary, `family capability '${family}' summary`);
  for (const term of capability.searchableTerms) {
    assertNoGuaranteeLanguage(term, `family capability '${family}' searchable term '${term}'`);
  }
  return capability;
}

/** All six family capability descriptors, in OPPORTUNITY_FAMILIES order. */
export function opportunityFamilyCapabilities(): readonly OpportunityFamilyCapability[] {
  return Object.freeze(
    (["liquidity", "lending", "staking", "incentives", "arbitrage", "other"] as const).map(
      (family) => opportunityFamilyCapability(family),
    ),
  );
}

/**
 * Runtime validation of a family capability descriptor from untyped
 * sources. Fails closed on a non-deterministic id, an unknown family, an
 * unsafe summary (the vocabulary law), and — structurally — on any
 * discovery authority other than NONE.
 */
export function validateOpportunityFamilyCapability(
  candidate: unknown,
): OpportunityFamilyCapability {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("an opportunity family capability must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (!isOpportunityFamily(record.family)) {
    errors.push("family must be one of the six opportunity families");
  }
  if (typeof record.capabilityId !== "string" || record.capabilityId.length === 0) {
    errors.push("capabilityId must be a non-empty string");
  } else if (
    isOpportunityFamily(record.family) &&
    record.capabilityId !== opportunityFamilyCapabilityId(record.family)
  ) {
    errors.push(
      `capabilityId is deterministic: expected '${opportunityFamilyCapabilityId(record.family)}'`,
    );
  }
  if (typeof record.summary !== "string" || record.summary.length === 0) {
    errors.push("summary must be a non-empty string");
  } else {
    try {
      assertNoGuaranteeLanguage(record.summary, "family capability summary");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!Array.isArray(record.searchableTerms)) {
    errors.push("searchableTerms must be an array of strings");
  } else {
    for (const term of record.searchableTerms) {
      if (typeof term !== "string" || term.length === 0) {
        errors.push("searchableTerms entries must be non-empty strings");
        break;
      }
      try {
        assertNoGuaranteeLanguage(term, "family capability searchable term");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (record.discoveryAuthority !== "NONE") {
    errors.push(
      "discoveryAuthority must be 'NONE' — registering a searchable capability never authorizes execution (P4-W3-002 law)",
    );
  }
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid opportunity family capability: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }
  return candidate as OpportunityFamilyCapability;
}
