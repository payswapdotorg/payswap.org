import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import type { UnknownOutcomeResolution } from "@payswap/settlement";
import {
  abandonCheckoutAttempt,
  attachAttemptSettlementRoute,
  attachMethodToIntent,
  attemptStatusView,
  confirmIntentSubmission,
  observeAttemptOutcome,
  recordAmbiguityEvidence,
  resolveAttemptUnknown,
  resolveIntentUnknown,
  settleIntentOutcome,
  submitWalletPaymentAttempt,
} from "../src/index.js";
import type { CheckoutPaymentAttempt } from "../src/index.js";
import { defineExternalConversionSettlementRoute } from "@payswap/merchant-crypto";
import { runFullJourney } from "./journey-helpers.js";
import {
  LATER,
  settlementDestination,
  fixtureQuote,
} from "./fixtures.js";
import { asRailCapabilityRef } from "@payswap/payment";

/** P4-W2-003 §3.5 — payment lifecycle over the canonical machines. */

const RECONCILER = { principalType: "user", principalId: "reconciler-1" } as const;


function submittedAttemptFixture(): { attempt: CheckoutPaymentAttempt; intent: ReturnType<typeof runFullJourney>["intent"] } {
  const journey = runFullJourney();
  // A fresh PROCESSING intent + SUBMITTED attempt over the journey's
  // authorization lineage (the journey's own records are already terminal).
  let intent = attachMethodToIntent(journey.flow.intent, LATER);
  intent = confirmIntentSubmission(intent, LATER);
  const attempt = submitWalletPaymentAttempt({
    attemptId: "attempt-fresh",
    intent,
    quote: fixtureQuote(),
    authorization: journey.lineage,
    now: LATER,
  });
  return { attempt, intent };
}

describe("payment lifecycle — authorization lineage is structurally mandatory", () => {
  it("submits an attempt bound to the wallet authorization lineage", () => {
    const { attempt } = submittedAttemptFixture();
    expect(attempt.attempt.state).toBe("SUBMITTED");
    expect(attempt.attempt.externalTxRef).toBe("tx:fixture-external-1");
    expect(attempt.authorization.authorizationRequestHash).toBe(
      journeyHashOf(),
    );
  });

  it("refuses an attempt without an explicit authorization lineage (unrepresentable)", () => {
    const journey = runFullJourney();
    expect(() =>
      submitWalletPaymentAttempt({
        attemptId: "attempt-bare",
        intent: journey.intent,
        quote: fixtureQuote(),
        authorization: undefined as unknown as never,
        now: LATER,
      }),
    ).toThrow(ValidationError);
  });

  it("refuses a lineage whose chain differs from the quote's chain", () => {
    const journey = runFullJourney();
    expect(() =>
      submitWalletPaymentAttempt({
        attemptId: "attempt-chain",
        intent: journey.intent,
        quote: fixtureQuote(),
        authorization: { ...journey.lineage, chainRef: "solana:mainnet-beta" },
        now: LATER,
      }),
    ).toThrow(ValidationError);
  });
});

function journeyHashOf(): string {
  return runFullJourney().lineage.authorizationRequestHash;
}

describe("payment lifecycle — intent machine over the landed transitions", () => {
  it("attaches the method, confirms the submission and settles the outcome", () => {
    const journey = runFullJourney();
    expect(journey.intent.state).toBe("SUCCEEDED");
  });

  it("refuses settling the intent before a definitive/ambiguous attempt outcome", () => {
    const { attempt, intent } = submittedAttemptFixture();
    expect(() =>
      settleIntentOutcome(intent, attempt, { evidenceIds: ["e:1"], now: LATER }),
    ).toThrow(ValidationError);
  });
});

describe("payment lifecycle — UNKNOWN preservation and reconciliation", () => {
  it("an UNKNOWN observation lands in OUTCOME_UNKNOWN, never FAILED", () => {
    const { attempt } = submittedAttemptFixture();
    const unknown = observeAttemptOutcome(attempt, {
      kind: "OUTCOME_UNKNOWN",
      evidenceIds: ["evidence:ambiguity-1"],
    }, LATER);
    expect(unknown.attempt.state).toBe("OUTCOME_UNKNOWN");
    expect(attemptStatusView(unknown).outcome).toBe("OUTCOME_UNKNOWN");
  });

  it("a re-observe of an ambiguous attempt appends evidence without a state change", () => {
    const { attempt } = submittedAttemptFixture();
    const unknown = observeAttemptOutcome(attempt, {
      kind: "OUTCOME_UNKNOWN",
      evidenceIds: ["evidence:ambiguity-1"],
    }, LATER);
    const reobserved = recordAmbiguityEvidence(unknown, ["evidence:ambiguity-2"], LATER);
    expect(reobserved.attempt.state).toBe("OUTCOME_UNKNOWN");
    expect(reobserved.attempt.evidenceIds).toContain("evidence:ambiguity-2");
    expect(reobserved.attempt.evidenceIds).toContain("evidence:ambiguity-1");
    // The earlier record is untouched (history preserved).
    expect(unknown.attempt.evidenceIds).not.toContain("evidence:ambiguity-2");
  });

  it("ambiguity evidence is only recordable on an OUTCOME_UNKNOWN attempt", () => {
    const { attempt } = submittedAttemptFixture();
    expect(() =>
      recordAmbiguityEvidence(attempt, ["evidence:x"], LATER),
    ).toThrow(ValidationError);
  });

  it("UNKNOWN exits ONLY through a reconciliation resolution (INV-X03)", () => {
    const { attempt, intent } = submittedAttemptFixture();
    const unknown = observeAttemptOutcome(attempt, {
      kind: "OUTCOME_UNKNOWN",
      evidenceIds: ["evidence:ambiguity-1"],
    }, LATER);
    const intentUnknown = settleIntentOutcome(intent, unknown, {
      evidenceIds: ["evidence:ambiguity-1"],
      now: LATER,
    });
    expect(intentUnknown.state).toBe("OUTCOME_UNKNOWN");
    const resolution: UnknownOutcomeResolution = {
      resolvedOutcome: "CONFIRMED_SUCCEEDED",
      resolvedBy: RECONCILER,
      caseId: "case-1",
      evidenceIds: ["evidence:resolution-1"],
    };
    const resolved = resolveAttemptUnknown(unknown, resolution, LATER);
    expect(resolved.attempt.state).toBe("CONFIRMED");
    const intentResolved = resolveIntentUnknown(intentUnknown, resolved, resolution, LATER);
    expect(intentResolved.state).toBe("SUCCEEDED");
  });

  it("an intent resolution inconsistent with the attempt outcome is rejected", () => {
    const { attempt, intent } = submittedAttemptFixture();
    const unknown = observeAttemptOutcome(attempt, {
      kind: "OUTCOME_UNKNOWN",
      evidenceIds: ["evidence:ambiguity-1"],
    }, LATER);
    const intentUnknown = settleIntentOutcome(intent, unknown, {
      evidenceIds: ["evidence:ambiguity-1"],
      now: LATER,
    });
    const succeededResolution: UnknownOutcomeResolution = {
      resolvedOutcome: "CONFIRMED_SUCCEEDED",
      resolvedBy: RECONCILER,
      caseId: "case-1",
      evidenceIds: ["evidence:resolution-1"],
    };
    const resolvedAsSuccess = resolveAttemptUnknown(unknown, succeededResolution, LATER);
    const failedResolution: UnknownOutcomeResolution = {
      resolvedOutcome: "CONFIRMED_FAILED",
      resolvedBy: RECONCILER,
      caseId: "case-1",
      evidenceIds: ["evidence:resolution-1"],
    };
    expect(() =>
      resolveIntentUnknown(intentUnknown, resolvedAsSuccess, failedResolution, LATER),
    ).toThrow(ValidationError);
  });

  it("a second observation after a definitive outcome is rejected (terminal monotonicity)", () => {
    const { attempt } = submittedAttemptFixture();
    const confirmed = observeAttemptOutcome(attempt, {
      kind: "SUCCEEDED",
      evidenceIds: ["evidence:confirmation-1"],
    }, LATER);
    expect(() =>
      observeAttemptOutcome(confirmed, { kind: "FAILED", evidenceIds: ["e:x"] }, LATER),
    ).toThrow(/terminal states are monotonic/);
  });

  it("definitive outcomes REQUIRE evidence (INV-E02, landed law)", () => {
    const { attempt } = submittedAttemptFixture();
    expect(() =>
      observeAttemptOutcome(attempt, { kind: "SUCCEEDED", evidenceIds: [] }, LATER),
    ).toThrow(ValidationError);
  });
});

describe("payment lifecycle — blind-retry is structurally forbidden", () => {
  it("there is no resubmit path: the landed machine declares SUBMIT only from PENDING", () => {
    const { attempt } = submittedAttemptFixture();
    // An already-SUBMITTED attempt cannot be submitted again through the
    // landed machine (no such transition exists) — and this package exposes
    // no resubmit function at all. The attempt record itself is immutable:
    const frozen = Object.isFrozen(attempt.attempt);
    expect(frozen).toBe(true);
    expect(() =>
      observeAttemptOutcome(attempt, { kind: "OUTCOME_UNKNOWN", evidenceIds: ["e:1"] }, LATER),
    ).not.toThrow();
    // The original record was never mutated (records are frozen):
    expect(attempt.attempt.state).toBe("SUBMITTED");
  });

  it("abandoning works only before submission (SUBMITTED cannot be abandoned)", () => {
    const journey = runFullJourney();
    const submitted = submitWalletPaymentAttempt({
      attemptId: "attempt-submitted",
      intent: journey.intent,
      quote: fixtureQuote(),
      authorization: journey.lineage,
      now: LATER,
    });
    expect(() => abandonCheckoutAttempt(submitted, LATER)).toThrow();
  });
});

describe("payment lifecycle — settlement/translation attachments", () => {
  it("attaches the settlement route, translation and protocol settlement mapping", () => {
    const journey = runFullJourney();
    // journey.attempt is CONFIRMED with settlement already attached:
    expect(journey.settledAttempt.attempt.settlementInstructionId).toBe("SI:fixture-1");
    expect(journey.settledAttempt.attempt.settlementAttemptIds).toEqual(["SA:fixture-1"]);
    // A route can be attached to a SUBMITTED attempt too:
    const { attempt } = submittedAttemptFixture();
    const externalRoute = defineExternalConversionSettlementRoute({
      destination: settlementDestination(),
      conversionChain: [asRailCapabilityRef("cap:fixture-conversion-1")],
    });
    const withRoute = attachAttemptSettlementRoute(attempt, externalRoute, LATER);
    expect(withRoute.attempt.settlementRoute?.routeFamily).toBe("EXTERNAL_PAYSWAP_CONVERSION");
  });
});
