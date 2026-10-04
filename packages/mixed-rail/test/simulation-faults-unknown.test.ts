import { describe, expect, it } from "vitest";
import {
  canonicalize,
  fnv1a64,
  runCounterfactual,
  recordProductionFacts,
  runReplay,
  runSimulation,
} from "@payswap/lab";
import {
  CANDIDATE_BODY_REF,
  CANDIDATE_PRINCIPAL,
  fiatExecutableBlocks,
  fiatScenario,
  fiatWorld,
  provedSimLane,
  NOW,
  NOW_ISO,
} from "./fixtures.js";
import {
  buildMixedRailCandidate,
  simulateMixedRail,
  validateMixedRailSimulationResult,
  isMixedRailSimulationResult,
  MIXED_RAIL_DOMAIN_PACK,
} from "./mixed-rail-lab-harness.js";
import { executeOnchainLane } from "../src/index.js";

/**
 * P4-W3-001 requirements 4 (replay/fault tests cover chain/protocol
 * failures and UNKNOWN) and 5 (exact evidence recorded), plus the
 * fiat-laws-unchanged guarantee for mixed routes.
 */
describe("P4-W3-001 mixed simulation: the three classes run deterministically", () => {
  function mixedCandidateInput() {
    return {
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    } as const;
  }

  it("a MIXED simulation keeps the fiat laws UNCHANGED (fiat legs equal a direct Lab run)", () => {
    const candidate = buildMixedRailCandidate({
      ...mixedCandidateInput(),
      candidateId: "mixed-rail:sim:mixed-1",
      title: "mixed sim",
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [provedSimLane()],
    });
    const result = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-mixed-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    expect(result.compositionClass).toBe("MIXED");

    // The fiat run is bit-identical to running the Lab's own simulator
    // directly with the same scenario/world/program/seed — the mixed
    // aggregate does not alter fiat semantics in any way.
    const direct = runSimulation({
      scenario: fiatScenario(),
      world: fiatWorld(),
      program: candidate.program,
      seed: "seed-mixed-1:fiat-legs",
    });
    expect(result.fiatRun).toEqual(direct);

    // The onchain leg executed CONFIRMED with a finality CANDIDATE only.
    expect(result.onchainExecutions.length).toBe(1);
    const execution = result.onchainExecutions[0]!;
    expect(execution.status).toBe("EXECUTED");
    if (execution.status !== "EXECUTED") {
      return;
    }
    expect(execution.outcome).toBe("CONFIRMED");
    expect(execution.observation.finalityCandidate?.candidateOnly).toBe(true);
    expect(execution.observation.finalityCandidate?.requiresProtocolFinality).toBe(true);
    expect(result.metrics.onchainConfirmed).toBe(1);
    expect(result.metrics.fiat.totalDemands).toBe(2);
  });

  it("determinism: the same inputs produce byte-identical digests (replay equality)", () => {
    const candidate = buildMixedRailCandidate({
      ...mixedCandidateInput(),
      candidateId: "mixed-rail:sim:det-1",
      title: "determinism",
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [provedSimLane()],
    });
    const input = {
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-det-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    } as const;
    const first = simulateMixedRail(input);
    const second = simulateMixedRail(input);
    expect(second.digest).toBe(first.digest);
    expect(second).toEqual(first);
  });

  it("ONCHAIN_ONLY and FIAT_ONLY classes simulate through the same aggregate", () => {
    const onchainOnly = simulateMixedRail({
      candidate: buildMixedRailCandidate({
        ...mixedCandidateInput(),
        candidateId: "mixed-rail:sim:onchain-1",
        title: "onchain sim",
        executionMode: "COMPOSED_PAYSWAP",
        fiatBlocks: [],
        onchainLanes: [provedSimLane()],
      }),
      world: fiatWorld(),
      scenario: { scenarioId: "mixed-rail:empty", demands: [], incidents: [] },
      seed: "seed-onchain-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    expect(onchainOnly.compositionClass).toBe("ONCHAIN_ONLY");
    expect(onchainOnly.metrics.onchainLanes).toBe(1);

    const fiatOnly = simulateMixedRail({
      candidate: buildMixedRailCandidate({
        ...mixedCandidateInput(),
        candidateId: "mixed-rail:sim:fiat-1",
        title: "fiat sim",
        executionMode: "PASS_THROUGH_NATIVE",
        fiatBlocks: fiatExecutableBlocks(),
        onchainLanes: [],
      }),
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-fiat-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    expect(fiatOnly.compositionClass).toBe("FIAT_ONLY");
    expect(fiatOnly.onchainExecutions).toEqual([]);
    expect(fiatOnly.metrics.onchainLanes).toBe(0);
    expect(fiatOnly.metrics.fiat.settled + fiatOnly.metrics.fiat.failedNoViableRoute).toBe(2);
  });
});

describe("P4-W3-001 fault injection: chain/protocol failures, unfinalized observations, UNKNOWN", () => {
  it("a PROTOCOL_FAILURE maps to the canonical FAILED rail outcome and event candidate", () => {
    const lane = provedSimLane();
    const execution = executeOnchainLane({
      lane,
      at: NOW,
      observedAtIso: NOW_ISO,
      fault: {
        kind: "PROTOCOL_FAILURE",
        failureClass: "REVERTED",
        description: "simulated revert: the swap router rejected the calldata",
        retryGuidance: "SAFE_TO_RETRY",
      },
    });
    expect(execution.status).toBe("EXECUTED");
    if (execution.status !== "EXECUTED") {
      return;
    }
    expect(execution.outcome).toBe("FAILED");
    expect(execution.observation.failure?.failureClass).toBe("REVERTED");
    expect(execution.observation.failure?.retryGuidance).toBe("SAFE_TO_RETRY");
    // Canonical kernel mapping, verbatim.
    expect(execution.railOutcome.kind).toBe("RAIL_EFFECT_FAILED");
    expect(execution.eventCandidate).toEqual({
      kind: "EVENT_CANDIDATE",
      event: "CONFIRM_FAILED",
    });
    // A failure is NOT terminal-UNKNOWN: retry guidance is carried.
    expect(execution.lifecycleStages).not.toContain("reconcile");
  });

  it("an UNFINALIZED_BROADCAST stays submitted-not-final (never confirmed, never failed)", () => {
    const lane = provedSimLane();
    const execution = executeOnchainLane({
      lane,
      at: NOW,
      observedAtIso: NOW_ISO,
      fault: { kind: "UNFINALIZED_BROADCAST" },
    });
    expect(execution.status).toBe("EXECUTED");
    if (execution.status !== "EXECUTED") {
      return;
    }
    expect(execution.outcome).toBe("BROADCAST");
    // The kernel observation law: BROADCAST carries NO finality candidate.
    expect(execution.observation.finalityCandidate).toBeUndefined();
    expect(execution.observation.failure).toBeUndefined();
    expect(execution.observation.unknownReason).toBeUndefined();
    expect(execution.railOutcome.kind).toBe("RAIL_EFFECT_PENDING");
    if (execution.railOutcome.kind !== "RAIL_EFFECT_PENDING") {
      return;
    }
    expect(execution.railOutcome.submittedNotFinal).toBe(true);
    expect(execution.eventCandidate).toEqual({
      kind: "NO_EVENT",
      reason: "SUBMITTED_NOT_FINAL",
    });
  });

  it("an OUTCOME_UNKNOWN fault is an HONEST TERMINAL STATE (never coerced, never retried blindly)", () => {
    const lane = provedSimLane();
    const execution = executeOnchainLane({
      lane,
      at: NOW,
      observedAtIso: NOW_ISO,
      fault: {
        kind: "OUTCOME_UNKNOWN",
        reason:
          "broadcast-then-reorg: the simulated receipt vanished after a prior CONFIRMED observation",
      },
    });
    expect(execution.status).toBe("EXECUTED");
    if (execution.status !== "EXECUTED") {
      return;
    }
    expect(execution.outcome).toBe("OUTCOME_UNKNOWN");
    expect(execution.observation.unknownReason).toMatch(/reorg/);
    // The kernel law: UNKNOWN carries NO failure descriptor (INV-X01) and
    // NO finality candidate.
    expect(execution.observation.failure).toBeUndefined();
    expect(execution.observation.finalityCandidate).toBeUndefined();
    expect(execution.railOutcome.kind).toBe("RAIL_EFFECT_UNKNOWN");
    if (execution.railOutcome.kind !== "RAIL_EFFECT_UNKNOWN") {
      return;
    }
    expect(execution.railOutcome.requiresReconciliation).toBe(true);
    expect(execution.eventCandidate).toEqual({
      kind: "EVENT_CANDIDATE",
      event: "OUTCOME_UNKNOWN",
    });
    // The walk records the reconcile lifecycle stage (never authorize/broadcast).
    expect(execution.lifecycleStages).toContain("reconcile");
    expect(execution.lifecycleStages).not.toContain("authorize");
    expect(execution.lifecycleStages).not.toContain("broadcast");
  });

  it("a stale lane grounding at execution time is GROUNDING_STALE (not executed, not failed)", () => {
    const lane = provedSimLane();
    const execution = executeOnchainLane({
      lane,
      at: NOW + 120_000, // observation maxAge is 60s
      observedAtIso: NOW_ISO,
    });
    expect(execution.status).toBe("GROUNDING_STALE");
    if (execution.status !== "GROUNDING_STALE") {
      return;
    }
    expect(execution.reason).toMatch(/re-observed, never executed on stale state/);
    expect(execution.lifecycleStages).toEqual(["observe"]);
  });

  it("faults flow through the mixed aggregate: metrics count each honest state exactly once", () => {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:faults-1",
      title: "faults",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [provedSimLane()],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    const laneId = candidate.lanes.find((lane) => lane.laneKind === "ONCHAIN")!
      .lane.laneId;

    const unknown = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-faults-unknown",
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFaults: {
        [laneId]: {
          kind: "OUTCOME_UNKNOWN",
          reason: "simulated external ambiguity: the receipt status is neither success nor revert",
        },
      },
    });
    expect(unknown.metrics.onchainUnknown).toBe(1);
    expect(unknown.metrics.onchainConfirmed).toBe(0);
    expect(unknown.metrics.onchainFailed).toBe(0);
    expect(unknown.metrics.onchainBroadcastNotFinal).toBe(0);
    // The fiat legs still settled under the unchanged fiat simulator.
    expect(unknown.metrics.fiat.settled).toBeGreaterThan(0);

    const failed = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-faults-failed",
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFaults: {
        [laneId]: {
          kind: "PROTOCOL_FAILURE",
          failureClass: "PROVIDER_DEFINED",
          description: "simulated provider error",
          retryGuidance: "NOT_RETRYABLE",
        },
      },
    });
    expect(failed.metrics.onchainFailed).toBe(1);
    expect(failed.metrics.onchainUnknown).toBe(0);

    const unfinalized = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-faults-unfinalized",
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFaults: { [laneId]: { kind: "UNFINALIZED_BROADCAST" } },
    });
    expect(unfinalized.metrics.onchainBroadcastNotFinal).toBe(1);
    expect(unfinalized.metrics.onchainConfirmed).toBe(0);
    expect(unfinalized.metrics.onchainFailed).toBe(0);

    // Stale grounding at execution time.
    const stale = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-faults-stale",
      at: NOW + 120_000,
      observedAtIso: NOW_ISO,
    });
    expect(stale.metrics.onchainStaleGroundings).toBe(1);
    expect(stale.metrics.onchainConfirmed).toBe(0);
  });
});

describe("P4-W3-001 exact evidence recorded (provenance chains, observation law)", () => {
  it("every mixed result carries per-lane provenance: capabilities, freshness, venue/lane", () => {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:evidence-1",
      title: "evidence",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [provedSimLane()],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    const result = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-evidence-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    });

    expect(result.provenance.lanes.length).toBe(3);
    const onchainRecord = result.provenance.lanes.find(
      (record) => record.laneKind === "ONCHAIN",
    );
    expect(onchainRecord).toBeDefined();
    if (onchainRecord === undefined) {
      return;
    }
    // WHICH capability: the deterministic protocol capability id.
    expect(onchainRecord.capabilityId).toBe("protocol.ethereum:mainnet:lab-sim-dex");
    // WHICH observations at WHAT freshness: quote law + asset observation law.
    expect(onchainRecord.quoteFreshness?.maxAgeMs).toBeGreaterThan(0);
    expect(onchainRecord.assetObservationFreshness?.maxAgeSeconds).toBeGreaterThan(0);
    // THROUGH which venue/lane.
    expect(onchainRecord.venueId).toBe("lab-sim-dex");
    expect(onchainRecord.railId).toBe("onchain.ethereum:mainnet");
    // The exact kernel outcome, recorded verbatim.
    expect(onchainRecord.outcome).toBe("CONFIRMED");
    // Kernel evidence refs are folded in.
    expect(onchainRecord.evidenceRefs.length).toBeGreaterThan(3);

    // Fiat records carry the current observation version (INV-C05 grounding).
    const fiatRecords = result.provenance.lanes.filter(
      (record) => record.laneKind === "FIAT",
    );
    expect(fiatRecords.length).toBe(2);
    for (const record of fiatRecords) {
      expect(record.fiatObservationVersion).toBe(1);
      expect(record.instanceId).toMatch(/^instance:/);
    }

    // The provenance chain digest is deterministic and tamper-evident.
    const sameAgain = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-evidence-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    expect(sameAgain.provenance.digest).toBe(result.provenance.digest);
  });

  it("a mutated provenance record is detectable (digest mismatch)", () => {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:tamper-1",
      title: "tamper",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [provedSimLane()],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    const result = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-tamper-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    const honest = result.provenance.lanes;
    const tampered = honest.map((record) =>
      record.laneKind === "ONCHAIN"
        ? { ...record, outcome: "SETTLED" }
        : record,
    );
    expect(fnv1a64(canonicalize(tampered))).not.toBe(result.provenance.digest);
    expect(fnv1a64(canonicalize(honest))).toBe(result.provenance.digest);
  });

  it("the result validates fail-closed (tier + namespace + composition class + evidence)", () => {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:validate-1",
      title: "validate",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [provedSimLane()],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    const result = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-validate-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    expect(() => validateMixedRailSimulationResult(result)).not.toThrow();
    expect(isMixedRailSimulationResult(result)).toBe(true);

    // A tier-stripped forgery fails closed.
    const { executionTier: _stripped, ...forged } = result;
    expect(() => validateMixedRailSimulationResult(forged)).toThrow();
    // A namespace-stripped forgery fails closed.
    const { namespace: _ns, ...forgedNamespace } = result;
    expect(() => validateMixedRailSimulationResult(forgedNamespace)).toThrow();
    // A non-object fails closed.
    expect(() => validateMixedRailSimulationResult(null)).toThrow();
  });
});

describe("P4-W3-001 replay and counterfactual (the Lab's own recorded-facts machinery)", () => {
  it("recorded fiat facts replay under the mixed candidate's fiat program (deterministic)", () => {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:replay-1",
      title: "replay",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [provedSimLane()],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    const facts = recordProductionFacts({
      factsId: "facts:mixed-rail:1",
      rails: fiatWorld().rails,
      pools: fiatWorld().pools,
      stepLatencyMs: fiatWorld().stepLatencyMs,
      demands: [
        {
          demandId: "d-1",
          amountMinor: 100_000n,
          currency: "EUR",
          direction: "OUTBOUND",
          deadlineMs: 5_000,
          observedAtMs: 0,
        },
      ],
      incidents: [],
    });
    const replay = runReplay({
      facts,
      program: candidate.program,
      seed: "seed-replay-1",
      stepMs: 1000,
    });
    expect(replay.run.scenarioId).toBe("replay:facts:mixed-rail:1");
    expect(replay.factsDigest.length).toBeGreaterThan(0);

    const counterfactual = runCounterfactual({
      facts,
      baseProgram: candidate.program,
      variantProgram: {
        ...candidate.program,
        programId: "mixed-rail:replay-1.variant",
        useNetting: true,
        delayToleranceSteps: 2,
      },
      seed: "seed-replay-1",
      stepMs: 1000,
    });
    expect(counterfactual.base.factsDigest).toBe(counterfactual.variant.factsDigest);
    expect(counterfactual.digest.length).toBeGreaterThan(0);
  });
});

