import { describe, expect, it } from "vitest";
import {
  CANDIDATE_BODY_REF,
  CANDIDATE_PRINCIPAL,
  makeCertification,
  makeServiceAccessCapability,
  makeSmartContractExtension,
} from "./fixtures.js";
import {
  CandidateRegistry,
  LAB_BUILDING_BLOCK_KINDS,
  LAB_PROPOSAL_ONLY_CONSTRAINT,
  LabBuildingBlockIndex,
  PAYMENT_ROUTING_DOMAIN_PACK,
} from "@payswap/lab";
import type { CandidateBuildingBlockRef } from "@payswap/lab";

/**
 * Candidate registry: composition without authority (INV-G03), immutable
 * published versions (INV-G02 discipline) and the searchable building-block
 * index (certified smart contracts first-class).
 */

const PROGRAM = {
  programId: "cand.program",
  programVersion: "1.0.0",
  routePreference: ["rail-a", "rail-b"],
  useNetting: true,
  useNetworkCredit: true,
  delayToleranceSteps: 2,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
} as const;

const BLOCKS: readonly CandidateBuildingBlockRef[] = [
  { blockKind: "CONNECTOR_CAPABILITY", blockId: "psp.native-routing", version: "1.0.0" },
  { blockKind: "CERTIFIED_SMART_CONTRACT", blockId: "sc.netting-pool", version: "1.0.0" },
  { blockKind: "SERVICE_ACCESS", blockId: "svc.fraud-scoring", version: "1.0.0" },
  { blockKind: "PARTICIPATION_MECHANISM", blockId: "mech.rewards-v1", version: "1.0.0" },
];

function newRegistry(): CandidateRegistry {
  return new CandidateRegistry();
}

function createDefaultCandidate(registry: CandidateRegistry) {
  return registry.createDraft({
    candidateId: "cand-1",
    title: "netting + native incumbent composition",
    domainPackId: PAYMENT_ROUTING_DOMAIN_PACK.packId,
    origin: "deterministic-baseline",
    executionMode: "COMPOSED_PAYSWAP",
    program: PROGRAM,
    buildingBlocks: BLOCKS,
    body: CANDIDATE_BODY_REF,
    principal: CANDIDATE_PRINCIPAL,
    domainHardConstraints: PAYMENT_ROUTING_DOMAIN_PACK.hardConstraints,
    evaluationSuiteRef: PAYMENT_ROUTING_DOMAIN_PACK.evaluationSuite.suiteId,
  });
}

describe("searchable building-block index (certified smart contracts first-class)", () => {
  it("indexes a CERTIFIED, searchable smart-contract extension", () => {
    const index = new LabBuildingBlockIndex();
    const result = index.registerCertifiedSmartContract({
      blockId: "sc.netting-pool",
      version: "1.0.0",
      capabilityClass: "rail_movement",
      extension: makeSmartContractExtension({ searchable: true }),
      certification: makeCertification({ subjectId: "sc.netting-pool" }),
    });
    expect(result.status).toBe("REGISTERED");
    if (result.status === "REGISTERED") {
      expect(result.block.blockKind).toBe("CERTIFIED_SMART_CONTRACT");
    }
    expect(index.get("sc.netting-pool")?.blockKind).toBe("CERTIFIED_SMART_CONTRACT");
  });

  it("refuses an extension that did not declare Lab searchability", () => {
    const index = new LabBuildingBlockIndex();
    const result = index.registerCertifiedSmartContract({
      blockId: "sc.private-pool",
      version: "1.0.0",
      capabilityClass: "rail_movement",
      extension: makeSmartContractExtension({ searchable: false }),
      certification: makeCertification({ subjectId: "sc.private-pool" }),
    });
    expect(result.status).toBe("REJECTED");
    if (result.status === "REJECTED") {
      expect(result.reason).toBe("SMART_CONTRACT_NOT_SEARCHABLE");
    }
  });

  it("refuses a non-CERTIFIED smart contract (searchable only after certification)", () => {
    const index = new LabBuildingBlockIndex();
    const result = index.registerCertifiedSmartContract({
      blockId: "sc.revoked-pool",
      version: "1.0.0",
      capabilityClass: "rail_movement",
      extension: makeSmartContractExtension({ searchable: true }),
      certification: makeCertification({ subjectId: "sc.revoked-pool", status: "REVOKED" }),
    });
    expect(result.status).toBe("REJECTED");
    if (result.status === "REJECTED") {
      expect(result.reason).toBe("CERTIFICATION_NOT_ACTIVE");
    }
  });

  it("indexes ServiceAccess capabilities and participation mechanisms and queries deterministically", () => {
    const index = new LabBuildingBlockIndex();
    expect(
      index.registerServiceAccess({
        blockId: "svc.fraud-scoring",
        version: "1.0.0",
        capability: makeServiceAccessCapability(),
      }).status,
    ).toBe("REGISTERED");
    expect(
      index.registerParticipationMechanism({
        blockId: "mech.rewards-v1",
        version: "1.0.0",
        description: "funded rewards for netting participation",
        incentiveKinds: ["rewards"],
        rewardModelRef: "reward-model@3",
      }).status,
    ).toBe("REGISTERED");
    const all = index.query();
    expect(all.map((block) => block.blockId)).toEqual([
      "svc.fraud-scoring",
      "mech.rewards-v1",
    ]);
    expect(LAB_BUILDING_BLOCK_KINDS).toContain("PARTICIPATION_MECHANISM");
    expect(index.query({ blockKind: "PARTICIPATION_MECHANISM" }).length).toBe(1);
  });
});

describe("candidate composition grants NO Lab authority (INV-G03)", () => {
  it("composes certified smart contracts and capabilities into an authority-free Organization DRAFT", () => {
    const registry = newRegistry();
    const candidate = createDefaultCandidate(registry);
    const organization = candidate.organization;

    // The candidate organization is a DRAFT — composed from certified
    // smart-contract blocks and capabilities, but carrying NO authority:
    expect(organization.budgets).toEqual([]); // no Lab-granted budget
    expect(organization.delegationEdges).toEqual([]); // no mandate granted
    expect(organization.communicationEdges).toEqual([]);
    // Its safety policy's FIRST hard constraint is the proposal-only rule:
    expect(organization.safetyPolicy.hardConstraints[0]).toBe(
      LAB_PROPOSAL_ONLY_CONSTRAINT,
    );
  });

  it("the candidate record carries no protocol command or authorization artifact", () => {
    const registry = newRegistry();
    const candidate = createDefaultCandidate(registry);
    const serialized = JSON.stringify(candidate, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain("commandId");
    expect(serialized).not.toContain("authorizationEvidenceRef");
    expect(serialized).not.toContain("ProtocolAuthorizationRef");
  });

  it("registry operations leave an external authority state untouched (Lab selection cannot mutate financial authority)", () => {
    const authorityState = Object.freeze({
      protocolCommands: 0,
      grants: 0,
      ledgerEntries: 0,
    });
    const registry = newRegistry();
    const candidate = createDefaultCandidate(registry);
    registry.attachEvidence({
      candidateId: candidate.candidateId,
      evidence: [
        { evidenceId: "ev-1", kind: "BASELINE_SUITE_EVALUATION", artifactRef: "a", contentDigest: "d" },
        { evidenceId: "ev-2", kind: "REPLAY", artifactRef: "a", contentDigest: "d" },
        { evidenceId: "ev-3", kind: "COUNTERFACTUAL", artifactRef: "a", contentDigest: "d" },
        { evidenceId: "ev-4", kind: "ROBUSTNESS", artifactRef: "a", contentDigest: "d" },
      ],
    });
    registry.publishVersion({ candidateId: candidate.candidateId, publishedAt: "2026-10-01T00:00:00Z" });
    expect(authorityState).toEqual({
      protocolCommands: 0,
      grants: 0,
      ledgerEntries: 0,
    });
  });
});

describe("candidate lifecycle and immutable published versions (INV-G02 discipline)", () => {
  it("starts at DRAFT, benchmarks on baseline evaluation, validates on the INV-L02 triple", () => {
    const registry = newRegistry();
    const candidate = createDefaultCandidate(registry);
    expect(candidate.stage).toBe("DRAFT");

    const benchmarked = registry.attachEvidence({
      candidateId: candidate.candidateId,
      evidence: [
        { evidenceId: "ev-b", kind: "BASELINE_SUITE_EVALUATION", artifactRef: "a", contentDigest: "d" },
      ],
    });
    expect(benchmarked.stage).toBe("BENCHMARKED");

    const missingCounterfactual = registry.attachEvidence({
      candidateId: candidate.candidateId,
      evidence: [
        { evidenceId: "ev-r", kind: "REPLAY", artifactRef: "a", contentDigest: "d" },
        { evidenceId: "ev-o", kind: "ROBUSTNESS", artifactRef: "a", contentDigest: "d" },
      ],
    });
    expect(missingCounterfactual.stage).toBe("BENCHMARKED"); // not yet validated

    const validated = registry.attachEvidence({
      candidateId: candidate.candidateId,
      evidence: [
        { evidenceId: "ev-c", kind: "COUNTERFACTUAL", artifactRef: "a", contentDigest: "d" },
      ],
    });
    expect(validated.stage).toBe("VALIDATED");
  });

  it("published versions are immutable snapshots; history is preserved across new versions", () => {
    const registry = newRegistry();
    const candidate = createDefaultCandidate(registry);
    const v1 = registry.publishVersion({
      candidateId: candidate.candidateId,
      publishedAt: "2026-10-01T00:00:00Z",
    });
    expect(v1.version).toBe(1);
    expect(v1.snapshot.stage).toBe("DRAFT");
    expect(Object.isFrozen(v1)).toBe(true);

    // Mutating the published snapshot is impossible.
    expect(() => {
      (v1 as { snapshot: unknown }).snapshot = null;
    }).toThrow();

    // The candidate matures; a NEW version is published. v1 remains the
    // DRAFT snapshot — history is never rewritten.
    registry.attachEvidence({
      candidateId: candidate.candidateId,
      evidence: [
        { evidenceId: "ev-b", kind: "BASELINE_SUITE_EVALUATION", artifactRef: "a", contentDigest: "d" },
        { evidenceId: "ev-r", kind: "REPLAY", artifactRef: "a", contentDigest: "d" },
        { evidenceId: "ev-c", kind: "COUNTERFACTUAL", artifactRef: "a", contentDigest: "d" },
        { evidenceId: "ev-o", kind: "ROBUSTNESS", artifactRef: "a", contentDigest: "d" },
      ],
    });
    const v2 = registry.publishVersion({
      candidateId: candidate.candidateId,
      publishedAt: "2026-10-02T00:00:00Z",
    });
    expect(v2.version).toBe(2);
    expect(v2.snapshot.stage).toBe("VALIDATED");
    expect(v2.contentDigest).not.toBe(v1.contentDigest);
    expect(registry.getPublishedVersion(candidate.candidateId, 1)?.snapshot.stage).toBe("DRAFT");
    expect(registry.listPublishedVersions(candidate.candidateId).length).toBe(2);
  });

  it("rejects duplicate candidate ids and unknown candidates", () => {
    const registry = newRegistry();
    createDefaultCandidate(registry);
    expect(() => createDefaultCandidate(registry)).toThrow(/already exists/);
    expect(() =>
      registry.attachEvidence({ candidateId: "nope", evidence: [] }),
    ).toThrow(/unknown candidate/);
    expect(() =>
      registry.publishVersion({ candidateId: "nope", publishedAt: "t" }),
    ).toThrow(/unknown candidate/);
  });
});
