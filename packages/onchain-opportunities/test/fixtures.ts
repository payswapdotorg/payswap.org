/**
 * Shared deterministic fixtures for the @payswap/onchain-opportunities test
 * suite (Work Order P4-W3-002). Every identifier, timestamp, amount and rate
 * is a fixed constant — no clock, no randomness. Venue and protocol names
 * are obviously synthetic; no real venue is referenced anywhere.
 *
 * The catalog deliberately spans:
 * - HEALTHY opportunities in all six families (liquidity, lending, staking,
 *   incentives, arbitrage, other) — each surfacing every mandated
 *   first-class field with honest estimates;
 * - the task packet's ADVERSARIAL fixtures: a stale quote, a manipulated
 *   APY, a fake incentive, vanished liquidity, a honeypot exit path and an
 *   unapproved "other" strategy — each must surface as ineligible/UNKNOWN/
 *   blocked, never as an attractive opportunity.
 */

import { canonicalAssetRef } from "@payswap/onchain-domain";
import type { OpportunityObservationInput } from "../src/index.js";
import type { ArbitrageLeg, ReturnComponent } from "../src/index.js";

// ---------------------------------------------------------------------------
// Deterministic constants
// ---------------------------------------------------------------------------

export const CHAIN = "ethereum:mainnet" as const;
export const NOW_ISO = "2026-10-04T00:00:00Z" as const;
export const NOW = Date.parse(NOW_ISO);
export const MAX_AGE_MS = 30_000;

/** Fresh evidence at the evaluation instant (age 0). */
export function freshEvidence(): { readonly asOfMs: number; readonly maxAgeMs: number } {
  return { asOfMs: NOW, maxAgeMs: MAX_AGE_MS };
}

/** Evidence exactly `ageMs` old at the evaluation instant. */
export function evidenceAged(ageMs: number): { readonly asOfMs: number; readonly maxAgeMs: number } {
  return { asOfMs: NOW - ageMs, maxAgeMs: MAX_AGE_MS };
}

// ---------------------------------------------------------------------------
// Shared surfaces (honest language only — the vocabulary law is tested
// separately with adversarial smuggled text)
// ---------------------------------------------------------------------------

export function healthyExitPath(): {
  readonly status: "AVAILABLE";
  readonly description: string;
  readonly constraints: readonly string[];
} {
  return {
    status: "AVAILABLE",
    description:
      "exit observed in one transaction through the venue router; withdrawal liquidity was observed at the evidence instant",
    constraints: ["exit size may be constrained by observed withdrawal liquidity"],
  };
}

export function noLockUp(): {
  readonly locked: boolean;
  readonly durationMs: number | null;
  readonly unlockConditions: readonly string[];
} {
  return { locked: false, durationMs: null, unlockConditions: [] };
}

export function lockedFor(durationMs: number): {
  readonly locked: boolean;
  readonly durationMs: number | null;
  readonly unlockConditions: readonly string[];
} {
  return {
    locked: true,
    durationMs,
    unlockConditions: ["the lock releases after the observed unbonding period"],
  };
}

export function auditedLowRisk(summary: string): {
  readonly level: "LOW";
  readonly audited: boolean | null;
  readonly summary: string;
} {
  return { level: "LOW", audited: true, summary };
}

export function unknownOracleRisk(): {
  readonly level: "UNKNOWN";
  readonly audited: null;
  readonly summary: string;
} {
  return {
    level: "UNKNOWN",
    audited: null,
    summary: "oracle and bridge dependencies were not determinable from the observation",
  };
}

const NUMERAIRE = canonicalAssetRef(CHAIN, "USCD");

export function capitalOf(minorUnits: string): { readonly assetRef: string; readonly minorUnits: string } {
  return { assetRef: NUMERAIRE, minorUnits };
}

export function standardFees(): {
  readonly entryFeeFraction: { readonly numerator: string; readonly denominator: string };
  readonly exitFeeFraction: { readonly numerator: string; readonly denominator: string };
  readonly ongoingFeeFractionPerYear: { readonly numerator: string; readonly denominator: string };
} {
  return {
    entryFeeFraction: { numerator: "0", denominator: "1" },
    exitFeeFraction: { numerator: "3", denominator: "1000" },
    ongoingFeeFractionPerYear: { numerator: "1", denominator: "10000" },
  };
}

function component(
  componentId: string,
  kind: ReturnComponent["kind"],
  numerator: string,
  denominator: string,
  extras?: { readonly evidenceVerified?: boolean; readonly budgetReserved?: boolean },
): ReturnComponent {
  return {
    componentId,
    kind,
    ratePerYear: { numerator, denominator },
    evidenceVerified: extras?.evidenceVerified ?? true,
    ...(extras?.budgetReserved !== undefined ? { budgetReserved: extras.budgetReserved } : {}),
    description: `observed ${kind.replace("_", " ").toLowerCase()} component, annualized from venue observations`,
  };
}

// ---------------------------------------------------------------------------
// Healthy family observations
// ---------------------------------------------------------------------------

export function healthyLiquidityObservation(input?: {
  readonly observationId?: string;
  readonly venueId?: string;
  readonly maxLossKnown?: boolean;
  readonly freshnessAgeMs?: number;
}): OpportunityObservationInput {
  return {
    family: "liquidity",
    observationId: input?.observationId ?? "obs:liq:001",
    venueId: input?.venueId ?? "venue:stable-pair",
    protocolKey: "protocol:amm-v2",
    chainKey: CHAIN,
    adapterId: "adapter:onchain:evm",
    observerId: "observer:indexer:001",
    freshness: input?.freshnessAgeMs !== undefined ? evidenceAged(input.freshnessAgeMs) : freshEvidence(),
    evidenceRefs: ["evidence:pool-state:001", "evidence:fee-tier:001"],
    title: "StablePair USCD/WSC liquidity provisioning",
    description:
      "observed liquidity provisioning opportunity in a stable pair pool; the estimate is derived from observed fee yields with uncertainty bounds",
    capitalRequired: capitalOf("1000000000"),
    fees: standardFees(),
    liquidity: { depthMinorUnits: "500000000000", withdrawalLiquidityMinorUnits: "480000000000" },
    exitPath: healthyExitPath(),
    lockUp: noLockUp(),
    smartContractRisk: auditedLowRisk(
      "independent audit observed; source and bytecode hashes recorded in the evidence chain",
    ),
    oracleBridgeRisk: unknownOracleRisk(),
    ...(input?.maxLossKnown === false
      ? {}
      : {
          maxLoss: { fractionOfCapital: { numerator: "5", denominator: "100" } },
        }),
    returnComponents: [
      component("liq:fee-yield", "FEE_YIELD", "431", "10000"),
    ],
  };
}

export function healthyLendingObservation(input?: {
  readonly observationId?: string;
  readonly venueId?: string;
}): OpportunityObservationInput {
  return {
    family: "lending",
    observationId: input?.observationId ?? "obs:len:001",
    venueId: input?.venueId ?? "venue:lending-market",
    protocolKey: "protocol:lending-v3",
    chainKey: CHAIN,
    adapterId: "adapter:onchain:evm",
    observerId: "observer:indexer:002",
    freshness: freshEvidence(),
    evidenceRefs: ["evidence:reserve-state:001", "evidence:supply-rate:001"],
    title: "USCD supply position",
    description:
      "observed supply-side lending position; the estimate is derived from the observed supply rate with uncertainty bounds",
    capitalRequired: capitalOf("2500000000"),
    fees: standardFees(),
    liquidity: { depthMinorUnits: "9000000000000", withdrawalLiquidityMinorUnits: "1200000000000" },
    exitPath: healthyExitPath(),
    lockUp: noLockUp(),
    smartContractRisk: auditedLowRisk(
      "independent audit observed; proxy admin authority recorded in the evidence chain",
    ),
    oracleBridgeRisk: {
      level: "MODERATE",
      audited: false,
      summary: "the market references an oracle for utilization accounting",
    },
    returnComponents: [
      component("len:supply-apy", "SUPPLY_APY", "350", "10000"),
    ],
  };
}

export function healthyStakingObservation(input?: {
  readonly observationId?: string;
  readonly venueId?: string;
}): OpportunityObservationInput {
  return {
    family: "staking",
    observationId: input?.observationId ?? "obs:stk:001",
    venueId: input?.venueId ?? "venue:staking-module",
    protocolKey: "protocol:staking",
    chainKey: CHAIN,
    adapterId: "adapter:onchain:evm",
    observerId: "observer:indexer:003",
    freshness: freshEvidence(),
    evidenceRefs: ["evidence:validator-set:001", "evidence:staking-rate:001"],
    title: "native staking position with unbonding period",
    description:
      "observed staking position; the estimate is derived from the observed staking rate with uncertainty bounds and the unbonding lock is disclosed",
    capitalRequired: capitalOf("5000000000"),
    fees: standardFees(),
    liquidity: { depthMinorUnits: null, withdrawalLiquidityMinorUnits: null },
    exitPath: {
      status: "RESTRICTED",
      description:
        "exit requires an unbonding transaction and completes after the observed unbonding period",
      constraints: ["unbonding period observed at 14 days", "slashing exposure is disclosed in the risk summaries"],
    },
    lockUp: lockedFor(1_209_600_000),
    smartContractRisk: auditedLowRisk("staking module audit observed in the evidence chain"),
    oracleBridgeRisk: unknownOracleRisk(),
    returnComponents: [
      component("stk:staking-yield", "STAKING_YIELD", "380", "10000"),
    ],
  };
}

export function healthyIncentivesObservation(input?: {
  readonly observationId?: string;
  readonly venueId?: string;
  readonly budgetReserved?: boolean;
}): OpportunityObservationInput {
  return {
    family: "incentives",
    observationId: input?.observationId ?? "obs:inc:001",
    venueId: input?.venueId ?? "venue:rewards-program",
    protocolKey: "protocol:incentives",
    chainKey: CHAIN,
    adapterId: "adapter:onchain:evm",
    observerId: "observer:indexer:004",
    freshness: freshEvidence(),
    evidenceRefs: ["evidence:program-terms:001", "evidence:reserved-budget:001"],
    title: "venue rebate program participation",
    description:
      "observed rebate program; the estimate is derived from the observed reward rate and the program budget is reserved onchain",
    capitalRequired: capitalOf("1000000000"),
    fees: standardFees(),
    liquidity: { depthMinorUnits: "75000000000", withdrawalLiquidityMinorUnits: "75000000000" },
    exitPath: healthyExitPath(),
    lockUp: noLockUp(),
    smartContractRisk: auditedLowRisk("rewards contract audit observed in the evidence chain"),
    oracleBridgeRisk: unknownOracleRisk(),
    returnComponents: [
      component("inc:rebate", "INCENTIVE_YIELD", "120", "10000", {
        budgetReserved: input?.budgetReserved ?? true,
      }),
    ],
  };
}

export function healthyArbitrageObservation(input?: {
  readonly observationId?: string;
  readonly legAVenue?: string;
  readonly legBVenue?: string;
  readonly legBWithdrawalLiquidity?: string;
}): OpportunityObservationInput {
  return {
    family: "arbitrage",
    observationId: input?.observationId ?? "obs:arb:001",
    venueId: "venue:arb-survey",
    chainKey: CHAIN,
    adapterId: "adapter:onchain:evm",
    observerId: "observer:indexer:005",
    freshness: freshEvidence(),
    evidenceRefs: ["evidence:venue-a-quote:001", "evidence:venue-b-quote:001"],
    title: "USCD price difference between two venues",
    description:
      "observed price difference between two venue quotes; the estimate is the exact observed spread with a lower bound net of observed execution costs",
    capitalRequired: capitalOf("100000000"),
    fees: standardFees(),
    liquidity: {
      depthMinorUnits: "30000000000",
      withdrawalLiquidityMinorUnits: "25000000000",
    },
    exitPath: healthyExitPath(),
    lockUp: noLockUp(),
    smartContractRisk: auditedLowRisk("both venue routers audited; digests in the evidence chain"),
    oracleBridgeRisk: unknownOracleRisk(),
    arbitrageLegs: [
      {
        legId: "leg:venue-a",
        venueId: input?.legAVenue ?? "venue:quote-a",
        price: { numerator: "1005", denominator: "1000" },
        freshness: freshEvidence(),
        withdrawalLiquidityMinorUnits: "15000000000",
      },
      {
        legId: "leg:venue-b",
        venueId: input?.legBVenue ?? "venue:quote-b",
        price: { numerator: "1020", denominator: "1000" },
        freshness: freshEvidence(),
        withdrawalLiquidityMinorUnits:
          input?.legBWithdrawalLiquidity ?? "12000000000",
      },
    ],
    executionCostFraction: { numerator: "5", denominator: "10000" },
  };
}

export function healthyOtherObservation(input?: {
  readonly observationId?: string;
  readonly withApproval?: boolean;
}): OpportunityObservationInput {
  return {
    family: "other",
    observationId: input?.observationId ?? "obs:oth:001",
    venueId: "venue:policy-strategy",
    protocolKey: "protocol:rebalance",
    chainKey: CHAIN,
    adapterId: "adapter:onchain:evm",
    observerId: "observer:indexer:006",
    freshness: freshEvidence(),
    evidenceRefs: ["evidence:strategy-terms:001", "evidence:policy-approval:001"],
    title: "policy-approved rebalancing strategy participation",
    description:
      "observed policy-approved strategy; the estimate is derived from observed component rates with uncertainty bounds and carries an explicit approval reference",
    capitalRequired: capitalOf("2000000000"),
    fees: standardFees(),
    liquidity: { depthMinorUnits: "40000000000", withdrawalLiquidityMinorUnits: "35000000000" },
    exitPath: healthyExitPath(),
    lockUp: noLockUp(),
    smartContractRisk: auditedLowRisk("strategy contract audit observed in the evidence chain"),
    oracleBridgeRisk: unknownOracleRisk(),
    returnComponents: [
      component("oth:strategy-yield", "FEE_YIELD", "210", "10000"),
    ],
    ...(input?.withApproval === false
      ? {}
      : { policyApprovalRef: "policy-approval:strategy:rebalance-001" }),
  };
}

// ---------------------------------------------------------------------------
// The adversarial fixtures (the task packet's hard requirement 5)
// ---------------------------------------------------------------------------

/** A liquidity observation whose evidence went stale. */
export function staleQuoteObservation(): OpportunityObservationInput {
  return {
    ...healthyLiquidityObservation({ observationId: "obs:liq:stale-001" }),
    freshness: evidenceAged(MAX_AGE_MS + 30_000),
  };
}

/** A lending observation with a manipulated APY (800,000%/yr). */
export function manipulatedApyObservation(): OpportunityObservationInput {
  return {
    ...healthyLendingObservation({ observationId: "obs:len:manip-001" }),
    returnComponents: [
      component("len:supply-apy", "SUPPLY_APY", "8000", "1"),
    ],
  };
}

/** An incentives observation whose reward component is unverified (fake). */
export function fakeIncentiveObservation(): OpportunityObservationInput {
  return {
    ...healthyIncentivesObservation({ observationId: "obs:inc:fake-001" }),
    returnComponents: [
      component("inc:rebate", "INCENTIVE_YIELD", "950", "10000", {
        evidenceVerified: false,
        budgetReserved: false,
      }),
    ],
  };
}

/** An incentives observation whose reward budget is NOT reserved (rule 13). */
export function unreservedBudgetObservation(): OpportunityObservationInput {
  return {
    ...healthyIncentivesObservation({ observationId: "obs:inc:unreserved-001" }),
    returnComponents: [
      component("inc:rebate", "INCENTIVE_YIELD", "950", "10000", {
        evidenceVerified: true,
        budgetReserved: false,
      }),
    ],
  };
}

/** An arbitrage observation where one venue's exit liquidity vanished. */
export function vanishedLiquidityObservation(): OpportunityObservationInput {
  return {
    ...healthyArbitrageObservation({
      observationId: "obs:arb:vanished-001",
      legBWithdrawalLiquidity: "0",
    }),
  };
}

/** A liquidity observation whose exit path is a suspected honeypot. */
export function honeypotObservation(): OpportunityObservationInput {
  return {
    ...healthyLiquidityObservation({ observationId: "obs:liq:honeypot-001" }),
    exitPath: {
      status: "SUSPECT_HONEYPOT",
      description:
        "deposits are open; withdrawals require an operator approval that has never been observed onchain",
      constraints: ["no withdrawal has ever been observed on this venue"],
    },
  };
}

/** An "other" strategy observation without a policy approval reference. */
export function unapprovedOtherObservation(): OpportunityObservationInput {
  return healthyOtherObservation({
    observationId: "obs:oth:unapproved-001",
    withApproval: false,
  });
}

/** A staking observation whose unbonding evidence went stale. */
export function staleStakingObservation(): OpportunityObservationInput {
  return {
    ...healthyStakingObservation({ observationId: "obs:stk:stale-001" }),
    freshness: evidenceAged(MAX_AGE_MS * 3),
  };
}

// ---------------------------------------------------------------------------
// The discovery catalog (deterministic; the report's family counts)
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  readonly label: string;
  readonly input: OpportunityObservationInput;
}

/**
 * The full discovery catalog: healthy opportunities in all six families
 * plus every adversarial fixture. Family counts (the completion-report
 * numbers): liquidity 5, lending 4, staking 4, incentives 4, arbitrage 3,
 * other 3 — 23 opportunities in total.
 */
export function discoveryCatalog(): readonly CatalogEntry[] {
  return [
    // liquidity: 3 healthy + stale + honeypot = 5
    { label: "liquidity:healthy-1", input: healthyLiquidityObservation() },
    {
      label: "liquidity:healthy-2",
      input: healthyLiquidityObservation({
        observationId: "obs:liq:002",
        venueId: "venue:volatile-pair",
        maxLossKnown: false,
      }),
    },
    {
      label: "liquidity:healthy-3",
      input: healthyLiquidityObservation({
        observationId: "obs:liq:003",
        venueId: "venue:correlated-pair",
      }),
    },
    { label: "liquidity:adversarial-stale", input: staleQuoteObservation() },
    { label: "liquidity:adversarial-honeypot", input: honeypotObservation() },
    // lending: 3 healthy + manipulated = 4
    { label: "lending:healthy-1", input: healthyLendingObservation() },
    {
      label: "lending:healthy-2",
      input: healthyLendingObservation({
        observationId: "obs:len:002",
        venueId: "venue:lending-market-b",
      }),
    },
    {
      label: "lending:healthy-3",
      input: healthyLendingObservation({
        observationId: "obs:len:003",
        venueId: "venue:isolated-market",
      }),
    },
    { label: "lending:adversarial-manipulated-apy", input: manipulatedApyObservation() },
    // staking: 3 healthy + stale = 4
    { label: "staking:healthy-1", input: healthyStakingObservation() },
    {
      label: "staking:healthy-2",
      input: healthyStakingObservation({
        observationId: "obs:stk:002",
        venueId: "venue:liquid-staking",
      }),
    },
    {
      label: "staking:healthy-3",
      input: healthyStakingObservation({
        observationId: "obs:stk:003",
        venueId: "venue:validator-pool",
      }),
    },
    { label: "staking:adversarial-stale", input: staleStakingObservation() },
    // incentives: 2 healthy + fake + unreserved = 4
    { label: "incentives:healthy-1", input: healthyIncentivesObservation() },
    {
      label: "incentives:healthy-2",
      input: healthyIncentivesObservation({
        observationId: "obs:inc:002",
        venueId: "venue:airdrop-program",
      }),
    },
    { label: "incentives:adversarial-fake", input: fakeIncentiveObservation() },
    { label: "incentives:adversarial-unreserved", input: unreservedBudgetObservation() },
    // arbitrage: 2 healthy + vanished = 3
    { label: "arbitrage:healthy-1", input: healthyArbitrageObservation() },
    {
      label: "arbitrage:healthy-2",
      input: healthyArbitrageObservation({
        observationId: "obs:arb:002",
        legAVenue: "venue:quote-c",
        legBVenue: "venue:quote-d",
      }),
    },
    { label: "arbitrage:adversarial-vanished-liquidity", input: vanishedLiquidityObservation() },
    // other: 2 healthy + unapproved = 3
    { label: "other:healthy-1", input: healthyOtherObservation() },
    {
      label: "other:healthy-2",
      input: healthyOtherObservation({ observationId: "obs:oth:002" }),
    },
    { label: "other:adversarial-unapproved", input: unapprovedOtherObservation() },
  ];
}

/** The adversarial entries of the catalog, by label. */
export function adversarialEntries(): readonly CatalogEntry[] {
  return discoveryCatalog().filter((entry) => entry.label.includes("adversarial"));
}

/** One healthy entry per family (the six-family smoke set). */
export function healthyEntries(): readonly CatalogEntry[] {
  return discoveryCatalog().filter((entry) => entry.label.includes("healthy-1"));
}

/** The arbitrage legs of the healthy fixture (evidence-chain assertions). */
export function healthyArbitrageLegs(): readonly ArbitrageLeg[] {
  return healthyArbitrageObservation().arbitrageLegs ?? [];
}
