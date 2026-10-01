/**
 * W2-007 fault families — incentive Sybil/collusion/wash behavior AND
 * leaderboard gaming (two scenarios, one module).
 *
 * Attack A (Sybil/collusion/wash): an attacker runs a self-referral Sybil
 * cluster and wash transactions to farm referral rewards, and a velocity
 * farmer trips the FLAG threshold.
 *
 * Attack B (leaderboard gaming): a gamer fabricates unverified activity to
 * climb a leaderboard and then attempts to use rank as authorization;
 * post-hoc detection triggers a clawback.
 *
 * Invariants on the line: INV-P04 (anti-Sybil/anti-collusion checks run
 * before reward finalization), INV-P01 (monetary incentives are funded or
 * explicitly contingent), INV-P03 (reward calculations reproducible),
 * INV-P02 (attribution deterministic and auditable), INV-P05
 * (leaderboards/points never become authorization), INV-P06 (clawbacks
 * create separate adjustment obligations; contribution history remains).
 */

import {
  ContributionLedger,
  ReferralRegistry,
  accrueReward,
  asContributionId,
  asIncentiveProgramId,
  asReferralBindingId,
  attributeContribution,
  clawBackReward,
  claimReward,
  defineLeaderboard,
  finalizeReward,
  projectLeaderboard,
  qualifyReward,
  recomputeReward,
  recordContribution,
  runAntiGamingChecks,
  reportAllowsFinalization,
} from "@payswap/participation";
import type {
  AntiGamingReport,
  ContributionRecord,
  EvidenceReference,
  IncentiveProgramVersion,
  RewardAccrual,
} from "@payswap/participation";
import { defineRoleLeaderboard, projectRoleLeaderboard } from "@payswap/campaigns";
import { evaluate } from "@payswap/trust";
import type { Principal } from "@payswap/trust";
import { usd } from "../harness.js";
import {
  buildAdversarialWorld,
  fundAccount,
  injectionCheck,
  party,
  probe,
  recoveryStep,
} from "../harness.js";
import type {
  AdversarialScenario,
  AdversarialWorld,
  FaultExecution,
} from "../harness.js";

/** A funded referral-reward program the attacker farms (registered on the world's real registries). */
function fundedReferralProgram(world: AdversarialWorld): IncentiveProgramVersion {
  const program = world.programs.registerProgram(
    {
      programId: asIncentiveProgramId("prog:adversarial-referral-1"),
      sponsor: party("sponsor-1"),
      objective: "Grow verified referral volume",
      eligibleRole: "SENDER",
      eligibilityRules: [{ kind: "ACTOR_ROLE", role: "SENDER" }],
      contributionEvents: ["REFERRAL_CREDIT"],
      proofRequirements: { minProofLevel: "P2" },
      reward: {
        mechanism: "REFERRAL",
        formula: { kind: "FIXED_PER_CONTRIBUTION", amount: usd(500n) },
      },
      budget: { totalAmount: usd(100_000n), funding: "REQUIRES_FUNDED_RESERVATION" },
      antiGamingPolicy: {
        forbidSelfReferral: true,
        requireIdentityLinkageChecks: true,
        velocity: { maxContributions: 3n, windowMs: 600_000n },
      },
      clawbackPolicy: { clawbackWindowMs: 2_592_000_000n, requiresDisputeRecord: false },
      privacyRules: ["aggregate-only reporting"],
      effectiveFrom: world.journey.clock.now(),
    },
    "ACTIVE",
  );
  world.budgets.establishFundedBudget(program);
  return program;
}

function contributionFixture(options: {
  readonly id: string;
  readonly actor: string;
  readonly actorRole?: "SENDER" | "MERCHANT";
  readonly behavior: string;
  readonly outcome: "VERIFIED_COMPLETED" | "OBSERVED" | "REJECTED";
  readonly evidenceLevel: "P0" | "P1" | "P2" | "P3" | "P4" | "P5";
  readonly quantity: bigint;
  readonly counterparty?: string;
  readonly occurredAt: bigint;
  readonly program?: IncentiveProgramVersion;
}): ContributionRecord {
  const actorRole = options.actorRole ?? "SENDER";
  const evidence: readonly EvidenceReference[] = [
    { kind: "contribution-proof", locator: `evidence:${options.id}`, level: options.evidenceLevel },
  ];
  return {
    id: asContributionId(options.id),
    actor: party(options.actor),
    actorRole,
    behavior: options.behavior,
    affectedObjects: [{ objectType: "referral", objectId: options.id }],
    quantity: options.quantity,
    occurredAt: options.occurredAt,
    outcome: options.outcome,
    evidence,
    attribution: attributeContribution({
      actor: party(options.actor),
      actorRole,
      evidence,
      rules: [{ ruleId: "rule:direct", kind: "DIRECT_PARTICIPANT" }],
    }),
    ...(options.counterparty !== undefined ? { counterparty: party(options.counterparty) } : {}),
    ...(options.program !== undefined
      ? {
          programVersion: {
            programId: options.program.programId,
            version: options.program.version,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Scenario A — incentive Sybil / collusion / wash
// ---------------------------------------------------------------------------

/** Typed binding evidence (the ProofLevel literal must not widen to string). */
function bindingEvidence(locator: string): readonly EvidenceReference[] {
  return [{ kind: "binding", locator, level: "P2" }];
}

export function incentiveSybilCollusionWashScenario(): AdversarialScenario {
  const declaration = {
    faultId: "fault:incentive-sybil-collusion-wash:1",
    family: "incentive-sybil-collusion-wash" as const,
    title: "Sybil cluster, self-referral and wash farming against reward finalization",
    description:
      "An attacker self-refers through an identity-linked Sybil cluster, washes transactions and farms velocity; the anti-gaming checks block every finalization, an unfunded (contingent) program cannot finalize either, and the honest contributor still earns reproducibly.",
    candidateInvariants: ["INV-P04", "INV-P01", "INV-P03", "INV-P02"],
    attackedSubsystems: ["@payswap/participation", "@payswap/protocol"],
  };

  return {
    declaration,
    run: (): FaultExecution => {
      const world = buildAdversarialWorld();
      fundAccount(world, world.accounts.incentiveAccountFor("sponsor-1"), usd(200_000n));
      const now = (): bigint => world.journey.clock.now();
      const program = fundedReferralProgram(world);
      const deps = {
        ids: world.journey.ids,
        clock: world.journey.clock,
        rewards: world.rewards,
        budgets: world.budgets,
        obligations: world.journey.obligations,
      };

      // --- INJECTION: the Sybil attack -------------------------------------
      const referrals = new ReferralRegistry();
      let selfReferralRefused = false;
      let selfReferralError = "";
      try {
        referrals.bind({
          id: asReferralBindingId("rb:self"),
          introducer: party("sybil-1"),
          introduced: party("sybil-1"),
          code: "SELF",
          boundAt: now(),
          evidence: bindingEvidence("bind:self"),
        });
      } catch (error) {
        selfReferralRefused = true;
        selfReferralError = error instanceof Error ? error.message : "unknown";
      }

      const sybilContribution = contributionFixture({
        id: "contrib:sybil-1",
        actor: "sybil-1",
        behavior: "REFERRAL_CREDIT",
        outcome: "VERIFIED_COMPLETED",
        evidenceLevel: "P3",
        quantity: 1n,
        counterparty: "sybil-2",
        occurredAt: now(),
        program,
      });
      const sybilBinding = {
        id: asReferralBindingId("rb:sybil"),
        introducer: party("sybil-1"),
        introduced: party("sybil-2"),
        code: "SYBIL",
        boundAt: now(),
        evidence: bindingEvidence("bind:sybil"),
      };
      const sybilReport = runAntiGamingChecks(program.antiGamingPolicy, {
        contribution: sybilContribution,
        history: [],
        referralBinding: sybilBinding,
        identityLinks: [{ a: party("sybil-1"), b: party("sybil-2"), kind: "same_device_kyc" }],
        declaredSurfaces: [],
        now: now(),
      });

      // --- INJECTION: wash transactions ------------------------------------
      const washContribution = contributionFixture({
        id: "contrib:wash-1",
        actor: "wash-1",
        behavior: "REFERRAL_CREDIT",
        outcome: "VERIFIED_COMPLETED",
        evidenceLevel: "P3",
        quantity: 1n,
        counterparty: "wash-1",
        occurredAt: now(),
        program,
      });
      const washReport = runAntiGamingChecks(program.antiGamingPolicy, {
        contribution: washContribution,
        history: [],
        identityLinks: [],
        declaredSurfaces: [],
        now: now(),
      });

      // --- INJECTION: velocity farming (FLAG) ------------------------------
      const velocityHistory: readonly ContributionRecord[] = [
        contributionFixture({
          id: "contrib:velocity-h1",
          actor: "farmer-1",
          behavior: "REFERRAL_CREDIT",
          outcome: "VERIFIED_COMPLETED",
          evidenceLevel: "P3",
          quantity: 1n,
          counterparty: "merchant-7",
          occurredAt: now() - 1_000n,
          program,
        }),
        contributionFixture({
          id: "contrib:velocity-h2",
          actor: "farmer-1",
          behavior: "REFERRAL_CREDIT",
          outcome: "VERIFIED_COMPLETED",
          evidenceLevel: "P3",
          quantity: 1n,
          counterparty: "merchant-8",
          occurredAt: now() - 500n,
          program,
        }),
        contributionFixture({
          id: "contrib:velocity-h3",
          actor: "farmer-1",
          behavior: "REFERRAL_CREDIT",
          outcome: "VERIFIED_COMPLETED",
          evidenceLevel: "P3",
          quantity: 1n,
          counterparty: "merchant-9",
          occurredAt: now() - 250n,
          program,
        }),
      ];
      const farmerContribution = contributionFixture({
        id: "contrib:farmer-1",
        actor: "farmer-1",
        behavior: "REFERRAL_CREDIT",
        outcome: "VERIFIED_COMPLETED",
        evidenceLevel: "P3",
        quantity: 1n,
        counterparty: "merchant-10",
        occurredAt: now(),
        program,
      });
      const velocityReport = runAntiGamingChecks(program.antiGamingPolicy, {
        contribution: farmerContribution,
        history: velocityHistory,
        identityLinks: [],
        declaredSurfaces: [],
        now: now(),
      });

      // --- the attack reaches finalization ---------------------------------
      const sybilAccrual = accrueReward(deps, program, sybilContribution);
      let blockedFinalizationThrown = false;
      let blockedFinalizationError = "";
      try {
        finalizeReward(deps, program, sybilAccrual.id, sybilReport);
      } catch (error) {
        blockedFinalizationThrown = true;
        blockedFinalizationError = error instanceof Error ? error.constructor.name : "unknown";
      }
      const sybilAccrualAfter = world.rewards.get(sybilAccrual.id);

      // --- INJECTION: the unfunded (contingent) promise --------------------
      const contingentProgram = world.programs.registerProgram(
        {
          programId: asIncentiveProgramId("prog:adversarial-contingent-1"),
          sponsor: party("sponsor-1"),
          objective: "Contingent completion bounty",
          eligibleRole: "SENDER",
          eligibilityRules: [{ kind: "ACTOR_ROLE", role: "SENDER" }],
          contributionEvents: ["REFERRAL_CREDIT"],
          proofRequirements: { minProofLevel: "P2" },
          reward: {
            mechanism: "COMPLETION_BOUNTY",
            formula: { kind: "FIXED_PER_CONTRIBUTION", amount: usd(300n) },
          },
          budget: { totalAmount: usd(50_000n), funding: "EXPLICITLY_CONTINGENT" },
          antiGamingPolicy: { forbidSelfReferral: true, requireIdentityLinkageChecks: true },
          clawbackPolicy: { clawbackWindowMs: 2_592_000_000n, requiresDisputeRecord: false },
          privacyRules: [],
          effectiveFrom: now(),
        },
        "ACTIVE",
      );
      world.budgets.declareContingentBudget(contingentProgram);
      const contingentContribution = contributionFixture({
        id: "contrib:contingent-1",
        actor: "sender-contingent",
        behavior: "REFERRAL_CREDIT",
        outcome: "VERIFIED_COMPLETED",
        evidenceLevel: "P3",
        quantity: 1n,
        counterparty: "merchant-11",
        occurredAt: now(),
        program: contingentProgram,
      });
      const contingentAccrual = accrueReward(deps, contingentProgram, contingentContribution);
      const passReport: AntiGamingReport = runAntiGamingChecks(contingentProgram.antiGamingPolicy, {
        contribution: contingentContribution,
        history: [],
        identityLinks: [],
        declaredSurfaces: [],
        now: now(),
      });
      let unfundedFinalizationThrown = false;
      let unfundedFinalizationError = "";
      try {
        finalizeReward(deps, contingentProgram, contingentAccrual.id, passReport);
      } catch (error) {
        unfundedFinalizationThrown = true;
        unfundedFinalizationError = error instanceof Error ? error.constructor.name : "unknown";
      }
      const contingentAccrualAfter = world.rewards.get(contingentAccrual.id);

      // --- recovery: fund the contingent budget, then finalize -------------
      world.budgets.fundContingentBudget({
        programId: contingentProgram.programId,
        version: contingentProgram.version,
      });
      const fundedFinalization = finalizeReward(deps, contingentProgram, contingentAccrual.id, passReport);

      // --- recovery: the honest contributor --------------------------------
      const honestPrior = contributionFixture({
        id: "contrib:honest-prior",
        actor: "sender-alice",
        behavior: "REFERRAL_CREDIT",
        outcome: "VERIFIED_COMPLETED",
        evidenceLevel: "P3",
        quantity: 1n,
        counterparty: "merchant-12",
        occurredAt: now() - 1_000n,
        program,
      });
      const honestContribution = contributionFixture({
        id: "contrib:honest-1",
        actor: "sender-alice",
        behavior: "REFERRAL_CREDIT",
        outcome: "VERIFIED_COMPLETED",
        evidenceLevel: "P3",
        quantity: 1n,
        counterparty: "merchant-13",
        occurredAt: now(),
        program,
      });
      const honestReport = runAntiGamingChecks(program.antiGamingPolicy, {
        contribution: honestContribution,
        history: [honestPrior],
        identityLinks: [],
        declaredSurfaces: [],
        now: now(),
      });
      const honestAccrual = accrueReward(deps, program, honestContribution);
      const honestFinalized = finalizeReward(deps, program, honestAccrual.id, honestReport);
      const recomputation = recomputeReward(program, honestContribution, "WITHIN_BAND", honestAccrual);

      // --- INV-P02: attribution determinism --------------------------------
      const attributionEvidence = honestContribution.evidence;
      const attributionOne = attributeContribution({
        actor: party("sender-alice"),
        actorRole: "SENDER",
        evidence: attributionEvidence,
        rules: [{ ruleId: "rule:direct", kind: "DIRECT_PARTICIPANT" }],
      });
      const attributionTwo = attributeContribution({
        actor: party("sender-alice"),
        actorRole: "SENDER",
        evidence: attributionEvidence,
        rules: [{ ruleId: "rule:direct", kind: "DIRECT_PARTICIPANT" }],
      });
      const attributionDeterministic =
        attributionOne.attributedActor === attributionTwo.attributedActor &&
        attributionOne.basis === attributionTwo.basis &&
        attributionOne.decisionTrace.length === attributionTwo.decisionTrace.length &&
        attributionOne.decisionTrace.every((line, index) => {
          const other = attributionTwo.decisionTrace[index];
          return other !== undefined && line.ruleId === other.ruleId && line.matched === other.matched;
        });

      const injectionChecks = [
        injectionCheck(
          selfReferralRefused && /refer themselves/.test(selfReferralError),
          `the self-referral binding was refused at the registry: ${selfReferralError}`,
        ),
        injectionCheck(
          sybilReport.verdict === "BLOCK" &&
            sybilReport.findings.some((finding) => finding.code === "SYBIL_IDENTITY_CLUSTER"),
          `the Sybil cluster (identity-linked introducer↔introduced) produced verdict ${sybilReport.verdict} with finding ${sybilReport.findings.map((f) => f.code).join(", ") || "none"}`,
        ),
        injectionCheck(
          washReport.verdict === "BLOCK" &&
            washReport.findings.some((finding) => finding.code === "WASH_TRANSACTION_PATTERN"),
          `the wash transaction (actor === counterparty) produced verdict ${washReport.verdict} with finding ${washReport.findings.map((f) => f.code).join(", ") || "none"}`,
        ),
        injectionCheck(
          velocityReport.verdict === "FLAG" &&
            velocityReport.findings.some((finding) => finding.code === "VELOCITY_LIMIT_EXCEEDED"),
          `velocity farming (4 contributions in a 3-max window) produced verdict ${velocityReport.verdict} with finding ${velocityReport.findings.map((f) => f.code).join(", ") || "none"}`,
        ),
        injectionCheck(
          blockedFinalizationThrown && blockedFinalizationError === "AntiGamingGateError",
          `the BLOCKED reward finalization threw ${blockedFinalizationError}`,
        ),
        injectionCheck(
          unfundedFinalizationThrown && unfundedFinalizationError === "UnfundedRewardFinalizationError",
          `the contingent (unfunded) program's finalization threw ${unfundedFinalizationError}`,
        ),
      ];

      const probes = [
        probe(
          "INV-P04",
          reportAllowsFinalization(sybilReport) === false &&
            reportAllowsFinalization(washReport) === false &&
            reportAllowsFinalization(velocityReport) === false &&
            blockedFinalizationThrown &&
            sybilAccrualAfter !== undefined &&
            sybilAccrualAfter.state === "PROVISIONAL",
          `anti-Sybil/anti-collusion checks ran BEFORE finalization: BLOCK (sybil), BLOCK (wash) and FLAG (velocity) all refused — the accrual stays ${sybilAccrualAfter?.state ?? "absent"}`,
        ),
        probe(
          "INV-P01",
          unfundedFinalizationThrown &&
            contingentAccrualAfter !== undefined &&
            contingentAccrualAfter.state === "PROVISIONAL" &&
            fundedFinalization.state === "CONFIRMED",
          `the contingent program could not finalize while unfunded (${unfundedFinalizationError}); after fundContingentBudget the same accrual finalized to ${fundedFinalization.state}`,
        ),
        probe(
          "INV-P03",
          recomputation.reproducible === true &&
            honestFinalized.state === "CONFIRMED" &&
            honestFinalized.antiGamingVerdict === "PASS",
          `the honest reward is reproducible from evidence + program version (recomputeReward reproducible=${String(recomputation.reproducible)}, digest ${recomputation.formulaDigest}) and finalized CONFIRMED`,
        ),
        probe(
          "INV-P02",
          attributionDeterministic &&
            attributionOne.attributedActor === party("sender-alice") &&
            attributionOne.decisionTrace.length > 0,
          `attribution is deterministic and auditable: identical inputs produce the identical attributed actor, basis and ${attributionOne.decisionTrace.length}-line decision trace`,
        ),
      ];

      const recoveryPath = [
        recoveryStep(
          1,
          "Self-referral binding refused at the registry",
          selfReferralRefused,
          `an actor cannot refer themselves (${selfReferralError})`,
        ),
        recoveryStep(
          2,
          "Sybil cluster blocked before finalization",
          sybilReport.verdict === "BLOCK" && blockedFinalizationThrown,
          `the identity-linked cluster was detected and finalizeReward refused (${blockedFinalizationError}); the accrual stays PROVISIONAL`,
        ),
        recoveryStep(
          3,
          "Wash pattern blocked",
          washReport.verdict === "BLOCK",
          `the wash transaction (actor === counterparty) was BLOCKed by the always-on wash check`,
        ),
        recoveryStep(
          4,
          "Velocity farming flagged and refused",
          velocityReport.verdict === "FLAG" && reportAllowsFinalization(velocityReport) === false,
          `FLAG also refuses finalization — only PASS finalizes`,
        ),
        recoveryStep(
          5,
          "Contingent budget funded, then finalization succeeds",
          fundedFinalization.state === "CONFIRMED",
          `the explicitly-contingent promise became fundable only after fundContingentBudget (INV-P01)`,
        ),
        recoveryStep(
          6,
          "Honest contributor earns reproducibly",
          honestFinalized.state === "CONFIRMED" && recomputation.reproducible === true,
          `sender-alice's verified, diverse-counterparty contribution passed all checks and finalized CONFIRMED with a reproducible digest`,
        ),
      ];

      const evidenceRefsOut = [
        sybilAccrual.id,
        contingentAccrual.id,
        honestAccrual.id,
        "rb:sybil",
        "contrib:sybil-1",
        "contrib:wash-1",
        "contrib:honest-1",
      ];

      return {
        declaration,
        injected: injectionChecks.every((check) => check.ok),
        injectionChecks,
        probes,
        recoveryPath,
        evidenceRefs: evidenceRefsOut,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario B — leaderboard gaming
// ---------------------------------------------------------------------------

export function leaderboardGamingScenario(): AdversarialScenario {
  const declaration = {
    faultId: "fault:leaderboard-gaming:1",
    family: "leaderboard-gaming" as const,
    title: "Leaderboard gaming — fabricated activity, raw-count metrics and rank-as-authority",
    description:
      "A gamer fabricates unverified activity to climb a leaderboard, tries to define a raw-activity metric and to bypass the ENFORCED proof gate, then attempts to use rank as authorization; post-hoc detection triggers a clawback with separate adjustment obligations.",
    candidateInvariants: ["INV-P05", "INV-P06"],
    attackedSubsystems: ["@payswap/participation", "@payswap/campaigns", "@payswap/trust"],
  };

  return {
    declaration,
    run: (): FaultExecution => {
      const world = buildAdversarialWorld();
      fundAccount(world, world.accounts.incentiveAccountFor("sponsor-1"), usd(100_000n));
      const now = (): bigint => world.journey.clock.now();
      const program = fundedReferralProgram(world);
      const deps = {
        ids: world.journey.ids,
        clock: world.journey.clock,
        rewards: world.rewards,
        budgets: world.budgets,
        obligations: world.journey.obligations,
      };
      const contributions = new ContributionLedger();

      // --- INJECTION: fabricated gamer activity ----------------------------
      const gamerRecords: readonly ContributionRecord[] = [1, 2, 3].map((index) =>
        contributionFixture({
          id: `contrib:gamer-${index}`,
          actor: "gamer-1",
          actorRole: "MERCHANT",
          behavior: "MERCHANT_SALE",
          outcome: "OBSERVED",
          evidenceLevel: "P0",
          quantity: 50n,
          counterparty: `gamer-shell-${index}`,
          occurredAt: now() - BigInt(index) * 10n,
        }),
      );
      const honestRecord = contributionFixture({
        id: "contrib:honest-merchant",
        actor: "merchant-honest",
        actorRole: "MERCHANT",
        behavior: "MERCHANT_SALE",
        outcome: "VERIFIED_COMPLETED",
        evidenceLevel: "P3",
        quantity: 10n,
        counterparty: "customer-42",
        occurredAt: now() - 5n,
      });
      const clawRecord = contributionFixture({
        id: "contrib:claw-1",
        actor: "sender-claw",
        behavior: "REFERRAL_CREDIT",
        outcome: "VERIFIED_COMPLETED",
        evidenceLevel: "P3",
        quantity: 1n,
        counterparty: "merchant-14",
        occurredAt: now(),
        program,
      });
      for (const record of [...gamerRecords, honestRecord, clawRecord]) {
        recordContribution(contributions, record);
      }
      const postedCount = gamerRecords.length + 2;

      // --- INJECTION: metric/gate bypass attempts --------------------------
      let rawMetricRejected = false;
      let rawMetricError = "";
      try {
        defineLeaderboard(
          {
            scope: "global",
            actorRole: "MERCHANT",
            metric: {
              kind: "RAW_ACTIVITY_COUNT",
              qualityWeights: { VERIFIED_COMPLETED: 1n, OBSERVED: 1n, REJECTED: 0n },
            },
            period: { from: now() - 1_000n, to: now() + 1_000n },
            eligibility: [{ kind: "MIN_PROOF_LEVEL", level: "P2" }],
            freshness: { computedAt: now(), sourceCutoff: now() },
            evidenceStrength: "P2",
            tieRule: "EARLIEST_FIRST",
            antiGamingStatus: "ENFORCED",
            includedBehaviors: ["MERCHANT_SALE"],
          },
          { ids: world.journey.ids },
        );
      } catch (error) {
        rawMetricRejected = true;
        rawMetricError = error instanceof Error ? error.constructor.name : "unknown";
      }

      let ungatedEnforcedRejected = false;
      let ungatedEnforcedError = "";
      try {
        defineLeaderboard(
          {
            scope: "global",
            actorRole: "MERCHANT",
            metric: {
              kind: "QUALITY_WEIGHTED_UNITS",
              qualityWeights: { VERIFIED_COMPLETED: 2n, OBSERVED: 1n, REJECTED: 0n },
            },
            period: { from: now() - 1_000n, to: now() + 1_000n },
            eligibility: [],
            freshness: { computedAt: now(), sourceCutoff: now() },
            evidenceStrength: "P2",
            tieRule: "EARLIEST_FIRST",
            antiGamingStatus: "ENFORCED",
            includedBehaviors: ["MERCHANT_SALE"],
          },
          { ids: world.journey.ids },
        );
      } catch (error) {
        ungatedEnforcedRejected = true;
        ungatedEnforcedError = error instanceof Error ? error.message : "unknown";
      }

      // --- the honest-gated projection over the same records ---------------
      const definition = defineLeaderboard(
        {
          scope: "global",
          actorRole: "MERCHANT",
          metric: {
            kind: "QUALITY_WEIGHTED_UNITS",
            qualityWeights: { VERIFIED_COMPLETED: 2n, OBSERVED: 1n, REJECTED: 0n },
          },
          period: { from: now() - 1_000n, to: now() + 1_000n },
          eligibility: [{ kind: "MIN_PROOF_LEVEL", level: "P2" }],
          freshness: { computedAt: now(), sourceCutoff: now() },
          evidenceStrength: "P2",
          tieRule: "EARLIEST_FIRST",
          antiGamingStatus: "ENFORCED",
          includedBehaviors: ["MERCHANT_SALE"],
        },
        { ids: world.journey.ids },
      );
      const projection = projectLeaderboard(definition, contributions.all);
      const gamerRanked = projection.entries.some((entry) => entry.actor === party("gamer-1"));
      const honestEntry = projection.entries.find((entry) => entry.actor === party("merchant-honest"));

      // --- the campaigns-side projection carries the NON_AUTHORIZATION mark
      const roleLeaderboard = defineRoleLeaderboard(
        {
          role: "MERCHANT",
          scope: "global",
          metric: {
            kind: "QUALITY_WEIGHTED_UNITS",
            qualityWeights: { VERIFIED_COMPLETED: 2n, OBSERVED: 1n, REJECTED: 0n },
          },
          period: { from: now() - 1_000n, to: now() + 1_000n },
          eligibility: [{ kind: "MIN_PROOF_LEVEL", level: "P2" }],
          freshness: { computedAt: now(), sourceCutoff: now() },
          evidenceStrength: "P2",
          tieRule: "EARLIEST_FIRST",
          includedBehaviors: ["MERCHANT_SALE"],
        },
        { ids: world.journey.ids },
      );
      const roleProjection = projectRoleLeaderboard(roleLeaderboard, contributions.all);

      // --- the attack: rank used as authorization --------------------------
      const gamerPrincipal: Principal = {
        kind: "user",
        id: "gamer-1",
        securityEpoch: 0n,
      };
      const rankAuthorization = evaluate(
        {
          principal: gamerPrincipal,
          action: "payments.execute",
          resource: { type: "payment_intent", resourceId: "pi-gamer-1" },
          context: { amount: { currency: "USD", minorUnits: "10000" } },
          requestHash: "reqhash:lb:gamer",
          requestedAt: Number(now()),
        },
        [], // the gamer holds NO grants — rank is not a grant
        { ledger: world.epochLedger },
      );

      // --- post-hoc detection: the claimed reward is clawed back -----------
      const clawReport = runAntiGamingChecks(program.antiGamingPolicy, {
        contribution: clawRecord,
        history: [],
        identityLinks: [],
        declaredSurfaces: [],
        now: now(),
      });
      const clawAccrual = accrueReward(deps, program, clawRecord);
      const clawFinalized = finalizeReward(deps, program, clawAccrual.id, clawReport);
      const clawQualified = qualifyReward(deps, program, clawAccrual.id, {
        settlementWindowMs: 86_400_000n,
      });
      const clawClaimed = claimReward(deps, program, clawAccrual.id);
      const clawedBack = clawBackReward(deps, program, clawAccrual.id, {
        settlementWindowMs: 86_400_000n,
      });
      const clawObligations = {
        original: clawedBack.obligationIds,
        adjustments: clawedBack.adjustmentObligationIds,
      };
      const firstOriginalId = clawedBack.obligationIds[0];
      const originalObligation =
        firstOriginalId !== undefined ? world.journey.obligations.get(firstOriginalId) : undefined;
      const firstAdjustmentId = clawedBack.adjustmentObligationIds[0];
      const adjustmentObligation =
        firstAdjustmentId !== undefined ? world.journey.obligations.get(firstAdjustmentId) : undefined;
      const historyIntact = contributions.all.length === postedCount;

      const injectionChecks = [
        injectionCheck(
          gamerRecords.length === 3 &&
            gamerRecords.every((record) => record.outcome === "OBSERVED" && record.evidence[0]?.level === "P0"),
          `the gamer fabricated ${gamerRecords.length} unverified (P0/OBSERVED) contributions with inflated quantity 50`,
        ),
        injectionCheck(
          rawMetricRejected && rawMetricError === "RawActivityMetricRejectedError",
          `the raw-activity-count leaderboard definition was rejected with ${rawMetricError}`,
        ),
        injectionCheck(
          ungatedEnforcedRejected && /MIN_PROOF_LEVEL/.test(ungatedEnforcedError),
          `an ENFORCED leaderboard without a P1+ proof gate was rejected: ${ungatedEnforcedError}`,
        ),
        injectionCheck(
          gamerRanked === false &&
            honestEntry !== undefined &&
            projection.excludedCount >= BigInt(gamerRecords.length),
          `the projection excluded all ${gamerRecords.length} fabricated records (excludedCount ${projection.excludedCount}) and ranked only verified contributors`,
        ),
        injectionCheck(
          clawedBack.state === "CLAWED_BACK" &&
            clawClaimed.state === "CLAIMED" &&
            clawFinalized.state === "CONFIRMED",
          `the post-hoc clawback executed over the full lifecycle CONFIRMED → CLAIMABLE → CLAIMED → CLAWED_BACK`,
        ),
      ];

      const probes = [
        probe(
          "INV-P05",
          gamerRanked === false &&
            rankAuthorization.decision === "DENY" &&
            rankAuthorization.reason === "no_matching_grant" &&
            roleProjection.nonAuthorization.marker === "NOT_AUTHORIZATION" &&
            (honestEntry?.__projection ?? "") === "LEADERBOARD_PROJECTION",
          `leaderboards never authorize: the fabricated records were excluded by the ENFORCED proof gate, the projection is branded ${honestEntry?.__projection ?? "absent"}, the campaigns projection carries ${roleProjection.nonAuthorization.marker}, and the gamer's rank-as-authorization request was DENY/${rankAuthorization.decision === "DENY" ? rankAuthorization.reason : "n/a"}`,
        ),
        probe(
          "INV-P06",
          clawedBack.state === "CLAWED_BACK" &&
            clawObligations.adjustments.length === 1 &&
            clawedBack.obligationIds.length === clawQualified.obligationIds.length &&
            adjustmentObligation !== undefined &&
            adjustmentObligation.debtor === party("sender-claw") &&
            adjustmentObligation.creditor === party("sponsor-1") &&
            originalObligation !== undefined &&
            historyIntact,
          `the clawback created a SEPARATE adjustment obligation (${adjustmentObligation?.debtor ?? "?"} → ${adjustmentObligation?.creditor ?? "?"} ${adjustmentObligation?.amount.value ?? 0n} minor units) while the original obligation and the ${contributions.all.length} contribution records remain intact`,
        ),
      ];

      const recoveryPath = [
        recoveryStep(
          1,
          "Raw-activity metric rejected at definition time",
          rawMetricRejected,
          `leaderboards must reflect useful outcomes (${rawMetricError})`,
        ),
        recoveryStep(
          2,
          "ENFORCED anti-gaming requires a proof gate",
          ungatedEnforcedRejected,
          `an ENFORCED leaderboard without MIN_PROOF_LEVEL ≥ P1 cannot be defined`,
        ),
        recoveryStep(
          3,
          "Fabricated records excluded from the projection",
          gamerRanked === false && honestEntry !== undefined,
          `only verified contributions rank (${projection.entries.length} entr(ies)); excludedCount ${projection.excludedCount}`,
        ),
        recoveryStep(
          4,
          "Rank refused as authorization",
          rankAuthorization.decision === "DENY",
          `the gamer's payments.execute request was DENY (no matching grant) — points/rank are projections, not authority`,
        ),
        recoveryStep(
          5,
          "Post-hoc gaming detection clawed the reward back",
          clawedBack.state === "CLAWED_BACK" && clawObligations.adjustments.length === 1,
          `the claimed reward was clawed back within the window, creating a separate adjustment obligation and preserving the contribution history`,
        ),
      ];

      const evidenceRefs = [
        `leaderboard:${definition.id}`,
        "contrib:gamer-1",
        "contrib:honest-merchant",
        clawAccrual.id,
        ...clawedBack.adjustmentObligationIds,
        ...(clawQualified.obligationIds.length > 0 ? [clawQualified.obligationIds[0] ?? ""] : []),
      ];

      return {
        declaration,
        injected: injectionChecks.every((check) => check.ok),
        injectionChecks,
        probes,
        recoveryPath,
        evidenceRefs,
      };
    },
  };
}
