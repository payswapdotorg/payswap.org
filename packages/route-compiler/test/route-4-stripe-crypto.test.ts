/**
 * Route 4 — eligible crypto → native Stripe crypto settlement (Work Order
 * P4-W4-001 representative route 4; the provider-verified-effects law).
 *
 * Proves BOTH Stripe settlement modes with their explicit distinction:
 * - Mode A compiles ONLY on provider-verified eligibility evidence, carries
 *   the honest awaitingAuthority: "P4-W1-003" marker (the actual Stripe
 *   integration waits on the wave-1 research artifacts), and is a
 *   provider-native baseline (INV-C08);
 * - Mode B is the explicit external PaySwap route, carrying the mandated
 *   "Stripe balance settlement unavailable for this route" notice — never
 *   faked equivalence with the native semantics;
 * - NO synthetic Stripe balance effect can exist: settlement effects arrive
 *   only as provider-verified StripeSettlementObservations, and eligibility
 *   evidence without provider verification is structurally unrepresentable.
 */

import { describe, expect, it } from "vitest";
import {
  compileBase,
  route4Intent,
  stripeEligibilityEvidence,
  NOW,
  NOW_ISO,
  STRIPE_ACCOUNT_REF,
  ONCHAIN_FINALITY_MODES,
} from "./fixtures.js";
import { walkRoutePlan } from "../src/index.js";
import type { StripeCryptoSettlementLeg } from "../src/index.js";
import {
  validateStripeCryptoSettlementEligibility,
  validateStripeSettlementObservation,
  STRIPE_CRYPTO_SETTLEMENT_AUTHORITY,
  STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE,
  stripeEligibilityEvidenceIsFresh,
} from "../src/index.js";

describe("route 4: eligible crypto→native Stripe crypto settlement (Mode A)", () => {
  it("compiles the native settlement leg ONLY on provider-verified eligibility evidence", () => {
    const result = compileBase(route4Intent());
    const native = result.plans.find(
      (plan) => plan.shapeId === "stripe-native-crypto-settlement",
    );
    expect(native).toBeDefined();
    expect(native!.candidateStatus).toBe("PROVIDER_NATIVE_BASELINE");
    expect(native!.executionMode).toBe("PASS_THROUGH_NATIVE");
    expect(native!.legs).toHaveLength(1);
    const leg = native!.legs[0]! as StripeCryptoSettlementLeg;
    expect(leg.legKind).toBe("STRIPE_CRYPTO_SETTLEMENT");
    expect(leg.mode).toBe("NATIVE_STRIPE_CRYPTO_SETTLEMENT");
    expect(leg.awaitingAuthority).toBe("P4-W1-003");
    expect(leg.authorizationLineage.legAuthorization.kind).toBe(
      "PROVIDER_VERIFIED_STRIPE_ELIGIBILITY",
    );
    expect(
      leg.authorizationLineage.legAuthorization.kind === "PROVIDER_VERIFIED_STRIPE_ELIGIBILITY"
        ? leg.authorizationLineage.legAuthorization.evidenceId
        : undefined,
    ).toBe("stripe-eligibility:001");
    // Custody is explicit: wallet → Stripe merchant balance via Stripe.
    expect(leg.custody.from.kind).toBe("ONCHAIN_WALLET");
    expect(leg.custody.to.kind).toBe("STRIPE_MERCHANT_BALANCE");
    expect(leg.custody.via?.kind).toBe("EXTERNAL_PROVIDER");
  });

  it("excludes Mode A honestly when the eligibility evidence is stale (observation law)", () => {
    const result = compileBase(route4Intent(), {
      stripeEligibilityEvidence: [
        stripeEligibilityEvidence({ asOf: "2026-10-02T00:00:00Z" }),
      ],
    });
    expect(result.plans.map((plan) => plan.shapeId)).not.toContain(
      "stripe-native-crypto-settlement",
    );
    const exclusion = result.exclusions.find(
      (e) => e.shapeId === "stripe-native-crypto-settlement",
    );
    expect(exclusion).toBeDefined();
    expect(exclusion!.reasons[0]).toContain("no fresh provider-verified Stripe crypto settlement eligibility evidence");
    expect(exclusion!.reasons[0]).toContain("P4-W1-003");
  });

  it("excludes Mode A honestly when the evidence covers a different account or currency", () => {
    const wrongAccount = compileBase(route4Intent(), {
      stripeEligibilityEvidence: [
        stripeEligibilityEvidence(),
      ],
    });
    // Baseline sanity: the correct evidence compiles.
    expect(
      wrongAccount.plans.some((plan) => plan.shapeId === "stripe-native-crypto-settlement"),
    ).toBe(true);

    const wrongCurrency = compileBase(route4Intent(), {
      stripeEligibilityEvidence: [stripeEligibilityEvidence({ currency: "EUR" })],
    });
    expect(
      wrongCurrency.plans.some((plan) => plan.shapeId === "stripe-native-crypto-settlement"),
    ).toBe(false);
    expect(
      wrongCurrency.exclusions.some((e) => e.shapeId === "stripe-native-crypto-settlement"),
    ).toBe(true);
  });

  it("Mode A walks to a provider-verified settlement observation (never a synthetic balance effect)", () => {
    const result = compileBase(route4Intent());
    const native = result.plans.find(
      (plan) => plan.shapeId === "stripe-native-crypto-settlement",
    )!;
    const walkResult = walkRoutePlan({
      plan: native,
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    expect(walkResult.status).toBe("ROUTE_COMPLETED_ALL_LEGS_OBSERVED");
    const execution = walkResult.legExecutions[0]!;
    expect(execution.stripeObservation?.verificationStatus).toBe("SUCCESS");
    expect(execution.stripeObservation?.verificationRef).toContain("stripe-verification");
    expect(walkResult.custodyAtStop?.party.kind).toBe("STRIPE_MERCHANT_BALANCE");
  });
});

describe("route 4: the external PaySwap route (Mode B)", () => {
  it("carries the mandated unavailability notice — never faked native semantics", () => {
    const result = compileBase(route4Intent());
    const external = result.plans.find(
      (plan) => plan.shapeId === "stripe-external-payswap-route",
    );
    expect(external).toBeDefined();
    expect(external!.candidateStatus).toBe("EXECUTABLE_CANDIDATE");
    // Mode B composes the DEX venue + the off-ramp provider: multi-provider.
    expect(external!.executionMode).toBe("OPTIMIZED_MULTI_PROVIDER");
    expect(external!.stripeNativeSettlementUnavailable?.notice).toBe(
      STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE,
    );
    expect(external!.stripeNativeSettlementUnavailable?.awaitingAuthority).toBe("P4-W1-003");
    expect(external!.stripeNativeSettlementUnavailable?.reason).toContain("never a synthetic Stripe balance effect");
    // Mode B is the off-ramp journey shape with the notice attached.
    expect(external!.legs.map((leg) => leg.legKind)).toEqual([
      "ONCHAIN_DEX_SWAP",
      "ONCHAIN_TRANSFER",
      "OFF_RAMP_PAYOUT",
      "BANK_SETTLEMENT",
    ]);
  });

  it("Mode B still compiles (and says why Mode A did not) when eligibility evidence is absent", () => {
    const result = compileBase(route4Intent(), { stripeEligibilityEvidence: [] });
    const external = result.plans.find(
      (plan) => plan.shapeId === "stripe-external-payswap-route",
    );
    expect(external).toBeDefined();
    expect(external!.candidateStatus).toBe("EXECUTABLE_CANDIDATE");
    expect(external!.stripeNativeSettlementUnavailable).toBeDefined();
  });
});

describe("the provider-verified-effects law (structural)", () => {
  it("rejects eligibility evidence without provider verification (fail closed)", () => {
    expect(() =>
      validateStripeCryptoSettlementEligibility({
        evidenceId: "stripe-eligibility:bad",
        stripeAccountRef: STRIPE_ACCOUNT_REF,
        currency: "USD",
        eligible: true,
        providerVerified: false,
        verificationRef: "stripe-verify:bad",
        observedAt: NOW_ISO,
        freshness: { asOf: NOW_ISO, maxAgeSeconds: 3600 },
        awaitingAuthority: "P4-W1-003",
      }),
    ).toThrow(/provider-verified/i);
  });

  it("rejects ineligible evidence (ineligibility is an exclusion, never evidence)", () => {
    expect(() =>
      validateStripeCryptoSettlementEligibility({
        evidenceId: "stripe-eligibility:ineligible",
        stripeAccountRef: STRIPE_ACCOUNT_REF,
        currency: "USD",
        eligible: false,
        providerVerified: true,
        verificationRef: "stripe-verify:ineligible",
        observedAt: NOW_ISO,
        freshness: { asOf: NOW_ISO, maxAgeSeconds: 3600 },
        awaitingAuthority: "P4-W1-003",
      }),
    ).toThrow(/ineligible/i);
  });

  it("rejects evidence missing the awaiting-authority marker (the authority is never implied)", () => {
    expect(() =>
      validateStripeCryptoSettlementEligibility({
        evidenceId: "stripe-eligibility:no-authority",
        stripeAccountRef: STRIPE_ACCOUNT_REF,
        currency: "USD",
        eligible: true,
        providerVerified: true,
        verificationRef: "stripe-verify:no-authority",
        observedAt: NOW_ISO,
        freshness: { asOf: NOW_ISO, maxAgeSeconds: 3600 },
      } as never),
    ).toThrow(/awaitingAuthority/i);
  });

  it("a SUCCESS settlement observation REQUIRES its provider verification reference", () => {
    expect(() =>
      validateStripeSettlementObservation({
        observationId: "stripe-obs:no-ref",
        stripeAccountRef: STRIPE_ACCOUNT_REF,
        observedAt: NOW_ISO,
        verificationStatus: "SUCCESS",
      }),
    ).toThrow(/verification reference/i);

    const valid = validateStripeSettlementObservation({
      observationId: "stripe-obs:ok",
      stripeAccountRef: STRIPE_ACCOUNT_REF,
      observedAt: NOW_ISO,
      verificationStatus: "SUCCESS",
      verificationRef: "stripe-verify:ok",
    });
    expect(valid.verificationStatus).toBe("SUCCESS");
  });

  it("an OUTCOME_UNKNOWN settlement observation carries its reason (INV-X01)", () => {
    const unknown = validateStripeSettlementObservation({
      observationId: "stripe-obs:unknown",
      stripeAccountRef: STRIPE_ACCOUNT_REF,
      observedAt: NOW_ISO,
      verificationStatus: "OUTCOME_UNKNOWN",
      unknownReason: "the provider verification endpoint could not be reached",
    });
    expect(unknown.verificationStatus).toBe("OUTCOME_UNKNOWN");
    expect(
      "unknownReason" in unknown ? unknown.unknownReason : undefined,
    ).toContain("could not be reached");
    expect(() =>
      validateStripeSettlementObservation({
        observationId: "stripe-obs:unknown-no-reason",
        stripeAccountRef: STRIPE_ACCOUNT_REF,
        observedAt: NOW_ISO,
        verificationStatus: "OUTCOME_UNKNOWN",
      }),
    ).toThrow(/unknownReason/i);
  });

  it("the eligibility freshness probe applies the observation law (fail closed on unparseable timestamps)", () => {
    const evidence = stripeEligibilityEvidence();
    expect(stripeEligibilityEvidenceIsFresh(evidence, NOW)).toBe(true);
    expect(stripeEligibilityEvidenceIsFresh(evidence, NOW + 2 * 3_600_000)).toBe(false);
    expect(
      stripeEligibilityEvidenceIsFresh(
        { ...evidence, freshness: { asOf: "not-a-timestamp", maxAgeSeconds: 3600 } },
        NOW,
      ),
    ).toBe(false);
  });

  it("the authority constant is the wave-1 research work order (honest marker)", () => {
    expect(STRIPE_CRYPTO_SETTLEMENT_AUTHORITY).toBe("P4-W1-003");
  });
});
