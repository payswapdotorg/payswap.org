import { describe, expect, it } from "vitest";
import { ValidationError, currencyCode, fromMinorUnits } from "@payswap/protocol";
import { ConnectorAuthorityError } from "@payswap/connectors";
import type { UnknownOutcomeResolution } from "@payswap/settlement";
import {
  asRefundId,
  initiateRefund,
  observeExternalConversionRefundSupport,
  observeNativeStripeRefundSupport,
  observeRefundOutcome,
  refundStateMachine,
  refundStatusView,
  resolveRefundUnknown,
  submitRefund,
} from "../src/index.js";
import { runFullJourney } from "./journey-helpers.js";
import {
  CART_AMOUNT,
  CUSTOMER_WALLET,
  LATER,
  STRIPE_CATALOGUE_ENTRY,
  stripeConnectedInstance,
} from "./fixtures.js";

/** P4-W2-003 §3.7 — refunds (typed rail observations + honest NOT_SUPPORTED). */

const RECONCILER = { principalType: "user", principalId: "reconciler-1" } as const;

function confirmedAttemptFixture() {
  return runFullJourney().attempt;
}

function nativeRefundSupportFixture() {
  return observeNativeStripeRefundSupport({
    observationId: "rail-obs-1",
    connectedInstance: stripeConnectedInstance(),
    evidenceRefs: ["evidence:rail-observation-1"],
    observedAt: LATER,
  });
}

describe("refund rail observations — scoped to the ACTUAL rail (rule 18)", () => {
  it("observes native Stripe refund support bound to the connected instance", () => {
    const observation = nativeRefundSupportFixture();
    expect(observation.routeFamily).toBe("NATIVE_STRIPE_CRYPTO");
    expect(observation.supportsRefunds).toBe(true);
    expect(observation.partialRefunds).toBe(true);
    expect(observation.refundMedium).toBe("STABLECOIN_TO_ORIGINAL_WALLET");
    expect(observation.chargebackPathAvailable).toBe(false);
  });

  it("an INACTIVE or ineligible instance is an honest NOT_SUPPORTED observation", () => {
    const observation = observeNativeStripeRefundSupport({
      observationId: "rail-obs-inactive",
      connectedInstance: stripeConnectedInstance({ status: "REVOKED" }),
      evidenceRefs: ["evidence:rail-observation-2"],
      observedAt: LATER,
    });
    expect(observation.supportsRefunds).toBe(false);
    expect(observation.refundMedium).toBeUndefined();
  });

  it("a provider CATALOGUE entry can never ground a refund observation (INV-C05)", () => {
    expect(() =>
      observeNativeStripeRefundSupport({
        observationId: "rail-obs-cat",
        connectedInstance: STRIPE_CATALOGUE_ENTRY as never,
        evidenceRefs: ["evidence:x"],
        observedAt: LATER,
      }),
    ).toThrow(ConnectorAuthorityError);
  });

  it("an observation without evidence is rejected (observations are evidence-backed)", () => {
    expect(() =>
      observeNativeStripeRefundSupport({
        observationId: "rail-obs-bare",
        connectedInstance: stripeConnectedInstance(),
        evidenceRefs: [],
        observedAt: LATER,
      }),
    ).toThrow(ValidationError);
  });

  it("external-conversion refund support is declared, evidence-backed and typed", () => {
    const observation = observeExternalConversionRefundSupport({
      observationId: "rail-obs-ext",
      conversionChain: ["cap:fixture-conversion-1"],
      supportsRefunds: false,
      partialRefunds: false,
      evidenceRefs: ["evidence:rail-observation-ext"],
      observedAt: LATER,
    });
    expect(observation.routeFamily).toBe("EXTERNAL_PAYSWAP_CONVERSION");
    expect(observation.supportsRefunds).toBe(false);
  });
});

describe("refund initiation — only where the rail supports it", () => {
  it("starts a refund on a supporting rail (partial, to the original wallet)", () => {
    const initiation = initiateRefund({
      refundId: "refund-1",
      attempt: confirmedAttemptFixture(),
      originalAmount: CART_AMOUNT,
      amount: fromMinorUnits(currencyCode("USD"), 4_950n),
      railSupport: nativeRefundSupportFixture(),
      destinationRef: CUSTOMER_WALLET,
      recourse: "MERCHANT_DISPUTE_WINDOW",
      now: LATER,
    });
    if (initiation.outcome !== "REFUND_STARTED") {
      throw new Error("the supporting rail must start the refund");
    }
    expect(initiation.refund.state).toBe("PENDING");
    expect(initiation.refund.refundMedium).toBe("STABLECOIN_TO_ORIGINAL_WALLET");
    expect(initiation.refund.originalAttemptId).toBe("attempt-1");
    expect(initiation.refund.recourse).toBe("MERCHANT_DISPUTE_WINDOW");
  });

  it("answers a non-supporting rail with the TYPED NOT_SUPPORTED outcome", () => {
    const nonSupporting = observeExternalConversionRefundSupport({
      observationId: "rail-obs-ext",
      conversionChain: ["cap:fixture-conversion-1"],
      supportsRefunds: false,
      partialRefunds: false,
      evidenceRefs: ["evidence:rail-observation-ext"],
      observedAt: LATER,
    });
    const initiation = initiateRefund({
      refundId: "refund-x",
      attempt: confirmedAttemptFixture(),
      originalAmount: CART_AMOUNT,
      amount: CART_AMOUNT,
      railSupport: nonSupporting,
      destinationRef: CUSTOMER_WALLET,
      recourse: "NONE",
      now: LATER,
    });
    expect(initiation.outcome).toBe("NOT_SUPPORTED");
    if (initiation.outcome === "NOT_SUPPORTED") {
      expect(initiation.routeFamily).toBe("EXTERNAL_PAYSWAP_CONVERSION");
      expect(initiation.reason).toContain("does not support refunds");
      // Never an implied future support:
      expect(initiation.reason).not.toContain("soon");
      expect(initiation.reason).not.toContain("later");
    }
  });

  it("refuses to refund a non-CONFIRMED attempt (fail-closed)", () => {
    const journey = runFullJourney();
    const notConfirmed = { ...journey.attempt, attempt: { ...journey.attempt.attempt, state: "SUBMITTED" as const } };
    expect(() =>
      initiateRefund({
        refundId: "refund-x",
        attempt: notConfirmed,
        originalAmount: CART_AMOUNT,
        amount: CART_AMOUNT,
        railSupport: nativeRefundSupportFixture(),
        destinationRef: CUSTOMER_WALLET,
        recourse: "NONE",
        now: LATER,
      }),
    ).toThrow(ValidationError);
  });

  it("refuses an over-refund and a currency mismatch (exact money laws)", () => {
    const attempt = confirmedAttemptFixture();
    expect(() =>
      initiateRefund({
        refundId: "refund-over",
        attempt,
        originalAmount: CART_AMOUNT,
        amount: fromMinorUnits(currencyCode("USD"), 9_901n),
        railSupport: nativeRefundSupportFixture(),
        destinationRef: CUSTOMER_WALLET,
        recourse: "NONE",
        now: LATER,
      }),
    ).toThrow(ValidationError);
  });

  it("the original payment record is never mutated by a refund", () => {
    const attempt = confirmedAttemptFixture();
    const before = attempt.attempt.state;
    const initiation = initiateRefund({
      refundId: "refund-1",
      attempt,
      originalAmount: CART_AMOUNT,
      amount: CART_AMOUNT,
      railSupport: nativeRefundSupportFixture(),
      destinationRef: CUSTOMER_WALLET,
      recourse: "NONE",
      now: LATER,
    });
    expect(initiation.outcome).toBe("REFUND_STARTED");
    expect(attempt.attempt.state).toBe(before);
    expect(Object.isFrozen(attempt.attempt)).toBe(true);
  });

  it("validates refund ids", () => {
    expect(() => asRefundId("")).toThrow(ValidationError);
  });
});

describe("refund lifecycle — mirrors the payment laws", () => {
  it("declares the machine with UNKNOWN non-terminal and reconciliation exits only", () => {
    expect(refundStateMachine.states).toEqual([
      "PENDING",
      "SUBMITTED",
      "CONFIRMED",
      "FAILED",
      "OUTCOME_UNKNOWN",
    ]);
    expect(refundStateMachine.terminalStates).toEqual(["CONFIRMED", "FAILED"]);
  });

  function pendingRefundFixture() {
    const initiation = initiateRefund({
      refundId: "refund-1",
      attempt: confirmedAttemptFixture(),
      originalAmount: CART_AMOUNT,
      amount: fromMinorUnits(currencyCode("USD"), 4_950n),
      railSupport: nativeRefundSupportFixture(),
      destinationRef: CUSTOMER_WALLET,
      recourse: "MERCHANT_DISPUTE_WINDOW",
      now: LATER,
    });
    if (initiation.outcome !== "REFUND_STARTED") {
      throw new Error("fixture requires a supporting rail");
    }
    return initiation.refund;
  }

  it("submits and confirms with evidence", () => {
    const submitted = submitRefund(pendingRefundFixture(), {
      submissionRef: "refund-sub-1",
      now: LATER,
    });
    expect(submitted.state).toBe("SUBMITTED");
    const confirmed = observeRefundOutcome(submitted, {
      kind: "SUCCEEDED",
      evidenceIds: ["evidence:refund-confirmation-1"],
    }, LATER);
    expect(confirmed.state).toBe("CONFIRMED");
    expect(refundStatusView(confirmed).outcome).toBe("SUCCEEDED");
  });

  it("UNKNOWN is preserved and exits only through reconciliation (INV-X01/X03)", () => {
    const submitted = submitRefund(pendingRefundFixture(), {
      submissionRef: "refund-sub-1",
      now: LATER,
    });
    const unknown = observeRefundOutcome(submitted, {
      kind: "OUTCOME_UNKNOWN",
      evidenceIds: ["evidence:refund-ambiguity-1"],
    }, LATER);
    expect(unknown.state).toBe("OUTCOME_UNKNOWN");
    // A definitive observation from OUTCOME_UNKNOWN is not declared:
    expect(() =>
      observeRefundOutcome(unknown, { kind: "FAILED", evidenceIds: ["e:x"] }, LATER),
    ).toThrow();
    const resolution: UnknownOutcomeResolution = {
      resolvedOutcome: "CONFIRMED_SUCCEEDED",
      resolvedBy: RECONCILER,
      caseId: "case-refund-1",
      evidenceIds: ["evidence:refund-resolution-1"],
    };
    const resolved = resolveRefundUnknown(unknown, resolution, LATER);
    expect(resolved.state).toBe("CONFIRMED");
    expect(resolved.evidenceIds).toContain("evidence:refund-resolution-1");
  });

  it("definitive outcomes REQUIRE evidence (INV-E02)", () => {
    const submitted = submitRefund(pendingRefundFixture(), {
      submissionRef: "refund-sub-1",
      now: LATER,
    });
    expect(() =>
      observeRefundOutcome(submitted, { kind: "SUCCEEDED", evidenceIds: [] }, LATER),
    ).toThrow(ValidationError);
  });

  it("a resolution without evidence is rejected (INV-X03)", () => {
    const submitted = submitRefund(pendingRefundFixture(), {
      submissionRef: "refund-sub-1",
      now: LATER,
    });
    const unknown = observeRefundOutcome(submitted, {
      kind: "OUTCOME_UNKNOWN",
      evidenceIds: ["evidence:refund-ambiguity-1"],
    }, LATER);
    expect(() =>
      resolveRefundUnknown(
        unknown,
        {
          resolvedOutcome: "CONFIRMED_FAILED",
          resolvedBy: RECONCILER,
          caseId: "case-refund-1",
          evidenceIds: [],
        },
        LATER,
      ),
    ).toThrow(ValidationError);
  });
});
