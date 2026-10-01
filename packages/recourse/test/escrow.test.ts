import { describe, expect, it } from "vitest";
import {
  USD,
  TerminalStateViolationError,
  asAccountId,
  accountTypeOf,
  projectBalances,
} from "@payswap/protocol";
import type { Money } from "@payswap/protocol";
import { InsufficientAvailableFundsError } from "@payswap/protocol";
import { EscrowDecisionIncompleteError, UnknownEscrowError } from "../src/escrow.js";
import { escrowStateMachine } from "../src/escrow.js";
import {
  ALICE,
  ALICE_ACCOUNT,
  BOB,
  BOB_ACCOUNT,
  CAROL,
  CAROL_ACCOUNT,
  DISPUTED_AMOUNT,
  NOW,
  SURETY_ACCOUNT,
  TRANSACTION_REF,
  buildScenario,
  openGrantedDispute,
  recordExtraEvidence,
} from "./fixtures.js";

const ESCROW_AMOUNT = { ...DISPUTED_AMOUNT, value: 25_000n }; // 250.00 USD

function balanceOf(scenario: ReturnType<typeof buildScenario>, account: string): bigint {
  const balances = projectBalances(scenario.journal, asAccountId(account));
  const money = balances.get(asAccountId(account)) as Money | undefined;
  return money?.value ?? 0n;
}

describe("Escrow (W1-006)", () => {
  it("opens a separately-accounted escrow hold (own reservation/account structure)", () => {
    const scenario = buildScenario();
    const aliceBefore = balanceOf(scenario, ALICE_ACCOUNT);
    const hold = scenario.escrow.openEscrow({
      transactionRef: TRANSACTION_REF,
      amount: ESCROW_AMOUNT,
      funderAccount: ALICE_ACCOUNT,
      beneficiaryAccount: BOB_ACCOUNT,
    });

    // The escrow account is a DEDICATED reserve account, never an
    // operational balance.
    expect(hold.escrowAccount).toBe(`RESERVE:escrow.${hold.escrowId}`);
    expect(accountTypeOf(hold.escrowAccount)).toBe("RESERVE");
    expect(hold.escrowAccount).not.toBe(ALICE_ACCOUNT);
    expect(hold.escrowAccount).not.toBe(BOB_ACCOUNT);

    // The funding entry moved the exact amount out of the funder's
    // operational account into the reserve account (INV-F03 balanced).
    expect(balanceOf(scenario, ALICE_ACCOUNT)).toBe(aliceBefore - 25_000n);
    expect(balanceOf(scenario, hold.escrowAccount)).toBe(25_000n);

    // The escrowed value is locked by a protocol reservation on the escrow
    // account itself — its own reservation structure.
    const reservation = scenario.reservationBook.get(hold.reservationId);
    expect(reservation?.state).toBe("ACTIVE");
    expect(reservation?.accountId).toBe(hold.escrowAccount);
    expect(reservation?.amount.value).toBe(25_000n);

    // The beneficiary's operational balance is untouched while HELD.
    expect(balanceOf(scenario, BOB_ACCOUNT)).toBe(1_000_000n);
    expect(hold.state).toBe("HELD");
    expect(Object.isFrozen(hold)).toBe(true);
  });

  it("INV-F04: escrow funding cannot exceed the funder's authorized available value", () => {
    const scenario = buildScenario();
    const journalSizeBefore = scenario.journal.size;
    const reservationsBefore = scenario.reservationBook.all.length;
    expect(() =>
      scenario.escrow.openEscrow({
        transactionRef: TRANSACTION_REF,
        amount: { ...DISPUTED_AMOUNT, value: 10_000_001n }, // exceeds 100,000.00 USD
        funderAccount: ALICE_ACCOUNT,
        beneficiaryAccount: BOB_ACCOUNT,
      }),
    ).toThrowError(InsufficientAvailableFundsError);
    // A failed open is never half-applied: nothing was posted or held.
    expect(scenario.journal.size).toBe(journalSizeBefore);
    expect(scenario.reservationBook.all.length).toBe(reservationsBefore);
    expect(scenario.escrow.all()).toHaveLength(0);
  });

  it("releases to the beneficiary via an explicit evidence-backed decision", () => {
    const scenario = buildScenario();
    const hold = scenario.escrow.openEscrow({
      transactionRef: TRANSACTION_REF,
      amount: ESCROW_AMOUNT,
      funderAccount: ALICE_ACCOUNT,
      beneficiaryAccount: BOB_ACCOUNT,
    });
    const bobBefore = balanceOf(scenario, BOB_ACCOUNT);
    const decisionEvidence = [recordExtraEvidence(scenario, "ev_escrow_release", "escrow-ops")];

    const released = scenario.escrow.releaseEscrow({
      escrowId: hold.escrowId,
      evidenceRefs: decisionEvidence,
    });

    expect(released.state).toBe("RELEASED");
    expect(released.decision?.payeeAccount).toBe(BOB_ACCOUNT);
    expect(released.decision?.evidenceRefs).toEqual(decisionEvidence);
    expect(balanceOf(scenario, BOB_ACCOUNT)).toBe(bobBefore + 25_000n);
    expect(balanceOf(scenario, released.escrowAccount)).toBe(0n);
    // The lock was consumed with the disposition.
    expect(scenario.reservationBook.get(released.reservationId)?.state).toBe("CAPTURED");
  });

  it("refuses dispositions without evidence (decisions are evidence-backed)", () => {
    const scenario = buildScenario();
    const hold = scenario.escrow.openEscrow({
      transactionRef: TRANSACTION_REF,
      amount: ESCROW_AMOUNT,
      funderAccount: ALICE_ACCOUNT,
      beneficiaryAccount: BOB_ACCOUNT,
    });
    expect(() =>
      scenario.escrow.releaseEscrow({ escrowId: hold.escrowId, evidenceRefs: [] }),
    ).toThrowError(EscrowDecisionIncompleteError);
    expect(scenario.escrow.get(hold.escrowId)?.state).toBe("HELD");
  });

  it("forfeits to a claimant only against a GRANTED dispute (adjudication first)", () => {
    const scenario = buildScenario();
    const hold = scenario.escrow.openEscrow({
      transactionRef: TRANSACTION_REF,
      amount: ESCROW_AMOUNT,
      funderAccount: ALICE_ACCOUNT,
      beneficiaryAccount: BOB_ACCOUNT,
    });
    const evidence = [recordExtraEvidence(scenario, "ev_escrow_forfeit", "escrow-ops")];

    // No dispute reference: refused.
    expect(() =>
      scenario.escrow.forfeitEscrow({
        escrowId: hold.escrowId,
        evidenceRefs: evidence,
      }),
    ).toThrowError(/dispute reference/);

    // An OPEN (not yet adjudicated) dispute: refused.
    const openDispute = scenario.disputes.openDispute({
      transactionRef: TRANSACTION_REF,
      claimant: CAROL,
      respondent: BOB,
      disputedAmount: DISPUTED_AMOUNT,
      reason: "forfeit before adjudication",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    expect(() =>
      scenario.escrow.forfeitEscrow({
        escrowId: hold.escrowId,
        evidenceRefs: evidence,
        disputeRef: openDispute.disputeId,
        claimantAccount: CAROL_ACCOUNT,
      }),
    ).toThrowError(/GRANTED dispute/);

    // A GRANTED dispute: the claimant is paid from the dedicated account.
    const granted = openGrantedDispute(scenario);
    const claimantBefore = balanceOf(scenario, ALICE_ACCOUNT);
    const forfeited = scenario.escrow.forfeitEscrow({
      escrowId: hold.escrowId,
      evidenceRefs: evidence,
      disputeRef: granted.disputeId,
      claimantAccount: ALICE_ACCOUNT,
    });
    expect(forfeited.state).toBe("FORFEITED");
    expect(forfeited.decision?.disputeRef).toBe(granted.disputeId);
    expect(balanceOf(scenario, ALICE_ACCOUNT)).toBe(claimantBefore + 25_000n);
    expect(balanceOf(scenario, forfeited.escrowAccount)).toBe(0n);
  });

  it("refunds to the funder and enforces terminal monotonicity (INV-X04)", () => {
    const scenario = buildScenario();
    const hold = scenario.escrow.openEscrow({
      transactionRef: TRANSACTION_REF,
      amount: ESCROW_AMOUNT,
      funderAccount: ALICE_ACCOUNT,
      beneficiaryAccount: BOB_ACCOUNT,
    });
    const aliceMid = balanceOf(scenario, ALICE_ACCOUNT);
    const refunded = scenario.escrow.refundEscrow({
      escrowId: hold.escrowId,
      evidenceRefs: [recordExtraEvidence(scenario, "ev_escrow_refund", "escrow-ops")],
    });
    expect(refunded.state).toBe("REFUNDED");
    expect(balanceOf(scenario, ALICE_ACCOUNT)).toBe(aliceMid + 25_000n);

    // Terminal: every further disposition is a TERMINAL_STATE violation.
    // The forfeit input carries a REAL granted dispute so the refusal comes
    // from the machine's terminality rule, not input validation.
    const grantedForTerminal = openGrantedDispute(scenario);
    for (const method of [
      () =>
        scenario.escrow.releaseEscrow({
          escrowId: hold.escrowId,
          evidenceRefs: ["ev_escrow_refund"],
        }),
      () =>
        scenario.escrow.forfeitEscrow({
          escrowId: hold.escrowId,
          evidenceRefs: ["ev_escrow_refund"],
          disputeRef: grantedForTerminal.disputeId,
          claimantAccount: ALICE_ACCOUNT,
        }),
      () =>
        scenario.escrow.refundEscrow({
          escrowId: hold.escrowId,
          evidenceRefs: ["ev_escrow_refund"],
        }),
    ] as const) {
      expect(method).toThrowError(TerminalStateViolationError);
    }
    expect(scenario.escrow.get(hold.escrowId)?.state).toBe("REFUNDED");
    expect(() => scenario.escrow.get("esc_unknown")?.state).not.toThrow();
    expect(scenario.escrow.get("esc_unknown")).toBeUndefined();
  });

  it("every journal-relevant effect is balanced and exact (INV-F01/F03)", () => {
    const scenario = buildScenario();
    const hold = scenario.escrow.openEscrow({
      transactionRef: TRANSACTION_REF,
      amount: ESCROW_AMOUNT,
      funderAccount: ALICE_ACCOUNT,
      beneficiaryAccount: BOB_ACCOUNT,
    });
    scenario.escrow.releaseEscrow({
      escrowId: hold.escrowId,
      evidenceRefs: [recordExtraEvidence(scenario, "ev_escrow_balanced", "escrow-ops")],
    });

    for (const entry of scenario.journal.entries) {
      let sum = 0n;
      for (const line of entry.lines) {
        expect(typeof line.amount.value).toBe("bigint"); // INV-F01: exact money
        sum += line.amount.value;
      }
      expect(sum).toBe(0n); // INV-F03: every entry balances
    }
    // The escrow-specific entries are identifiable and reference the hold.
    const memos = scenario.journal.entries.map((entry) => entry.memo ?? "");
    expect(memos).toContain(`ESCROW_FUND:${hold.escrowId}`);
    expect(memos).toContain(`ESCROW_RELEASE:${hold.escrowId}`);
    const fundingEntry = scenario.journal.get(hold.fundingEntryId);
    expect(fundingEntry?.source?.correlationId).toBe(hold.escrowId);
  });

  it("rejects malformed opens and policies without the ESCROW mechanism", () => {
    const scenario = buildScenario();
    expect(() =>
      scenario.escrow.openEscrow({
        transactionRef: "",
        amount: ESCROW_AMOUNT,
        funderAccount: ALICE_ACCOUNT,
        beneficiaryAccount: BOB_ACCOUNT,
      }),
    ).toThrowError(/transactionRef/);
    expect(() =>
      scenario.escrow.openEscrow({
        transactionRef: TRANSACTION_REF,
        amount: { ...ESCROW_AMOUNT, value: 0n },
        funderAccount: ALICE_ACCOUNT,
        beneficiaryAccount: BOB_ACCOUNT,
      }),
    ).toThrowError(/positive Money/);
    const nonEscrowPolicy = {
      policyId: "RCP:TX-NOESCROW",
      transactionRef: "TX-NOESCROW",
      currency: USD,
      mechanisms: ["BOND"],
      claimWindow: { opensAt: NOW, closesAt: NOW + 1n },
      evidenceRequirements: [],
      initiatedAt: NOW,
      version: 1n,
    } as const;
    expect(() =>
      scenario.escrow.openEscrow({
        transactionRef: "TX-NOESCROW",
        amount: ESCROW_AMOUNT,
        funderAccount: ALICE_ACCOUNT,
        beneficiaryAccount: BOB_ACCOUNT,
        policy: nonEscrowPolicy,
      }),
    ).toThrowError(/does not declare the ESCROW mechanism/);
    expect(() =>
      scenario.escrow.releaseEscrow({
        escrowId: "esc_missing",
        evidenceRefs: ["ev_escrow_balanced"],
      }),
    ).toThrowError(UnknownEscrowError);
    // The machine declares the terminal set explicitly.
    expect(escrowStateMachine.terminalStates).toEqual(["RELEASED", "FORFEITED", "REFUNDED"]);
  });

  it("escrow value never appears in any operational balance projection", () => {
    const scenario = buildScenario();
    const hold = scenario.escrow.openEscrow({
      transactionRef: TRANSACTION_REF,
      amount: ESCROW_AMOUNT,
      funderAccount: ALICE_ACCOUNT,
      beneficiaryAccount: BOB_ACCOUNT,
    });
    // While HELD, the exact escrowed value (+25_000n) is credited to EXACTLY
    // ONE account: the dedicated reserve account. No operational account
    // ever carries it — the value is never merged with operational balances.
    const creditLines = scenario.journal.entries
      .flatMap((entry) => [...entry.lines])
      .filter((line) => line.amount.value === 25_000n);
    expect(creditLines).toHaveLength(1);
    expect(creditLines[0]?.accountId).toBe(hold.escrowAccount);
    expect(accountTypeOf(asAccountId(creditLines[0]?.accountId as string))).toBe("RESERVE");

    // And the total value sitting in dedicated escrow reserve accounts is
    // exactly the escrowed amount (nothing leaks anywhere else).
    const allBalances = projectBalances(scenario.journal);
    let reserveTotal = 0n;
    for (const [account, money] of allBalances) {
      if (account.startsWith("RESERVE:escrow.")) {
        reserveTotal += money.value;
      }
    }
    expect(reserveTotal).toBe(25_000n);
    expect(balanceOf(scenario, hold.escrowAccount)).toBe(25_000n);
  });
});
