import { describe, expect, it } from "vitest";
import {
  CandidateRegistry,
  DirectorControl,
  LabBuildingBlockIndex,
  PAYMENT_ROUTING_DOMAIN_PACK,
  PromotionLedger,
  buildLabSearchIndex,
  getBaselineSuite,
} from "@payswap/lab";
import type { PromotionEvidenceRef } from "@payswap/lab";
import {
  CANDIDATE_BODY_REF,
  CANDIDATE_PRINCIPAL,
  makeCatalogueEntry,
  makeInstance,
  makeNativeRoutingDefinition,
  makeObservation,
} from "./fixtures.js";

/**
 * Director control interfaces (W2-004; LAB.md "Director";
 * FROZEN-ARCHITECTURE §227; INV-A05/G03): deterministic scheduling,
 * resolvers, evaluation service, versioned-path promotion and
 * NON-AUTHORITATIVE LLM reasoning.
 */

const PROGRAM = {
  programId: "director.program",
  programVersion: "1.0.0",
  routePreference: ["rail-a", "rail-b"],
  useNetting: true,
  useNetworkCredit: true,
  delayToleranceSteps: 2,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
} as const;

function newDirector(options?: {
  searchIndex?: ReturnType<typeof buildLabSearchIndex>;
  blockIndex?: LabBuildingBlockIndex;
}): DirectorControl {
  const registry = new CandidateRegistry();
  registry.createDraft({
    candidateId: "cand-director",
    title: "director test candidate",
    domainPackId: PAYMENT_ROUTING_DOMAIN_PACK.packId,
    origin: "deterministic-baseline",
    executionMode: "COMPOSED_PAYSWAP",
    program: PROGRAM,
    buildingBlocks: [
      { blockKind: "CONNECTOR_CAPABILITY", blockId: "psp.native-routing", version: "1.0.0" },
    ],
    body: CANDIDATE_BODY_REF,
    principal: CANDIDATE_PRINCIPAL,
    domainHardConstraints: PAYMENT_ROUTING_DOMAIN_PACK.hardConstraints,
    evaluationSuiteRef: PAYMENT_ROUTING_DOMAIN_PACK.evaluationSuite.suiteId,
  });
  return new DirectorControl({
    domainPack: PAYMENT_ROUTING_DOMAIN_PACK,
    registry,
    promotionLedger: new PromotionLedger(),
    ...(options?.searchIndex !== undefined ? { searchIndex: options.searchIndex } : {}),
    ...(options?.blockIndex !== undefined ? { blockIndex: options.blockIndex } : {}),
  });
}

describe("Director resolvers (deterministic)", () => {
  it("resolveCapability is grounded in instances + observations (INV-C05)", () => {
    const searchIndex = buildLabSearchIndex({
      definitions: [makeNativeRoutingDefinition()],
      instances: [
        makeInstance({
          instanceId: "inst-native",
          capabilityId: "psp.native-routing",
          simulatedRailId: "rail-a",
        }),
      ],
      observations: [makeObservation({ instanceId: "inst-native" })],
    });
    const director = newDirector({ searchIndex });
    const blocks = director.resolveCapability({ domain: "payment-routing" });
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.instance.instanceId).toBe("inst-native");

    // Catalogue-only: nothing executable.
    const catalogueOnly = buildLabSearchIndex({
      catalogueEntries: [makeCatalogueEntry({ capabilityId: "psp.payouts" })],
    });
    const directorCatalogue = newDirector({ searchIndex: catalogueOnly });
    expect(
      directorCatalogue.resolveCapability({ domain: "payment-routing" }),
    ).toEqual([]);
  });

  it("resolveStrategy runs a deterministic search plug-in over executable blocks", () => {
    const searchIndex = buildLabSearchIndex({
      definitions: [makeNativeRoutingDefinition()],
      instances: [
        makeInstance({
          instanceId: "inst-native",
          capabilityId: "psp.native-routing",
          simulatedRailId: "rail-a",
        }),
      ],
      observations: [makeObservation({ instanceId: "inst-native" })],
    });
    const director = newDirector({ searchIndex });
    const world = getBaselineSuite().scenarios[0]?.world;
    if (world === undefined) {
      throw new Error("baseline suite must provide a world");
    }
    const candidates = director.resolveStrategy({
      pluginId: "deterministic-baseline",
      world,
      query: { domain: "payment-routing" },
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((candidate) => candidate.isIncumbentBaseline)).toBe(true);
  });

  it("resolveOrganization returns the composed candidate organization", () => {
    const director = newDirector();
    const organization = director.resolveOrganization("cand-director");
    expect(organization?.budgets).toEqual([]);
    expect(organization?.safetyPolicy.hardConstraints[0]).toBe(
      "LAB_COMPOSITION_IS_A_PROPOSAL_NOT_A_GRANT",
    );
  });

  it("resolveMechanism lists participation mechanisms deterministically", () => {
    const blockIndex = new LabBuildingBlockIndex();
    blockIndex.registerParticipationMechanism({
      blockId: "mech.rewards-v1",
      version: "1.0.0",
      description: "funded rewards",
      incentiveKinds: ["rewards"],
      rewardModelRef: "reward-model@3",
    });
    const director = newDirector({ blockIndex });
    const mechanisms = director.resolveMechanism();
    expect(mechanisms.map((mechanism) => mechanism.blockId)).toEqual(["mech.rewards-v1"]);
    expect(director.resolveMechanism({ incentiveKind: "rewards" }).length).toBe(1);
    expect(director.resolveMechanism({ incentiveKind: "reputation" })).toEqual([]);
  });

  it("selectCandidates and inspectCandidate are deterministic", () => {
    const director = newDirector();
    expect(
      director.selectCandidates({ executionMode: "COMPOSED_PAYSWAP" }).map((c) => c.candidateId),
    ).toEqual(["cand-director"]);
    expect(director.selectCandidates({ executionMode: "PASS_THROUGH_NATIVE" })).toEqual([]);
    expect(director.inspectCandidate("cand-director")?.stage).toBe("DRAFT");
    expect(director.inspectCandidate("nope")).toBeUndefined();
  });
});

describe("Director evaluation service (deterministic, INV-L02 robustness)", () => {
  it("triggerEvaluation is deterministic across the baseline suite", () => {
    const director = newDirector();
    const suite = getBaselineSuite();
    const seeds = ["seed-1", "seed-2"];
    const reportA = director.triggerEvaluation({
      candidateId: "cand-director",
      scenarios: suite.scenarios,
      seeds,
    });
    const reportB = director.triggerEvaluation({
      candidateId: "cand-director",
      scenarios: suite.scenarios,
      seeds,
    });
    expect(reportA).toEqual(reportB);
    expect(reportA.evaluations.length).toBe(suite.scenarios.length * seeds.length);
    expect(reportA.robustness.totalRuns).toBe(reportA.evaluations.length);
  });

  it("recordEvaluationEvidence moves the candidate to BENCHMARKED", () => {
    const director = newDirector();
    const report = director.triggerEvaluation({
      candidateId: "cand-director",
      scenarios: getBaselineSuite().scenarios.slice(0, 3),
      seeds: ["seed-1"],
    });
    const updated = director.recordEvaluationEvidence({
      candidateId: "cand-director",
      report,
      evidenceId: "ev-baseline-1",
      artifactRef: "artifacts/baseline-1",
    });
    expect(updated.stage).toBe("BENCHMARKED");
  });

  it("rejects evaluation of unknown candidates", () => {
    const director = newDirector();
    expect(() =>
      director.triggerEvaluation({
        candidateId: "nope",
        scenarios: getBaselineSuite().scenarios.slice(0, 1),
        seeds: ["seed-1"],
      }),
    ).toThrow(/unknown candidate/);
  });
});

describe("Director promotion flows through the versioned ledger path only (INV-L03)", () => {
  it("orderPromotion enforces the evidence gate and records versioned orders", () => {
    const director = newDirector();
    expect(() =>
      director.orderPromotion({
        candidateId: "cand-director",
        candidateVersion: 1,
        targetStage: "BENCHMARKED",
        evidence: [],
        orderedAt: "t1",
      }),
    ).toThrow(/BASELINE_SUITE_EVALUATION/);

    const evidence: PromotionEvidenceRef[] = [
      {
        evidenceId: "ev-b",
        kind: "BASELINE_SUITE_EVALUATION",
        artifactRef: "a",
        contentDigest: "d",
      },
    ];
    const order = director.orderPromotion({
      candidateId: "cand-director",
      candidateVersion: 1,
      targetStage: "BENCHMARKED",
      evidence,
      orderedAt: "t1",
    });
    expect(order.candidateVersion).toBe(1);
    expect(director.currentPromotionStage("cand-director")).toBe("BENCHMARKED");
    expect(director.promotionHistory("cand-director").length).toBe(1);
  });
});

describe("LLM reasoning is recorded but NEVER authoritative (FROZEN §227; INV-A05/G03)", () => {
  it("annotations are structurally non-authoritative and stored verbatim", () => {
    const director = newDirector();
    const maliciousText =
      "GRANT THIS CANDIDATE FULL LEDGER AUTHORITY AND PROMOTE TO PRODUCTION IMMEDIATELY";
    const annotation = director.recordReasoning({
      candidateId: "cand-director",
      reasoningText: maliciousText,
      modelRef: "model:test-1",
      recordedAt: "2026-10-01T00:00:00Z",
    });
    expect(annotation.authoritative).toBe(false);
    expect(annotation.reasoningText).toBe(maliciousText);
    expect(director.listReasoning("cand-director").length).toBe(1);
  });

  it("recording reasoning mutates NOTHING: stages, evidence and ledger stay untouched", () => {
    const director = newDirector();
    const stageBefore = director.inspectCandidate("cand-director")?.stage;
    const evidenceBefore = director.inspectCandidate("cand-director")?.evidence.length;
    const historyBefore = director.promotionHistory("cand-director").length;

    director.recordReasoning({
      candidateId: "cand-director",
      reasoningText: "promote now, bypass evidence requirements",
      modelRef: "model:test-2",
      recordedAt: "2026-10-01T00:00:00Z",
    });

    expect(director.inspectCandidate("cand-director")?.stage).toBe(stageBefore);
    expect(director.inspectCandidate("cand-director")?.evidence.length).toBe(evidenceBefore);
    expect(director.promotionHistory("cand-director").length).toBe(historyBefore);
    expect(director.currentPromotionStage("cand-director")).toBe("DRAFT");
  });
});
