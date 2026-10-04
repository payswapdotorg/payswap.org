/**
 * The mixed-rail Lab composition harness (Work Order P4-W3-001).
 *
 * TEST-LAYER BY LAW: the repository-wide INV-L01 discipline forbids any
 * other package's src/** from importing the Lab runtime (the simulator is
 * not callable from any production path; every existing Lab consumer —
 * certification, journeys, adversarial — drives it from tests). This
 * harness is that test-layer driver for mixed-rail organizations: it
 * composes candidate organizations through the Lab's own proposal-only
 * composer, compiles programs in the Lab's pure-data program vocabulary,
 * registers the mixed-rail search plug-in behind the Lab's replaceable
 * plug-in registry, and aggregates the Lab's UNCHANGED fiat simulation
 * with this package's kernel-grounded onchain execution walk into one
 * tier-branded mixed result.
 *
 * Nothing here re-implements a kernel surface: fiat legs run through the
 * Lab's own runSimulation (its laws apply unchanged); onchain legs run
 * through src/executeOnchainLane (the real engine-produced lane proof +
 * kernel-validated observations + canonical settlement mapping); the
 * aggregate carries the structural non-production tier from src/.
 */

import { ValidationError } from "@payswap/protocol";
import type { VersionedRef, AgentBody, AgentPrincipalRef } from "@payswap/agents";
import type { ExecutionMode } from "@payswap/connectors";
import { onchainRailId, protocolCapabilityId } from "@payswap/onchain-domain";
import {
  canonicalize,
  composeCandidateOrganization,
  fnv1a64,
  runSimulation,
  SIMULATION_NAMESPACE,
} from "@payswap/lab";
import type {
  CandidateBuildingBlockRef,
  DomainPack,
  ExecutableBlock,
  LabCandidate,
  LabSearchInput,
  LabSearchPlugin,
  SearchedCandidate,
  SimulationMetrics,
  SimulationProgram,
  SimulationScenarioPlan,
  SimulationRunResult,
  SimulatedWorld,
} from "@payswap/lab";
import {
  LAB_EXECUTION_TIER,
  buildOnchainLaneEvidence,
  executeOnchainLane,
  isLabTieredValue,
} from "../src/index.js";
import type {
  LabExecutionTierBrand,
  OnchainLaneEvidenceRecord,
  OnchainLaneExecution,
  OnchainLaneFault,
  OnchainLaneProof,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Composition classes (structural, derived — never declared)
// ---------------------------------------------------------------------------

export const MIXED_RAIL_COMPOSITION_CLASSES = [
  "FIAT_ONLY",
  "ONCHAIN_ONLY",
  "MIXED",
] as const;
export type MixedRailCompositionClass = (typeof MIXED_RAIL_COMPOSITION_CLASSES)[number];

/**
 * The first hard constraint of EVERY mixed-rail candidate organization:
 * Lab simulation is never production financial execution (the Lab-side
 * restatement of the src tier law, carried into the organization draft's
 * safety policy where every evaluator reads it).
 */
export const MIXED_RAIL_NON_PRODUCTION_CONSTRAINT =
  "LAB_SIMULATION_IS_NOT_PRODUCTION_SETTLEMENT" as const;

/** One lane of a mixed-rail composition, grounded on either side. */
export type MixedRailLaneBinding =
  | {
      readonly laneKind: "FIAT";
      /** The Lab's executable block (instance + current observation, INV-C05). */
      readonly block: ExecutableBlock;
      /** The Lab-only simulated rail binding convention. */
      readonly simulatedRailId: string;
    }
  | {
      readonly laneKind: "ONCHAIN";
      /** The kernel-proved onchain lane (engine-selected, gate-ALLOWed). */
      readonly lane: OnchainLaneProof;
    };

/** Structural classification: the lane mix IS the composition class. */
export function classifyMixedRailComposition(
  lanes: readonly MixedRailLaneBinding[],
): MixedRailCompositionClass {
  if (lanes.length === 0) {
    throw new ValidationError(
      "classifyMixedRailComposition: an empty lane set has no composition class (fail closed — never guessed)",
    );
  }
  const hasFiat = lanes.some((lane) => lane.laneKind === "FIAT");
  const hasOnchain = lanes.some((lane) => lane.laneKind === "ONCHAIN");
  if (hasFiat && hasOnchain) {
    return "MIXED";
  }
  return hasOnchain ? "ONCHAIN_ONLY" : "FIAT_ONLY";
}

// ---------------------------------------------------------------------------
// The mixed-rail candidate organization
// ---------------------------------------------------------------------------

export class MixedRailCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MixedRailCompositionError";
  }
}

export interface MixedRailCandidate {
  readonly candidateId: string;
  readonly title: string;
  readonly domainPackId: string;
  readonly origin: string;
  readonly executionMode: ExecutionMode;
  readonly compositionClass: MixedRailCompositionClass;
  readonly lanes: readonly MixedRailLaneBinding[];
  /** Pure-data program (route preference = fiat rails then onchain rails). */
  readonly program: SimulationProgram;
  readonly buildingBlocks: readonly CandidateBuildingBlockRef[];
  /**
   * The Lab-native candidate (organization DRAFT composed through the
   * Lab's own proposal-only composer: no budgets, no delegation edges —
   * INV-G03: a Lab composition is a proposal, never a grant).
   */
  readonly labCandidate: LabCandidate;
}

export interface BuildMixedRailCandidateInput {
  readonly candidateId: string;
  readonly title: string;
  readonly domainPackId: string;
  readonly origin?: string;
  readonly executionMode: ExecutionMode;
  readonly fiatBlocks: readonly ExecutableBlock[];
  readonly onchainLanes: readonly OnchainLaneProof[];
  readonly body: VersionedRef<AgentBody>;
  readonly principal: AgentPrincipalRef;
  readonly domainHardConstraints?: readonly string[];
  readonly evaluationSuiteRef?: string;
}

/**
 * Composes a candidate organization for one of the three composition
 * classes (derived structurally from the lane mix, never declared): the
 * organization DRAFT is composed by the Lab's own composer with the
 * non-production constraint as the FIRST domain hard constraint, and the
 * building blocks reference the deterministic capability ids of both
 * sides (fiat connector capabilities + onchain protocol capabilities).
 */
export function buildMixedRailCandidate(
  input: BuildMixedRailCandidateInput,
): MixedRailCandidate {
  if (input.candidateId.length === 0) {
    throw new MixedRailCompositionError("candidateId must not be empty");
  }

  const lanes: MixedRailLaneBinding[] = [];
  for (const block of input.fiatBlocks) {
    const railId = block.instance.configuration["simulatedRailId"];
    if (typeof railId !== "string") {
      throw new MixedRailCompositionError(
        `fiat block '${block.definition.capabilityId}' has no simulatedRailId configuration — a fiat lane must bind to a Lab-simulated rail (the Lab-only convention)`,
      );
    }
    lanes.push({ laneKind: "FIAT", block, simulatedRailId: railId });
  }
  for (const lane of input.onchainLanes) {
    lanes.push({ laneKind: "ONCHAIN", lane });
  }
  if (lanes.length === 0) {
    throw new MixedRailCompositionError(
      "a mixed-rail candidate needs at least one lane (fiat or onchain) — an empty composition is never fabricated",
    );
  }
  const compositionClass = classifyMixedRailComposition(lanes);

  const buildingBlocks = Object.freeze(
    lanes.map((lane) => {
      if (lane.laneKind === "FIAT") {
        return {
          blockKind: "CONNECTOR_CAPABILITY" as const,
          blockId: lane.block.definition.capabilityId,
          version: lane.block.definition.capabilityVersion,
        };
      }
      return {
        blockKind: "CERTIFIED_SMART_CONTRACT" as const,
        blockId: protocolCapabilityId(
          lane.lane.protocolBinding.protocolKey,
          lane.lane.protocolBinding.chainKey,
        ),
        version: "1.0.0",
      };
    }),
  );

  const routePreference = Object.freeze(
    lanes.map((lane) =>
      lane.laneKind === "FIAT" ? lane.simulatedRailId : lane.lane.railId,
    ),
  );
  const program: SimulationProgram = {
    programId: `${input.candidateId}.program`,
    programVersion: "1.0.0",
    routePreference,
    useNetting: false,
    useNetworkCredit: false,
    delayToleranceSteps: 0,
    fraudScreening: true,
    privacyBounded: true,
    authorizationMode: "PROTOCOL_AUTHORIZED",
  };

  const organization = composeCandidateOrganization({
    candidateId: input.candidateId,
    domainPackId: input.domainPackId,
    body: input.body,
    principal: input.principal,
    domainHardConstraints: [
      MIXED_RAIL_NON_PRODUCTION_CONSTRAINT,
      ...(input.domainHardConstraints ?? []),
    ],
    buildingBlocks,
    evaluationSuiteRef: input.evaluationSuiteRef ?? "lab.mixed-rail-suite",
  });

  const labCandidate: LabCandidate = {
    candidateId: input.candidateId,
    title: input.title,
    domainPackId: input.domainPackId,
    origin: input.origin ?? "mixed-rail",
    executionMode: input.executionMode,
    program,
    buildingBlocks,
    organization,
    evidence: [],
    stage: "DRAFT",
  };

  return Object.freeze({
    candidateId: input.candidateId,
    title: input.title,
    domainPackId: input.domainPackId,
    origin: input.origin ?? "mixed-rail",
    executionMode: input.executionMode,
    compositionClass,
    lanes: Object.freeze(lanes),
    program,
    buildingBlocks,
    labCandidate,
  });
}

// ---------------------------------------------------------------------------
// The mixed-rail domain pack (the Lab's Domain Pack declaration dimensions)
// ---------------------------------------------------------------------------

export const MIXED_RAIL_DOMAIN_PACK: DomainPack = {
  packId: "lab.domain-pack.mixed-rail",
  version: "1.0.0",
  domain: "mixed-rail-execution",
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
    "onchainConfirmed",
    "onchainFailed",
    "onchainUnknown",
    "onchainBroadcastNotFinal",
    "onchainStaleGroundings",
  ],
  actionSpace: [
    {
      dimensionId: "route-preference",
      description: "ordered preference over fiat simulated rails and onchain lane rails",
      domain: ["rail-a", "rail-b", "onchain.ethereum:mainnet"],
    },
    {
      dimensionId: "netting",
      description: "co-directional batching within the delay window",
      domain: ["enabled", "disabled"],
    },
    {
      dimensionId: "adversarial-screening",
      description: "fraud/collusion/malicious/gaming screening",
      domain: ["enabled", "disabled"],
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
  ],
  evaluationSuite: {
    suiteId: "lab.mixed-rail-suite",
    version: "1.0.0",
  },
  provenanceRequirements: [
    {
      requirementId: "onchain-lane-observation-law",
      description:
        "every onchain lane carries quote freshness, canonical asset-observation freshness and kernel evidence refs (the onchain-domain observation law)",
      acceptedEvidenceKinds: ["ATTESTATION", "TEST_RUN"],
    },
    {
      requirementId: "simulation-seed-provenance",
      description: "every mixed simulation result records its seed and program version",
      acceptedEvidenceKinds: ["TEST_RUN", "REPLAY"],
    },
    {
      requirementId: "non-production-tier-provenance",
      description:
        "every mixed result carries the structural non-production execution tier and is rejected by settlement gates",
      acceptedEvidenceKinds: ["TEST_RUN"],
    },
  ],
};

// ---------------------------------------------------------------------------
// The mixed-rail search plug-in (behind the Lab's replaceable registry)
// ---------------------------------------------------------------------------

/**
 * Creates the mixed-rail search plug-in bound to proved onchain lanes: it
 * emits fiat-only, onchain-only, mixed and incumbent candidates grounded
 * ONLY in executable blocks (INV-C05) and proved lanes. The incumbent
 * candidate is the provider-native baseline on EITHER side (fiat
 * native-optimization block or venue-native benchmark lane — INV-C08:
 * incumbents compete, composition is never structurally preferred).
 */
export function createMixedRailSearchPlugin(
  onchainLanes: readonly OnchainLaneProof[],
): LabSearchPlugin {
  return {
    pluginId: "mixed-rail",
    description:
      "mixed-rail search: fiat-only/onchain-only/mixed composed programs over executable fiat blocks and kernel-proved onchain lanes, plus the provider-native incumbent",
    search(input: LabSearchInput): readonly SearchedCandidate[] {
      const fiatBound = input.executableBlocks.filter((block) => {
        const railId = block.instance.configuration["simulatedRailId"];
        return (
          typeof railId === "string" &&
          input.world.rails.some((rail) => rail.railId === railId)
        );
      });
      const onchainBound = onchainLanes;
      if (fiatBound.length === 0 && onchainBound.length === 0) {
        return [];
      }

      const baseProgram = {
        programVersion: "1.0.0",
        useNetting: false,
        useNetworkCredit: false,
        delayToleranceSteps: 0,
        fraudScreening: true,
        privacyBounded: true,
        authorizationMode: "PROTOCOL_AUTHORIZED",
      } as const;

      const candidates: SearchedCandidate[] = [];

      // The incumbent provider-native candidate (INV-C08): one lane, the
      // provider's own optimization, PASS_THROUGH_NATIVE.
      const incumbentFiat = fiatBound.find((block) => block.isIncumbentBaseline);
      const incumbentOnchain = onchainBound.find((lane) => lane.isVenueNativeBaseline);
      const incumbent =
        incumbentFiat !== undefined
          ? {
              railId: String(incumbentFiat.instance.configuration["simulatedRailId"]),
              instanceId: incumbentFiat.instance.instanceId,
            }
          : incumbentOnchain !== undefined
            ? { railId: incumbentOnchain.railId, instanceId: incumbentOnchain.instance.instanceId }
            : undefined;
      if (incumbent !== undefined) {
        candidates.push({
          candidateId: "search.mixed-rail:incumbent-native",
          origin: "mixed-rail",
          executionMode: "PASS_THROUGH_NATIVE",
          program: {
            ...baseProgram,
            programId: "search.mixed-rail.incumbent-native",
            routePreference: [incumbent.railId],
          },
          instanceRefs: [incumbent.instanceId],
          isIncumbentBaseline: true,
        });
      }

      if (onchainBound.length > 0) {
        candidates.push({
          candidateId: "search.mixed-rail:onchain-only",
          origin: "mixed-rail",
          executionMode: "COMPOSED_PAYSWAP",
          program: {
            ...baseProgram,
            programId: "search.mixed-rail.onchain-only",
            routePreference: onchainBound.map((lane) => lane.railId),
          },
          instanceRefs: onchainBound.map((lane) => lane.instance.instanceId),
          isIncumbentBaseline: false,
        });
      }

      if (fiatBound.length > 0) {
        candidates.push({
          candidateId: "search.mixed-rail:fiat-only",
          origin: "mixed-rail",
          executionMode: "COMPOSED_PAYSWAP",
          program: {
            ...baseProgram,
            programId: "search.mixed-rail.fiat-only",
            routePreference: fiatBound.map((block) =>
              String(block.instance.configuration["simulatedRailId"]),
            ),
          },
          instanceRefs: fiatBound.map((block) => block.instance.instanceId),
          isIncumbentBaseline: false,
        });
      }

      if (fiatBound.length > 0 && onchainBound.length > 0) {
        candidates.push({
          candidateId: "search.mixed-rail:mixed",
          origin: "mixed-rail",
          executionMode: "OPTIMIZED_MULTI_PROVIDER",
          program: {
            programId: "search.mixed-rail.mixed",
            programVersion: "1.0.0",
            routePreference: [
              ...fiatBound.map((block) =>
                String(block.instance.configuration["simulatedRailId"]),
              ),
              ...onchainBound.map((lane) => lane.railId),
            ],
            useNetting: true,
            useNetworkCredit: true,
            delayToleranceSteps: 2,
            fraudScreening: true,
            privacyBounded: true,
            authorizationMode: "PROTOCOL_AUTHORIZED",
          },
          instanceRefs: [
            ...fiatBound.map((block) => block.instance.instanceId),
            ...onchainBound.map((lane) => lane.instance.instanceId),
          ],
          isIncumbentBaseline: false,
        });
      }

      return Object.freeze(candidates);
    },
  };
}

// ---------------------------------------------------------------------------
// The mixed simulation aggregate (tier-branded, never production)
// ---------------------------------------------------------------------------

/** Exact joint metrics: the fiat metrics VERBATIM + onchain counters. */
export interface MixedRailMetrics {
  readonly compositionClass: MixedRailCompositionClass;
  /** The fiat run's metrics, verbatim (the fiat lanes' laws apply unchanged). */
  readonly fiat: SimulationMetrics;
  readonly onchainLanes: number;
  readonly onchainConfirmed: number;
  readonly onchainFailed: number;
  /** Honest terminal UNKNOWN (never coerced). */
  readonly onchainUnknown: number;
  /** BROADCAST: submitted, not final (never counted confirmed or failed). */
  readonly onchainBroadcastNotFinal: number;
  readonly onchainStaleGroundings: number;
  readonly incumbentFiatLanes: number;
  readonly venueNativeBaselineLanes: number;
}

/** One provenance record per lane (the exact-evidence law). */
export interface MixedRailProvenanceRecord {
  readonly laneId: string;
  readonly laneKind: "FIAT" | "ONCHAIN";
  readonly capabilityId: string;
  readonly instanceId: string;
  readonly providerName: string;
  readonly railId: string;
  readonly incumbentBaseline: boolean;
  /** Onchain lanes: the venue (through which venue/lane). */
  readonly venueId?: string;
  /** Onchain lanes: quote freshness (the quote observation law). */
  readonly quoteFreshness?: { readonly asOfMs: number; readonly maxAgeMs: number };
  /** Onchain lanes: asset-observation freshness (the observation law). */
  readonly assetObservationFreshness?: { readonly asOf: string; readonly maxAgeSeconds: number };
  /** Fiat lanes: the current CapabilityObservation version. */
  readonly fiatObservationVersion?: number;
  /** The outcome (kernel vocabulary for onchain lanes, when executed). */
  readonly outcome?: string;
  readonly evidenceRefs: readonly string[];
}

export interface MixedRailProvenanceChain {
  readonly candidateId: string;
  readonly compositionClass: MixedRailCompositionClass;
  readonly lanes: readonly MixedRailProvenanceRecord[];
  readonly digest: string;
}

export interface MixedRailSimulationResult extends LabExecutionTierBrand {
  /** The Lab simulation namespace (the Lab's own brand vocabulary). */
  readonly namespace: typeof SIMULATION_NAMESPACE;
  readonly __payswapSimulationNamespace: typeof SIMULATION_NAMESPACE;
  readonly executionTier: typeof LAB_EXECUTION_TIER;
  readonly environmentClass: "SIMULATION";
  readonly candidateId: string;
  readonly compositionClass: MixedRailCompositionClass;
  readonly seed: string;
  readonly at: number;
  /** The UNCHANGED fiat simulation run (its laws apply verbatim). */
  readonly fiatRun: SimulationRunResult;
  readonly onchainExecutions: readonly OnchainLaneExecution[];
  readonly metrics: MixedRailMetrics;
  readonly provenance: MixedRailProvenanceChain;
  readonly digest: string;
}

export interface SimulateMixedRailInput {
  readonly candidate: MixedRailCandidate;
  readonly world: SimulatedWorld;
  readonly scenario: SimulationScenarioPlan;
  readonly seed: string;
  readonly at: number;
  /** Caller-supplied deterministic observation timestamp (no ambient clock). */
  readonly observedAtIso: string;
  /** Faults keyed by lane id (deterministic injection). */
  readonly onchainFaults?: Readonly<Record<string, OnchainLaneFault>>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (Object.isFrozen(value)) {
      return value;
    }
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function toProvenanceRecord(
  lane: MixedRailLaneBinding,
  execution: OnchainLaneExecution | undefined,
): MixedRailProvenanceRecord {
  if (lane.laneKind === "FIAT") {
    return {
      laneId: `fiat-lane:${lane.block.definition.capabilityId}`,
      laneKind: "FIAT",
      capabilityId: lane.block.definition.capabilityId,
      instanceId: lane.block.instance.instanceId,
      providerName: lane.block.instance.providerName,
      railId: lane.simulatedRailId,
      incumbentBaseline: lane.block.isIncumbentBaseline,
      fiatObservationVersion: lane.block.observation.observationVersion,
      outcome: "FIAT_LEG_SIMULATED",
      evidenceRefs: [
        `fiat-obs:${lane.block.instance.instanceId}:${lane.block.observation.observationVersion}`,
      ],
    };
  }
  const onchainRecord: OnchainLaneEvidenceRecord = buildOnchainLaneEvidence(
    lane.lane,
    execution,
  );
  return {
    laneId: onchainRecord.laneId,
    laneKind: "ONCHAIN",
    capabilityId: onchainRecord.protocolCapabilityId,
    instanceId: onchainRecord.instanceId,
    providerName: onchainRecord.providerName,
    railId: onchainRecord.railId,
    incumbentBaseline: onchainRecord.incumbentBaseline,
    venueId: onchainRecord.venueId,
    quoteFreshness: onchainRecord.quoteFreshness,
    assetObservationFreshness: onchainRecord.assetObservationFreshness,
    ...(onchainRecord.outcome !== undefined ? { outcome: onchainRecord.outcome } : {}),
    evidenceRefs: onchainRecord.evidenceRefs,
  };
}

/**
 * Runs one deterministic mixed-rail simulation: the fiat legs through the
 * Lab's own (unchanged) simulator, the onchain legs through the
 * kernel-grounded execution walk with optional fault injection. The
 * aggregate carries the structural non-production tier and a
 * provenance chain over every lane.
 */
export function simulateMixedRail(
  input: SimulateMixedRailInput,
): MixedRailSimulationResult {
  const { candidate } = input;

  // Fiat legs: the Lab's own simulator, laws unchanged. Route preferences
  // referencing onchain rails are simply not rails of this world and are
  // skipped by the simulator's own routing loop (verified by tests).
  const fiatRun = runSimulation({
    scenario: input.scenario,
    world: input.world,
    program: candidate.program,
    seed: `${input.seed}:fiat-legs`,
  });

  // Onchain legs: the kernel-grounded walk, fault-injected per lane.
  const onchainExecutions: OnchainLaneExecution[] = [];
  for (const lane of candidate.lanes) {
    if (lane.laneKind !== "ONCHAIN") {
      continue;
    }
    const fault = input.onchainFaults?.[lane.lane.laneId];
    onchainExecutions.push(
      executeOnchainLane({
        lane: lane.lane,
        at: input.at,
        observedAtIso: input.observedAtIso,
        ...(fault !== undefined ? { fault } : {}),
      }),
    );
  }

  const metrics: MixedRailMetrics = {
    compositionClass: candidate.compositionClass,
    fiat: fiatRun.metrics,
    onchainLanes: onchainExecutions.length,
    onchainConfirmed: onchainExecutions.filter(
      (execution) => execution.status === "EXECUTED" && execution.outcome === "CONFIRMED",
    ).length,
    onchainFailed: onchainExecutions.filter(
      (execution) => execution.status === "EXECUTED" && execution.outcome === "FAILED",
    ).length,
    onchainUnknown: onchainExecutions.filter(
      (execution) => execution.status === "EXECUTED" && execution.outcome === "OUTCOME_UNKNOWN",
    ).length,
    onchainBroadcastNotFinal: onchainExecutions.filter(
      (execution) => execution.status === "EXECUTED" && execution.outcome === "BROADCAST",
    ).length,
    onchainStaleGroundings: onchainExecutions.filter(
      (execution) => execution.status === "GROUNDING_STALE",
    ).length,
    incumbentFiatLanes: candidate.lanes.filter(
      (lane) => lane.laneKind === "FIAT" && lane.block.isIncumbentBaseline,
    ).length,
    venueNativeBaselineLanes: candidate.lanes.filter(
      (lane) => lane.laneKind === "ONCHAIN" && lane.lane.isVenueNativeBaseline,
    ).length,
  };

  const executionByLaneId = new Map<string, OnchainLaneExecution>(
    onchainExecutions.map((execution) => [execution.laneId, execution]),
  );
  const laneRecords = candidate.lanes.map((lane) => {
    if (lane.laneKind === "FIAT") {
      return toProvenanceRecord(lane, undefined);
    }
    return toProvenanceRecord(lane, executionByLaneId.get(lane.lane.laneId));
  });
  const provenance: MixedRailProvenanceChain = {
    candidateId: candidate.candidateId,
    compositionClass: candidate.compositionClass,
    lanes: Object.freeze(laneRecords),
    digest: fnv1a64(canonicalize(laneRecords)),
  };

  const digest = fnv1a64(
    canonicalize({
      candidateId: candidate.candidateId,
      compositionClass: candidate.compositionClass,
      seed: input.seed,
      at: input.at,
      fiatDigest: fiatRun.digest,
      onchainExecutions,
      metrics,
      provenanceDigest: provenance.digest,
    }),
  );

  return deepFreeze({
    namespace: SIMULATION_NAMESPACE,
    __payswapSimulationNamespace: SIMULATION_NAMESPACE,
    executionTier: LAB_EXECUTION_TIER,
    environmentClass: "SIMULATION",
    candidateId: candidate.candidateId,
    compositionClass: candidate.compositionClass,
    seed: input.seed,
    at: input.at,
    fiatRun,
    onchainExecutions: Object.freeze(onchainExecutions),
    metrics,
    provenance,
    digest,
  } as MixedRailSimulationResult);
}

/** Runtime guard: is this value a tier-branded mixed-rail simulation result? */
export function isMixedRailSimulationResult(
  value: unknown,
): value is MixedRailSimulationResult {
  return isLabTieredValue(value) && typeof (value as { digest?: unknown }).digest === "string";
}

/**
 * Fail-closed validation of a mixed-rail simulation result: the structural
 * tier, the Lab namespace, the composition class and the evidence chain
 * must all be present and well-formed. A tier-stripped or forged result
 * is rejected (never guessed).
 */
export function validateMixedRailSimulationResult(
  value: unknown,
): MixedRailSimulationResult {
  if (typeof value !== "object" || value === null) {
    throw new ValidationError(
      "mixed-rail simulation result validation failed: value is not an object",
    );
  }
  const candidate = value as Partial<MixedRailSimulationResult>;
  if (candidate.executionTier !== LAB_EXECUTION_TIER) {
    throw new ValidationError(
      `mixed-rail simulation result validation failed: the structural execution tier '${LAB_EXECUTION_TIER}' is missing — a tier-stripped Lab result is malformed and fails closed`,
    );
  }
  if (
    candidate.namespace !== SIMULATION_NAMESPACE ||
    candidate.__payswapSimulationNamespace !== SIMULATION_NAMESPACE
  ) {
    throw new ValidationError(
      "mixed-rail simulation result validation failed: the Lab simulation namespace brand is missing",
    );
  }
  if (candidate.environmentClass !== "SIMULATION") {
    throw new ValidationError(
      "mixed-rail simulation result validation failed: the environment class must be SIMULATION (never a production class)",
    );
  }
  if (candidate.compositionClass === undefined || typeof candidate.digest !== "string") {
    throw new ValidationError(
      "mixed-rail simulation result validation failed: composition class or digest missing",
    );
  }
  if (!MIXED_RAIL_COMPOSITION_CLASSES.includes(candidate.compositionClass)) {
    throw new ValidationError(
      `mixed-rail simulation result validation failed: unknown composition class '${String(candidate.compositionClass)}'`,
    );
  }
  if (candidate.fiatRun === undefined || candidate.metrics === undefined || candidate.provenance === undefined) {
    throw new ValidationError(
      "mixed-rail simulation result validation failed: fiat run, metrics or provenance chain missing",
    );
  }
  return value as MixedRailSimulationResult;
}
