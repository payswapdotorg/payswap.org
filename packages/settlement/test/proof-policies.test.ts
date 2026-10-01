import { describe, expect, it } from "vitest";
import { GHS, USD, ValidationError, fromMinorUnits } from "@payswap/protocol";
import {
  PROOF_LEVELS,
  defineProofPolicy,
  maxProofLevel,
  minProofLevel,
  proofLevelRank,
  proofSatisfaction,
  refundDisputeSymmetricLevels,
  requiredProofLevel,
} from "../src/proof-policies.js";
import type { EvidenceNode } from "../src/evidence-graph.js";
import { NOW, makeProofPolicy } from "./fixtures.js";

function evidence(
  nodeId: string,
  claimedLevel: EvidenceNode["claimedLevel"],
  actionRef = "att_1",
): EvidenceNode {
  return {
    nodeId,
    kind: "OUTCOME",
    actionRef,
    claimedLevel,
    provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "test-psp" },
    payloadHash: `evh:${nodeId}`,
    links: [],
    recordedAt: NOW,
  };
}

describe("Proof policies (W1-004)", () => {
  it("exposes the frozen level vocabulary with deterministic ranks", () => {
    expect(PROOF_LEVELS).toEqual(["P0", "P1", "P2", "P3", "P4", "P5"]);
    expect(PROOF_LEVELS.map((level) => proofLevelRank(level))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxProofLevel("P2", "P4")).toBe("P4");
    expect(minProofLevel("P2", "P4")).toBe("P2");
  });

  it("INV-E03: the required level is policy/risk driven and composes by strongest requirement", () => {
    const policy = makeProofPolicy();

    // Ordinary amount → the baseline level.
    expect(
      requiredProofLevel(policy, {
        direction: "SETTLE",
        amount: fromMinorUnits(USD, 10_000n),
      }),
    ).toEqual({ required: "P1", considered: ["BASELINE:P1"] });

    // At/above the high-risk threshold → the high-risk level.
    const highRisk = requiredProofLevel(policy, {
      direction: "SETTLE",
      amount: fromMinorUnits(USD, 50_000n),
    });
    expect(highRisk.required).toBe("P3");
    expect(highRisk.considered).toContain("HIGH_RISK_AMOUNT:P3");

    // Rail minimums apply independently.
    expect(
      requiredProofLevel(policy, {
        direction: "SETTLE",
        amount: fromMinorUnits(USD, 10_000n),
        rail: "OFF_NETWORK_CHECK",
      }).required,
    ).toBe("P4");

    // Counterparty risk applies independently.
    expect(
      requiredProofLevel(policy, {
        direction: "SETTLE",
        amount: fromMinorUnits(USD, 10_000n),
        counterpartyRiskClass: "UNVERIFIED",
      }).required,
    ).toBe("P3");

    // Composition: high amount + high rail → strongest.
    expect(
      requiredProofLevel(policy, {
        direction: "SETTLE",
        amount: fromMinorUnits(USD, 90_000n),
        rail: "OFF_NETWORK_CHECK",
      }).required,
    ).toBe("P4");
  });

  it("refuses to price risk in a currency the policy does not cover (no silent FX)", () => {
    const policy = makeProofPolicy();
    expect(() =>
      requiredProofLevel(policy, {
        direction: "SETTLE",
        amount: fromMinorUnits(GHS, 90_000n),
      }),
    ).toThrow(ValidationError);
  });

  it("INV-E03: low-proof evidence cannot satisfy a high-risk requirement", () => {
    const policy = makeProofPolicy();
    const context = {
      direction: "SETTLE" as const,
      amount: fromMinorUnits(USD, 90_000n),
    };

    // Low proof (P1) against a P3 requirement: refused with the gap named.
    const low = proofSatisfaction(policy, context, [evidence("ev_low", "P1")]);
    expect(low.satisfied).toBe(false);
    expect(low.required).toBe("P3");
    expect(low.achieved).toBe("P1");
    expect(low.gaps).toContain("REQUIRED_P3_ACHIEVED_P1");

    // Sufficient proof (P3, independent destination observation): satisfied.
    const sufficient = proofSatisfaction(policy, context, [
      evidence("ev_low", "P1"),
      evidence("ev_destination", "P3"),
    ]);
    expect(sufficient.satisfied).toBe(true);
    expect(sufficient.achieved).toBe("P3");
    expect(sufficient.gaps).toEqual([]);

    // No evidence at all: refused with NO_EVIDENCE_PRESENTED.
    const empty = proofSatisfaction(policy, context, []);
    expect(empty.satisfied).toBe(false);
    expect(empty.achieved).toBe("P0");
    expect(empty.gaps).toContain("NO_EVIDENCE_PRESENTED");
  });

  it("INV-E04 flows into satisfaction: a P5-claiming screenshot proves only P0", () => {
    const policy = makeProofPolicy();
    const screenshot: EvidenceNode = {
      nodeId: "ev_screenshot",
      kind: "OUTCOME",
      actionRef: "att_1",
      claimedLevel: "P5",
      provenance: { source: "UI_BROWSER_ARTIFACT" as const, authenticated: false },
      payloadHash: "evh:screenshot",
      links: [],
      recordedAt: NOW,
    };
    const satisfaction = proofSatisfaction(
      policy,
      { direction: "SETTLE", amount: fromMinorUnits(USD, 10_000n) },
      [screenshot],
    );
    expect(satisfaction.achieved).toBe("P0");
    expect(satisfaction.satisfied).toBe(false);
  });

  it("refund/dispute symmetry: identical proof burden for identical amount and rail", () => {
    const policy = makeProofPolicy();
    for (const minorUnits of [1_000n, 49_999n, 50_000n, 90_000n]) {
      const levels = refundDisputeSymmetricLevels(policy, {
        amount: fromMinorUnits(USD, minorUnits),
      });
      expect(levels.symmetric).toBe(true);
      expect(levels.refund).toBe(levels.settle);
      expect(levels.dispute).toBe(levels.settle);
    }
    // The same holds with rail and counterparty dimensions.
    const withRail = refundDisputeSymmetricLevels(policy, {
      amount: fromMinorUnits(USD, 90_000n),
      rail: "OFF_NETWORK_CHECK",
    });
    expect(withRail.settle).toBe("P4");
    expect(withRail.refund).toBe("P4");
    expect(withRail.dispute).toBe("P4");
  });

  it("defineProofPolicy validates its input (typed failures)", () => {
    expect(() =>
      defineProofPolicy({
        policyId: "bad",
        currency: USD,
        baselineLevel: "P9" as never,
        highRiskThresholdMinorUnits: 1n,
        highRiskLevel: "P3",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      defineProofPolicy({
        policyId: "bad",
        currency: USD,
        baselineLevel: "P1",
        highRiskThresholdMinorUnits: -1n,
        highRiskLevel: "P3",
      }),
    ).toThrow(ValidationError);
  });
});
