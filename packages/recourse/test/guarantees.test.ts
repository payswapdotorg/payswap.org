import { describe, expect, it } from "vitest";
import { USD, TransitionGuardError } from "@payswap/protocol";
import {
  GuaranteeCoverageExceededError,
  GuaranteeDeclarationImmutableError,
  GuaranteeInvocationWindowError,
  GuaranteeProofThresholdError,
  UnknownGuaranteeError,
  invokedTotal,
} from "../src/guarantees.js";
import {
  ALICE,
  BOB,
  CAROL,
  DAY_MS,
  DISPUTED_AMOUNT,
  DUE_WINDOW,
  GRANTED_AMOUNT,
  GUARANTOR,
  NOW,
  buildScenario,
  openGrantedDispute,
  recordExtraEvidence,
} from "./fixtures.js";

const COVERAGE_CAP = { ...DISPUTED_AMOUNT, value: 100_000n }; // 1,000.00 USD
const INVOCATION_WINDOW = { opensAt: NOW, closesAt: NOW + 90n * DAY_MS };

function declareGuarantee(scenario: ReturnType<typeof buildScenario>) {
  return scenario.guarantees.declareGuarantee({
    guarantor: GUARANTOR,
    protectedParty: BOB,
    currency: USD,
    coverageCap: COVERAGE_CAP,
    proofThreshold: "P2",
    invocationWindow: INVOCATION_WINDOW,
  });
}

describe("Guarantee (W1-006)", () => {
  it("declares a guarantee with an immutable, frozen guarantor declaration", () => {
    const scenario = buildScenario();
    const guarantee = declareGuarantee(scenario);
    expect(guarantee.state).toBe("ACTIVE");
    expect(guarantee.declaration.guarantor).toBe(GUARANTOR);
    expect(guarantee.declaration.protectedParty).toBe(BOB);
    expect(guarantee.declaration.coverageCap.value).toBe(100_000n);
    expect(Object.isFrozen(guarantee)).toBe(true);
    expect(Object.isFrozen(guarantee.declaration)).toBe(true);
    expect(invokedTotal(guarantee)).toBe(0n);

    // Identical re-declaration with the same id at the same clock reading is
    // an idempotent replay.
    const replay = scenario.guarantees.declareGuarantee({
      guaranteeId: guarantee.declaration.guaranteeId,
      guarantor: GUARANTOR,
      protectedParty: BOB,
      currency: USD,
      coverageCap: COVERAGE_CAP,
      proofThreshold: "P2",
      invocationWindow: INVOCATION_WINDOW,
    });
    expect(replay).toBe(guarantee);
  });

  it("the declaration is immutable: any content change under the same id is rejected", () => {
    const scenario = buildScenario();
    const guarantee = declareGuarantee(scenario);
    // Same id, different coverage cap: rejected.
    expect(() =>
      scenario.guarantees.declareGuarantee({
        guaranteeId: guarantee.declaration.guaranteeId,
        guarantor: GUARANTOR,
        protectedParty: BOB,
        currency: USD,
        coverageCap: { ...DISPUTED_AMOUNT, value: 999_999n },
        proofThreshold: "P2",
        invocationWindow: INVOCATION_WINDOW,
      }),
    ).toThrowError(GuaranteeDeclarationImmutableError);
    // The original declaration is untouched.
    expect(scenario.guarantees.get(guarantee.declaration.guaranteeId)).toBe(guarantee);
    expect(scenario.guarantees.all()).toHaveLength(1);
  });

  it("rejects malformed declarations", () => {
    const scenario = buildScenario();
    const base = {
      guarantor: GUARANTOR,
      protectedParty: BOB,
      currency: USD,
      coverageCap: COVERAGE_CAP,
      proofThreshold: "P2" as const,
      invocationWindow: INVOCATION_WINDOW,
    };
    expect(() =>
      scenario.guarantees.declareGuarantee({
        ...base,
        coverageCap: { ...COVERAGE_CAP, currency: "EUR" as never },
      }),
    ).toThrowError(/currency differs/);
    expect(() =>
      scenario.guarantees.declareGuarantee({
        ...base,
        invocationWindow: { opensAt: NOW - 10n, closesAt: NOW - 1n },
      }),
    ).toThrowError(/already closed at declaration/);
    expect(() =>
      scenario.guarantees.declareGuarantee({
        ...base,
        proofThreshold: "P9" as never,
      }),
    ).toThrowError(/declared proof level/);
  });

  it("an invocation creates a guarantee-backed recourse obligation (guarantor → claimant)", () => {
    const scenario = buildScenario();
    const guarantee = declareGuarantee(scenario);
    const granted = openGrantedDispute(scenario);

    const invoked = scenario.guarantees.invokeGuarantee({
      guaranteeId: guarantee.declaration.guaranteeId,
      disputeId: granted.disputeId,
      claimant: CAROL,
      amount: { ...DISPUTED_AMOUNT, value: 40_000n },
      evidenceRefs: [recordExtraEvidence(scenario, "ev_guarantee_invoke", "guarantee-ops")],
      obligationDueWindow: DUE_WINDOW,
    });

    expect(invoked.state).toBe("ACTIVE");
    expect(invoked.invocations).toHaveLength(1);
    const invocation = invoked.invocations[0];
    expect(invocation?.disputeId).toBe(granted.disputeId);
    expect(invocation?.amount.value).toBe(40_000n);

    // The SEPARATE recourse obligation: guarantor owes the claimant.
    const obligation = scenario.book.get(invocation?.recourseObligationId as never);
    expect(obligation?.debtor).toBe(GUARANTOR);
    expect(obligation?.creditor).toBe(CAROL);
    expect(obligation?.amount.value).toBe(40_000n);
    expect(obligation?.state).toBe("PENDING");

    // Lineage: the obligations ledger records the guarantee payout kind.
    const entry = scenario.obligations
      .entriesForDispute(granted.disputeId)
      .find((candidate) => candidate.adjustmentKind === "GUARANTEE_PAYOUT");
    expect(entry?.mechanism).toBe("GUARANTEE");
    expect(entry?.obligationId).toBe(invocation?.recourseObligationId);
    expect(invokedTotal(invoked)).toBe(40_000n);
  });

  it("enforces invocation conditions: granted dispute, window, proof threshold, coverage cap", () => {
    const scenario = buildScenario();
    const guarantee = declareGuarantee(scenario);

    // Not-yet-granted dispute: refused, nothing recorded.
    const openDispute = scenario.disputes.openDispute({
      transactionRef: "TX-1",
      claimant: ALICE,
      respondent: BOB,
      disputedAmount: DISPUTED_AMOUNT,
      reason: "guarantee before adjudication",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    expect(() =>
      scenario.guarantees.invokeGuarantee({
        guaranteeId: guarantee.declaration.guaranteeId,
        disputeId: openDispute.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 40_000n },
        evidenceRefs: [recordExtraEvidence(scenario, "ev_g_1", "guarantee-ops")],
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/GRANTED dispute/);

    const granted = openGrantedDispute(scenario);

    // Weak evidence: refused (unauthenticated artifact capped at P0 < P2).
    scenario.evidence.record({
      nodeId: "ev_guarantee_weak",
      kind: "PROOF",
      actionRef: "guarantee-ops",
      claimedLevel: "P5",
      provenance: { source: "UI_BROWSER_ARTIFACT", authenticated: false },
      payload: "screenshot:claims-p5",
      links: [],
      recordedAt: scenario.clock.now(),
    });
    expect(() =>
      scenario.guarantees.invokeGuarantee({
        guaranteeId: guarantee.declaration.guaranteeId,
        disputeId: granted.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 40_000n },
        evidenceRefs: ["ev_guarantee_weak"],
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(GuaranteeProofThresholdError);

    // Coverage cap with exact arithmetic: each dispute's grant is 60,000n, so
    // exhausting the 100,000n coverage cap needs two granted disputes —
    // 60,000 (dispute A) + 60,000 (dispute B) > 100,000 is refused.
    const grantedB = openGrantedDispute(scenario);
    scenario.guarantees.invokeGuarantee({
      guaranteeId: guarantee.declaration.guaranteeId,
      disputeId: granted.disputeId,
      claimant: CAROL,
      amount: GRANTED_AMOUNT,
      evidenceRefs: [recordExtraEvidence(scenario, "ev_g_2", "guarantee-ops")],
      obligationDueWindow: DUE_WINDOW,
    });
    expect(() =>
      scenario.guarantees.invokeGuarantee({
        guaranteeId: guarantee.declaration.guaranteeId,
        disputeId: grantedB.disputeId,
        claimant: CAROL,
        amount: GRANTED_AMOUNT,
        evidenceRefs: [recordExtraEvidence(scenario, "ev_g_3", "guarantee-ops")],
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(GuaranteeCoverageExceededError);
    // The refused invocation recorded nothing for dispute B.
    expect(
      scenario.guarantees.get(guarantee.declaration.guaranteeId)?.invocations,
    ).toHaveLength(1);

    // Cumulative grant bound: dispute A's 60,000n grant is fully consumed;
    // one more minor invocation citing A is refused (no overcompensation).
    expect(() =>
      scenario.guarantees.invokeGuarantee({
        guaranteeId: guarantee.declaration.guaranteeId,
        disputeId: granted.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 1n },
        evidenceRefs: [recordExtraEvidence(scenario, "ev_g_5", "guarantee-ops")],
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/cumulative recourse/);

    // Outside the invocation window: refused (dispute B still has grant left).
    scenario.clock.advanceMs(Number(90n * DAY_MS + 1n));
    expect(() =>
      scenario.guarantees.invokeGuarantee({
        guaranteeId: guarantee.declaration.guaranteeId,
        disputeId: grantedB.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 5_000n },
        evidenceRefs: [recordExtraEvidence(scenario, "ev_g_4", "guarantee-ops")],
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(GuaranteeInvocationWindowError);
  });

  it("exhausts at the coverage cap (terminal, INV-X04) and refuses later invocations", () => {
    const scenario = buildScenario();
    const guarantee = declareGuarantee(scenario);
    const grantedA = openGrantedDispute(scenario);
    const grantedB = openGrantedDispute(scenario);

    // 60,000 (dispute A) + 40,000 (dispute B) = the 100,000n coverage cap.
    scenario.guarantees.invokeGuarantee({
      guaranteeId: guarantee.declaration.guaranteeId,
      disputeId: grantedA.disputeId,
      claimant: CAROL,
      amount: GRANTED_AMOUNT,
      evidenceRefs: [recordExtraEvidence(scenario, "ev_g_full_a", "guarantee-ops")],
      obligationDueWindow: DUE_WINDOW,
    });
    const exhausted = scenario.guarantees.invokeGuarantee({
      guaranteeId: guarantee.declaration.guaranteeId,
      disputeId: grantedB.disputeId,
      claimant: CAROL,
      amount: { ...DISPUTED_AMOUNT, value: 40_000n },
      evidenceRefs: [recordExtraEvidence(scenario, "ev_g_full_b", "guarantee-ops")],
      obligationDueWindow: DUE_WINDOW,
    });
    expect(exhausted.state).toBe("EXHAUSTED");
    expect(exhausted.history).toHaveLength(1);
    expect(exhausted.history[0]?.on).toBe("EXHAUST");
    expect(exhausted.invocations).toHaveLength(2);
    expect(() =>
      scenario.guarantees.invokeGuarantee({
        guaranteeId: guarantee.declaration.guaranteeId,
        disputeId: grantedB.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 1n },
        evidenceRefs: ["ev_g_full_b"],
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/while the guarantee is ACTIVE/);
  });

  it("lapses only after the invocation window closed (guarded, terminal)", () => {
    const scenario = buildScenario();
    const guarantee = declareGuarantee(scenario);
    // Before the window closes: the lapse guard refuses.
    expect(() => scenario.guarantees.lapseGuarantee(guarantee.declaration.guaranteeId)).toThrowError(
      TransitionGuardError,
    );
    // After the window closes: LAPSED is terminal.
    scenario.clock.advanceMs(Number(90n * DAY_MS + 1n));
    const lapsed = scenario.guarantees.lapseGuarantee(guarantee.declaration.guaranteeId);
    expect(lapsed.state).toBe("LAPSED");
    expect(lapsed.lapsedAt).toBeDefined();
    expect(lapsed.history).toHaveLength(1);
    expect(lapsed.history[0]?.on).toBe("LAPSE");
    // No invocations after the lapse.
    expect(() =>
      scenario.guarantees.invokeGuarantee({
        guaranteeId: guarantee.declaration.guaranteeId,
        disputeId: "dsp_any",
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 1n },
        evidenceRefs: ["ev_g_full"],
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/while the guarantee is ACTIVE/);
  });

  it("invocations are bounded by the granted amount and fail closed on unknown ids", () => {
    const scenario = buildScenario();
    const guarantee = declareGuarantee(scenario);
    const granted = openGrantedDispute(scenario); // granted 60,000n
    expect(() =>
      scenario.guarantees.invokeGuarantee({
        guaranteeId: guarantee.declaration.guaranteeId,
        disputeId: granted.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 60_001n },
        evidenceRefs: [recordExtraEvidence(scenario, "ev_g_bound", "guarantee-ops")],
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/granted amount/);
    // Nothing was recorded by the refused invocation.
    expect(scenario.guarantees.get(guarantee.declaration.guaranteeId)?.invocations).toHaveLength(0);

    expect(() => scenario.guarantees.get("gnt_missing")?.state).not.toThrow();
    expect(scenario.guarantees.get("gnt_missing")).toBeUndefined();
    expect(() =>
      scenario.guarantees.invokeGuarantee({
        guaranteeId: "gnt_missing",
        disputeId: granted.disputeId,
        claimant: CAROL,
        amount: GRANTED_AMOUNT,
        evidenceRefs: ["ev_g_bound"],
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(UnknownGuaranteeError);
    expect(() => scenario.guarantees.lapseGuarantee("gnt_missing")).toThrowError(UnknownGuaranteeError);
  });
});
