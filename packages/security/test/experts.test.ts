import { describe, expect, it } from "vitest";
import type {
  EpochScopedAuthorization,
  ExpertResolution,
  ResolutionEvidenceArtifact,
} from "../src/index.js";
import {
  CapabilityCaseLedger,
  EXPERT_EVIDENCE_NAMESPACE,
  ExpertBridgeError,
  ExpertResolutionError,
  ExpertResolutionLedger,
  ExpertTaskBoard,
  matchExpert,
  matchExperts,
  resolutionToEvidenceArtifact,
} from "../src/index.js";
import type { Equal, Expect } from "./type-utils.js";

/**
 * INV-L04 — expert resolutions are versioned; historical versions remain
 * for learning. Expert output is EVIDENCE/learning, never hidden authority.
 */

const evidenceA = {
  evidenceId: "ev-forensics-1",
  artifactRef: "artifact:forensics-report",
  contentDigest: "fnv1a64:aaaaaaaaaaaaaaaa",
};

const seniorForensics = {
  expertId: "expert:fraud-senior",
  displayName: "Senior Fraud Forensics",
  qualifications: [
    {
      skillId: "fraud-forensics",
      level: "senior" as const,
      qualificationEvidence: evidenceA,
    },
  ],
  jurisdictions: ["DE", "FR"],
  active: true,
};

const juniorForensics = {
  expertId: "expert:fraud-junior",
  displayName: "Junior Fraud Analyst",
  qualifications: [
    {
      skillId: "fraud-forensics",
      level: "practitioner" as const,
      qualificationEvidence: evidenceA,
    },
  ],
  jurisdictions: ["DE"],
  active: true,
};

function escalatedCase() {
  const ledger = new CapabilityCaseLedger();
  const record = ledger.open({
    caseId: "case-arena-1",
    kind: "incident",
    title: "Coordinated abuse cluster",
    component: { kind: "agent_key", id: "sha256:agent-key-1" },
    signal: {
      signalKind: "coordinated_abuse",
      observedAt: 1_000,
      detail: "ring of 12 accounts",
      sourceRef: "runtime:fraud-detector",
    },
    evidence: [evidenceA],
    openedAt: 1_100,
  });
  ledger.escalate({ caseId: "case-arena-1", at: 1_200 });
  return record;
}

describe("qualification matching (deterministic, fail-closed)", () => {
  const requirements = [
    { skillId: "fraud-forensics", minLevel: "expert" as const, jurisdiction: "DE" },
  ];

  it("matches only experts meeting level AND jurisdiction", () => {
    const senior = matchExpert(seniorForensics, requirements);
    expect(senior.qualified).toBe(true);
    expect(senior.satisfied[0]?.viaLevel).toBe("senior");

    const junior = matchExpert(juniorForensics, requirements);
    expect(junior.qualified).toBe(false);
    expect(junior.unmet[0]?.reason).toBe("level_insufficient");
  });

  it("jurisdiction and inactivity are fail-closed", () => {
    const abroad = matchExpert(seniorForensics, [
      { skillId: "fraud-forensics", minLevel: "expert", jurisdiction: "US" },
    ]);
    expect(abroad.qualified).toBe(false);
    expect(abroad.unmet[0]?.reason).toBe("jurisdiction_not_served");

    const inactive = matchExpert({ ...seniorForensics, active: false }, requirements);
    expect(inactive.qualified).toBe(false);
    expect(inactive.unmet[0]?.reason).toBe("expert_inactive");

    const missing = matchExpert(
      { ...seniorForensics, qualifications: [] },
      requirements,
    );
    expect(missing.qualified).toBe(false);
    expect(missing.unmet[0]?.reason).toBe("skill_missing");
  });

  it("ranking is deterministic: qualified first, then satisfied count, then id", () => {
    const ranked = matchExperts(
      [juniorForensics, seniorForensics, { ...seniorForensics, expertId: "expert:aaa" }],
      requirements,
    );
    expect(ranked.map((match) => match.expertId)).toEqual([
      "expert:aaa",
      "expert:fraud-senior",
      "expert:fraud-junior",
    ]);
  });
});

describe("expert task dispatch (§18: CapabilityCase → requirements → match → task)", () => {
  it("dispatches to the first qualified expert deterministically", () => {
    const board = new ExpertTaskBoard();
    const task = board.dispatch({
      taskId: "task-1",
      case: escalatedCase(),
      requirements: [{ skillId: "fraud-forensics", minLevel: "expert", jurisdiction: "DE" }],
      experts: [juniorForensics, seniorForensics],
      at: 1_300,
    });
    expect(task.matchedExpertId).toBe("expert:fraud-senior");
    expect(task.caseId).toBe("case-arena-1");
    expect(task.status).toBe("dispatched");
  });

  it("refuses to dispatch when nobody is qualified (fail closed)", () => {
    const board = new ExpertTaskBoard();
    expect(() =>
      board.dispatch({
        taskId: "task-2",
        case: escalatedCase(),
        requirements: [{ skillId: "fraud-forensics", minLevel: "senior", jurisdiction: "US" }],
        experts: [seniorForensics, juniorForensics],
        at: 1_300,
      }),
    ).toThrow(ExpertBridgeError);
  });
});

describe("INV-L04: versioned expert resolutions with full history", () => {
  function task() {
    const board = new ExpertTaskBoard();
    return board.dispatch({
      taskId: "task-1",
      case: escalatedCase(),
      requirements: [{ skillId: "fraud-forensics", minLevel: "expert", jurisdiction: "DE" }],
      experts: [seniorForensics],
      at: 1_300,
    });
  }

  function ledgerWithFirstResolution(): ExpertResolutionLedger {
    const resolutions = new ExpertResolutionLedger();
    resolutions.recordResolution({
      task: task(),
      expertId: "expert:fraud-senior",
      findings: ["12 colluding accounts confirmed"],
      recommendation: "Freeze the ring; escalate to the network abuse policy",
      evidence: [evidenceA],
      resolvedAt: 1_500,
    });
    return resolutions;
  }

  it("records version 1 with content digest and provenance", () => {
    const resolutions = ledgerWithFirstResolution();
    const current = resolutions.currentForTask("task-1");
    expect(current?.version).toBe(1);
    expect(current?.contentDigest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(current?.supersededBy).toBeUndefined();
    expect(current?.expertId).toBe("expert:fraud-senior");
  });

  it("superseding appends version 2 and KEEPS version 1 for learning", () => {
    const resolutions = ledgerWithFirstResolution();
    const superseding = resolutions.recordSupersedingResolution({
      task: task(),
      expertId: "expert:fraud-senior",
      findings: ["Ring is 14 accounts, not 12; two dormant accounts found"],
      recommendation: "Freeze all 14; file rail-side reports",
      evidence: [
        evidenceA,
        { evidenceId: "ev-2", artifactRef: "artifact:dormant-analysis", contentDigest: "fnv1a64:bb" },
      ],
      resolvedAt: 1_700,
    });
    expect(superseding.version).toBe(2);

    const history = resolutions.versionHistoryForTask("task-1");
    expect(history.map((resolution) => resolution.version)).toEqual([1, 2]);
    // Version 1 REMAINS fully retrievable and is marked superseded.
    const historical = history[0]!;
    expect(historical.supersededBy).toBe(2);
    expect(historical.findings).toEqual(["12 colluding accounts confirmed"]);
    // Distinct digests: the versions are different content.
    expect(historical.contentDigest).not.toBe(superseding.contentDigest);
    // The current resolution has no superseded marker.
    expect(resolutions.currentForTask("task-1")?.version).toBe(2);
  });

  it("later better resolutions coexist with historical versions across many bumps", () => {
    const resolutions = ledgerWithFirstResolution();
    for (let version = 2; version <= 4; version += 1) {
      resolutions.recordSupersedingResolution({
        task: task(),
        expertId: "expert:fraud-senior",
        findings: [`revision ${version}`],
        recommendation: `recommendation ${version}`,
        evidence: [evidenceA],
        resolvedAt: 1_500 + version * 100,
      });
    }
    const history = resolutions.versionHistoryForTask("task-1");
    expect(history.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expect(history.map((r) => r.supersededBy)).toEqual([2, 3, 4, undefined]);
  });

  it("refuses resolutions from a non-dispatched expert and empty evidence", () => {
    const resolutions = new ExpertResolutionLedger();
    expect(() =>
      resolutions.recordResolution({
        task: task(),
        expertId: "expert:someone-else",
        findings: ["f"],
        recommendation: "r",
        evidence: [evidenceA],
        resolvedAt: 1,
      }),
    ).toThrow(/dispatched expert/);
    expect(() =>
      resolutions.recordResolution({
        task: task(),
        expertId: "expert:fraud-senior",
        findings: ["f"],
        recommendation: "r",
        evidence: [],
        resolvedAt: 1,
      }),
    ).toThrow(/at least one evidence ref/);
    expect(() =>
      resolutions.recordSupersedingResolution({
        task: task(),
        expertId: "expert:fraud-senior",
        findings: ["f"],
        recommendation: "r",
        evidence: [evidenceA],
        resolvedAt: 1,
      }),
    ).toThrow(ExpertResolutionError);
  });
});

describe("expert output is evidence, never hidden authority", () => {
  function resolved(): ExpertResolution {
    const board = new ExpertTaskBoard();
    const task = board.dispatch({
      taskId: "task-1",
      case: escalatedCase(),
      requirements: [{ skillId: "fraud-forensics", minLevel: "expert", jurisdiction: "DE" }],
      experts: [seniorForensics],
      at: 1_300,
    });
    const resolutions = new ExpertResolutionLedger();
    return resolutions.recordResolution({
      task,
      expertId: "expert:fraud-senior",
      findings: ["ring confirmed"],
      recommendation: "freeze ring",
      evidence: [evidenceA],
      resolvedAt: 1_500,
    });
  }

  it("the ONLY consumable form is a branded evidence artifact", () => {
    const artifact = resolutionToEvidenceArtifact(resolved());
    expect(artifact.namespace).toBe(EXPERT_EVIDENCE_NAMESPACE);
    expect(artifact.artifactId).toBe("expert-evidence:task-1:v1");
    expect(artifact.evidence).toEqual([evidenceA]);
    expect(Object.isFrozen(artifact)).toBe(true);
  });

  it("a resolution structurally cannot act as an authorization (type-level)", () => {
    // Compile-time guarantees enforced by tsc --noEmit (typecheck gate):
    // a resolution is not assignable to an epoch-scoped authorization and an
    // evidence artifact is not assignable to one either — nor the reverse.
    type ResolutionNotAuthorization = Expect<
      Equal<ExpertResolution extends EpochScopedAuthorization ? true : false, false>
    >;
    type ArtifactNotAuthorization = Expect<
      Equal<ResolutionEvidenceArtifact extends EpochScopedAuthorization ? true : false, false>
    >;
    type AuthorizationNotArtifact = Expect<
      Equal<EpochScopedAuthorization extends ResolutionEvidenceArtifact ? true : false, false>
    >;
    expect(true).toBe(true);
  });

  it("the resolution shape carries no authority vocabulary at runtime", () => {
    const resolution = resolved();
    const serialized = JSON.stringify(resolution);
    for (const forbidden of [
      "mandate",
      "grant",
      "approval",
      "signature",
      "authorize",
      "ledger",
      "permission",
      "credentials",
    ]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
    // The observable keys are findings/recommendation/evidence only (plus
    // identity, version, digests and timestamps).
    expect(Object.keys(resolution).sort()).toEqual([
      "caseId",
      "contentDigest",
      "evidence",
      "expertId",
      "findings",
      "recommendation",
      "resolutionId",
      "resolvedAt",
      "taskId",
      "version",
    ]);
  });
});
