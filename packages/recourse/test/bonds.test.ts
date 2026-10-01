import { describe, expect, it } from "vitest";
import { TransitionGuardError, asAccountId, projectBalances } from "@payswap/protocol";
import type { Money } from "@payswap/protocol";
import {
  BondClaimWindowError,
  BondExposureExceededError,
  BondProofThresholdError,
  UnknownBondError,
  claimedTotal,
  remainingCollateral,
} from "../src/bonds.js";
import {
  ALICE,
  ALICE_ACCOUNT,
  BOB,
  CAROL,
  CAROL_ACCOUNT,
  DAY_MS,
  DISPUTED_AMOUNT,
  DUE_WINDOW,
  GRANTED_AMOUNT,
  NOW,
  SURETY,
  SURETY_ACCOUNT,
  buildScenario,
  openGrantedDispute,
  recordExtraEvidence,
} from "./fixtures.js";

const BOND_AMOUNT = { ...DISPUTED_AMOUNT, value: 50_000n }; // 500.00 USD
const EXPOSURE_CAP = { ...DISPUTED_AMOUNT, value: 40_000n }; // 400.00 USD
const BOND_WINDOW = { opensAt: NOW, closesAt: NOW + 60n * DAY_MS };

function balanceOf(scenario: ReturnType<typeof buildScenario>, account: string): bigint {
  const balances = projectBalances(scenario.journal, asAccountId(account));
  const money = balances.get(asAccountId(account)) as Money | undefined;
  return money?.value ?? 0n;
}

describe("ExecutionBond (W1-006)", () => {
  it("issues a bond with separately-accounted collateral", () => {
    const scenario = buildScenario();
    const suretyBefore = balanceOf(scenario, SURETY_ACCOUNT);
    const bond = scenario.bonds.issueBond({
      surety: SURETY,
      beneficiary: BOB,
      bondedAmount: BOND_AMOUNT,
      exposureCap: EXPOSURE_CAP,
      proofThreshold: "P2",
      disputeWindow: BOND_WINDOW,
      fundingAccount: SURETY_ACCOUNT,
    });

    // Dedicated reserve account, never an operational balance.
    expect(bond.bondAccount).toBe(`RESERVE:bond.${bond.bondId}`);
    expect(balanceOf(scenario, bond.bondAccount)).toBe(50_000n);
    expect(balanceOf(scenario, SURETY_ACCOUNT)).toBe(suretyBefore - 50_000n);

    // Locked by a protocol reservation on the dedicated account.
    const reservation = scenario.reservationBook.get(bond.reservationId);
    expect(reservation?.state).toBe("ACTIVE");
    expect(reservation?.accountId).toBe(bond.bondAccount);

    expect(bond.state).toBe("ACTIVE");
    expect(claimedTotal(bond)).toBe(0n);
    expect(remainingCollateral(bond)).toBe(50_000n);
    expect(Object.isFrozen(bond)).toBe(true);
  });

  it("rejects malformed issuances (cap, window, currency)", () => {
    const scenario = buildScenario();
    const base = {
      surety: SURETY,
      beneficiary: BOB,
      bondedAmount: BOND_AMOUNT,
      proofThreshold: "P2" as const,
      disputeWindow: BOND_WINDOW,
      fundingAccount: SURETY_ACCOUNT,
    };
    expect(() =>
      scenario.bonds.issueBond({
        ...base,
        exposureCap: { ...DISPUTED_AMOUNT, value: 50_001n },
      }),
    ).toThrowError(/cannot exceed the bonded amount/);
    expect(() =>
      scenario.bonds.issueBond({
        ...base,
        exposureCap: EXPOSURE_CAP,
        disputeWindow: { opensAt: NOW - 10n, closesAt: NOW - 1n },
      }),
    ).toThrowError(/already closed at issuance/);
    expect(() =>
      scenario.bonds.issueBond({
        ...base,
        exposureCap: { ...EXPOSURE_CAP, currency: "EUR" as never },
      }),
    ).toThrowError(/currency differs/);
  });

  it("a successful claim pays out from the dedicated account AND creates a separate recourse obligation", () => {
    const scenario = buildScenario();
    const bond = scenario.bonds.issueBond({
      surety: SURETY,
      beneficiary: BOB,
      bondedAmount: BOND_AMOUNT,
      exposureCap: EXPOSURE_CAP,
      proofThreshold: "P2",
      disputeWindow: BOND_WINDOW,
      fundingAccount: SURETY_ACCOUNT,
    });
    const granted = openGrantedDispute(scenario);
    const claimantBefore = balanceOf(scenario, CAROL_ACCOUNT);
    const evidence = [recordExtraEvidence(scenario, "ev_bond_claim", "bond-ops")];

    const claimed = scenario.bonds.claimBond({
      bondId: bond.bondId,
      disputeId: granted.disputeId,
      claimant: CAROL,
      amount: { ...DISPUTED_AMOUNT, value: 15_000n },
      evidenceRefs: evidence,
      claimantAccount: CAROL_ACCOUNT,
      obligationDueWindow: DUE_WINDOW,
    });

    // Payout moved the exact value out of the dedicated bond account.
    expect(balanceOf(scenario, CAROL_ACCOUNT)).toBe(claimantBefore + 15_000n);
    expect(balanceOf(scenario, claimed.bondAccount)).toBe(35_000n);
    expect(remainingCollateral(claimed)).toBe(35_000n);
    expect(claimedTotal(claimed)).toBe(15_000n);

    // The claim created a SEPARATE recourse obligation (surety → claimant).
    expect(claimed.claims).toHaveLength(1);
    const claim = claimed.claims[0];
    expect(claim?.disputeId).toBe(granted.disputeId);
    const obligation = scenario.book.get(claim?.recourseObligationId as never);
    expect(obligation?.debtor).toBe(SURETY);
    expect(obligation?.creditor).toBe(CAROL);
    expect(obligation?.amount.value).toBe(15_000n);
    expect(obligation?.state).toBe("PENDING");
    expect(claimed.state).toBe("ACTIVE");

    // The linkage ledger records the bond-forfeiture derivation.
    const entry = scenario.obligations
      .entriesForDispute(granted.disputeId)
      .find((candidate) => candidate.adjustmentKind === "BOND_FORFEITURE");
    expect(entry?.mechanism).toBe("BOND");
    expect(entry?.obligationId).toBe(claim?.recourseObligationId);
  });

  it("enforces forfeiture conditions: granted dispute, window, proof threshold, exposure cap", () => {
    const scenario = buildScenario();
    const bond = scenario.bonds.issueBond({
      surety: SURETY,
      beneficiary: BOB,
      bondedAmount: BOND_AMOUNT,
      exposureCap: EXPOSURE_CAP,
      proofThreshold: "P2",
      disputeWindow: BOND_WINDOW,
      fundingAccount: SURETY_ACCOUNT,
    });

    // Not-yet-granted dispute: refused.
    const openDispute = scenario.disputes.openDispute({
      transactionRef: "TX-1",
      claimant: ALICE,
      respondent: BOB,
      disputedAmount: DISPUTED_AMOUNT,
      reason: "bond before adjudication",
      evidenceRefs: scenario.originalEvidenceRefs,
    });
    expect(() =>
      scenario.bonds.claimBond({
        bondId: bond.bondId,
        disputeId: openDispute.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 15_000n },
        evidenceRefs: [recordExtraEvidence(scenario, "ev_bond_1", "bond-ops")],
        claimantAccount: CAROL_ACCOUNT,
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/GRANTED dispute/);

    const granted = openGrantedDispute(scenario);

    // Outside the dispute window: refused (advance past the window).
    scenario.clock.advanceMs(Number(60n * DAY_MS + 1n));
    expect(() =>
      scenario.bonds.claimBond({
        bondId: bond.bondId,
        disputeId: granted.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 15_000n },
        evidenceRefs: [recordExtraEvidence(scenario, "ev_bond_2", "bond-ops")],
        claimantAccount: CAROL_ACCOUNT,
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(BondClaimWindowError);
    scenario.clock.advanceMs(-Number(60n * DAY_MS + 1n)); // back inside the window

    // Weak evidence (unauthenticated artifact capped at P0 < P2): refused.
    scenario.evidence.record({
      nodeId: "ev_bond_weak",
      kind: "PROOF",
      actionRef: "bond-ops",
      claimedLevel: "P4",
      provenance: { source: "UI_BROWSER_ARTIFACT", authenticated: false },
      payload: "screenshot:claims-p4",
      links: [],
      recordedAt: scenario.clock.now(),
    });
    expect(() =>
      scenario.bonds.claimBond({
        bondId: bond.bondId,
        disputeId: granted.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 15_000n },
        evidenceRefs: ["ev_bond_weak"],
        claimantAccount: CAROL_ACCOUNT,
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(BondProofThresholdError);

    // Exposure cap: 30,000 + 15,000 > 40,000 refused; exact arithmetic.
    scenario.bonds.claimBond({
      bondId: bond.bondId,
      disputeId: granted.disputeId,
      claimant: CAROL,
      amount: { ...DISPUTED_AMOUNT, value: 30_000n },
      evidenceRefs: [recordExtraEvidence(scenario, "ev_bond_3", "bond-ops")],
      claimantAccount: CAROL_ACCOUNT,
      obligationDueWindow: DUE_WINDOW,
    });
    expect(() =>
      scenario.bonds.claimBond({
        bondId: bond.bondId,
        disputeId: granted.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 15_000n },
        evidenceRefs: [recordExtraEvidence(scenario, "ev_bond_4", "bond-ops")],
        claimantAccount: CAROL_ACCOUNT,
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(BondExposureExceededError);
  });

  it("exhausts at the exposure cap (terminal, INV-X04) and refuses later claims", () => {
    const scenario = buildScenario();
    const bond = scenario.bonds.issueBond({
      surety: SURETY,
      beneficiary: BOB,
      bondedAmount: BOND_AMOUNT,
      exposureCap: EXPOSURE_CAP,
      proofThreshold: "P2",
      disputeWindow: BOND_WINDOW,
      fundingAccount: SURETY_ACCOUNT,
    });
    const granted = openGrantedDispute(scenario);

    const exhausted = scenario.bonds.claimBond({
      bondId: bond.bondId,
      disputeId: granted.disputeId,
      claimant: CAROL,
      amount: EXPOSURE_CAP,
      evidenceRefs: [recordExtraEvidence(scenario, "ev_bond_full", "bond-ops")],
      claimantAccount: CAROL_ACCOUNT,
      obligationDueWindow: DUE_WINDOW,
    });

    expect(exhausted.state).toBe("EXHAUSTED");
    expect(exhausted.history).toHaveLength(1);
    expect(exhausted.history[0]?.on).toBe("EXHAUST");
    // Remaining collateral stays in the dedicated account (10,000n).
    expect(remainingCollateral(exhausted)).toBe(10_000n);
    expect(balanceOf(scenario, exhausted.bondAccount)).toBe(10_000n);

    // No further claims, no release from the terminal state.
    expect(() =>
      scenario.bonds.claimBond({
        bondId: bond.bondId,
        disputeId: granted.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 1n },
        evidenceRefs: ["ev_bond_full"],
        claimantAccount: CAROL_ACCOUNT,
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/while the bond is ACTIVE/);
    expect(() => scenario.bonds.releaseBond(bond.bondId)).toThrowError();
  });

  it("releases the remaining collateral to the surety only after the dispute window closed", () => {
    const scenario = buildScenario();
    const bond = scenario.bonds.issueBond({
      surety: SURETY,
      beneficiary: BOB,
      bondedAmount: BOND_AMOUNT,
      exposureCap: EXPOSURE_CAP,
      proofThreshold: "P2",
      disputeWindow: BOND_WINDOW,
      fundingAccount: SURETY_ACCOUNT,
    });
    const granted = openGrantedDispute(scenario);
    scenario.bonds.claimBond({
      bondId: bond.bondId,
      disputeId: granted.disputeId,
      claimant: CAROL,
      amount: { ...DISPUTED_AMOUNT, value: 15_000n },
      evidenceRefs: [recordExtraEvidence(scenario, "ev_bond_rel", "bond-ops")],
      claimantAccount: CAROL_ACCOUNT,
      obligationDueWindow: DUE_WINDOW,
    });

    // Before the window closes: the release guard refuses.
    expect(() => scenario.bonds.releaseBond(bond.bondId)).toThrowError(TransitionGuardError);

    // After the window closes: the remaining collateral returns to the surety.
    scenario.clock.advanceMs(Number(60n * DAY_MS + 1n));
    const suretyBefore = balanceOf(scenario, SURETY_ACCOUNT);
    const released = scenario.bonds.releaseBond(bond.bondId);
    expect(released.state).toBe("RELEASED");
    expect(released.releasedAt).toBeDefined();
    expect(balanceOf(scenario, SURETY_ACCOUNT)).toBe(suretyBefore + 35_000n);
    expect(balanceOf(scenario, released.bondAccount)).toBe(0n);
    expect(scenario.reservationBook.get(released.reservationId)?.state).toBe("CAPTURED");
    // RELEASED is terminal: repeated release is a terminal violation.
    expect(() => scenario.bonds.releaseBond(bond.bondId)).toThrowError();
  });

  it("every journal-relevant bond effect is balanced and exact (INV-F01/F03)", () => {
    const scenario = buildScenario();
    const bond = scenario.bonds.issueBond({
      surety: SURETY,
      beneficiary: BOB,
      bondedAmount: BOND_AMOUNT,
      exposureCap: EXPOSURE_CAP,
      proofThreshold: "P2",
      disputeWindow: BOND_WINDOW,
      fundingAccount: SURETY_ACCOUNT,
    });
    const granted = openGrantedDispute(scenario);
    scenario.bonds.claimBond({
      bondId: bond.bondId,
      disputeId: granted.disputeId,
      claimant: CAROL,
      amount: { ...DISPUTED_AMOUNT, value: 15_000n },
      evidenceRefs: [recordExtraEvidence(scenario, "ev_bond_bal", "bond-ops")],
      claimantAccount: CAROL_ACCOUNT,
      obligationDueWindow: DUE_WINDOW,
    });

    for (const entry of scenario.journal.entries) {
      let sum = 0n;
      for (const line of entry.lines) {
        expect(typeof line.amount.value).toBe("bigint");
        sum += line.amount.value;
      }
      expect(sum).toBe(0n);
    }
    // The bond collateral credit exists exactly once, in the reserve account.
    const collateralLines = scenario.journal.entries
      .flatMap((entry) => [...entry.lines])
      .filter((line) => line.amount.value === 50_000n);
    expect(collateralLines).toHaveLength(1);
    expect(collateralLines[0]?.accountId).toBe(bond.bondAccount);

    expect(() => scenario.bonds.get("bnd_missing")?.state).not.toThrow();
    expect(scenario.bonds.get("bnd_missing")).toBeUndefined();
    expect(() => scenario.bonds.claimBond({
      bondId: "bnd_missing",
      disputeId: granted.disputeId,
      claimant: CAROL,
      amount: { ...DISPUTED_AMOUNT, value: 1n },
      evidenceRefs: ["ev_bond_bal"],
      claimantAccount: CAROL_ACCOUNT,
      obligationDueWindow: DUE_WINDOW,
    })).toThrowError(UnknownBondError);
    expect(() => scenario.bonds.releaseBond("bnd_missing")).toThrowError(UnknownBondError);
  });

  it("bond claims are bounded by the granted amount of their dispute", () => {
    const scenario = buildScenario();
    const bond = scenario.bonds.issueBond({
      surety: SURETY,
      beneficiary: BOB,
      bondedAmount: { ...DISPUTED_AMOUNT, value: 200_000n },
      exposureCap: { ...DISPUTED_AMOUNT, value: 200_000n },
      proofThreshold: "P2",
      disputeWindow: BOND_WINDOW,
      fundingAccount: SURETY_ACCOUNT,
    });
    const granted = openGrantedDispute(scenario); // granted 60,000n
    // A claim larger than the granted amount cannot mint its obligation.
    expect(() =>
      scenario.bonds.claimBond({
        bondId: bond.bondId,
        disputeId: granted.disputeId,
        claimant: CAROL,
        amount: { ...DISPUTED_AMOUNT, value: 60_001n },
        evidenceRefs: [recordExtraEvidence(scenario, "ev_bond_bound", "bond-ops")],
        claimantAccount: CAROL_ACCOUNT,
        obligationDueWindow: DUE_WINDOW,
      }),
    ).toThrowError(/exceed the granted amount/);
    // Nothing was paid out or recorded by the refused claim.
    expect(balanceOf(scenario, bond.bondAccount)).toBe(200_000n);
    expect(scenario.bonds.get(bond.bondId)?.claims).toHaveLength(0);
    // GRANTED_AMOUNT (60,000n) itself is claimable.
    const claimed = scenario.bonds.claimBond({
      bondId: bond.bondId,
      disputeId: granted.disputeId,
      claimant: CAROL,
      amount: GRANTED_AMOUNT,
      evidenceRefs: [recordExtraEvidence(scenario, "ev_bond_bound2", "bond-ops")],
      claimantAccount: CAROL_ACCOUNT,
      obligationDueWindow: DUE_WINDOW,
    });
    expect(claimed.claims).toHaveLength(1);
  });
});
