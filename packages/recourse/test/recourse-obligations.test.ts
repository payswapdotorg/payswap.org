import { describe, expect, it } from "vitest";
import { asObligationId } from "@payswap/protocol";
import type { Obligation } from "@payswap/protocol";
import {
  DisputeNotGrantedError,
  RecourseAmountExceedsGrantError,
} from "../src/recourse-obligations.js";
import { RecourseObligationAuthority } from "../src/recourse-obligations.js";
import {
  ALICE,
  BOB,
  DISPUTED_AMOUNT,
  DUE_WINDOW,
  GRANTED_AMOUNT,
  NOW,
  TRANSACTION_REF,
  buildScenario,
  openGrantedDispute,
} from "./fixtures.js";

describe("RecourseObligation (W1-006)", () => {
  it("a granted dispute produces SEPARATE obligations through the protocol machinery", () => {
    const scenario = buildScenario();
    const granted = openGrantedDispute(scenario);
    const before = scenario.book.all.length;

    const minted = scenario.obligations.grantRecourseObligations({
      dispute: granted,
      debtor: BOB, // the respondent compensates the claimant
      creditor: ALICE,
      amount: GRANTED_AMOUNT,
      mechanism: "EXPLICIT_CREDIT",
      adjustmentKind: "COMPENSATION",
      dueWindow: { opensAt: NOW, closesAt: NOW + 1_000_000n },
    });

    expect(minted).toHaveLength(1);
    const obligation = minted[0] as Obligation;
    expect(obligation.debtor).toBe(BOB);
    expect(obligation.creditor).toBe(ALICE);
    expect(obligation.amount.value).toBe(60_000n);
    expect(obligation.amount.currency).toBe("USD");
    expect(obligation.state).toBe("PENDING");
    // SEPARATE: own id, derived from the RECOURSE clearing record — never the
    // original transaction's clearing record.
    expect(obligation.id).not.toBe(scenario.originalObligation.id);
    expect(obligation.derivedFrom).not.toBe(scenario.originalClearingRecord.id);

    // The book grew by exactly the new obligation; the original is untouched.
    expect(scenario.book.all).toHaveLength(before + 1);
    expect(scenario.book.get(obligation.id)).toStrictEqual(obligation);

    // The linkage ledger records the derivation (queryable audit trail).
    const entries = scenario.obligations.entriesForDispute(granted.disputeId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.obligationId).toBe(obligation.id);
    expect(entries[0]?.mechanism).toBe("EXPLICIT_CREDIT");
    expect(entries[0]?.adjustmentKind).toBe("COMPENSATION");
    expect(entries[0]?.clearingRecordId).toBe(obligation.derivedFrom);
    expect(scenario.obligations.obligationsForDispute(granted.disputeId)).toEqual([
      obligation,
    ]);
  });

  it("the ORIGINAL obligation is untouched after a granted dispute (W1-006 acceptance)", () => {
    const scenario = buildScenario();
    const originalBefore = scenario.book.get(scenario.originalObligation.id) as Obligation;
    const granted = openGrantedDispute(scenario);

    scenario.obligations.grantRecourseObligations({
      dispute: granted,
      debtor: BOB,
      creditor: ALICE,
      amount: { ...GRANTED_AMOUNT, value: 30_000n },
      mechanism: "EXPLICIT_CREDIT",
      adjustmentKind: "COMPENSATION",
      dueWindow: DUE_WINDOW,
    });
    // ...and a clawback against the original as well (cumulative recourse
    // stays within the 60,000n grant):
    scenario.obligations.clawbackObligation({
      dispute: granted,
      originalObligation: originalBefore,
      amount: { ...GRANTED_AMOUNT, value: 30_000n },
      mechanism: "AUTHORIZED_PULLBACK",
      dueWindow: DUE_WINDOW,
    });

    const originalAfter = scenario.book.get(scenario.originalObligation.id) as Obligation;
    expect(originalAfter).toBe(originalBefore); // same frozen record, never replaced
    expect(originalAfter.state).toBe("PENDING");
    expect(originalAfter.amount.value).toBe(90_000n);
    expect(originalAfter.debtor).toBe(ALICE);
    expect(originalAfter.creditor).toBe(BOB);
    expect(originalAfter.dueWindow).toEqual(scenario.originalObligation.dueWindow);
    expect(originalAfter.derivedFrom).toBe(scenario.originalClearingRecord.id);
  });

  it("clawback-style adjustments follow INV-F02 append-only discipline", () => {
    const scenario = buildScenario();
    const granted = openGrantedDispute(scenario);
    const clawback = scenario.obligations.clawbackObligation({
      dispute: granted,
      originalObligation: scenario.originalObligation,
      amount: GRANTED_AMOUNT,
      mechanism: "AUTHORIZED_PULLBACK",
      dueWindow: DUE_WINDOW,
    });

    expect(clawback).toHaveLength(1);
    const adjustment = clawback[0] as Obligation;
    // The clawback REVERSES the direction: the original creditor (bob)
    // compensates the original debtor (alice).
    expect(adjustment.debtor).toBe(BOB);
    expect(adjustment.creditor).toBe(ALICE);
    // The clawback is a SEPARATE obligation with its own id; the original
    // keeps existing unchanged — both coexist (append-only, no rewrite).
    expect(adjustment.id).not.toBe(scenario.originalObligation.id);
    expect(scenario.book.get(scenario.originalObligation.id)?.state).toBe("PENDING");
    expect(scenario.book.get(adjustment.id)?.state).toBe("PENDING");

    // The linkage names the original obligation it compensates.
    const entry = scenario.obligations
      .entriesForDispute(granted.disputeId)
      .find((candidate) => candidate.obligationId === adjustment.id);
    expect(entry?.adjustmentKind).toBe("CLAWBACK");
    expect(entry?.originalObligationRef).toBe(scenario.originalObligation.id);
  });

  it("refuses recourse on non-granted disputes (adjudication precedes effects)", () => {
    const scenario = buildScenario();
    const dispute = scenario.disputes.openDispute({
      transactionRef: TRANSACTION_REF,
      claimant: ALICE,
      respondent: BOB,
      disputedAmount: DISPUTED_AMOUNT,
      reason: "not granted yet",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    expect(() =>
      scenario.obligations.grantRecourseObligations({
        dispute,
        debtor: BOB,
        creditor: ALICE,
        amount: GRANTED_AMOUNT,
        mechanism: "EXPLICIT_CREDIT",
        adjustmentKind: "COMPENSATION",
        dueWindow: DUE_WINDOW,
      }),
    ).toThrowError(DisputeNotGrantedError);

    // REJECTED disputes produce nothing either.
    scenario.disputes.applyEvent({
      disputeId: dispute.disputeId,
      event: "REJECT",
      decidedBy: "operator:adjudicator-1",
    });
    expect(() =>
      scenario.obligations.grantRecourseObligations({
        dispute: scenario.disputes.require(dispute.disputeId),
        debtor: BOB,
        creditor: ALICE,
        amount: GRANTED_AMOUNT,
        mechanism: "EXPLICIT_CREDIT",
        adjustmentKind: "COMPENSATION",
        dueWindow: DUE_WINDOW,
      }),
    ).toThrowError(DisputeNotGrantedError);
  });

  it("bounds recourse amounts by the granted amount with exact arithmetic (INV-F01)", () => {
    const scenario = buildScenario();
    const granted = openGrantedDispute(scenario);
    expect(() =>
      scenario.obligations.grantRecourseObligations({
        dispute: granted,
        debtor: BOB,
        creditor: ALICE,
        amount: { ...GRANTED_AMOUNT, value: 60_001n },
        mechanism: "EXPLICIT_CREDIT",
        adjustmentKind: "COMPENSATION",
        dueWindow: DUE_WINDOW,
      }),
    ).toThrowError(RecourseAmountExceedsGrantError);
    expect(() =>
      scenario.obligations.grantRecourseObligations({
        dispute: granted,
        debtor: BOB,
        creditor: ALICE,
        amount: { ...GRANTED_AMOUNT, value: 0n },
        mechanism: "EXPLICIT_CREDIT",
        adjustmentKind: "COMPENSATION",
        dueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/positive Money/);
    expect(() =>
      scenario.obligations.grantRecourseObligations({
        dispute: granted,
        debtor: BOB,
        creditor: BOB,
        amount: GRANTED_AMOUNT,
        mechanism: "EXPLICIT_CREDIT",
        adjustmentKind: "COMPENSATION",
        dueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/same party/);
  });

  it("the minted obligation carries dispute lineage in its activity refs", () => {
    const scenario = buildScenario();
    const granted = openGrantedDispute(scenario);
    scenario.obligations.grantRecourseObligations({
      dispute: granted,
      debtor: BOB,
      creditor: ALICE,
      amount: GRANTED_AMOUNT,
      mechanism: "GUARANTEE",
      adjustmentKind: "GUARANTEE_PAYOUT",
      dueWindow: DUE_WINDOW,
    });
    // The entries ledger is the queryable lineage: every effect names its
    // dispute and mechanism.
    for (const entry of scenario.obligations.entries()) {
      expect(entry.disputeId).toBe(granted.disputeId);
      expect(entry.createdAt).toBe(NOW);
    }
    expect(scenario.obligations.entries()).toHaveLength(1);
    // Money is exact throughout: bigint values only.
    const obligation = scenario.obligations.obligationsForDispute(granted.disputeId)[0];
    expect(typeof obligation?.amount.value).toBe("bigint");
    expect(obligation?.amount.value).toBe(60_000n);
  });

  it("an authority over an empty book starts empty and rejects malformed commands", () => {
    const scenario = buildScenario();
    const authority = new RecourseObligationAuthority({
      book: scenario.book,
      ids: scenario.ledger.ids,
      clock: scenario.clock,
    });
    expect(authority.entries()).toHaveLength(0);
    expect(authority.obligationsForDispute("dsp_none")).toEqual([]);
    expect(() =>
      authority.grantRecourseObligations({
        dispute: { state: "OPEN" } as never,
        debtor: BOB,
        creditor: ALICE,
        amount: GRANTED_AMOUNT,
        mechanism: "BOND",
        adjustmentKind: "BOND_FORFEITURE",
        dueWindow: DUE_WINDOW,
      }),
    ).toThrowError(DisputeNotGrantedError);
    expect(() =>
      authority.clawbackObligation({
        dispute: { state: "GRANTED" } as never,
        originalObligation: {
          ...scenario.originalObligation,
          id: asObligationId("OBL:missing"),
        },
        amount: GRANTED_AMOUNT,
        mechanism: "AUTHORIZED_PULLBACK",
        dueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/must exist in the protocol book/);
  });
});
