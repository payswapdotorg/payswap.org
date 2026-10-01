import { describe, expect, it } from "vitest";
import { USD, ExternalAmbiguityError, ValidationError, fromMinorUnits, isFailureOutcome } from "@payswap/protocol";
import { isPaySwapExecutedSettlement, recordOffNetworkPayment } from "@payswap/payment";
import type { ExternalFundsPositionObservation } from "@payswap/connectors";
import { SettlementAttemptLedger, asSettlementAttemptId } from "../src/instructions.js";
import {
  ProviderRevisionConflictError,
  ProviderRevisionLedger,
  SettlementReconciliationAuthority,
  isExternalFundsObservationCandidate,
  reconcileExternalFundsObservation,
  reconcileMandateRenewal,
  reconcileOffNetworkRecord,
  settlementOutcomeFromProviderState,
} from "../src/reconciliation.js";
import { NOW, PRINCIPAL, makeEnvelope, makeExternalFundsObservation, makeMandates, makeSettlementInstruction } from "./fixtures.js";

function ledgerWithUnknownAttempt(): { ledger: SettlementAttemptLedger; attemptId: string } {
  const ledger = new SettlementAttemptLedger();
  const instruction = makeSettlementInstruction();
  const outcome = ledger.begin({
    attemptId: "att_amb",
    instructionId: instruction.id,
    rail: "INSTANT_PAYMENT_RAIL",
    idempotencyKey: "idem-amb",
    principal: PRINCIPAL,
    now: NOW,
  });
  if (outcome.kind !== "BEGIN") throw new Error("fixture setup failed");
  ledger.start("att_amb", NOW + 1n);
  ledger.recordExternalOutcome("att_amb", "OUTCOME_UNKNOWN", ["ev_amb"], NOW + 2n);
  return { ledger, attemptId: "att_amb" };
}

describe("Settlement reconciliation (W1-004)", () => {
  it("INV-X01: UNKNOWN is never mapped to FAILED (classifier + kernel agreement)", () => {
    const ambiguous = makeEnvelope({
      failure: { retryable: false, ambiguity: "OUTCOME_UNKNOWN", providerErrorCode: "timeout" },
    });
    const classification = settlementOutcomeFromProviderState(ambiguous);
    expect(classification.recordable).toBe(true);
    if (classification.recordable) {
      expect(classification.outcome).toBe("OUTCOME_UNKNOWN");
      expect(classification.outcome).not.toBe("FAILED");
    }
    // Even a RETRYABLE failure with UNKNOWN ambiguity stays UNKNOWN.
    const retryableAmbiguous = makeEnvelope({
      failure: { retryable: true, ambiguity: "OUTCOME_UNKNOWN" },
    });
    expect(settlementOutcomeFromProviderState(retryableAmbiguous)).toEqual({
      recordable: true,
      outcome: "OUTCOME_UNKNOWN",
    });
    // A definitive provider failure (ambiguity NONE) IS a failure.
    const definitive = makeEnvelope({
      failure: { retryable: true, ambiguity: "NONE", providerErrorCode: "card_declined" },
    });
    expect(settlementOutcomeFromProviderState(definitive)).toEqual({
      recordable: true,
      outcome: "FAILED",
    });
    // Terminal provider state is success.
    expect(settlementOutcomeFromProviderState(makeEnvelope({ isTerminal: true }))).toEqual({
      recordable: true,
      outcome: "SUCCEEDED",
    });
    // Customer action / async states are NOT recordable outcomes.
    expect(settlementOutcomeFromProviderState(
      makeEnvelope({
        family: "customer_action_required",
        requiresCustomerAction: true,
        actionRequired: { kind: "3ds", message: "challenge" },
      }),
    )).toEqual({ recordable: false, reason: "AWAITING_CUSTOMER_ACTION" });
    expect(settlementOutcomeFromProviderState(makeEnvelope())).toEqual({
      recordable: false,
      reason: "ASYNC_PROCESSING",
    });
    // The protocol kernel agrees: ambiguity is not a failure outcome.
    expect(isFailureOutcome(new ExternalAmbiguityError("outcome unknown"))).toBe(false);
  });

  it("INV-X03: reconciliation is the ONLY definitive resolver of ambiguity", () => {
    const { ledger, attemptId } = ledgerWithUnknownAttempt();
    const reconciliation = new SettlementReconciliationAuthority(ledger);

    // A case opens for the ambiguous attempt...
    const open = reconciliation.openCase({
      caseId: "case_1",
      subject: { kind: "SETTLEMENT_ATTEMPT", attemptId: asSettlementAttemptId("att_amb") },
      reason: "EXTERNAL_AMBIGUITY",
      now: NOW + 3n,
    });
    expect(open.status).toBe("OPEN");
    // The case inherited the attempt's instruction reference (finality gate).
    expect(open.instructionRef).toBe(ledger.attempt(attemptId)?.instructionId);

    // ...and ONLY a resolution with evidence moves it to a definitive outcome.
    const resolution = reconciliation.resolveCase({
      caseId: "case_1",
      outcome: "CONFIRMED_SUCCEEDED",
      resolvedBy: PRINCIPAL,
      evidenceIds: ["ev_resolved"],
      now: NOW + 4n,
    });
    expect(resolution.outcome).toBe("CONFIRMED_SUCCEEDED");
    expect(ledger.attempt(attemptId)?.state).toBe("SUCCEEDED");
    expect(ledger.attempt(attemptId)?.resolution?.caseId).toBe("case_1");
    expect(ledger.attempt(attemptId)?.evidenceIds).toContain("ev_resolved");

    // Resolutions are immutable: re-resolving is rejected (INV-E05).
    expect(() =>
      reconciliation.resolveCase({
        caseId: "case_1",
        outcome: "CONFIRMED_FAILED",
        resolvedBy: PRINCIPAL,
        evidenceIds: [],
        now: NOW + 5n,
      }),
    ).toThrow(/already RESOLVED/);
  });

  it("INV-X03: a resolution without evidence is rejected", () => {
    const { ledger } = ledgerWithUnknownAttempt();
    const reconciliation = new SettlementReconciliationAuthority(ledger);
    reconciliation.openCase({
      caseId: "case_2",
      subject: { kind: "SETTLEMENT_ATTEMPT", attemptId: asSettlementAttemptId("att_amb") },
      reason: "EXTERNAL_AMBIGUITY",
      now: NOW + 3n,
    });
    expect(() =>
      reconciliation.resolveCase({
        caseId: "case_2",
        outcome: "CONFIRMED_FAILED",
        resolvedBy: PRINCIPAL,
        evidenceIds: [],
        now: NOW + 4n,
      }),
    ).toThrow(/requires evidence/);
    // The ambiguity is NOT resolved by the failed attempt to resolve.
    expect(ledger.attempt("att_amb")?.state).toBe("OUTCOME_UNKNOWN");
  });

  it("INV-X03: cases only open for genuinely ambiguous attempts; one OPEN case per attempt", () => {
    const ledger = new SettlementAttemptLedger();
    const instruction = makeSettlementInstruction();
    const outcome = ledger.begin({
      attemptId: "att_clean",
      instructionId: instruction.id,
      rail: "INSTANT_PAYMENT_RAIL",
      idempotencyKey: "idem-clean",
      principal: PRINCIPAL,
      now: NOW,
    });
    if (outcome.kind !== "BEGIN") throw new Error("fixture setup failed");
    ledger.start("att_clean", NOW + 1n);
    ledger.recordExternalOutcome("att_clean", "SUCCEEDED", ["ev_ok"], NOW + 2n);
    const reconciliation = new SettlementReconciliationAuthority(ledger);
    expect(() =>
      reconciliation.openCase({
        caseId: "case_bad",
        subject: { kind: "SETTLEMENT_ATTEMPT", attemptId: asSettlementAttemptId("att_clean") },
        reason: "EXTERNAL_AMBIGUITY",
        now: NOW + 3n,
      }),
    ).toThrow(/not OUTCOME_UNKNOWN \(INV-X03\)/);

    const { ledger: ambLedger } = ledgerWithUnknownAttempt();
    const ambReconciliation = new SettlementReconciliationAuthority(ambLedger);
    ambReconciliation.openCase({
      caseId: "case_dup",
      subject: { kind: "SETTLEMENT_ATTEMPT", attemptId: asSettlementAttemptId("att_amb") },
      reason: "EXTERNAL_AMBIGUITY",
      now: NOW + 3n,
    });
    expect(() =>
      ambReconciliation.openCase({
        caseId: "case_dup2",
        subject: { kind: "SETTLEMENT_ATTEMPT", attemptId: asSettlementAttemptId("att_amb") },
        reason: "EXTERNAL_AMBIGUITY",
        now: NOW + 4n,
      }),
    ).toThrow(/already has OPEN case/);
  });

  it("INV-C06: provider revisions are reconciled append-only, never overwritten", () => {
    const ledger = new ProviderRevisionLedger();
    const rev1 = makeEnvelope({ revision: "rev_1", state: { providerNativeStatus: "processing" } });
    const rev2 = makeEnvelope({ revision: "rev_2", state: { providerNativeStatus: "succeeded" }, isTerminal: true });

    ledger.append(rev1, NOW);
    ledger.append(rev2, NOW + 1n);
    const history = ledger.history("test-psp", "payment", "pay_ext_1");
    expect(history.length).toBe(2);
    expect(history[0]?.revision).toBe("rev_1");
    expect(history[1]?.revision).toBe("rev_2");
    expect(ledger.latest("test-psp", "payment", "pay_ext_1")?.revision).toBe("rev_2");

    // Identical re-observation of rev_1 is an idempotent replay.
    ledger.append(rev1, NOW + 2n);
    expect(ledger.history("test-psp", "payment", "pay_ext_1").length).toBe(2);

    // A DIVERGENT re-record of the same revision is an overwrite attempt — rejected.
    const divergent = makeEnvelope({
      revision: "rev_1",
      state: { providerNativeStatus: "tampered" },
    });
    expect(() => ledger.append(divergent, NOW + 3n)).toThrow(ProviderRevisionConflictError);

    // Canonical history is unchanged after the rejected overwrite attempt.
    const historyAfter = ledger.history("test-psp", "payment", "pay_ext_1");
    expect(historyAfter.length).toBe(2);
    expect(JSON.stringify(historyAfter[0]?.envelope.state)).toBe(
      JSON.stringify({ providerNativeStatus: "processing" }),
    );
    expect(JSON.stringify(historyAfter[1]?.envelope.state)).toBe(
      JSON.stringify({ providerNativeStatus: "succeeded" }),
    );
  });

  it("INV-C09: external funds observations reconcile with freshness + provenance, never as custody", () => {
    // Fresh, provenance-complete observation matching the expectation.
    const fresh = makeExternalFundsObservation() as unknown as ExternalFundsPositionObservation;
    const matched = reconcileExternalFundsObservation({
      observation: fresh,
      expectedMinorUnits: "90000",
      referenceTime: "2026-01-01T00:00:30.000Z",
    });
    expect(matched.outcome).toBe("MATCHED");
    expect(matched.fresh).toBe(true);
    expect(matched.provenanceVerified).toBe(true);
    // The result is structurally NOT a custody booking (INV-C09).
    expect(matched.custodyBooking).toBe("NONE");
    expect("amount" in matched).toBe(false);
    expect("balance" in matched).toBe(false);

    // Stale observation: unusable, never a false balance.
    const stale = makeExternalFundsObservation() as unknown as ExternalFundsPositionObservation;
    const staleResult = reconcileExternalFundsObservation({
      observation: stale,
      expectedMinorUnits: "90000",
      referenceTime: "2026-01-01T00:05:00.000Z",
    });
    expect(staleResult.outcome).toBe("STALE_NOT_USABLE");
    expect(staleResult.fresh).toBe(false);

    // Amount mismatch on a fresh observation is a DISCREPANCY, never a booking.
    const differing = makeExternalFundsObservation({ minorUnits: "80000" }) as unknown as ExternalFundsPositionObservation;
    expect(
      reconcileExternalFundsObservation({
        observation: differing,
        expectedMinorUnits: "90000",
        referenceTime: "2026-01-01T00:00:30.000Z",
      }).outcome,
    ).toBe("DISCREPANCY");

    // Provenance mismatch is reported, not silently accepted.
    const foreign = makeExternalFundsObservation({ provenanceProvider: "other-psp" }) as unknown as ExternalFundsPositionObservation;
    const foreignResult = reconcileExternalFundsObservation({
      observation: foreign,
      expectedMinorUnits: "90000",
      referenceTime: "2026-01-01T00:00:30.000Z",
      expectedProviderName: "test-psp",
    });
    expect(foreignResult.provenanceVerified).toBe(false);

    // An observation without provenance fails canonical validation (INV-C09).
    const noProvenance = makeExternalFundsObservation({ omitProvenance: true });
    expect(() =>
      reconcileExternalFundsObservation({
        observation: noProvenance as unknown as ExternalFundsPositionObservation,
        expectedMinorUnits: "90000",
        referenceTime: "2026-01-01T00:00:30.000Z",
      }),
    ).toThrow(ValidationError);

    // The structural guard identifies observations but never balances.
    expect(isExternalFundsObservationCandidate(makeExternalFundsObservation())).toBe(true);
  });

  it("recurring mandate renewal reconciliation: authority never silently expands (renewal)", () => {
    const { previous, renewed } = makeMandates();
    const authorized = reconcileMandateRenewal({ renewed, previous });
    expect(authorized.outcome).toBe("RENEWAL_AUTHORIZED");
    expect(authorized.reasons).toEqual([]);

    // A renewal that RAISES the per-charge maximum is an authority expansion.
    const expanded = { ...renewed, maxAmountPerCharge: { currency: "USD", value: 20_000n } };
    const expansion = reconcileMandateRenewal({ renewed: expanded, previous });
    expect(expansion.outcome).toBe("AUTHORITY_EXPANSION");
    expect(expansion.reasons).toContain("CHARGE_MAXIMUM_RAISED");

    // A renewal that overlaps the previous validity and ends later extends
    // the total authority window — reported, never absorbed.
    const extended = { ...renewed, validFrom: NOW, expiresAt: renewed.expiresAt + 1n };
    expect(reconcileMandateRenewal({ renewed: extended, previous }).reasons).toContain(
      "VALIDITY_EXTENDED",
    );

    // Broadened scope is reported.
    const broadened = { ...renewed, scope: "subscription:premium" };
    expect(reconcileMandateRenewal({ renewed: broadened, previous }).reasons).toContain(
      "SCOPE_BROADENED",
    );
  });

  it("off-network record reconciliation: matched/discrepant, never PaySwap execution", () => {
    const record = recordOffNetworkPayment({
      id: "OFF-1",
      source: "CHECK",
      reporter: "merchant_staff_1",
      amount: fromMinorUnits(USD, 90_000n),
      externalRef: "check-1234",
      evidence: [{ kind: "check_image", reference: "img-1", recordedAt: NOW }],
      reconciliationState: "UNRECONCILED",
      businessDocumentRefs: [{ documentKind: "INVOICE", documentId: "doc-100" }],
      recordedAt: NOW,
    });

    // The payment plane guard first: an off-network record is NEVER a
    // PaySwap-executed settlement.
    expect(isPaySwapExecutedSettlement(record)).toBe(false);

    const matched = reconcileOffNetworkRecord({
      record,
      expected: { currency: "USD", minorUnits: "90000", externalRef: "check-1234" },
    });
    expect(matched.outcome).toBe("MATCHED");
    expect(matched.payswapExecuted).toBe(false);
    expect(matched.orchestratedBy).toBe("EXTERNAL_PARTY");

    const discrepant = reconcileOffNetworkRecord({
      record,
      expected: { currency: "USD", minorUnits: "80000", externalRef: "check-9999" },
    });
    expect(discrepant.outcome).toBe("DISCREPANCY");
    expect(discrepant.reasons).toContain("AMOUNT_MISMATCH");
    expect(discrepant.reasons).toContain("EXTERNAL_REF_MISMATCH");
  });

  it("payment-plane subjects open and resolve like settlement attempts (refund/dispute symmetry cases)", () => {
    const ledger = new SettlementAttemptLedger();
    const reconciliation = new SettlementReconciliationAuthority(ledger);

    const refundCase = reconciliation.openCase({
      caseId: "case_refund",
      subject: { kind: "REFUND_DISPUTE_SYMMETRY", originalRef: "SI:NS-1:a>b", adjustmentRef: "OBL-REFUND-1" },
      reason: "REFUND_DISPUTE_AMBIGUITY",
      now: NOW,
    });
    expect(refundCase.status).toBe("OPEN");
    const resolution = reconciliation.resolveCase({
      caseId: "case_refund",
      outcome: "MATCHED",
      resolvedBy: PRINCIPAL,
      evidenceIds: ["ev_refund_1"],
      now: NOW + 1n,
    });
    expect(resolution.outcome).toBe("MATCHED");
    expect(reconciliation.case("case_refund")?.status).toBe("RESOLVED");

    // Off-network and mandate-renewal subjects behave identically.
    const offNetwork = reconciliation.openCase({
      caseId: "case_off",
      subject: { kind: "OFF_NETWORK_RECORD", recordId: "OFF-1" },
      reason: "OFF_NETWORK_RECORD_AMBIGUITY",
      now: NOW,
    });
    expect(offNetwork.status).toBe("OPEN");
    reconciliation.resolveCase({
      caseId: "case_off",
      outcome: "DISCREPANCY_RECORDED",
      resolvedBy: PRINCIPAL,
      evidenceIds: ["ev_off_1"],
      now: NOW + 1n,
    });
    expect(reconciliation.case("case_off")?.status).toBe("RESOLVED");
  });
});
