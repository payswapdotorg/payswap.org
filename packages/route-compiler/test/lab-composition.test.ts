/**
 * Lab composition (Work Order P4-W4-001 task-packet hard requirement 7:
 * "compose the REAL merged kernels … mixed-rail Lab classes").
 *
 * The Lab runtime is driven from the TEST layer only (the repository-wide
 * INV-L01 law: no src/ ever imports @payswap/lab). This suite composes a
 * REAL Lab candidate organization whose lanes are ROUTE-COMPILER ARTIFACTS:
 *
 * - the fiat lanes are the compiled route-2 plan's PSP collect/issuance
 *   instances grounded through the Lab's OWN search
 *   (buildLabSearchIndex → selectExecutableBlocks — INV-C05 grounding);
 * - the onchain lane is the REAL engine-selected lane proof carried by the
 *   compiled route-1 DEX swap leg, executed through the REAL mixed-rail
 *   executeOnchainLane;
 * - the candidate organization is composed by the Lab's own
 *   composeCandidateOrganization with the non-production constraint as the
 *   FIRST domain hard constraint;
 * - the fiat legs run through the Lab's own runSimulation (its laws apply
 *   unchanged) and the aggregate carries the structural non-production
 *   execution tier from mixed-rail src.
 */

import { describe, expect, it } from "vitest";
import {
  buildLabSearchIndex,
  composeCandidateOrganization,
  runSimulation,
  selectExecutableBlocks,
} from "@payswap/lab";
import type {
  CandidateBuildingBlockRef,
  DomainPack,
  ExecutableBlock,
  LabCandidate,
  SimulationProgram,
} from "@payswap/lab";
import {
  LAB_EXECUTION_TIER,
  executeOnchainLane,
  isLabTieredValue,
} from "@payswap/mixed-rail";
import { protocolCapabilityId } from "@payswap/onchain-domain";
import {
  compileBase,
  route1Intent,
  route2Intent,
  makeNativeRoutingDefinition,
  makeComposedPayoutDefinition,
  makeFiatInstance,
  makeFiatObservation,
  fiatWorld,
  fiatScenario,
  CANDIDATE_BODY_REF,
  CANDIDATE_PRINCIPAL,
  ONCHAIN_FINALITY_MODES,
  NOW,
  NOW_ISO,
} from "./fixtures.js";

/** The route-compiler domain pack (the Lab's DomainPack declaration dimensions). */
export const ROUTE_COMPILER_DOMAIN_PACK: DomainPack = {
  packId: "lab.domain-pack.route-compiler",
  version: "1.0.0",
  domain: "mixed-fiat-onchain-route-compilation",
  scenarioTypes: [
    "NORMAL_DEMAND",
    "PROVIDER_OUTAGE",
    "FX_VOLATILITY",
    "DELAYED_WRITE",
    "CONGESTION",
    "PARTIAL_PAYMENT",
  ],
  hardConstraints: [
    "AUTHORIZATION",
    "COMPLIANCE",
    "PRIVACY",
    "DEADLINE",
    "EXPLICIT_CREDIT",
  ],
  objectives: ["TOTAL_COST", "RESILIENCE", "LATENCY", "OPERATIONAL_COMPLEXITY"],
  observables: [
    "externalValueMovedMinor",
    "feesMinor",
    "totalLatencyMs",
    "unknownOutcomes",
    "routeLegsObserved",
    "routeLegsUnknown",
  ],
  actionSpace: [
    {
      dimensionId: "route-preference",
      description: "ordered preference over compiled route-plan rails",
      domain: ["rail-a", "rail-b", "onchain.ethereum:mainnet"],
    },
  ],
  failureTaxonomy: [
    "FAILED_NO_VIABLE_ROUTE",
    "UNKNOWN_REQUIRES_RECONCILIATION",
    "OUTCOME_UNKNOWN",
    "RAIL_EFFECT_FAILED",
    "RAIL_EFFECT_PENDING",
    "GROUNDING_STALE",
    "HARD_CONSTRAINT_VIOLATION",
  ],
  policySet: [
    "policy:protocol-authorization-required",
    "policy:adversarial-screening-required",
    "policy:privacy-minimum-context",
    "policy:lab-simulation-never-production",
    "policy:route-compiler-journeys-are-lab-compositions",
  ],
  evaluationSuite: {
    suiteId: "lab.route-compiler-suite",
    version: "1.0.0",
  },
  provenanceRequirements: [
    {
      requirementId: "route-leg-custody-law",
      description:
        "every compiled route leg carries an explicit, evidenced custody transfer and consecutive legs custody-chain (the no-hidden-custody law, INV-C09/INV-E02)",
      acceptedEvidenceKinds: ["ATTESTATION", "TEST_RUN"],
    },
    {
      requirementId: "compiled-plan-determinism",
      description:
        "every compiled plan and walk is a pure function of its inputs (caller-supplied instants, canonical input ordering, no ambient clock, no randomness)",
      acceptedEvidenceKinds: ["TEST_RUN", "REPLAY"],
    },
    {
      requirementId: "non-production-tier-provenance",
      description:
        "every route-compiler Lab composition carries the structural non-production execution tier and is rejected by settlement gates",
      acceptedEvidenceKinds: ["TEST_RUN"],
    },
  ],
};

describe("route-compiler artifacts compose the REAL Lab", () => {
  it("the compiled route-2 fiat instances ground as Lab executable blocks (INV-C05)", () => {
    const nativeDefinition = makeNativeRoutingDefinition();
    const payoutDefinition = makeComposedPayoutDefinition();
    const nativeInstance = makeFiatInstance({
      instanceId: "instance:native-routing:1",
      capabilityId: nativeDefinition.capabilityId,
    });
    const payoutInstance = makeFiatInstance({
      instanceId: "instance:psp-payouts:1",
      capabilityId: payoutDefinition.capabilityId,
    });
    const index = buildLabSearchIndex({
      definitions: [nativeDefinition, payoutDefinition],
      instances: [nativeInstance, payoutInstance],
      observations: [
        makeFiatObservation({ instanceId: nativeInstance.instanceId }),
        makeFiatObservation({ instanceId: payoutInstance.instanceId }),
      ],
    });
    const { executable } = selectExecutableBlocks(index, {
      domain: "payment-routing",
      currency: "EUR",
    });
    expect(executable.length).toBeGreaterThan(0);
    // The blocks are the same instances the compiled plan grounds in.
    const plan = compileBase(route2Intent()).plans.find(
      (plan) => plan.shapeId === "mixed-psp-onramp",
    )!;
    const collect = plan.legs[0] as Extract<
      typeof plan.legs[number],
      { legKind: "FIAT_PSP_COLLECT" }
    >;
    expect(
      executable.some((block) => block.instance.instanceId === collect.instance.instanceId),
    ).toBe(true);
  });

  it("composes a candidate organization whose onchain lane is the compiled route-1 DEX lane", () => {
    const route1 = compileBase(route1Intent());
    const plan = route1.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const swap = plan.legs[0] as Extract<typeof plan.legs[number], { legKind: "ONCHAIN_DEX_SWAP" }>;
    const lane = swap.lane;

    // Fiat blocks from the compiled route-2 grounding (the Lab search).
    const nativeDefinition = makeNativeRoutingDefinition();
    const payoutDefinition = makeComposedPayoutDefinition();
    const nativeInstance = makeFiatInstance({
      instanceId: "instance:native-routing:1",
      capabilityId: nativeDefinition.capabilityId,
    });
    const payoutInstance = makeFiatInstance({
      instanceId: "instance:psp-payouts:1",
      capabilityId: payoutDefinition.capabilityId,
    });
    const index = buildLabSearchIndex({
      definitions: [nativeDefinition, payoutDefinition],
      instances: [nativeInstance, payoutInstance],
      observations: [
        makeFiatObservation({ instanceId: nativeInstance.instanceId }),
        makeFiatObservation({ instanceId: payoutInstance.instanceId }),
      ],
    });
    const { executable } = selectExecutableBlocks(index, {
      domain: "payment-routing",
      currency: "EUR",
    });
    const fiatBlocks: readonly ExecutableBlock[] = [...executable];

    const buildingBlocks: readonly CandidateBuildingBlockRef[] = [
      ...fiatBlocks.map((block) => ({
        blockKind: "CONNECTOR_CAPABILITY" as const,
        blockId: block.definition.capabilityId,
        version: block.definition.capabilityVersion,
      })),
      {
        blockKind: "CERTIFIED_SMART_CONTRACT" as const,
        blockId: protocolCapabilityId(lane.protocolBinding.protocolKey, lane.protocolBinding.chainKey),
        version: "1.0.0",
      },
    ];
    const program: SimulationProgram = {
      programId: "route-compiler-journey.program",
      programVersion: "1.0.0",
      routePreference: [
        ...fiatBlocks.map(() => "rail-a"),
        lane.railId,
      ],
      useNetting: false,
      useNetworkCredit: false,
      delayToleranceSteps: 0,
      fraudScreening: true,
      privacyBounded: true,
      authorizationMode: "PROTOCOL_AUTHORIZED",
    };
    const organization = composeCandidateOrganization({
      candidateId: "route-compiler-journey-001",
      domainPackId: ROUTE_COMPILER_DOMAIN_PACK.packId,
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
      domainHardConstraints: [
        "LAB_SIMULATION_IS_NOT_PRODUCTION_SETTLEMENT",
        "ROUTE_COMPILER_JOURNEYS_ARE_LAB_COMPOSITIONS",
      ],
      buildingBlocks,
      evaluationSuiteRef: "lab.route-compiler-suite",
    });
    const labCandidate: LabCandidate = {
      candidateId: "route-compiler-journey-001",
      title: "compiled mixed fiat/onchain route journey",
      domainPackId: ROUTE_COMPILER_DOMAIN_PACK.packId,
      origin: "route-compiler",
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      program,
      buildingBlocks,
      organization,
      evidence: [],
      stage: "DRAFT",
    };
    expect(labCandidate.stage).toBe("DRAFT");

    // The fiat legs run through the Lab's own simulation.
    const fiatRun = runSimulation({
      scenario: fiatScenario(),
      world: fiatWorld(),
      program,
      seed: "route-compiler-journey-001:fiat-legs",
    });
    expect(fiatRun).toBeDefined();

    // The onchain lane runs through the REAL mixed-rail executor.
    const laneExecution = executeOnchainLane({
      lane,
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    expect(laneExecution.status).toBe("EXECUTED");
    if (laneExecution.status === "EXECUTED") {
      expect(laneExecution.outcome).toBe("CONFIRMED");
      expect(laneExecution.railOutcome.kind).toBe("RAIL_EFFECT_OBSERVED");
      expect(laneExecution.eventCandidate).toEqual({
        kind: "EVENT_CANDIDATE",
        event: "CONFIRM_SUCCEEDED",
      });
      // The observation is the kernel's own, mapped into canonical settlement.
      expect(laneExecution.railOperation.railId).toBe(lane.railId);
    }

    // The aggregate carries the structural non-production tier.
    expect(LAB_EXECUTION_TIER).toBe("LAB_SIMULATION_NON_PRODUCTION");
    const aggregate = {
      candidateId: labCandidate.candidateId,
      executionTier: LAB_EXECUTION_TIER,
      fiatRun,
      onchainExecutions: [laneExecution],
    };
    expect(isLabTieredValue(aggregate)).toBe(true);
  });

  it("fault-injected lane execution surfaces honest UNKNOWN in the Lab composition", () => {
    const route1 = compileBase(route1Intent());
    const plan = route1.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const swap = plan.legs[0] as Extract<typeof plan.legs[number], { legKind: "ONCHAIN_DEX_SWAP" }>;
    const laneExecution = executeOnchainLane({
      lane: swap.lane,
      at: NOW,
      observedAtIso: NOW_ISO,
      fault: { kind: "OUTCOME_UNKNOWN", reason: "reorg ambiguity in the Lab simulation" },
    });
    expect(laneExecution.status).toBe("EXECUTED");
    if (laneExecution.status === "EXECUTED") {
      expect(laneExecution.outcome).toBe("OUTCOME_UNKNOWN");
      expect(laneExecution.railOutcome.kind).toBe("RAIL_EFFECT_UNKNOWN");
      expect(laneExecution.railOutcome).toMatchObject({
        requiresReconciliation: true,
      });
      expect(laneExecution.lifecycleStages).toContain("reconcile");
    }
  });
});
