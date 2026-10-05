import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import { defineCryptoAmount } from "@payswap/merchant-crypto";
import {
  acceptanceOfferView,
  activateCryptoAcceptance,
  activationEvaluate,
  activationMatches,
  asCryptoAcceptanceActivationId,
  deactivateCryptoAcceptance,
} from "../src/index.js";
import { currencyCode } from "@payswap/protocol";
import {
  activeAcceptance,
  baseAcceptancePolicy,
  CHAIN_ID,
  CHAIN_REF,
  cryptoPolicyInput,
  fixtureQuote,
  LATER,
  NOW,
  onboardedMerchant,
  QUOTED_USC,
  QUOTE_VALID_UNTIL,
  USC_CRYPTO_ASSET,
  STABLECOIN_METHOD_ID,
} from "./fixtures.js";

const USD_CODE = currencyCode("USD");
const EUR_CODE = currencyCode("EUR");

/** P4-W2-003 §3.2 — crypto acceptance activation (composed, never copied). */

describe("crypto acceptance activation — construction laws", () => {
  it("activates for a verified merchant with the composed merchant-crypto policy", () => {
    const activation = activeAcceptance();
    expect(activation.state).toBe("ACTIVE");
    expect(activation.merchantId).toBe("merchant-1");
    expect(activation.policy.id).toBe("mcap-1");
    expect(activation.policy.basePolicyId).toBe("pap-1");
    expect(Object.isFrozen(activation)).toBe(true);
  });

  it("refuses activation for an unverified merchant", () => {
    expect(() =>
      activateCryptoAcceptance({
        id: "activation-x",
        merchant: onboardedMerchant({ state: "SUBMITTED" }),
        policyInput: cryptoPolicyInput(),
        basePolicy: baseAcceptancePolicy(),
        now: NOW,
      }),
    ).toThrow(/verified merchant/);
  });

  it("refuses a policy that references a different merchant", () => {
    expect(() =>
      activateCryptoAcceptance({
        id: "activation-x",
        merchant: onboardedMerchant(),
        policyInput: { ...cryptoPolicyInput(), merchantRef: "merchant-other" },
        basePolicy: baseAcceptancePolicy(),
        now: NOW,
      }),
    ).toThrow(ValidationError);
  });

  it("refuses a base policy that does not declare STABLECOIN_CRYPTO (the landed law)", () => {
    const nonCryptoPolicy = {
      ...baseAcceptancePolicy(),
      methods: ["CARD" as const],
      methodCatalog: baseAcceptancePolicy().methodCatalog.filter(
        (method) => method.kind !== "STABLECOIN_CRYPTO",
      ),
    };
    expect(() =>
      activateCryptoAcceptance({
        id: "activation-x",
        merchant: onboardedMerchant(),
        policyInput: cryptoPolicyInput(),
        basePolicy: nonCryptoPolicy,
        now: NOW,
      }),
    ).toThrow(ValidationError);
  });

  it("validates activation ids", () => {
    expect(() => asCryptoAcceptanceActivationId("")).toThrow(ValidationError);
    expect(() => asCryptoAcceptanceActivationId(" x ")).toThrow(ValidationError);
  });
});

describe("crypto acceptance activation — deactivation preserves history", () => {
  it("deactivation returns a NEW record; the original stays untouched", () => {
    const activation = activeAcceptance();
    const deactivated = deactivateCryptoAcceptance(activation, {
      reason: "merchant paused crypto",
      now: LATER,
    });
    expect(deactivated.state).toBe("DEACTIVATED");
    expect(deactivated.deactivationReason).toBe("merchant paused crypto");
    expect(deactivated).not.toBe(activation);
    expect(activation.state).toBe("ACTIVE");
    expect(activation.deactivatedAt).toBeUndefined();
    // The composed policy record is shared verbatim (immutable history):
    expect(deactivated.policy).toEqual(activation.policy);
  });

  it("the historical policy snapshot is preserved verbatim inside both records", () => {
    const activation = activeAcceptance();
    const deactivated = deactivateCryptoAcceptance(activation, {
      reason: "paused",
      now: LATER,
    });
    expect(deactivated.policy).toEqual(activation.policy);
    expect(deactivated.policy.id).toBe("mcap-1");
  });

  it("a DEACTIVATED activation cannot be deactivated again (terminal discipline)", () => {
    const deactivated = deactivateCryptoAcceptance(activeAcceptance(), {
      reason: "paused",
      now: LATER,
    });
    expect(() =>
      deactivateCryptoAcceptance(deactivated, { reason: "again", now: LATER }),
    ).toThrow(ValidationError);
  });

  it("deactivation requires a reason", () => {
    expect(() =>
      deactivateCryptoAcceptance(activeAcceptance(), { reason: "", now: LATER }),
    ).toThrow(ValidationError);
  });
});

describe("crypto acceptance activation — the typed view over the composed policy", () => {
  it("the offer view is derived through the landed merchant-crypto functions", () => {
    const view = acceptanceOfferView(activeAcceptance());
    expect(view.policyId).toBe("mcap-1");
    expect(view.basePolicyId).toBe("pap-1");
    expect(view.quoteValidityMs).toBe(30_000n);
    expect(view.assets).toHaveLength(1);
    expect(view.assets[0]?.assetId).toBe(USC_CRYPTO_ASSET.id);
    expect(view.assets[0]?.chains).toEqual([CHAIN_REF]);
    // A fresh frozen snapshot: mutating the view never touches the policy.
    expect(Object.isFrozen(view.assets[0])).toBe(true);
  });

  it("an ACTIVE activation matches an in-bounds request (landed matcher)", () => {
    const activation = activeAcceptance();
    const decision = activationMatches(
      activation,
      {
        assetId: USC_CRYPTO_ASSET.id,
        chainId: CHAIN_ID,
        amount: QUOTED_USC,
      },
      LATER,
    );
    expect(decision.accepted).toBe(true);
  });

  it("an ACTIVE activation rejects an out-of-bounds amount with the landed reasons", () => {
    const decision = activationMatches(
      activeAcceptance(),
      {
        assetId: USC_CRYPTO_ASSET.id,
        chainId: CHAIN_ID,
        amount: defineCryptoAmount(USC_CRYPTO_ASSET, 1n),
      },
      LATER,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toContain("AMOUNT_BELOW_MINIMUM");
  });

  it("a DEACTIVATED activation rejects with the typed ACTIVATION_INACTIVE reason", () => {
    const deactivated = deactivateCryptoAcceptance(activeAcceptance(), {
      reason: "paused",
      now: LATER,
    });
    const decision = activationMatches(
      deactivated,
      {
        assetId: USC_CRYPTO_ASSET.id,
        chainId: CHAIN_ID,
        amount: QUOTED_USC,
      },
      LATER,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(["ACTIVATION_INACTIVE"]);
  });

  it("the both-planes evaluation delegates to the landed evaluateCryptoAcceptance", () => {
    const activation = activeAcceptance();
    const accepted = activationEvaluate(
      activation,
      baseAcceptancePolicy(),
      { assetId: USC_CRYPTO_ASSET.id, chainId: CHAIN_ID, amount: QUOTED_USC },
      { methodId: STABLECOIN_METHOD_ID, currency: USD_CODE },
      LATER,
    );
    expect(accepted.accepted).toBe(true);

    const rejected = activationEvaluate(
      activation,
      baseAcceptancePolicy(),
      { assetId: USC_CRYPTO_ASSET.id, chainId: CHAIN_ID, amount: QUOTED_USC },
      { methodId: STABLECOIN_METHOD_ID, currency: EUR_CODE },
      LATER,
    );
    expect(rejected.accepted).toBe(false);
    expect(rejected.reasons).toContain("BASE_POLICY_REJECTED");
  });

  it("quotes expire at the boundary (expiry-at-boundary semantics via the landed matcher)", () => {
    const decision = activationMatches(
      activeAcceptance(),
      {
        assetId: USC_CRYPTO_ASSET.id,
        chainId: CHAIN_ID,
        amount: QUOTED_USC,
        quote: fixtureQuote(),
      },
      QUOTE_VALID_UNTIL,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toContain("QUOTE_EXPIRED");
  });
});
