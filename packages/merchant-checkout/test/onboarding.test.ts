import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  activateMerchant,
  asMerchantId,
  draftMerchant,
  merchantOnboardingStateMachine,
  merchantMayActivateCryptoAcceptance,
  mayChangeCountry,
  submitMerchantApplication,
  updateMerchantProfile,
  verifyMerchant,
} from "../src/index.js";
import { LATER, NOW, settlementDestination } from "./fixtures.js";

/** P4-W2-003 §3.1 — merchant onboarding contracts. */

describe("merchant onboarding — construction validation (fail-closed)", () => {
  it("drafts a fiat-denominated merchant profile", () => {
    const profile = draftMerchant({
      id: "merchant-1",
      businessName: "Fixture Coffee Roasters",
      country: "US",
      pricingCurrency: "USD",
      supportContact: "support@example.com",
      now: NOW,
    });
    expect(profile.state).toBe("DRAFT");
    expect(profile.pricingCurrency).toBe("USD");
    expect(profile.createdAt).toBe(NOW);
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("rejects empty ids, whitespace ids and overlong ids", () => {
    expect(() => asMerchantId("")).toThrow(ValidationError);
    expect(() => asMerchantId(" padded ")).toThrow(ValidationError);
    expect(() => asMerchantId("x".repeat(257))).toThrow(ValidationError);
  });

  it("rejects malformed country and currency codes", () => {
    expect(() =>
      draftMerchant({ id: "m", businessName: "B", country: "usa", pricingCurrency: "USD", now: NOW }),
    ).toThrow(ValidationError);
    expect(() =>
      draftMerchant({ id: "m", businessName: "B", country: "US", pricingCurrency: "usd", now: NOW }),
    ).toThrow(ValidationError);
    expect(() =>
      draftMerchant({ id: "m", businessName: "", country: "US", pricingCurrency: "USD", now: NOW }),
    ).toThrow(ValidationError);
  });

  it("rejects a non-bigint now (deterministic instants only)", () => {
    expect(() =>
      draftMerchant({
        id: "m",
        businessName: "B",
        country: "US",
        pricingCurrency: "USD",
        now: 123 as unknown as bigint,
      }),
    ).toThrow(ValidationError);
  });
});

describe("merchant onboarding — the DRAFT → SUBMITTED → VERIFIED → ACTIVE machine", () => {
  it("declares exactly the four work-item states with ACTIVE terminal", () => {
    expect(merchantOnboardingStateMachine.states).toEqual([
      "DRAFT",
      "SUBMITTED",
      "VERIFIED",
      "ACTIVE",
    ]);
    expect(merchantOnboardingStateMachine.terminalStates).toEqual(["ACTIVE"]);
  });

  it("refuses submission of an incomplete application (no support contact)", () => {
    const draft = draftMerchant({
      id: "merchant-1",
      businessName: "B",
      country: "US",
      pricingCurrency: "USD",
      now: NOW,
    });
    expect(() => submitMerchantApplication(draft, LATER)).toThrow(ValidationError);
  });

  it("walks draft → submitted → verified → active deterministically", () => {
    const draft = draftMerchant({
      id: "merchant-1",
      businessName: "B",
      country: "US",
      pricingCurrency: "USD",
      supportContact: "support@example.com",
      now: NOW,
    });
    const submitted = submitMerchantApplication(draft, LATER);
    expect(submitted.state).toBe("SUBMITTED");
    const verified = verifyMerchant(submitted, { verificationRef: "verify-1", now: LATER });
    expect(verified.state).toBe("VERIFIED");
    expect(verified.verificationRef).toBe("verify-1");
    const active = activateMerchant(verified, {
      settlementDestination: settlementDestination(),
      now: LATER,
    });
    expect(active.state).toBe("ACTIVE");
    expect(active.settlementDestination?.id).toBe("dest-bank-1");
  });

  it("refuses verification without a verification record reference (lineage)", () => {
    const draft = draftMerchant({
      id: "merchant-1",
      businessName: "B",
      country: "US",
      pricingCurrency: "USD",
      supportContact: "support@example.com",
      now: NOW,
    });
    const submitted = submitMerchantApplication(draft, LATER);
    expect(() =>
      verifyMerchant(submitted, { verificationRef: "", now: LATER }),
    ).toThrow(ValidationError);
  });

  it("refuses activation without a settlement destination (fail-closed)", () => {
    const draft = draftMerchant({
      id: "merchant-1",
      businessName: "B",
      country: "US",
      pricingCurrency: "USD",
      supportContact: "support@example.com",
      now: NOW,
    });
    const submitted = submitMerchantApplication(draft, LATER);
    const verified = verifyMerchant(submitted, { verificationRef: "verify-1", now: LATER });
    expect(() =>
      activateMerchant(verified, {
        settlementDestination: undefined as unknown as never,
        now: LATER,
      }),
    ).toThrow(ValidationError);
  });

  it("refuses out-of-order transitions (submit an ACTIVE merchant)", () => {
    const active = (() => {
      const draft = draftMerchant({
        id: "merchant-1",
        businessName: "B",
        country: "US",
        pricingCurrency: "USD",
        supportContact: "support@example.com",
        now: NOW,
      });
      return activateMerchant(
        verifyMerchant(submitMerchantApplication(draft, LATER), {
          verificationRef: "v",
          now: LATER,
        }),
        { settlementDestination: settlementDestination(), now: LATER },
      );
    })();
    expect(() => submitMerchantApplication(active, LATER)).toThrow(/terminal states are monotonic/);
  });
});

describe("merchant onboarding — no step may imply rail connectivity", () => {
  it("rejects an onboarding record carrying connectivity-implying fields", () => {
    const offending = {
      id: "merchant-1",
      businessName: "B",
      country: "US",
      pricingCurrency: "USD",
      state: "DRAFT",
      connectedRails: ["stripe"],
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(() =>
      updateMerchantProfile(offending as never, { now: LATER }),
    ).toThrow(ValidationError);
  });

  it("rejects nested connectivity vocabulary (stripeAccountRef)", () => {
    const offending = {
      id: "merchant-1",
      businessName: "B",
      country: "US",
      pricingCurrency: "USD",
      state: "DRAFT",
      details: { stripeAccountRef: "acct_1" },
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(() =>
      updateMerchantProfile(offending as never, { now: LATER }),
    ).toThrow(ValidationError);
  });

  it("the clean profile passes the guard", () => {
    const profile = draftMerchant({
      id: "merchant-1",
      businessName: "B",
      country: "US",
      pricingCurrency: "USD",
      now: NOW,
    });
    expect(() => updateMerchantProfile(profile, { now: LATER })).not.toThrow();
  });
});

describe("merchant onboarding — immutability laws", () => {
  it("the origin country is immutable once ACTIVE", () => {
    const draft = draftMerchant({
      id: "merchant-1",
      businessName: "B",
      country: "US",
      pricingCurrency: "USD",
      supportContact: "support@example.com",
      now: NOW,
    });
    expect(mayChangeCountry(draft)).toBe(true);
    const active = activateMerchant(
      verifyMerchant(submitMerchantApplication(draft, LATER), {
        verificationRef: "v",
        now: LATER,
      }),
      { settlementDestination: settlementDestination(), now: LATER },
    );
    expect(mayChangeCountry(active)).toBe(false);
  });

  it("crypto acceptance requires a verified merchant", () => {
    const draft = draftMerchant({
      id: "merchant-1",
      businessName: "B",
      country: "US",
      pricingCurrency: "USD",
      supportContact: "support@example.com",
      now: NOW,
    });
    expect(merchantMayActivateCryptoAcceptance(draft)).toBe(false);
    const submitted = submitMerchantApplication(draft, LATER);
    expect(merchantMayActivateCryptoAcceptance(submitted)).toBe(false);
    const verified = verifyMerchant(submitted, { verificationRef: "v", now: LATER });
    expect(merchantMayActivateCryptoAcceptance(verified)).toBe(true);
  });

  it("records are frozen (historical onboarding facts are immutable)", () => {
    const draft = draftMerchant({
      id: "merchant-1",
      businessName: "B",
      country: "US",
      pricingCurrency: "USD",
      supportContact: "support@example.com",
      now: NOW,
    });
    expect(() => {
      (draft as unknown as { businessName: string }).businessName = "X";
    }).toThrow();
  });
});
