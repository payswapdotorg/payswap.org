import { describe, expect, it } from "vitest";
import {
  EvidenceGraph,
  EvidenceMutationError,
  UnknownEvidenceNodeError,
} from "../src/evidence-graph.js";
import type { EvidenceNodeDraft } from "../src/evidence-graph.js";
import { effectiveEvidenceLevel, provenanceOverclaim } from "../src/proof-policies.js";
import { NOW } from "./fixtures.js";

const AUTH: EvidenceNodeDraft = {
  nodeId: "ev_auth",
  kind: "AUTHORIZATION",
  actionRef: "SI:NS-1:party_a>party_b:USD",
  claimedLevel: "P2",
  provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "test-psp" },
  payload: "approval-artifact:art-1",
  links: [],
  recordedAt: NOW,
};

const EXEC: EvidenceNodeDraft = {
  nodeId: "ev_exec",
  kind: "EXECUTION",
  actionRef: "att_1",
  claimedLevel: "P2",
  provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "test-psp" },
  payload: "provider-op:op-1",
  links: ["ev_auth"],
  recordedAt: NOW + 1n,
};

const OUTCOME: EvidenceNodeDraft = {
  nodeId: "ev_outcome",
  kind: "OUTCOME",
  actionRef: "att_1",
  claimedLevel: "P3",
  provenance: { source: "INDEPENDENT_OBSERVER", observerRef: "bank-statement:line-7" },
  payload: "destination-observation:credit-90000",
  links: ["ev_exec"],
  recordedAt: NOW + 2n,
};

function graphWithChain(): EvidenceGraph {
  const graph = new EvidenceGraph();
  graph.record(AUTH);
  graph.record(EXEC);
  graph.record(OUTCOME);
  return graph;
}

describe("Evidence graph (W1-004)", () => {
  it("INV-E01/E02: authorization and execution lineage are queryable per action", () => {
    const graph = graphWithChain();

    // The attempt's lineage: execution + outcome evidence (INV-E02).
    const attemptLineage = graph.lineageForAction("att_1");
    expect(attemptLineage.execution.map((node) => node.nodeId)).toEqual(["ev_exec"]);
    expect(attemptLineage.outcome.map((node) => node.nodeId)).toEqual(["ev_outcome"]);

    // The instruction's lineage: authorization evidence (INV-E01).
    const instructionLineage = graph.lineageForAction("SI:NS-1:party_a>party_b:USD");
    expect(instructionLineage.authorization.map((node) => node.nodeId)).toEqual(["ev_auth"]);

    // The full chain of the outcome node walks the lineage transitively.
    const chain = graph.chainOf("ev_outcome");
    expect(chain.map((node) => node.nodeId)).toEqual(["ev_outcome", "ev_exec", "ev_auth"]);

    // Unknown actions yield empty lineages — never a fabricated one.
    expect(graph.lineageForAction("att_missing").all).toEqual([]);
  });

  it("INV-E05: historical evidence is immutable — mutation is rejected", () => {
    const graph = graphWithChain();

    // Identical re-record is an idempotent replay.
    const replayed = graph.record(AUTH);
    expect(replayed.nodeId).toBe("ev_auth");
    expect(graph.allNodes().length).toBe(3);

    // ANY content difference under the same node id is a mutation — rejected.
    expect(() =>
      graph.record({ ...AUTH, payload: "approval-artifact:tampered" }),
    ).toThrow(EvidenceMutationError);
    expect(() =>
      graph.record({ ...AUTH, claimedLevel: "P5" }),
    ).toThrow(EvidenceMutationError);
    expect(() =>
      graph.record({ ...EXEC, links: ["ev_outcome"] }),
    ).toThrow(EvidenceMutationError);

    // The graph is unchanged after the rejected mutations.
    expect(graph.allNodes().length).toBe(3);
    expect(graph.node("ev_auth")?.claimedLevel).toBe("P2");

    // Recorded nodes are frozen — in-place mutation throws.
    const node = graph.node("ev_auth");
    if (node === undefined) throw new Error("fixture setup failed");
    expect(() => {
      (node as { nodeId: string }).nodeId = "ev_tampered";
    }).toThrow(TypeError);

    // Lineage must be recorded bottom-up: linking to an unknown parent fails.
    expect(() =>
      graph.record({
        ...OUTCOME,
        nodeId: "ev_orphan",
        links: ["ev_nonexistent"],
      }),
    ).toThrow(UnknownEvidenceNodeError);
  });

  it("INV-E04: UI/browser artifacts are never stronger than their authenticated provenance", () => {
    const screenshot: EvidenceNodeDraft = {
      nodeId: "ev_screenshot",
      kind: "EXECUTION",
      actionRef: "att_1",
      claimedLevel: "P5",
      provenance: { source: "UI_BROWSER_ARTIFACT", authenticated: false },
      payload: "screenshot:checkout-success.png",
      links: [],
      recordedAt: NOW,
    };
    const authenticatedReceipt: EvidenceNodeDraft = {
      ...screenshot,
      nodeId: "ev_receipt",
      provenance: { source: "UI_BROWSER_ARTIFACT", authenticated: true },
      payload: "browser-session-receipt:receipt-1",
    };
    const providerSigned: EvidenceNodeDraft = {
      ...screenshot,
      nodeId: "ev_provider",
      provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "test-psp" },
      payload: "provider-webhook:evt-1",
    };

    // A bare screenshot claiming P5 effectively proves only P0 (assertion).
    expect(effectiveEvidenceLevel(screenshot)).toBe("P0");
    expect(provenanceOverclaim(screenshot)).toBe(true);

    // An authenticated browser artifact is capped at P1 (artifact/receipt).
    expect(effectiveEvidenceLevel(authenticatedReceipt)).toBe("P1");
    expect(provenanceOverclaim(authenticatedReceipt)).toBe(true);

    // Authenticated provider provenance is believed at its claimed level.
    expect(effectiveEvidenceLevel(providerSigned)).toBe("P5");
    expect(provenanceOverclaim(providerSigned)).toBe(false);

    // The cap also holds through the recorded nodes.
    const graph = new EvidenceGraph();
    const recorded = graph.record(screenshot);
    expect(effectiveEvidenceLevel(recorded)).toBe("P0");
  });

  it("deterministic replay: canonical node rendering is byte-identical", () => {
    const first = new EvidenceGraph();
    const second = new EvidenceGraph();
    for (const graph of [first, second]) {
      graph.record(AUTH);
      graph.record(EXEC);
      graph.record(OUTCOME);
    }
    expect(first.canonicalNode("ev_outcome")).toBe(second.canonicalNode("ev_outcome"));
    expect(first.canonicalNode("ev_auth")).toBe(second.canonicalNode("ev_auth"));
    // The payload is stored only as its deterministic hash.
    expect(first.node("ev_auth")?.payloadHash).toBe(second.node("ev_auth")?.payloadHash);
    expect(first.node("ev_auth")?.payloadHash).toMatch(/^evh:/);
  });
});
