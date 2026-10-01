import { describe, expect, it } from "vitest";
import { USD, TerminalStateViolationError } from "@payswap/protocol";
import type { ClearingRecord, Obligation } from "@payswap/protocol";
import {
  DisputeGrantExceedsDisputedAmountError,
  UnknownDisputeError,
  disputeStateMachine,
} from "../src/disputes.js";
import { DisputeAuthority } from "../src/disputes.js";
import {
  ClaimWindowClosedError,
  ClaimWindowNotOpenError,
  MissingDisputeEvidenceError,
  NoRecoursePolicyError,
  initiateRecoursePolicy,
} from "../src/policy.js";
import { UnknownDisputeEvidenceError } from "../src/evidence.js";
import {
  ALICE,
  BOB,
  CLAIM_WINDOW,
  DAY_MS,
  DISPUTED_AMOUNT,
  GRANTED_AMOUNT,
  NOW,
  TRANSACTION_REF,
  buildScenario,
  recordExtraEvidence,
} from "./fixtures.js";

/** Deep structural copy for "originals unchanged" comparisons. */
function snapshotObligation(obligation: Obligation): Obligation {
  return JSON.parse(
    JSON.stringify({
      ...obligation,
      amount: { currency: obligation.amount.currency, value: obligation.amount.value.toString() },
      dueWindow: {
        opensAt: obligation.dueWindow.opensAt.toString(),
        closesAt: obligation.dueWindow.closesAt.toString(),
      },
    }),
  ) as unknown as Obligation;
}

describe("DisputeCase (W1-006)", () => {
  it("opens a dispute that references the original transaction by id only", () => {
    const scenario = buildScenario();
    const dispute = scenario.disputes.openDispute({
      transactionRef: TRANSACTION_REF,
      claimant: ALICE,
      respondent: BOB,
      disputedAmount: DISPUTED_AMOUNT,
      reason: "goods not delivered as described",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    expect(dispute.state).toBe("OPEN");
    expect(dispute.transactionRef).toBe(TRANSACTION_REF);
    expect(dispute.policyId).toBe(`RCP:${TRANSACTION_REF}`);
    expect(dispute.disputedAmount.value).toBe(90_000n);
    expect(dispute.evidenceRefs).toEqual([...scenario.originalEvidenceRefs]);
    expect(Object.isFrozen(dispute)).toBe(true);
    // The dispute record never embeds the original artifacts: it carries the
    // reference string only.
    const record = dispute as unknown as Record<string, unknown>;
    expect(record.originalObligation).toBeUndefined();
    expect(record.clearingRecord).toBeUndefined();
  });

  it("NEVER rewrites the original transaction: originals are byte-identical after the full lifecycle", () => {
    const scenario = buildScenario();
    const originalObligationBefore: Obligation = scenario.book.get(
      scenario.originalObligation.id,
    ) as Obligation;
    const originalSnapshot = snapshotObligation(originalObligationBefore);
    const clearingSnapshot = JSON.parse(
      JSON.stringify({
        ...scenario.originalClearingRecord,
        activities: scenario.originalClearingRecord.activities.map((activity) => ({
          ...activity,
          amount: {
            currency: activity.amount.currency,
            value: activity.amount.value.toString(),
          },
          occurredAt: activity.occurredAt.toString(),
        })),
      }),
    ) as ClearingRecord;
    const evidenceBefore = scenario.evidence
      .allNodes()
      .map((node) => scenario.evidence.canonicalNode(node.nodeId));

    // Full dispute lifecycle: OPEN → REVIEW → UNDER_REVIEW → GRANT → GRANTED.
    const dispute = scenario.disputes.openDispute({
      transactionRef: TRANSACTION_REF,
      claimant: ALICE,
      respondent: BOB,
      disputedAmount: DISPUTED_AMOUNT,
      reason: "goods not delivered as described",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    scenario.disputes.applyEvent({ disputeId: dispute.disputeId, event: "REVIEW" });
    const granted = scenario.disputes.applyEvent({
      disputeId: dispute.disputeId,
      event: "GRANT",
      decidedBy: "operator:adjudicator-1",
      grantedAmount: GRANTED_AMOUNT,
    });
    expect(granted.state).toBe("GRANTED");
    expect(granted.resolution?.outcome).toBe("GRANTED");
    expect(granted.resolution?.grantedAmount?.value).toBe(60_000n);

    // The original obligation is the SAME frozen record, byte-identical.
    const originalAfter = scenario.book.get(scenario.originalObligation.id) as Obligation;
    expect(originalAfter).toBe(originalObligationBefore);
    expect(snapshotObligation(originalAfter)).toEqual(originalSnapshot);
    expect(originalAfter.state).toBe("PENDING");

    // The original clearing record is untouched (compare the same
    // stringified projection on both sides).
    const clearingAfter = JSON.parse(
      JSON.stringify({
        ...scenario.originalClearingRecord,
        activities: scenario.originalClearingRecord.activities.map((activity) => ({
          ...activity,
          amount: {
            currency: activity.amount.currency,
            value: activity.amount.value.toString(),
          },
          occurredAt: activity.occurredAt.toString(),
        })),
      }),
    ) as ClearingRecord;
    expect(clearingAfter).toEqual(clearingSnapshot);

    // The original transaction's evidence is untouched (INV-E05).
    const evidenceAfter = scenario.evidence
      .allNodes()
      .filter((node) => evidenceBefore.includes(scenario.evidence.canonicalNode(node.nodeId)))
      .map((node) => scenario.evidence.canonicalNode(node.nodeId));
    expect(evidenceAfter).toEqual(evidenceBefore);
  });

  it("enforces the declared claim window at claim time", () => {
    // Before the window opens.
    const early = buildScenario();
    early.policies.register(
      initiateRecoursePolicy(
        {
          transactionRef: "TX-EARLY",
          currency: USD,
          mechanisms: ["EXPLICIT_CREDIT"],
          claimWindow: { opensAt: NOW + DAY_MS, closesAt: NOW + 2n * DAY_MS },
          evidenceRequirements: [],
        },
        { now: NOW },
      ),
    );
    expect(() =>
      early.disputes.openDispute({
        transactionRef: "TX-EARLY",
        claimant: ALICE,
        respondent: BOB,
        disputedAmount: DISPUTED_AMOUNT,
        reason: "too early",
        evidenceRefs: [],
      }),
    ).toThrowError(ClaimWindowNotOpenError);

    // After the window closed.
    const late = buildScenario();
    late.clock.advanceMs(Number(CLAIM_WINDOW.closesAt - NOW) + 1);
    expect(() =>
      late.disputes.openDispute({
        transactionRef: TRANSACTION_REF,
        claimant: ALICE,
        respondent: BOB,
        disputedAmount: DISPUTED_AMOUNT,
        reason: "too late",
        evidenceRefs: late.originalEvidenceRefs,
      }),
    ).toThrowError(ClaimWindowClosedError);
  });

  it("enforces the declared evidence requirements at claim time", () => {
    const scenario = buildScenario();
    // Authorization only: the delivery-outcome requirement is unmet.
    expect(() =>
      scenario.disputes.openDispute({
        transactionRef: TRANSACTION_REF,
        claimant: ALICE,
        respondent: BOB,
        disputedAmount: DISPUTED_AMOUNT,
        reason: "missing outcome evidence",
        evidenceRefs: ["ev_tx_auth"],
      }),
    ).toThrowError(MissingDisputeEvidenceError);
  });

  it("fails closed without a declared policy and on unknown evidence refs", () => {
    const scenario = buildScenario();
    expect(() =>
      scenario.disputes.openDispute({
        transactionRef: "TX-NOPOLICY",
        claimant: ALICE,
        respondent: BOB,
        disputedAmount: DISPUTED_AMOUNT,
        reason: "no policy",
        evidenceRefs: scenario.originalEvidenceRefs,
      }),
    ).toThrowError(NoRecoursePolicyError);

    expect(() =>
      scenario.disputes.openDispute({
        transactionRef: TRANSACTION_REF,
        claimant: ALICE,
        respondent: BOB,
        disputedAmount: DISPUTED_AMOUNT,
        reason: "unknown evidence",
        evidenceRefs: ["ev_never_recorded"],
      }),
    ).toThrowError(UnknownDisputeEvidenceError);
  });

  it("terminal transitions are monotonic (INV-X04): GRANTED never regresses", () => {
    const scenario = buildScenario();
    const dispute = scenario.disputes.openDispute({
      transactionRef: TRANSACTION_REF,
      claimant: ALICE,
      respondent: BOB,
      disputedAmount: DISPUTED_AMOUNT,
      reason: "terminal test",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    const granted = scenario.disputes.applyEvent({
      disputeId: dispute.disputeId,
      event: "GRANT",
      decidedBy: "operator:adjudicator-1",
      grantedAmount: DISPUTED_AMOUNT,
    });
    expect(granted.state).toBe("GRANTED");
    expect(granted.history).toHaveLength(1);

    // Every event out of the terminal state without a declared recovery is a
    // TERMINAL_STATE violation — including REOPEN (only REJECTED recovers).
    // GRANT/REJECT carry their required inputs and REOPEN carries new
    // evidence so the refusal comes from the machine's terminality rule,
    // not input validation.
    const terminalEvidence = [recordExtraEvidence(scenario, "ev_terminal", dispute.disputeId)];
    for (const event of ["REVIEW", "REJECT", "WITHDRAW"] as const) {
      expect(() =>
        scenario.disputes.applyEvent({
          disputeId: dispute.disputeId,
          event,
          decidedBy: "operator:adjudicator-1",
        }),
      ).toThrowError(TerminalStateViolationError);
    }
    expect(() =>
      scenario.disputes.applyEvent({
        disputeId: dispute.disputeId,
        event: "REOPEN",
        additionalEvidenceRefs: terminalEvidence,
      }),
    ).toThrowError(TerminalStateViolationError);
    expect(() =>
      scenario.disputes.applyEvent({
        disputeId: dispute.disputeId,
        event: "GRANT",
        decidedBy: "operator:adjudicator-1",
        grantedAmount: DISPUTED_AMOUNT,
      }),
    ).toThrowError(TerminalStateViolationError);
    expect(scenario.disputes.get(dispute.disputeId)?.state).toBe("GRANTED");
  });

  it("explicit recovery: REJECTED --REOPEN--> UNDER_REVIEW only with new evidence (INV-X04)", () => {
    const scenario = buildScenario();
    const dispute = scenario.disputes.openDispute({
      transactionRef: TRANSACTION_REF,
      claimant: ALICE,
      respondent: BOB,
      disputedAmount: DISPUTED_AMOUNT,
      reason: "recovery test",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    const rejected = scenario.disputes.applyEvent({
      disputeId: dispute.disputeId,
      event: "REJECT",
      decidedBy: "operator:adjudicator-1",
    });
    expect(rejected.state).toBe("REJECTED");
    expect(rejected.history).toHaveLength(1);

    // Recovery without new evidence is forbidden.
    expect(() =>
      scenario.disputes.applyEvent({ disputeId: dispute.disputeId, event: "REOPEN" }),
    ).toThrowError(/requires new evidence/);

    // Recovery with new evidence is the declared, explicit path.
    const newEvidenceRef = recordExtraEvidence(
      scenario,
      "ev_new_facts",
      dispute.disputeId,
    );
    const reopened = scenario.disputes.applyEvent({
      disputeId: dispute.disputeId,
      event: "REOPEN",
      additionalEvidenceRefs: [newEvidenceRef],
    });
    expect(reopened.state).toBe("UNDER_REVIEW");
    expect(reopened.history).toHaveLength(2);
    expect(reopened.history[1]?.viaRecovery).toBe(true);
    // The rejection stays in history (append-only) and the new evidence is
    // appended to the citation list.
    expect(reopened.history[0]?.on).toBe("REJECT");
    expect(reopened.evidenceRefs).toContain(newEvidenceRef);

    // The dispute can now be granted after the review.
    const granted = scenario.disputes.applyEvent({
      disputeId: dispute.disputeId,
      event: "GRANT",
      decidedBy: "operator:adjudicator-2",
      grantedAmount: GRANTED_AMOUNT,
    });
    expect(granted.state).toBe("GRANTED");
  });

  it("grants are bounded by the disputed amount and require an adjudicator", () => {
    const scenario = buildScenario();
    const dispute = scenario.disputes.openDispute({
      transactionRef: TRANSACTION_REF,
      claimant: ALICE,
      respondent: BOB,
      disputedAmount: DISPUTED_AMOUNT,
      reason: "bounds test",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    expect(() =>
      scenario.disputes.applyEvent({
        disputeId: dispute.disputeId,
        event: "GRANT",
        decidedBy: "operator:adjudicator-1",
        grantedAmount: { ...DISPUTED_AMOUNT, value: 90_001n },
      }),
    ).toThrowError(DisputeGrantExceedsDisputedAmountError);
    expect(() =>
      scenario.disputes.applyEvent({
        disputeId: dispute.disputeId,
        event: "GRANT",
        grantedAmount: GRANTED_AMOUNT,
      }),
    ).toThrowError(/adjudicator/);
    // WITHDRAW works from OPEN and stamps the claimant as the withdrawer.
    const withdrawn = scenario.disputes.applyEvent({
      disputeId: dispute.disputeId,
      event: "WITHDRAW",
    });
    expect(withdrawn.state).toBe("WITHDRAWN");
    expect(withdrawn.resolution?.outcome).toBe("WITHDRAWN");
  });

  it("supports multiple independent disputes per transaction and audit views", () => {
    const scenario = buildScenario();
    const first = scenario.disputes.openDispute({
      transactionRef: TRANSACTION_REF,
      claimant: ALICE,
      respondent: BOB,
      disputedAmount: DISPUTED_AMOUNT,
      reason: "first claim",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    const second = scenario.disputes.openDispute({
      transactionRef: TRANSACTION_REF,
      claimant: ALICE,
      respondent: BOB,
      disputedAmount: { ...DISPUTED_AMOUNT, value: 10_000n },
      reason: "second claim",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    expect(first.disputeId).not.toBe(second.disputeId);
    expect(scenario.disputes.byTransaction(TRANSACTION_REF)).toHaveLength(2);
    expect(scenario.disputes.all()).toHaveLength(2);
    expect(() => scenario.disputes.require("dsp_unknown")).toThrowError(UnknownDisputeError);
  });

  it("the declared machine refuses undeclared shapes and self-disputes", () => {
    expect(disputeStateMachine.terminalStates).toEqual(["GRANTED", "REJECTED", "WITHDRAWN"]);
    expect(disputeStateMachine.states).toContain("UNDER_REVIEW");
    const scenario = buildScenario();
    expect(() =>
      scenario.disputes.openDispute({
        transactionRef: TRANSACTION_REF,
        claimant: ALICE,
        respondent: ALICE,
        disputedAmount: DISPUTED_AMOUNT,
        reason: "self dispute",
        evidenceRefs: scenario.originalEvidenceRefs,
      }),
    ).toThrowError(/against itself/);
    expect(() =>
      scenario.disputes.openDispute({
        transactionRef: TRANSACTION_REF,
        claimant: ALICE,
        respondent: BOB,
        disputedAmount: { ...DISPUTED_AMOUNT, value: 0n },
        reason: "zero amount",
        evidenceRefs: scenario.originalEvidenceRefs,
      }),
    ).toThrowError(/positive Money/);
    // The authority rejects malformed event input.
    expect(() =>
      scenario.disputes.applyEvent({ disputeId: "", event: "REVIEW" }),
    ).toThrowError(/disputeId/);
    const authority = new DisputeAuthority({
      policies: scenario.policies,
      evidence: scenario.evidence,
      ids: scenario.ledger.ids,
      clock: scenario.clock,
    });
    expect(authority.all()).toHaveLength(0);
  });
});
