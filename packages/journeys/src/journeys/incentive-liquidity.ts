/**
 * Journey 6 — incentive-funded liquidity acquisition (W1-007).
 *
 * campaign budget reservation -> reward accrual (funded — INV-P01) ->
 * liquidity acquisition through protocol authority. Composes the
 * participation plane (versioned program, FUNDED budget reserved on the real
 * protocol journal, reproducible reward) and the campaigns plane
 * (CampaignEngine with curve/epoch discipline) — the monetary reward becomes
 * a protocol obligation (AGENTS rule 12) that settles through the shared
 * evidenced chain, while the acquired liquidity is reserved through the
 * protocol liquidity layer.
 */

import {
  USD,
  InMemoryLiquidityReservationBook,
  asLiquidityAssetId,
  availableLiquidity,
  defineLiquidityAsset,
  fromMinorUnits,
  observeLiquidityPosition,
  accountId,
  reserveLiquidity,
} from "@payswap/protocol";
import type { AccountId, Money } from "@payswap/protocol";
import { projectBalances } from "@payswap/protocol";
import {
  IncentiveBudgetLedger,
  InMemoryRewardBook,
  ProgramVersionRegistry,
  asIncentiveProgramId,
  incentiveFundingAccount,
  qualifyReward,
  recomputeReward,
} from "@payswap/participation";
import type { IncentiveProgramDraft, IncentiveProgramVersion } from "@payswap/participation";
import { runAntiGamingChecks } from "@payswap/participation";
import type { AntiGamingReport } from "@payswap/participation";
import { ContributionLedger, asContributionId } from "@payswap/participation";
import type { ContributionRecord } from "@payswap/participation";
import { CampaignEngine, asCampaignId } from "@payswap/campaigns";
import { asParticipationGoalId } from "@payswap/participation";
import {
  assembleJourneyOutcome,
  buildWorld,
  checkAccountingReconciles,
  checkApprovalsAndProofs,
  checkEvidencedChain,
  checkFeesFxIncentivesExact,
  checkLosslessStateReconciliation,
  party,
  postEntry,
  providerEnvelope,
  registerRailFixture,
  runSettlementChain,
} from "../harness.js";
import type {
  AxisAssertion,
  InvariantProof,
  JourneyOutcome,
  SettlementChainOutcome,
} from "../harness.js";
import type { JourneyWorld } from "../harness.js";

export interface IncentiveLiquidityJourneyDetails {
  readonly programId: string;
  readonly budgetFundingStatus: "FUNDED" | "CONTINGENT";
  readonly budgetCommittedMinorUnits: bigint;
  readonly rewardAmount: Money;
  readonly rewardReproducible: boolean;
  readonly rewardObligationCount: number;
  readonly accruedState: string;
  readonly finalizedState: string;
  readonly claimableState: string;
  readonly liquidityAssetId: string;
  readonly liquidityAvailableBeforeMinorUnits: bigint;
  readonly liquidityReservedMinorUnits: bigint;
  readonly liquidityAvailableAfterMinorUnits: bigint;
  readonly sponsorBalanceAfter: Money;
  readonly chain: SettlementChainOutcome;
}

export interface IncentiveLiquidityJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: IncentiveLiquidityJourneyDetails;
}

const LP_WALLET: AccountId = accountId("ASSET", "wallet.lp-alpha");

/** Run the incentive-funded liquidity acquisition journey deterministically. */
export function runIncentiveLiquidityJourney(): IncentiveLiquidityJourneyOutcome {
  const sponsor = party("sponsor:protocol-treasury");
  const world = buildWorld({
    openingBalances: [
      { account: incentiveFundingAccount(sponsor), amount: fromMinorUnits(USD, 50_000n) },
    ],
  });
  const now = world.clock.now();

  registerRailFixture(world, {
    providerName: "psp-liquidity-rewards",
    capabilityId: "cap.incentive.reward_payout",
    currencies: ["USD"],
  });
  const envelope = providerEnvelope(
    {
      providerName: "psp-liquidity-rewards",
      externalId: "reward_payout_1",
      revision: "rev_1",
      family: "payout",
      lifecycleStep: "settled",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "succeeded", rewardAccrualId: "ra:lp-alpha-1" },
    },
    world,
  );

  // ---- Participation: versioned program with a FUNDED budget (INV-P01/P07).
  const programs = new ProgramVersionRegistry();
  const programDraft: IncentiveProgramDraft = {
    programId: asIncentiveProgramId("prog:liquidity-acquisition"),
    effectiveFrom: now,
    sponsor,
    objective: "acquire committed USD liquidity for protocol settlement",
    eligibleRole: "LIQUIDITY_PROVIDER",
    eligibilityRules: [{ kind: "MIN_PROOF_LEVEL", level: "P1" }],
    contributionEvents: ["LIQUIDITY_PROVIDED"],
    proofRequirements: { minProofLevel: "P1" },
    reward: {
      mechanism: "FEE_REBATE",
      formula: { kind: "FIXED_PER_CONTRIBUTION", amount: fromMinorUnits(USD, 2_500n) },
    },
    budget: { totalAmount: fromMinorUnits(USD, 50_000n), funding: "REQUIRES_FUNDED_RESERVATION" },
    antiGamingPolicy: {
      forbidSelfReferral: true,
      requireIdentityLinkageChecks: true,
      velocity: { maxContributions: 100n, windowMs: 600_000n },
    },
    clawbackPolicy: { clawbackWindowMs: 2_592_000_000n, requiresDisputeRecord: false },
  };
  const program: IncentiveProgramVersion = programs.registerProgram(programDraft, "ACTIVE");
  const budgets = new IncentiveBudgetLedger(world.reservationState);
  const budget = budgets.establishFundedBudget(program);

  // ---- Campaign: budget reservation is a precondition (CampaignBudgetRequiredError otherwise).
  const rewards = new InMemoryRewardBook();
  const contributionLedger = new ContributionLedger();
  const engine = new CampaignEngine({
    ids: world.ids,
    clock: world.clock,
    rewards,
    budgets,
    obligations: world.obligations,
    programs,
    ledger: contributionLedger,
  });
  const campaign = engine.openCampaign({
    campaignId: asCampaignId("camp:liquidity-1"),
    goalId: asParticipationGoalId("goal:liquidity-acquisition"),
    enrollment: { opensAt: now - 1n, closesAt: now + 30n * 86_400_000n },
    effectiveFrom: now,
    programVersion: { programId: program.programId, version: program.version },
    fundingCap: fromMinorUnits(USD, 50_000n),
    capPolicy: "REJECT",
    curve: { kind: "CONSTANT", target: 10n },
    band: { toleranceBps: 500n },
  });

  // ---- The verified liquidity-provision contribution.
  const contribution: ContributionRecord = {
    id: asContributionId("c:lp-alpha-1"),
    actor: party("lp:alpha"),
    actorRole: "LIQUIDITY_PROVIDER",
    behavior: "LIQUIDITY_PROVIDED",
    affectedObjects: [{ objectType: "liquidity_pool", objectId: "pool:usd-primary" }],
    quantity: 1n,
    value: fromMinorUnits(USD, 500_000n),
    occurredAt: now,
    outcome: "VERIFIED_COMPLETED",
    evidence: [{ kind: "rail_receipt", locator: "stmt:lp:alpha:pledge-1", level: "P2" }],
    attribution: {
      attributedActor: party("lp:alpha"),
      creditedRole: "LIQUIDITY_PROVIDER",
      basis: "DIRECT_EVIDENCE",
      evidenceRefs: ["stmt:lp:alpha:pledge-1"],
      decisionTrace: [{ ruleId: "rule:direct-participant", matched: true, note: "actor is the direct provider" }],
    },
  };
  const accrualOutcome = engine.processContribution(campaign.id, contribution, {
    identityLinks: [],
    declaredSurfaces: [],
    observedParticipation: 1n,
  });
  if (accrualOutcome.disposition !== "ACCRUED") {
    throw new Error(`incentive journey: contribution not accrued (${accrualOutcome.disposition})`);
  }
  const accrued = accrualOutcome.accrual;

  // ---- INV-P04: anti-gaming checks pass before finalization; INV-P01: the
  // reward finalizes only because the budget is FUNDED.
  const antiGaming: AntiGamingReport = runAntiGamingChecks(
    {
      forbidSelfReferral: true,
      requireIdentityLinkageChecks: true,
      velocity: { maxContributions: 100n, windowMs: 600_000n },
    },
    {
      contribution,
      history: [],
      identityLinks: [],
      declaredSurfaces: [],
      now,
    },
  );
  const finalized = engine.finalizeCampaignReward(campaign.id, accrued.id, antiGaming);

  // ---- AGENTS rule 12 / INV-P03: the monetary reward becomes a protocol
  // obligation and is reproducible from evidence + program version.
  const rewardDeps = {
    ids: world.ids,
    clock: world.clock,
    rewards,
    budgets,
    obligations: world.obligations,
  };
  const claimable = qualifyReward(rewardDeps, program, finalized.id, { settlementWindowMs: 360_000n });
  const recomputation = recomputeReward(program, contribution, "BELOW_TARGET", finalized);
  const liveBudget = budgets.get(program.programId, program.version);

  // ---- Liquidity acquisition through protocol authority (liquidity layer).
  const liquidityAsset = defineLiquidityAsset({
    id: "liq:lp-alpha-wallet",
    label: "LP Alpha committed wallet",
    kind: "WALLET",
    currency: USD,
    venue: "lp:alpha",
  });
  const liquidityPosition = observeLiquidityPosition({
    assetId: liquidityAsset.id,
    balance: fromMinorUnits(USD, 500_000n),
    asOf: now,
    provenance: {
      source: "lp:alpha",
      observationRef: "stmt:lp:alpha:pledge-1",
      observedAt: now - 60_000n,
    },
  });
  const liquidityState = {
    positions: new Map([[liquidityAsset.id, liquidityPosition]]),
    reservations: new InMemoryLiquidityReservationBook(),
    ids: world.ids,
    clock: world.clock,
  };
  const availableBefore = availableLiquidity(liquidityState, asLiquidityAssetId(liquidityAsset.id)).available.value;
  reserveLiquidity(liquidityState, {
    assetId: asLiquidityAssetId(liquidityAsset.id),
    amount: fromMinorUnits(USD, 250_000n),
    refs: { purpose: "protocol-liquidity-acquisition", correlationId: "camp:liquidity-1" },
  });
  const availableAfter = availableLiquidity(liquidityState, asLiquidityAssetId(liquidityAsset.id)).available.value;

  // ---- The reward obligation settles through the protocol chain.
  const rewardObligations = claimable.obligationIds
    .map((id) => world.obligations.get(id))
    .filter((obligation): obligation is NonNullable<typeof obligation> => obligation !== undefined);
  if (rewardObligations.length === 0) {
    throw new Error("incentive journey: qualifyReward minted no protocol obligation");
  }
  const chain = runSettlementChain({
    world,
    sequence: "incentive",
    obligations: rewardObligations,
    dueWindow: { opensAt: now, closesAt: now + 1_000_000n },
    authorizationRefs: ["approval:incentive:camp-1", "grant:incentive:execution"],
    instructions: [
      { settlementDestinationId: "dest:lp-alpha", rail: "INCENTIVE_REWARD_RAIL", providerName: "psp-liquidity-rewards" },
    ],
  });

  // ---- Accounting: the reward settles from the sponsor's funded account.
  const rewardAmount = chain.settlements[0]?.instruction.amount ?? fromMinorUnits(USD, 0n);
  postEntry(
    world,
    [
      { accountId: incentiveFundingAccount(sponsor), amount: fromMinorUnits(USD, -rewardAmount.value) },
      { accountId: LP_WALLET, amount: rewardAmount },
    ],
    "incentive reward settlement",
    "incentive:settlement",
  );

  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain),
    checkAccountingReconciles(world, [
      { account: incentiveFundingAccount(sponsor), amount: fromMinorUnits(USD, 47_500n) },
      { account: LP_WALLET, amount: fromMinorUnits(USD, 2_500n) },
    ]),
    checkFeesFxIncentivesExact([
      { label: "reward amount matches the program formula exactly", expected: fromMinorUnits(USD, 2_500n), actual: finalized.amount },
      { label: "settled reward obligation amount", expected: fromMinorUnits(USD, 2_500n), actual: rewardAmount },
      {
        label: "budget committed at promise time",
        expected: fromMinorUnits(USD, 2_500n),
        actual: fromMinorUnits(USD, liveBudget === undefined ? 0n : liveBudget.committed.value),
      },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: ["approval:incentive:camp-1", "grant:incentive:execution"],
      finalities: chain.settlements.map((s) => s.finality),
      evidenceLineageHasAuthorization: world.evidence
        .lineageForAction(chain.settlements[0]?.instruction.id ?? "")
        .authorization.length > 0,
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [envelope],
      canonicalMatches: [
        {
          description: "reward accrual -> protocol obligation -> SETTLED canonical state (AGENTS rule 12)",
          ok: rewardObligations.every((o) => world.obligations.get(o.id)?.state === "SETTLED"),
        },
        {
          description: "the campaign committed exactly the reward amount against the funded cap",
          ok: engine.campaignCommitted(campaign.id).value === 2_500n,
        },
      ],
      evidenceLinked: chain.settlements.every((s) => s.certificate.evidenceChain.length === 3),
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-P01", proof: `budget ${budget.fundingStatus} via protocol reservation ${budget.reservationId ?? "n/a"} BEFORE the reward was promised; committed ${budget.committed.value} minor units at accrual` },
    { id: "INV-P03", proof: `reward recomputation from evidence + program version reproduced ${recomputation.computed.value} minor units (reproducible: ${recomputation.reproducible})` },
    { id: "INV-P04", proof: `anti-gaming verdict ${antiGaming.verdict} (${antiGaming.checksRun.length} checks) gated finalization` },
    { id: "INV-P07", proof: `program version ${program.programId}@${program.version} is immutable and versioned` },
    { id: "INV-F04", proof: `the liquidity reservation of 250.00 USD could not exceed the observed 5,000.00 USD position (available ${availableBefore} -> ${availableAfter})` },
    { id: "INV-F01", proof: "reward, budget commitment and settlement amounts are exact integer minor units" },
    { id: "INV-F03", proof: "the reward settlement entry balances and the USD trial balance sums to zero" },
    { id: "INV-F06", proof: "the reward obligation settled through the protocol netting/settlement/finality chain" },
  ];

  const journey = assembleJourneyOutcome(
    "incentive-liquidity",
    "Incentive-funded liquidity acquisition",
    invariants,
    assertions,
    chain.evidenceNodeIds,
  );
  return {
    journey,
    details: {
      programId: program.programId,
      budgetFundingStatus: budget.fundingStatus,
      budgetCommittedMinorUnits: liveBudget === undefined ? 0n : liveBudget.committed.value,
      rewardAmount: finalized.amount,
      rewardReproducible: recomputation.reproducible,
      rewardObligationCount: rewardObligations.length,
      accruedState: accrued.state,
      finalizedState: finalized.state,
      claimableState: claimable.state,
      liquidityAssetId: liquidityAsset.id,
      liquidityAvailableBeforeMinorUnits: availableBefore,
      liquidityReservedMinorUnits: 250_000n,
      liquidityAvailableAfterMinorUnits: availableAfter,
      sponsorBalanceAfter: projected(world, incentiveFundingAccount(sponsor)),
      chain,
    },
  };
}

function projected(world: JourneyWorld, account: AccountId): Money {
  return projectBalances(world.journal, account).get(account) ?? fromMinorUnits(USD, 0n);
}

export const incentiveLiquidityJourney = {
  journeyId: "incentive-liquidity",
  title: "Incentive-funded liquidity acquisition",
  description:
    "campaign budget reservation -> reward accrual (funded — INV-P01) -> liquidity acquisition through protocol authority",
  run: (): JourneyOutcome => runIncentiveLiquidityJourney().journey,
} as const;
