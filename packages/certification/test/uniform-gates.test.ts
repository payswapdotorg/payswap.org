import { describe, expect, it } from "vitest";
import {
  EXECUTION_MODES,
} from "@payswap/connectors";
import {
  UNIFORM_GATE_REQUIREMENTS,
  assertUniformGateWall,
  evaluateUniformGates,
  runUniformGateWall,
} from "@payswap/certification";
import type { UniformGateCandidate, UniformGateDecisionInput } from "@payswap/certification";
import type { Equal, Expect } from "./type-utils.js";

/**
 * THE uniform gate wall (W2-006 acceptance: PASS_THROUGH_NATIVE,
 * COMPOSED_PAYSWAP and OPTIMIZED_MULTI_PROVIDER share the SAME
 * authorization/compliance/evidence gates; no mode-specific bypass;
 * provider-native optimization candidates cannot bypass safety gates).
 */

// ---------------------------------------------------------------------------
// Type-level proof: the decision input structurally cannot carry the mode
// ---------------------------------------------------------------------------

type ModeInDecision = "executionMode" extends keyof UniformGateDecisionInput
  ? true
  : false;
type IncumbentInDecision = "isIncumbentBaseline" extends keyof UniformGateDecisionInput
  ? true
  : false;
type _noModeInDecision = Expect<Equal<ModeInDecision, false>>;
type _noIncumbentInDecision = Expect<Equal<IncumbentInDecision, false>>;
type _decisionIsOmit = Expect<
  Equal<
    UniformGateDecisionInput,
    Omit<UniformGateCandidate, "executionMode" | "isIncumbentBaseline">
  >
>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function completeCandidate(
  candidateId: string,
  executionMode: UniformGateCandidate["executionMode"],
  isIncumbentBaseline: boolean,
): UniformGateCandidate {
  return {
    candidateId,
    executionMode,
    isIncumbentBaseline,
    authorizationEvidence: [
      {
        authorizationRef: "auth:cand-1",
        evidenceRef: "evidence:auth-1",
        issuedAtEpoch: 0n,
      },
    ],
    complianceClearances: [
      {
        clearanceId: "clearance:eu",
        policyRef: "policy:eu-payments@2",
        evidenceRef: "evidence:screening-1",
      },
    ],
    evidence: [
      { evidenceId: "ev-1", kind: "REPLAY", artifactRef: "a/1", contentDigest: "d/1" },
      { evidenceId: "ev-2", kind: "COUNTERFACTUAL", artifactRef: "a/2", contentDigest: "d/2" },
      { evidenceId: "ev-3", kind: "ROBUSTNESS", artifactRef: "a/3", contentDigest: "d/3" },
    ],
  };
}

describe("THE uniform gate wall: one pipeline for all three execution modes", () => {
  it("all three modes pass through the SAME requirements object with identical results", () => {
    const results = EXECUTION_MODES.map((mode) =>
      runUniformGateWall(completeCandidate("cand-uniform", mode, false)),
    );
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.passed).toBe(true);
      expect(result.gateChecks.map((check) => check.gateId)).toEqual([
        "AUTHORIZATION",
        "COMPLIANCE",
        "EVIDENCE",
      ]);
      // THE SAME requirements object for every mode — literally.
      expect(result.requirements).toBe(UNIFORM_GATE_REQUIREMENTS);
    }
    // Identical submissions → identical gate checks AND identical digests:
    // the wall output is mode-invariant.
    const [first, second, third] = results as [typeof results[0], typeof results[0], typeof results[0]];
    expect(second.gateChecks).toEqual(first.gateChecks);
    expect(third.gateChecks).toEqual(first.gateChecks);
    expect(second.wallDigest).toBe(first.wallDigest);
    expect(third.wallDigest).toBe(first.wallDigest);
  });

  it("each mode fails identically when the same gate fails — no mode-specific bypass", () => {
    const results = EXECUTION_MODES.map((mode) =>
      runUniformGateWall({
        ...completeCandidate("cand-uniform-fail", mode, false),
        complianceClearances: [],
      }),
    );
    for (const result of results) {
      expect(result.passed).toBe(false);
      const compliance = result.gateChecks.find(
        (check) => check.gateId === "COMPLIANCE",
      );
      expect(compliance?.passed).toBe(false);
      expect(String(compliance?.violations[0])).toContain(
        "hard constraints before soft optimization",
      );
    }
    // The three failures are structurally identical (mode-invariant).
    const [first, second, third] = results as [typeof results[0], typeof results[0], typeof results[0]];
    expect(second.gateChecks).toEqual(first.gateChecks);
    expect(third.gateChecks).toEqual(first.gateChecks);

    // The throwing variant rejects every mode.
    for (const mode of EXECUTION_MODES) {
      expect(() =>
        assertUniformGateWall({
          ...completeCandidate("cand-uniform-fail", mode, false),
          complianceClearances: [],
        }),
      ).toThrow(/uniform gate wall/);
    }
  });

  it("missing authorization evidence fails every mode — including the provider-native pass-through", () => {
    for (const mode of EXECUTION_MODES) {
      const result = runUniformGateWall({
        ...completeCandidate("cand-noauth", mode, false),
        authorizationEvidence: [],
      });
      expect(result.passed).toBe(false);
      const authorization = result.gateChecks.find(
        (check) => check.gateId === "AUTHORIZATION",
      );
      expect(String(authorization?.violations[0])).toContain(
        "requires protocol authorization",
      );
    }
  });

  it("missing INV-L02 evidence fails every mode", () => {
    for (const mode of EXECUTION_MODES) {
      const result = runUniformGateWall({
        ...completeCandidate("cand-noevidence", mode, false),
        evidence: [
          { evidenceId: "ev-1", kind: "REPLAY", artifactRef: "a/1", contentDigest: "d/1" },
        ],
      });
      expect(result.passed).toBe(false);
      const evidence = result.gateChecks.find(
        (check) => check.gateId === "EVIDENCE",
      );
      expect(String(evidence?.violations[0])).toContain("COUNTERFACTUAL");
    }
  });

  it("an incumbent-native candidate is gated IDENTICALLY and is rejected when a gate fails", () => {
    // The provider-native optimization incumbent baseline (INV-C08):
    // PASS_THROUGH_NATIVE + isIncumbentBaseline.
    const passingIncumbent = runUniformGateWall(
      completeCandidate("cand-incumbent", "PASS_THROUGH_NATIVE", true),
    );
    expect(passingIncumbent.passed).toBe(true);
    expect(passingIncumbent.isIncumbentBaseline).toBe(true);
    expect(passingIncumbent.requirements).toBe(UNIFORM_GATE_REQUIREMENTS);

    // A failing gate rejects the incumbent-native candidate exactly like
    // every other candidate: being the provider's own optimization confers
    // NO bypass (INV-C07, AGENTS.md rule 20).
    const failingIncumbent = runUniformGateWall({
      ...completeCandidate("cand-incumbent", "PASS_THROUGH_NATIVE", true),
      authorizationEvidence: [],
    });
    expect(failingIncumbent.passed).toBe(false);
    expect(() =>
      assertUniformGateWall({
        ...completeCandidate("cand-incumbent", "PASS_THROUGH_NATIVE", true),
        authorizationEvidence: [],
      }),
    ).toThrow(/uniform gate wall/);

    // Incumbent rejection is identical to non-incumbent rejection for the
    // same submission: the incumbent flag never changes the outcome.
    const failingChallenger = runUniformGateWall({
      ...completeCandidate("cand-incumbent", "PASS_THROUGH_NATIVE", false),
      authorizationEvidence: [],
    });
    expect(failingIncumbent.gateChecks).toEqual(failingChallenger.gateChecks);
    expect(failingIncumbent.wallDigest).toBe(failingChallenger.wallDigest);
  });

  it("candidates without an explicit execution mode are rejected (INV-C07)", () => {
    expect(() =>
      runUniformGateWall({
        ...completeCandidate("cand-implicit", "NATIVE_MAGIC" as "PASS_THROUGH_NATIVE", false),
      }),
    ).toThrow(/explicit execution mode/);
  });
});

describe("the decision core", () => {
  it("is a pure function of the decision input and the requirements", () => {
    const decision: UniformGateDecisionInput = {
      candidateId: "cand-core",
      authorizationEvidence: [
        { authorizationRef: "auth:1", evidenceRef: "ev:1", issuedAtEpoch: 3n },
      ],
      complianceClearances: [
        { clearanceId: "c:1", policyRef: "p:1", evidenceRef: "e:1" },
      ],
      evidence: [
        { evidenceId: "ev-1", kind: "REPLAY", artifactRef: "a", contentDigest: "d" },
        { evidenceId: "ev-2", kind: "COUNTERFACTUAL", artifactRef: "a", contentDigest: "d" },
        { evidenceId: "ev-3", kind: "ROBUSTNESS", artifactRef: "a", contentDigest: "d" },
      ],
    };
    const first = evaluateUniformGates(decision, UNIFORM_GATE_REQUIREMENTS);
    const second = evaluateUniformGates(decision, UNIFORM_GATE_REQUIREMENTS);
    expect(first).toEqual(second);
    expect(first.every((check) => check.passed)).toBe(true);

    expect(() =>
      evaluateUniformGates({ ...decision, candidateId: "" }, UNIFORM_GATE_REQUIREMENTS),
    ).toThrow(/candidateId/);
  });

  it("THE requirements cannot disable protocol authorization or compliance", () => {
    // Literal types: requireProtocolAuthorization and requireComplianceClearance
    // are `true` — declared at the type level, checked at runtime fail-closed.
    const requirements = UNIFORM_GATE_REQUIREMENTS;
    expect(requirements.requireProtocolAuthorization).toBe(true);
    expect(requirements.requireComplianceClearance).toBe(true);
    expect(Object.isFrozen(requirements)).toBe(true);
    expect(requirements.requiredGates).toEqual(["AUTHORIZATION", "COMPLIANCE", "EVIDENCE"]);
  });
});
