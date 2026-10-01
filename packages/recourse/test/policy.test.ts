import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import { EvidenceGraph } from "@payswap/settlement";
import {
  ClaimWindowClosedError,
  ClaimWindowNotOpenError,
  MissingDisputeEvidenceError,
  NoRecoursePolicyError,
  RecoursePolicyImmutableError,
  enforceClaimWindow,
  enforceEvidenceRequirements,
  initiateRecoursePolicy,
  isWithinClaimWindow,
} from "../src/policy.js";
import { RecoursePolicyRegistry } from "../src/policy.js";
import {
  ALICE,
  BOB,
  CLAIM_WINDOW,
  DISPUTED_AMOUNT,
  NOW,
  TRANSACTION_REF,
  buildScenario,
} from "./fixtures.js";

describe("RecoursePolicy (W1-006)", () => {
  it("initiates and deeply freezes the policy at transaction initiation", () => {
    const policy = initiateRecoursePolicy(
      {
        transactionRef: TRANSACTION_REF,
        currency: USD,
        mechanisms: ["ESCROW", "EXPLICIT_CREDIT"],
        claimWindow: CLAIM_WINDOW,
        evidenceRequirements: [
          {
            requirementId: "auth",
            description: "authorization proof",
            requiredKinds: ["AUTHORIZATION"],
            minimumProofLevel: "P2",
          },
        ],
      },
      { now: NOW },
    );
    expect(policy.policyId).toBe(`RCP:${TRANSACTION_REF}`);
    expect(policy.version).toBe(1n);
    expect(policy.mechanisms).toEqual(["ESCROW", "EXPLICIT_CREDIT"]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.mechanisms)).toBe(true);
    expect(Object.isFrozen(policy.claimWindow)).toBe(true);
    expect(Object.isFrozen(policy.evidenceRequirements)).toBe(true);
    expect(Object.isFrozen(policy.evidenceRequirements[0])).toBe(true);
    // Direct mutation attempts throw in strict mode (frozen records).
    expect(() => {
      (policy as { transactionRef: string }).transactionRef = "TX-2";
    }).toThrow();
  });

  it("rejects invalid declarations (mechanisms, windows, requirements)", () => {
    const base = {
      transactionRef: "TX-BAD",
      currency: USD,
      claimWindow: CLAIM_WINDOW,
      evidenceRequirements: [
        {
          requirementId: "auth",
          description: "authorization proof",
          requiredKinds: ["AUTHORIZATION"],
          minimumProofLevel: "P2",
        },
      ],
    } as const;
    expect(() =>
      initiateRecoursePolicy({ ...base, mechanisms: [] }, { now: NOW }),
    ).toThrowError(/at least one mechanism/);
    expect(() =>
      initiateRecoursePolicy(
        { ...base, mechanisms: ["TELEPORTATION"] as never },
        { now: NOW },
      ),
    ).toThrowError(/frozen vocabulary/);
    expect(() =>
      initiateRecoursePolicy(
        {
          ...base,
          mechanisms: ["ESCROW"],
          claimWindow: { opensAt: NOW - 10n, closesAt: NOW - 1n },
        },
        { now: NOW },
      ),
    ).toThrowError(/already closed at initiation/);
    expect(() =>
      initiateRecoursePolicy(
        {
          ...base,
          mechanisms: ["ESCROW"],
          evidenceRequirements: [
            {
              requirementId: "auth",
              description: "authorization proof",
              requiredKinds: ["AUTHORIZATION"],
              minimumProofLevel: "P2",
            },
            {
              requirementId: "auth",
              description: "duplicate id",
              requiredKinds: ["PROOF"],
              minimumProofLevel: "P1",
            },
          ],
        },
        { now: NOW },
      ),
    ).toThrowError(/duplicate evidence requirement id/);
  });

  it("is IMMUTABLE after initiation: the registry rejects any post-initiation mutation", () => {
    const scenario = buildScenario();
    const registered = scenario.policies.requireForTransaction(TRANSACTION_REF);

    // Identical re-registration is an idempotent replay (same record back).
    const replay = scenario.policies.register(registered);
    expect(replay).toBe(registered);

    // ANY content difference is a rejected post-initiation mutation.
    const mutated = initiateRecoursePolicy(
      {
        transactionRef: TRANSACTION_REF,
        currency: USD,
        mechanisms: ["ESCROW", "BOND", "GUARANTEE", "EXPLICIT_CREDIT", "HYBRID"],
        claimWindow: { opensAt: CLAIM_WINDOW.opensAt, closesAt: CLAIM_WINDOW.closesAt + 1n },
        evidenceRequirements: [
          {
            requirementId: "authorization-proof",
            description: "proof that the original payment was authorized",
            requiredKinds: ["AUTHORIZATION"],
            minimumProofLevel: "P2",
          },
          {
            requirementId: "delivery-outcome",
            description: "independent observation of what was actually delivered",
            requiredKinds: ["OUTCOME", "PROOF"],
            minimumProofLevel: "P2",
          },
        ],
      },
      { now: NOW },
    );
    expect(() => scenario.policies.register(mutated)).toThrowError(RecoursePolicyImmutableError);

    // The original registration is untouched by the rejected mutation.
    expect(scenario.policies.requireForTransaction(TRANSACTION_REF)).toBe(registered);
    expect(scenario.policies.all()).toHaveLength(1);
  });

  it("a fresh registry has no policy and claims fail closed", () => {
    const registry = new RecoursePolicyRegistry();
    expect(registry.forTransaction("TX-UNKNOWN")).toBeUndefined();
    expect(() => registry.requireForTransaction("TX-UNKNOWN")).toThrowError(NoRecoursePolicyError);
  });

  describe("claim window enforcement (at claim time)", () => {
    it("accepts claims inside the window", () => {
      const scenario = buildScenario();
      const policy = scenario.policies.requireForTransaction(TRANSACTION_REF);
      expect(isWithinClaimWindow(policy, NOW)).toBe(true);
      expect(isWithinClaimWindow(policy, CLAIM_WINDOW.closesAt)).toBe(true);
      expect(() => enforceClaimWindow(policy, NOW + 1n)).not.toThrow();
    });

    it("rejects claims before the window opens", () => {
      const scenario = buildScenario();
      const policy = scenario.policies.requireForTransaction(TRANSACTION_REF);
      const future = initiateRecoursePolicy(
        {
          transactionRef: "TX-FUTURE",
          currency: USD,
          mechanisms: ["ESCROW"],
          claimWindow: { opensAt: NOW + 10n, closesAt: NOW + 20n },
          evidenceRequirements: [],
        },
        { now: NOW },
      );
      expect(() => enforceClaimWindow(future, NOW)).toThrowError(ClaimWindowNotOpenError);
      expect(isWithinClaimWindow(policy, NOW - 1n)).toBe(false);
    });

    it("rejects claims after the window closed", () => {
      const scenario = buildScenario();
      const policy = scenario.policies.requireForTransaction(TRANSACTION_REF);
      expect(() =>
        enforceClaimWindow(policy, CLAIM_WINDOW.closesAt + 1n),
      ).toThrowError(ClaimWindowClosedError);
      expect(isWithinClaimWindow(policy, CLAIM_WINDOW.closesAt + 1n)).toBe(false);
    });
  });

  describe("evidence requirement enforcement (at claim time)", () => {
    it("accepts evidence satisfying every declared requirement", () => {
      const scenario = buildScenario();
      const policy = scenario.policies.requireForTransaction(TRANSACTION_REF);
      const nodes = scenario.originalEvidenceRefs.flatMap((ref) => {
        const node = scenario.evidence.node(ref);
        return node === undefined ? [] : [node];
      });
      expect(() => enforceEvidenceRequirements(policy, nodes)).not.toThrow();
    });

    it("rejects claims without the required evidence", () => {
      const scenario = buildScenario();
      const policy = scenario.policies.requireForTransaction(TRANSACTION_REF);
      // Only the authorization node: the delivery-outcome requirement is unmet.
      const authNode = scenario.evidence.node("ev_tx_auth");
      expect(authNode).toBeDefined();
      const onlyAuth = [authNode as NonNullable<typeof authNode>];
      expect(() => enforceEvidenceRequirements(policy, onlyAuth)).toThrowError(
        MissingDisputeEvidenceError,
      );

      // No evidence at all: every requirement is unmet.
      expect(() => enforceEvidenceRequirements(policy, [])).toThrowError(
        MissingDisputeEvidenceError,
      );
    });

    it("rejects weak evidence regardless of what it claims (INV-E04 caps)", () => {
      const scenario = buildScenario();
      const policy = scenario.policies.requireForTransaction(TRANSACTION_REF);
      const graph = new EvidenceGraph();
      // An unauthenticated screenshot CLAIMING P4 strength is capped at P0.
      const screenshot = graph.record({
        nodeId: "ev_screenshot",
        kind: "OUTCOME",
        actionRef: TRANSACTION_REF,
        claimedLevel: "P4",
        provenance: { source: "UI_BROWSER_ARTIFACT", authenticated: false },
        payload: "screenshot:order-page.png",
        links: [],
        recordedAt: NOW,
      });
      const overclaimingAuth = graph.record({
        nodeId: "ev_overclaim",
        kind: "AUTHORIZATION",
        actionRef: TRANSACTION_REF,
        claimedLevel: "P5",
        provenance: { source: "UI_BROWSER_ARTIFACT", authenticated: true },
        payload: "browser-artifact:signed-session",
        links: [],
        recordedAt: NOW,
      });
      let caught: unknown;
      try {
        enforceEvidenceRequirements(policy, [screenshot, overclaimingAuth]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MissingDisputeEvidenceError);
      const details = (caught as MissingDisputeEvidenceError).details as
        | { unmetRequirements?: string[] }
        | undefined;
      // The screenshot (capped at P0) cannot satisfy the P2 delivery-outcome
      // requirement; the authenticated browser artifact (capped at P1) cannot
      // satisfy the P2 authorization requirement either.
      expect(details?.unmetRequirements).toEqual([
        "authorization-proof",
        "delivery-outcome",
      ]);
    });
  });

  it("refuses claims priced in a different currency without an explicit FX policy", () => {
    const scenario = buildScenario();
    const eurAmount = { ...DISPUTED_AMOUNT, currency: "EUR" as typeof USD };
    expect(() =>
      scenario.disputes.openDispute({
        transactionRef: TRANSACTION_REF,
        claimant: ALICE,
        respondent: BOB,
        disputedAmount: eurAmount,
        reason: "currency mismatch",
        evidenceRefs: scenario.originalEvidenceRefs,
      }),
    ).toThrowError(/prices recourse in USD/);
  });

  it("deterministic policy ids are derived from the transaction reference", () => {
    const policy = initiateRecoursePolicy(
      {
        transactionRef: "TX-42",
        currency: USD,
        mechanisms: ["BOND"],
        claimWindow: CLAIM_WINDOW,
        evidenceRequirements: [],
      },
      { now: NOW },
    );
    expect(policy.policyId).toBe("RCP:TX-42");
    expect(policy.initiatedAt).toBe(NOW);
    // Exact money discipline: the policy currency is a branded code.
    expect(policy.currency).toBe(USD);
    expect(fromMinorUnits(policy.currency, 1n).value).toBe(1n);
  });
});
