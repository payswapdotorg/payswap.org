import { describe, expect, it } from "vitest";
import { ExternalAmbiguityError, isFailureOutcome, ValidationError } from "@payswap/protocol";
import { ExecutionAttemptLedger, asExecutionAttemptId } from "../src/attempts.js";
import type { ExecutionAttemptId } from "../src/attempts.js";
import {
  ReconciliationAuthority,
  classifyProviderOutcome,
  retryRequiresReconciliation,
} from "../src/reconciliation.js";
import { makeCapability, makeEnvelope, NOW, PRINCIPAL } from "./fixtures.js";

const CAPABILITY = makeCapability();

function ledgerWithUnknownAttempt(): {
  ledger: ExecutionAttemptLedger;
  attemptId: ExecutionAttemptId;
} {
  const ledger = new ExecutionAttemptLedger();
  const outcome = ledger.begin({
    attemptId: asExecutionAttemptId("att_amb"),
    planId: "plan_1",
    stepId: "step_1",
    executionMode: "COMPOSED_PAYSWAP",
    capabilityInstanceId: "inst-mm-1",
    capabilityId: CAPABILITY.capabilityId,
    retryPolicy: "SAFE_TO_RETRY",
    cancellation: "UNTIL_SETTLEMENT",
    compensation: CAPABILITY.compensation,
    idempotencyKey: "idem-amb",
    principal: PRINCIPAL,
    now: NOW,
  });
  if (outcome.kind !== "BEGIN") {
    throw new Error("fixture setup failed");
  }
  ledger.advance(outcome.attempt.attemptId, "START", { now: NOW + 1n });
  ledger.advance(outcome.attempt.attemptId, "EXTERNAL_OUTCOME_UNKNOWN", {
    now: NOW + 2n,
    evidence: [
      {
        evidenceId: "ev_amb",
        kind: "EXECUTION",
        evidenceRef: "provider-op:amb",
        providerState: makeEnvelope({
          failure: { retryable: false, ambiguity: "OUTCOME_UNKNOWN", providerErrorCode: "timeout" },
        }),
        recordedAt: NOW + 2n,
      },
    ],
  });
  return { ledger, attemptId: outcome.attempt.attemptId };
}

describe("Reconciliation (W3-003)", () => {
  it("INV-X01: UNKNOWN is never mapped to FAILED", () => {
    const ambiguous = makeEnvelope({
      failure: { retryable: false, ambiguity: "OUTCOME_UNKNOWN", providerErrorCode: "timeout" },
    });
    const classification = classifyProviderOutcome(ambiguous);
    expect(classification.outcome).toBe("OUTCOME_UNKNOWN");
    if (classification.outcome === "OUTCOME_UNKNOWN") {
      expect(classification.requiresReconciliation).toBe(true);
    }
    // Even a RETRYABLE failure with UNKNOWN ambiguity stays UNKNOWN.
    const retryableAmbiguous = makeEnvelope({
      failure: { retryable: true, ambiguity: "OUTCOME_UNKNOWN" },
    });
    expect(classifyProviderOutcome(retryableAmbiguous).outcome).toBe("OUTCOME_UNKNOWN");
    // A definitive provider failure (ambiguity NONE) IS a failure.
    const definitive = makeEnvelope({
      failure: { retryable: true, ambiguity: "NONE", providerErrorCode: "card_declined" },
    });
    expect(classifyProviderOutcome(definitive)).toEqual({ outcome: "FAILED", retryable: true });
    // The protocol kernel agrees: ambiguity is not a failure outcome.
    expect(isFailureOutcome(new ExternalAmbiguityError("outcome unknown"))).toBe(false);
  });

  it("classifies customer-action, terminal and async provider states without flattening (INV-C06)", () => {
    expect(
      classifyProviderOutcome(
        makeEnvelope({
          family: "customer_action_required",
          requiresCustomerAction: true,
          actionRequired: { kind: "3ds", message: "challenge" },
        }),
      ).outcome,
    ).toBe("AWAITING_CUSTOMER_ACTION");
    expect(classifyProviderOutcome(makeEnvelope({ isTerminal: true })).outcome).toBe("SUCCEEDED");
    expect(classifyProviderOutcome(makeEnvelope()).outcome).toBe("ASYNC_PROCESSING");
    expect(() => classifyProviderOutcome(null as never)).toThrow(ValidationError);
  });

  it("INV-X03: reconciliation is the authority for ambiguous external effects", () => {
    const { ledger, attemptId } = ledgerWithUnknownAttempt();
    const reconciliation = new ReconciliationAuthority(ledger);

    // A case can be opened for the ambiguous attempt...
    const open = reconciliation.openCase({
      caseId: "case_1",
      attemptId,
      reason: "EXTERNAL_AMBIGUITY",
      now: NOW + 3n,
    });
    expect(open.status).toBe("OPEN");

    // ...and ONLY a resolution with evidence moves it to a definitive outcome.
    const resolution = reconciliation.resolveCase({
      caseId: "case_1",
      outcome: "CONFIRMED_SUCCEEDED",
      resolvedBy: PRINCIPAL,
      evidence: [
        {
          evidenceId: "ev_resolved",
          kind: "RECONCILIATION",
          evidenceRef: "provider-report:1",
          providerState: makeEnvelope({ isTerminal: true }),
          recordedAt: NOW + 4n,
        },
      ],
      now: NOW + 4n,
    });
    expect(resolution.outcome).toBe("CONFIRMED_SUCCEEDED");
    expect(ledger.attempt(attemptId)!.state).toBe("SUCCEEDED");
    // Resolutions are immutable: re-resolving is rejected (INV-E05).
    expect(() =>
      reconciliation.resolveCase({
        caseId: "case_1",
        outcome: "CONFIRMED_FAILED",
        resolvedBy: PRINCIPAL,
        evidence: [],
        now: NOW + 5n,
      }),
    ).toThrow(/already RESOLVED/);
  });

  it("INV-X03: a resolution without evidence is rejected", () => {
    const { ledger, attemptId } = ledgerWithUnknownAttempt();
    const reconciliation = new ReconciliationAuthority(ledger);
    reconciliation.openCase({
      caseId: "case_2",
      attemptId,
      reason: "EXTERNAL_AMBIGUITY",
      now: NOW + 3n,
    });
    expect(() =>
      reconciliation.resolveCase({
        caseId: "case_2",
        outcome: "CONFIRMED_FAILED",
        resolvedBy: PRINCIPAL,
        evidence: [],
        now: NOW + 4n,
      }),
    ).toThrow(/requires provider evidence/);
  });

  it("INV-X02: retryRequiresReconciliation holds for UNKNOWN writes", () => {
    const { ledger, attemptId } = ledgerWithUnknownAttempt();
    const attempt = ledger.attempt(attemptId)!;
    expect(attempt.state).toBe("OUTCOME_UNKNOWN");
    expect(retryRequiresReconciliation(attempt)).toBe(true);

    const reconciled = new ReconciliationAuthority(ledger);
    reconciled.openCase({
      caseId: "case_3",
      attemptId,
      reason: "PROVIDER_OUTAGE_UNKNOWN_EFFECT",
      now: NOW + 3n,
    });
    reconciled.resolveCase({
      caseId: "case_3",
      outcome: "CONFIRMED_FAILED",
      resolvedBy: PRINCIPAL,
      evidence: [
        {
          evidenceId: "ev_failed",
          kind: "RECONCILIATION",
          evidenceRef: "provider-report:failed",
          providerState: makeEnvelope({
            failure: { retryable: false, ambiguity: "NONE", providerErrorCode: "declined" },
          }),
          recordedAt: NOW + 4n,
        },
      ],
      now: NOW + 4n,
    });
    // After reconciliation the ambiguity is resolved — retry policy applies again.
    const resolved = ledger.attempt(attemptId)!;
    expect(resolved.state).toBe("FAILED");
    expect(retryRequiresReconciliation(resolved)).toBe(false); // SAFE_TO_RETRY capability
  });

  it("cases exist only for ambiguous attempts — never for resolved or in-flight ones", () => {
    const ledger = new ExecutionAttemptLedger();
    const outcome = ledger.begin({
      attemptId: asExecutionAttemptId("att_ok"),
      planId: "plan_1",
      stepId: "step_1",
      executionMode: "COMPOSED_PAYSWAP",
      capabilityInstanceId: "inst-mm-1",
      capabilityId: CAPABILITY.capabilityId,
      retryPolicy: "SAFE_TO_RETRY",
      cancellation: "UNTIL_SETTLEMENT",
      compensation: CAPABILITY.compensation,
      idempotencyKey: "idem-ok",
      principal: PRINCIPAL,
      now: NOW,
    });
    const reconciliation = new ReconciliationAuthority(ledger);
    expect(() =>
      reconciliation.openCase({
        caseId: "case_bad",
        attemptId: outcome.attempt.attemptId,
        reason: "EXTERNAL_AMBIGUITY",
        now: NOW + 1n,
      }),
    ).toThrow(/not OUTCOME_UNKNOWN/);
  });

  it("refunds, disputes and recurring mandates reuse the SAME canonical execution/reconciliation machinery", () => {
    // A refund-capability attempt whose provider outcome is ambiguous goes
    // through the identical attempt lifecycle + reconciliation authority —
    // there is no parallel refund/dispute/mandate state model (the provider
    // lifecycle semantics stay preserved in the envelope families).
    const ledger = new ExecutionAttemptLedger();
    const refundAttempt = ledger.begin({
      attemptId: "att_refund",
      planId: "plan_refund_1",
      stepId: "step_refund",
      executionMode: "COMPOSED_PAYSWAP",
      capabilityInstanceId: "inst-psp-refund",
      capabilityId: "cap.psp.refund",
      retryPolicy: "REQUIRES_RECONCILIATION",
      cancellation: "NOT_SUPPORTED",
      compensation: CAPABILITY.compensation,
      idempotencyKey: "idem-refund",
      principal: PRINCIPAL,
      now: NOW,
    }).attempt;
    ledger.advance(refundAttempt.attemptId, "START", { now: NOW + 1n });
    const ambiguous = ledger.advance(refundAttempt.attemptId, "EXTERNAL_OUTCOME_UNKNOWN", {
      now: NOW + 2n,
      evidence: [
        {
          evidenceId: "ev_refund_amb",
          kind: "EXECUTION",
          evidenceRef: "provider-op:refund-amb",
          providerState: makeEnvelope({
            family: "refund",
            lifecycleStep: "pending_unknown",
            failure: { retryable: false, ambiguity: "OUTCOME_UNKNOWN", providerErrorCode: "timeout" },
          }),
          recordedAt: NOW + 2n,
        },
      ],
    });
    expect(ambiguous.state).toBe("OUTCOME_UNKNOWN");
    // The refund family lifecycle semantics are preserved, not flattened.
    expect(ambiguous.providerState?.classification.family).toBe("refund");

    const reconciliation = new ReconciliationAuthority(ledger);
    reconciliation.openCase({
      caseId: "case_refund",
      attemptId: refundAttempt.attemptId,
      reason: "EXTERNAL_AMBIGUITY",
      now: NOW + 3n,
    });
    reconciliation.resolveCase({
      caseId: "case_refund",
      outcome: "CONFIRMED_FAILED",
      resolvedBy: PRINCIPAL,
      evidence: [
        {
          evidenceId: "ev_refund_resolved",
          kind: "RECONCILIATION",
          evidenceRef: "provider-report:refund-failed",
          providerState: makeEnvelope({
            family: "refund",
            lifecycleStep: "failed",
            failure: { retryable: false, ambiguity: "NONE", providerErrorCode: "expired" },
          }),
          recordedAt: NOW + 4n,
        },
      ],
      now: NOW + 4n,
    });
    const resolved = ledger.attempt(refundAttempt.attemptId)!;
    expect(resolved.state).toBe("FAILED");
    // REQUIRES_RECONCILIATION discipline: even after resolution this
    // failure cannot be blindly retried (INV-X02).
    expect(() => ledger.requestRetry(refundAttempt.attemptId, "att_refund_retry", NOW + 5n)).toThrow(
      /must be reconciled, not retried/,
    );
  });
});
