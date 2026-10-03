import { describe, expect, it } from "vitest";
import { prepareWrite } from "@payswap/onchain-security";
import {
  AdversarialTransactionAgent,
  InvalidAdversarialAnalysisError,
  recommendationFromSignals,
} from "../src/index.js";
import { buildThreatSignal } from "../src/index.js";
import { SecretShapeError } from "@payswap/onchain-security";
import {
  AGENT_REF,
  MALICIOUS_SPENDER,
  NOW,
  baseThreatPolicy,
  baseWriteRequest,
  benignBundle,
  canonicalApproval,
  consistentSimulation,
} from "./helpers.js";

describe("AdversarialTransactionAgent", () => {
  const agent = new AdversarialTransactionAgent(AGENT_REF);

  it("rejects an empty agent ref (provenance is mandatory)", () => {
    expect(() => new AdversarialTransactionAgent("")).toThrow(
      InvalidAdversarialAnalysisError,
    );
  });

  it("a healthy world yields an empty assessment with ALLOW recommendation", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const assessment = agent.analyze({
      write,
      simulation: consistentSimulation(write.writeId),
      policy: baseThreatPolicy(),
      bundle: benignBundle(),
      at: NOW,
    });
    expect(assessment.signals).toEqual([]);
    expect(assessment.agentRecommendation).toBe("ALLOW");
    expect(assessment.agentRef).toBe(AGENT_REF);
    expect(assessment.analyzedAt).toBe(NOW);
    expect(assessment.evidenceRefs.join(" ")).toContain(`write:${write.writeDigest}`);
    expect(assessment.assessmentId.startsWith("fnv1a64:")).toBe(true);
    expect(Object.isFrozen(assessment)).toBe(true);
  });

  it("signals are ordered severity-first and content-addressed", () => {
    const write = prepareWrite(
      baseWriteRequest({
        approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })],
      }),
      NOW,
    );
    const assessment = agent.analyze({
      write,
      policy: baseThreatPolicy(),
      bundle: benignBundle(),
      at: NOW,
    });
    expect(assessment.signals.length).toBeGreaterThan(0);
    for (const signal of assessment.signals) {
      // EVERY signal carries a complete evidence chain + calibrated bps.
      expect(signal.evidence.observationRefs.length).toBeGreaterThan(0);
      expect(signal.evidence.digestRefs.length).toBeGreaterThan(0);
      expect(Number.isInteger(signal.confidenceBps)).toBe(true);
    }
    const severities = assessment.signals.map((s) => s.severity);
    const ranks = severities.map((s) =>
      s === "critical" ? 4 : s === "high" ? 3 : s === "medium" ? 2 : s === "low" ? 1 : 0,
    );
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it("deterministic: identical input → identical assessmentId", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const input = {
      write,
      simulation: consistentSimulation(write.writeId),
      policy: baseThreatPolicy(),
      bundle: benignBundle(),
      at: NOW,
    };
    expect(agent.analyze(input).assessmentId).toBe(agent.analyze(input).assessmentId);
  });

  it("the recommendation follows the fixed severity rule", () => {
    const mk = (severity: "info" | "medium" | "high" | "critical") =>
      buildThreatSignal({
        family: "oracle_manipulation",
        code: "x",
        severity,
        method: "threshold_breach",
        confidenceBps: 9_000,
        evidence: {
          observationRefs: ["obs:1"],
          digestRefs: ["write:d"],
          note: "n",
        },
        summary: "s",
      });
    expect(recommendationFromSignals([])).toBe("ALLOW");
    expect(recommendationFromSignals([mk("info")])).toBe("ALLOW");
    expect(recommendationFromSignals([mk("medium")])).toBe("ALLOW_WITH_CONSTRAINTS");
    expect(recommendationFromSignals([mk("high")])).toBe("REQUIRE_CONFIRMATION");
    expect(recommendationFromSignals([mk("critical")])).toBe("BLOCK");
  });

  it("rejects a negative evaluation instant (fail closed)", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    expect(() =>
      agent.analyze({
        write,
        policy: baseThreatPolicy(),
        bundle: benignBundle(),
        at: -1,
      }),
    ).toThrow(InvalidAdversarialAnalysisError);
  });

  it("SECRET BOUNDARY: key material cannot enter the agent input (rule 25)", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const rawKeyShape = `0x${"ab".repeat(32)}`;
    expect(() =>
      agent.analyze({
        write,
        policy: baseThreatPolicy(),
        // @ts-expect-error deliberately smuggle key-shaped material
        bundle: { ...benignBundle(), note: rawKeyShape },
        at: NOW,
      }),
    ).toThrow(SecretShapeError);
  });
});
