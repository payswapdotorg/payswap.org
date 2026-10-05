import { describe, expect, it } from "vitest";
import { contentDigest } from "@payswap/onchain-security";
import { buildJourneyEvidenceFile, verifyJourneyEvidenceFile } from "../src/index.js";
import { runFullJourney } from "./journey-helpers.js";
import { LATER } from "./fixtures.js";

/**
 * P4-W2-003 §3.10 — the end-to-end happy path through the REAL composed
 * kernels (merchant onboarding → acceptance → checkout → wallet
 * authorization → lifecycle → webhooks → refund → settlement), plus the
 * determinism law: same fixtures → same records → same digests.
 */

describe("the full merchant crypto checkout journey", () => {
  it("walks every stage to a terminal, evidence-bearing state", () => {
    const journey = runFullJourney();
    // Onboarding: ACTIVE with a settlement destination + verification lineage.
    expect(journey.profile.state).toBe("ACTIVE");
    expect(journey.profile.verificationRef).toBe("verify-record-1");
    expect(journey.profile.settlementDestination?.id).toBe("dest-bank-1");
    // Acceptance: ACTIVE, composed policy.
    expect(journey.activation.state).toBe("ACTIVE");
    expect(journey.activation.policy.id).toBe("mcap-1");
    // Checkout: OPEN session over a REQUIRES_PAYMENT_METHOD intent with options.
    expect(journey.flow.session.state).toBe("OPEN");
    expect(journey.flow.intent.state).toBe("REQUIRES_PAYMENT_METHOD");
    expect(journey.flow.options.length).toBeGreaterThanOrEqual(2);
    // Wallet authorization: the kernel reached BROADCAST_HANDOFF (its only
    // exit toward execution) with a full evidence log.
    expect(journey.pipeline.state).toBe("BROADCAST_HANDOFF");
    expect(journey.pipeline.evidence().length).toBeGreaterThanOrEqual(7);
    expect(journey.lineage.evidenceRefs.length).toBeGreaterThan(0);
    // Lifecycle: the attempt CONFIRMED, the intent SUCCEEDED.
    expect(journey.attempt.attempt.state).toBe("CONFIRMED");
    expect(journey.intent.state).toBe("SUCCEEDED");
    expect(journey.attempt.attempt.evidenceIds.length).toBeGreaterThan(0);
    // Webhooks: two applied events, one replayed duplicate.
    expect(journey.inbox.appliedEventIds).toEqual(["evt-1", "evt-2"]);
    expect(journey.inbox.duplicates).toEqual(["evt-1"]);
    // Refund: CONFIRMED partial refund to the original wallet.
    expect(journey.refund.state).toBe("CONFIRMED");
    expect(journey.refund.refundMedium).toBe("STABLECOIN_TO_ORIGINAL_WALLET");
    // Settlement: the native Stripe path with a provider-verified confirmation.
    expect(journey.settlement.routeFamily).toBe("NATIVE_STRIPE_CRYPTO");
    expect(journey.settlement.settlementMode).toBe("NATIVE_STRIPE_CRYPTO");
    if (journey.settlement.routeFamily === "NATIVE_STRIPE_CRYPTO") {
      expect(journey.settlement.confirmation.confirmedByProvider).toBe(true);
      expect(journey.settlement.confirmation.evidenceIds.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic: the same fixtures produce identical records and digests", () => {
    const first = runFullJourney();
    const second = runFullJourney();
    // Deterministic content digests over each stage's canonical projection.
    const digestOf = (value: unknown) => contentDigest(value);
    expect(digestOf(first.intent)).toBe(digestOf(second.intent));
    expect(digestOf(first.attempt.attempt)).toBe(digestOf(second.attempt.attempt));
    expect(digestOf(first.settlement)).toBe(digestOf(second.settlement));
    expect(digestOf(first.refund)).toBe(digestOf(second.refund));
    expect(first.bundle.request.requestHash).toBe(second.bundle.request.requestHash);
    expect(first.lineage.paymentSummaryDigest).toBe(second.lineage.paymentSummaryDigest);
    expect(first.inbox).toEqual(second.inbox);
  });

  it("the payment summary the customer saw is bound into the authorization lineage", () => {
    const journey = runFullJourney();
    expect(journey.lineage.paymentSummaryDigest).toBe(journey.bundle.summaryDigest);
    expect(journey.lineage.authorizationRequestHash).toBe(journey.bundle.request.requestHash);
    expect(journey.lineage.writeDigest).toBe(journey.pipeline.prepared.writeDigest);
  });

  it("builds a digest-stable journey evidence file covering all eight stages", () => {
    const journey = runFullJourney();
    const file = buildJourneyEvidenceFile({
      journeyId: "journey:merchant-checkout:fixture-1",
      profile: journey.profile,
      activation: journey.activation,
      flow: journey.flow,
      authorization: journey.lineage,
      pipelineEvidence: journey.pipeline.evidence(),
      attempt: journey.attempt,
      inbox: journey.inbox,
      refund: journey.refund,
      settlement: journey.settlement,
    });
    expect(file.lawMarker).toBe("FIXTURE_PROVEN_TRUSTED_SURFACE_SIGNING_ONLY");
    expect(file.stages.map((stage) => stage.stage)).toEqual([
      "MERCHANT_ONBOARDING",
      "ACCEPTANCE_ACTIVATION",
      "CHECKOUT_SESSION",
      "WALLET_AUTHORIZATION",
      "PAYMENT_LIFECYCLE",
      "WEBHOOK_UPDATES",
      "REFUND",
      "SETTLEMENT",
    ]);
    expect(verifyJourneyEvidenceFile(file)).toBe(true);
    // The wallet-authorization stage carries the kernel's evidence log.
    const authStage = file.stages.find((stage) => stage.stage === "WALLET_AUTHORIZATION");
    expect(authStage?.pipelineEvidence?.length).toBeGreaterThanOrEqual(7);
    // Determinism: rebuilding produces identical digests.
    const again = buildJourneyEvidenceFile({
      journeyId: "journey:merchant-checkout:fixture-1",
      profile: journey.profile,
      activation: journey.activation,
      flow: journey.flow,
      authorization: journey.lineage,
      pipelineEvidence: journey.pipeline.evidence(),
      attempt: journey.attempt,
      inbox: journey.inbox,
      refund: journey.refund,
      settlement: journey.settlement,
    });
    expect(again.stages.map((stage) => stage.digest)).toEqual(
      file.stages.map((stage) => stage.digest),
    );
  });

  it("the evidence stages record lineage and evidence refs at every stage (INV-E01/E02)", () => {
    const journey = runFullJourney();
    const file = buildJourneyEvidenceFile({
      journeyId: "journey:merchant-checkout:fixture-1",
      profile: journey.profile,
      activation: journey.activation,
      flow: journey.flow,
      authorization: journey.lineage,
      pipelineEvidence: journey.pipeline.evidence(),
      attempt: journey.attempt,
      inbox: journey.inbox,
      refund: journey.refund,
      settlement: journey.settlement,
    });
    for (const stage of file.stages) {
      expect(stage.refs.length).toBeGreaterThan(0);
      expect(stage.evidenceRefs.length).toBeGreaterThan(0);
    }
    void LATER;
  });
});
