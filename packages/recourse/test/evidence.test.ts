import { describe, expect, it } from "vitest";
import { createIdFactory } from "@payswap/protocol";
import { DeterministicClock } from "@payswap/protocol";
import { EvidenceMutationError } from "@payswap/settlement";
import {
  UnknownDisputeEvidenceError,
  disputeEvidenceLineage,
  evidenceMeetsThreshold,
  maxEffectiveEvidenceLevel,
  recordDisputeEvidence,
  resolveEvidenceRefs,
} from "../src/evidence.js";
import { NOW, TRANSACTION_REF, buildScenario } from "./fixtures.js";

describe("Dispute/recourse evidence (W1-006)", () => {
  it("records dispute evidence into the settlement evidence graph with deterministic ids", () => {
    const scenario = buildScenario();
    const disputeId = "dsp_test_1";
    const node = recordDisputeEvidence(
      scenario.evidence,
      {
        actionRef: disputeId,
        kind: "PROOF",
        claimedLevel: "P3",
        provenance: { source: "INDEPENDENT_OBSERVER", observerRef: "inspector:report-1" },
        payload: "dispute-proof:goods-not-delivered",
        // Linked to the ORIGINAL transaction's evidence — full lineage.
        links: [...scenario.originalEvidenceRefs],
        recordedAt: NOW,
      },
      { ids: scenario.ledger.ids },
    );
    expect(node.nodeId.startsWith("rev")).toBe(true);
    expect(node.actionRef).toBe(disputeId);
    expect(node.links).toEqual([...scenario.originalEvidenceRefs]);
    expect(scenario.evidence.node(node.nodeId)).toBe(node);
  });

  it("exposes the full dispute lineage (INV-E01/E02: queryable at any time)", () => {
    const scenario = buildScenario();
    const disputeId = "dsp_test_2";
    const node = recordDisputeEvidence(
      scenario.evidence,
      {
        actionRef: disputeId,
        kind: "PROOF",
        claimedLevel: "P3",
        provenance: { source: "INDEPENDENT_OBSERVER", observerRef: "inspector:report-2" },
        payload: "dispute-proof:lineage",
        links: ["ev_tx_outcome"],
        recordedAt: NOW,
      },
      { ids: scenario.ledger.ids },
    );

    const lineage = disputeEvidenceLineage(scenario.evidence, disputeId);
    expect(lineage.actionRef).toBe(disputeId);
    expect(lineage.proof.map((n) => n.nodeId)).toEqual([node.nodeId]);

    // The chain walks back through the original transaction's evidence:
    // dispute PROOF → original OUTCOME → original EXECUTION → original
    // AUTHORIZATION (authorization + execution + outcome lineage, INV-E01/E02).
    const chain = scenario.evidence.chainOf(node.nodeId);
    expect(chain.map((n) => n.nodeId)).toEqual([
      node.nodeId,
      "ev_tx_outcome",
      "ev_tx_exec",
      "ev_tx_auth",
    ]);
  });

  it("historical evidence is immutable (INV-E05: mutation rejected, replay idempotent)", () => {
    const scenario = buildScenario();
    const node = recordDisputeEvidence(
      scenario.evidence,
      {
        actionRef: "dsp_test_3",
        kind: "RECEIPT",
        claimedLevel: "P1",
        provenance: { source: "OPERATOR", operatorRef: "operator:helpdesk-1" },
        payload: "dispute-receipt:case-opened",
        links: [],
        recordedAt: NOW,
      },
      { ids: scenario.ledger.ids },
    );

    // Identical re-record through the settlement graph: idempotent replay.
    const replay = scenario.evidence.record({
      nodeId: node.nodeId,
      kind: "RECEIPT",
      actionRef: "dsp_test_3",
      claimedLevel: "P1",
      provenance: { source: "OPERATOR", operatorRef: "operator:helpdesk-1" },
      payload: "dispute-receipt:case-opened",
      links: [],
      recordedAt: NOW,
    });
    expect(replay).toBe(node);

    // ANY content difference is rejected — historical evidence is immutable.
    expect(() =>
      scenario.evidence.record({
        nodeId: node.nodeId,
        kind: "RECEIPT",
        actionRef: "dsp_test_3",
        claimedLevel: "P1",
        provenance: { source: "OPERATOR", operatorRef: "operator:helpdesk-1" },
        payload: "dispute-receipt:TAMPERED",
        links: [],
        recordedAt: NOW,
      }),
    ).toThrowError(EvidenceMutationError);
  });

  it("resolves evidence refs fail-closed against the graph", () => {
    const scenario = buildScenario();
    const nodes = resolveEvidenceRefs(scenario.evidence, scenario.originalEvidenceRefs);
    expect(nodes.map((n) => n.nodeId)).toEqual([...scenario.originalEvidenceRefs]);
    expect(() => resolveEvidenceRefs(scenario.evidence, ["ev_never_recorded"])).toThrowError(
      UnknownDisputeEvidenceError,
    );
  });

  it("INV-E04 caps: a UI/browser artifact never proves more than its provenance", () => {
    const clock = new DeterministicClock(NOW);
    const ids = createIdFactory(clock);
    const scenario = buildScenario();
    const screenshot = recordDisputeEvidence(
      scenario.evidence,
      {
        actionRef: "dsp_test_4",
        kind: "OUTCOME",
        claimedLevel: "P4",
        provenance: { source: "UI_BROWSER_ARTIFACT", authenticated: false },
        payload: "screenshot:claims-p4",
        links: [],
        recordedAt: NOW,
      },
      { ids },
    );
    const authenticatedArtifact = recordDisputeEvidence(
      scenario.evidence,
      {
        actionRef: "dsp_test_4",
        kind: "OUTCOME",
        claimedLevel: "P4",
        provenance: { source: "UI_BROWSER_ARTIFACT", authenticated: true },
        payload: "artifact:claims-p4-authenticated",
        links: [],
        recordedAt: NOW,
      },
      { ids },
    );
    const providerProof = recordDisputeEvidence(
      scenario.evidence,
      {
        actionRef: "dsp_test_4",
        kind: "PROOF",
        claimedLevel: "P2",
        provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "test-psp" },
        payload: "provider-proof:p2",
        links: [],
        recordedAt: NOW,
      },
      { ids },
    );

    expect(maxEffectiveEvidenceLevel([screenshot])).toBe("P0");
    expect(maxEffectiveEvidenceLevel([authenticatedArtifact])).toBe("P1");
    expect(maxEffectiveEvidenceLevel([providerProof])).toBe("P2");
    expect(maxEffectiveEvidenceLevel([screenshot, providerProof])).toBe("P2");
    expect(maxEffectiveEvidenceLevel([])).toBeUndefined();

    expect(evidenceMeetsThreshold([screenshot], "P2").met).toBe(false);
    expect(evidenceMeetsThreshold([providerProof], "P2").met).toBe(true);
    expect(evidenceMeetsThreshold([], "P0").met).toBe(false);
    const verdict = evidenceMeetsThreshold([screenshot, providerProof], "P2");
    expect(verdict.met).toBe(true);
    expect(verdict.achieved).toBe("P2");
  });

  it("rejects malformed evidence drafts", () => {
    const scenario = buildScenario();
    const ids = scenario.ledger.ids;
    expect(() =>
      recordDisputeEvidence(
        scenario.evidence,
        {
          actionRef: "",
          kind: "PROOF",
          claimedLevel: "P1",
          provenance: { source: "PROTOCOL_LEDGER" },
          payload: "x",
          links: [],
          recordedAt: NOW,
        },
        { ids },
      ),
    ).toThrowError(/actionRef/);
    expect(() =>
      recordDisputeEvidence(
        scenario.evidence,
        {
          actionRef: "dsp_test_5",
          kind: "NOT_A_KIND" as never,
          claimedLevel: "P1",
          provenance: { source: "PROTOCOL_LEDGER" },
          payload: "x",
          links: [],
          recordedAt: NOW,
        },
        { ids },
      ),
    ).toThrowError(/declared evidence kind/);
    // Linking to an unknown parent is rejected by the settlement graph
    // (lineage must be recorded bottom-up).
    expect(() =>
      recordDisputeEvidence(
        scenario.evidence,
        {
          actionRef: "dsp_test_5",
          kind: "PROOF",
          claimedLevel: "P1",
          provenance: { source: "PROTOCOL_LEDGER" },
          payload: "x",
          links: ["ev_unknown_parent"],
          recordedAt: NOW,
        },
        { ids },
      ),
    ).toThrowError();
    // Deterministic ids: the same factory order produces distinct ids.
    const a = recordDisputeEvidence(
      scenario.evidence,
      {
        actionRef: TRANSACTION_REF,
        kind: "PROOF",
        claimedLevel: "P1",
        provenance: { source: "PROTOCOL_LEDGER" },
        payload: "a",
        links: [],
        recordedAt: NOW,
      },
      { ids },
    );
    const b = recordDisputeEvidence(
      scenario.evidence,
      {
        actionRef: TRANSACTION_REF,
        kind: "PROOF",
        claimedLevel: "P1",
        provenance: { source: "PROTOCOL_LEDGER" },
        payload: "b",
        links: [],
        recordedAt: NOW,
      },
      { ids },
    );
    expect(a.nodeId).not.toBe(b.nodeId);
  });
});
