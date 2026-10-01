import { describe, expect, it } from "vitest";
import {
  CapabilityCaseLedger,
  SECURITY_LEARNING_NAMESPACE,
  type EvidenceRef,
} from "../src/index.js";

/**
 * INV-S04 — incidents feed evidence and security learning. Every case
 * carries explicit evidence and appends immutable, content-addressed
 * learning records to the feed (the Arena/production-learning surface).
 */

const evidence: EvidenceRef = {
  evidenceId: "ev-signal-1",
  artifactRef: "artifact:telemetry-batch-42",
  contentDigest: "fnv1a64:0123456789abcdef",
};

function openCase(ledger: CapabilityCaseLedger, caseId = "case-001") {
  return ledger.open({
    caseId,
    kind: "incident",
    title: "Suspicious beneficiary change burst",
    component: { kind: "agent_key", id: "sha256:agent-key-1" },
    signal: {
      signalKind: "beneficiary_change",
      observedAt: 1_000,
      detail: "18 beneficiary changes in 60 seconds",
      sourceRef: "runtime:fraud-detector",
    },
    evidence: [evidence],
    matchedSignatureRefs: ["sig-behavior-7"],
    openedAt: 1_100,
  });
}

describe("capability case lifecycle", () => {
  it("opens a case with mandatory evidence and signal provenance", () => {
    const ledger = new CapabilityCaseLedger();
    const record = openCase(ledger);
    expect(record.status).toBe("open");
    expect(record.evidence).toEqual([evidence]);
    expect(record.signal.signalKind).toBe("beneficiary_change");
    expect(record.matchedSignatureRefs).toEqual(["sig-behavior-7"]);
    expect(ledger.casesForComponent({ kind: "agent_key", id: "sha256:agent-key-1" })).toHaveLength(1);
  });

  it("refuses cases without evidence (an incident with no evidence feeds nothing)", () => {
    const ledger = new CapabilityCaseLedger();
    expect(() =>
      ledger.open({
        caseId: "case-no-evidence",
        kind: "observation",
        title: "t",
        component: { kind: "extension", id: "ext:x" },
        signal: {
          signalKind: "graph_anomaly",
          observedAt: 1,
          detail: "d",
          sourceRef: "s",
        },
        evidence: [],
        openedAt: 1,
      }),
    ).toThrow(/at least one evidence ref/);
    expect(() =>
      ledger.open({
        caseId: "case-bad-signal",
        kind: "observation",
        title: "t",
        component: { kind: "extension", id: "ext:x" },
        signal: {
          signalKind: "weird" as never,
          observedAt: 1,
          detail: "d",
          sourceRef: "s",
        },
        evidence: [evidence],
        openedAt: 1,
      }),
    ).toThrow(/unknown signal kind/);
  });

  it("escalates and resolves with append-only events", () => {
    const ledger = new CapabilityCaseLedger();
    openCase(ledger);
    const escalated = ledger.escalate({ caseId: "case-001", at: 1_200 });
    expect(escalated.status).toBe("escalated");
    const withEvidence = ledger.attachEvidence({
      caseId: "case-001",
      evidence: [
        { evidenceId: "ev-2", artifactRef: "artifact:second", contentDigest: "fnv1a64:b" },
      ],
      at: 1_300,
    });
    expect(withEvidence.evidence).toHaveLength(2);
    const resolved = ledger.resolve({
      caseId: "case-001",
      at: 1_400,
      resolutionNote: "Coordinated abuse confirmed; agent key revoked",
    });
    expect(resolved.status).toBe("resolved");
    expect(ledger.history().map((event) => event.eventType)).toEqual([
      "opened",
      "escalated",
      "evidence_attached",
      "resolved",
    ]);
    expect(() => ledger.resolve({ caseId: "case-001", at: 1_500, resolutionNote: "again" })).toThrow(
      /already resolved/,
    );
    expect(() =>
      ledger.attachEvidence({ caseId: "case-001", evidence: [evidence], at: 1_500 }),
    ).toThrow(/resolved/);
  });
});

describe("INV-S04: the security learning feed", () => {
  it("every lifecycle event appends an immutable, content-addressed learning record", () => {
    const ledger = new CapabilityCaseLedger();
    openCase(ledger);
    ledger.escalate({ caseId: "case-001", at: 1_200 });
    ledger.resolve({
      caseId: "case-001",
      at: 1_400,
      resolutionNote: "Coordinated abuse confirmed; agent key revoked",
    });

    const feed = ledger.learningFeed();
    expect(feed).toHaveLength(3); // opened + escalated + resolved
    const statuses = feed.map((record) => record.caseStatus);
    expect(statuses).toEqual(["open", "escalated", "resolved"]);
    for (const record of feed) {
      expect(record.namespace).toBe(SECURITY_LEARNING_NAMESPACE);
      expect(record.caseId).toBe("case-001");
      expect(record.signalKind).toBe("beneficiary_change");
      expect(record.contentDigest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
      expect(record.learningId).toBe(`learning:case-001:${record.sequence}`);
    }
    // Learning records for the case are in emission order with sequence 1..3.
    expect(feed.map((record) => record.sequence)).toEqual([1, 2, 3]);
    // Each snapshot has a DISTINCT digest: the case state genuinely evolved.
    const digests = new Set(feed.map((record) => record.contentDigest));
    expect(digests.size).toBe(3);
  });

  it("resolving a case never removes its historical learning records", () => {
    const ledger = new CapabilityCaseLedger();
    openCase(ledger);
    const before = ledger.learningFeed().length;
    ledger.resolve({ caseId: "case-001", at: 1_400, resolutionNote: "done" });
    const after = ledger.learningFeed();
    expect(after.length).toBe(before + 1);
    // The FIRST record (open status) is still present and unchanged.
    expect(after[0]?.caseStatus).toBe("open");
    expect(ledger.learningRecordsFor("case-001")).toHaveLength(2);
  });

  it("learning records are frozen and case evidence is preserved in every snapshot", () => {
    const ledger = new CapabilityCaseLedger();
    const record = openCase(ledger);
    const learning = ledger.learningFeed()[0]!;
    expect(Object.isFrozen(learning)).toBe(true);
    expect(record.evidence[0]?.artifactRef).toBe("artifact:telemetry-batch-42");
    expect(learning.component).toEqual(record.component);
  });
});
