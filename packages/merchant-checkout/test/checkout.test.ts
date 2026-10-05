import { describe, expect, it } from "vitest";
import { ValidationError, fromMinorUnits, currencyCode } from "@payswap/protocol";
import { asCryptoAssetId, defineCryptoAmount, defineCryptoQuote } from "@payswap/merchant-crypto";
import {
  asCheckoutFlowId,
  checkoutOption,
  defineRailAssetBinding,
  deriveDisplayedCryptoAmount,
  isOptionExpired,
  openCheckoutFlow,
} from "../src/index.js";
import {
  activeAcceptance,
  baseAcceptancePolicy,
  CART_AMOUNT,
  CHAIN_REF,
  EXPIRY,
  fixtureQuote,
  LATER,
  NOW,
  onboardedMerchant,
  QUOTE_VALID_UNTIL,
  USC_CRYPTO_ASSET,
  USC_KERNEL_ASSET,
  USC_RAIL_BINDING,
} from "./fixtures.js";

/** P4-W2-003 §3.3 — checkout session construction + payment options. */

function openFlowFixture(overrides?: {
  readonly quotes?: ReturnType<typeof fixtureQuote>[];
  readonly amount?: ReturnType<typeof fromMinorUnits>;
}) {
  return openCheckoutFlow({
    id: "flow-1",
    merchantId: "merchant-1",
    activation: activeAcceptance(),
    basePolicy: baseAcceptancePolicy(),
    cart: { amount: overrides?.amount ?? CART_AMOUNT },
    quotes: overrides?.quotes ?? [fixtureQuote()],
    railBindings: [USC_RAIL_BINDING],
    now: LATER,
    expiresAt: EXPIRY,
  });
}

describe("checkout flow — rail asset bindings (the two vocabularies)", () => {
  it("validates the kernel side with the kernel's own validators", () => {
    expect(() =>
      defineRailAssetBinding({
        merchantAssetId: USC_CRYPTO_ASSET.id,
        merchantChainId: CHAIN_REF,
        chainRef: "not-a-chain-ref",
        assetIdentity: { ...USC_KERNEL_ASSET },
      }),
    ).toThrow(/chain reference/);
    expect(() =>
      defineRailAssetBinding({
        merchantAssetId: USC_CRYPTO_ASSET.id,
        merchantChainId: CHAIN_REF,
        chainRef: CHAIN_REF,
        assetIdentity: { chain: CHAIN_REF, assetId: "0x1", symbol: "TOOLONGSYMBOL" },
      }),
    ).toThrow(/symbol/);
  });

  it("rejects a kernel asset living on a different chain than the binding", () => {
    expect(() =>
      defineRailAssetBinding({
        merchantAssetId: USC_CRYPTO_ASSET.id,
        merchantChainId: CHAIN_REF,
        chainRef: CHAIN_REF,
        assetIdentity: { chain: "solana:mainnet-beta", assetId: "0x1", symbol: "USC" },
      }),
    ).toThrow(ValidationError);
  });
});

describe("checkout flow — opening laws (fail-closed)", () => {
  it("opens a flow with crypto options and fiat fallbacks", () => {
    const flow = openFlowFixture();
    expect(flow.id).toBe("flow-1");
    expect(flow.intent.state).toBe("REQUIRES_PAYMENT_METHOD");
    expect(flow.session.state).toBe("OPEN");
    expect(flow.session.expiresAt).toBe(EXPIRY);
    const kinds = flow.options.map((option) => option.kind);
    expect(kinds).toContain("CRYPTO_WALLET_PAYMENT");
    expect(kinds).toContain("FIAT_FALLBACK");
  });

  it("refuses to open against a deactivated activation", () => {
    expect(() =>
      openCheckoutFlow({
        id: "flow-x",
        merchantId: "merchant-1",
        activation: { ...activeAcceptance(), state: "DEACTIVATED" },
        basePolicy: baseAcceptancePolicy(),
        cart: { amount: CART_AMOUNT },
        quotes: [fixtureQuote()],
        railBindings: [USC_RAIL_BINDING],
        now: LATER,
        expiresAt: EXPIRY,
      }),
    ).toThrow(/ACTIVE crypto acceptance/);
  });

  it("refuses a quote whose asset is not in the offered snapshot", () => {
    const offAssetQuote = defineCryptoQuote({
      id: "quote-off",
      assetId: "asset.other",
      chainId: CHAIN_REF,
      fiatAmount: CART_AMOUNT,
      cryptoAmount: { assetId: asCryptoAssetId("asset.other"), value: 10000n, decimals: 6 },
      ratio: { numerator: 99n, denominator: 100n },
      fees: fromMinorUnits(currencyCode("USD"), 0n),
      quotedAt: NOW,
      validUntil: QUOTE_VALID_UNTIL,
      sourceRef: "fixture",
    });
    expect(() => openFlowFixture({ quotes: [offAssetQuote] })).toThrow(/not in the offered/);
  });

  it("refuses a quote that prices a different cart amount", () => {
    const wrongPrice = defineCryptoQuote({
      id: "quote-wrong",
      assetId: USC_CRYPTO_ASSET.id,
      chainId: CHAIN_REF,
      fiatAmount: fromMinorUnits(currencyCode("USD"), 5000n),
      cryptoAmount: defineCryptoAmount(USC_CRYPTO_ASSET, 5000n),
      ratio: { numerator: 1n, denominator: 1n },
      fees: fromMinorUnits(currencyCode("USD"), 0n),
      quotedAt: NOW,
      validUntil: QUOTE_VALID_UNTIL,
      sourceRef: "fixture",
    });
    expect(() => openFlowFixture({ quotes: [wrongPrice] })).toThrow(/exact cart amount/);
  });

  it("refuses a non-positive cart amount", () => {
    expect(() =>
      openFlowFixture({ amount: fromMinorUnits(currencyCode("USD"), 0n) }),
    ).toThrow(ValidationError);
  });

  it("refuses an expiry at or before opening", () => {
    expect(() =>
      openCheckoutFlow({
        id: "flow-x",
        merchantId: "merchant-1",
        activation: activeAcceptance(),
        basePolicy: baseAcceptancePolicy(),
        cart: { amount: CART_AMOUNT },
        quotes: [fixtureQuote()],
        railBindings: [USC_RAIL_BINDING],
        now: LATER,
        expiresAt: LATER,
      }),
    ).toThrow(ValidationError);
  });

  it("validates flow ids", () => {
    expect(() => asCheckoutFlowId("")).toThrow(ValidationError);
    expect(() => asCheckoutFlowId(" x")).toThrow(ValidationError);
  });
});

describe("checkout flow — displayed amounts by exact cross-multiplication", () => {
  it("derives the display amount and it equals the quote's exact crypto amount", () => {
    const quote = fixtureQuote();
    const display = deriveDisplayedCryptoAmount(quote);
    expect(display.value).toBe(quote.cryptoAmount.value);
    // EXACT cross-multiplication (bigint, INV-F01):
    expect(quote.fiatAmount.value * quote.ratio.denominator).toBe(
      quote.cryptoAmount.value * quote.ratio.numerator,
    );
  });

  it("rejects an inconsistent quote (cross-multiplication violated)", () => {
    const quote = fixtureQuote();
    const broken = {
      ...quote,
      cryptoAmount: { ...quote.cryptoAmount, value: quote.cryptoAmount.value + 1n },
    };
    expect(() => deriveDisplayedCryptoAmount(broken)).toThrow(ValidationError);
  });
});

describe("checkout flow — options and expiry", () => {
  it("looks up options by id and rejects unknown ids", () => {
    const flow = openFlowFixture();
    const option = checkoutOption(flow, `crypto:${USC_CRYPTO_ASSET.id}@${CHAIN_REF}`);
    expect(option.kind).toBe("CRYPTO_WALLET_PAYMENT");
    expect(option.optionId).toBe(`crypto:${USC_CRYPTO_ASSET.id}@${CHAIN_REF}`);
    expect(() => checkoutOption(flow, "no-such-option")).toThrow(ValidationError);
  });

  it("the session's offered assets are snapshotted at open (immutable history)", () => {
    const flow = openFlowFixture();
    expect(flow.session.offeredAssets).toHaveLength(1);
    expect(Object.isFrozen(flow.session.offeredAssets[0])).toBe(true);
  });

  it("crypto options expire AT the quote boundary (last usable instant is validUntil - 1)", () => {
    const flow = openFlowFixture();
    const option = checkoutOption(flow, `crypto:${USC_CRYPTO_ASSET.id}@${CHAIN_REF}`);
    expect(option.kind).toBe("CRYPTO_WALLET_PAYMENT");
    if (option.kind !== "CRYPTO_WALLET_PAYMENT") {
      throw new Error("unreachable");
    }
    expect(isOptionExpired(option, QUOTE_VALID_UNTIL - 1n)).toBe(false);
    expect(isOptionExpired(option, QUOTE_VALID_UNTIL)).toBe(true);
  });

  it("fiat fallback options never expire with the quote", () => {
    const flow = openFlowFixture();
    const fiat = flow.options.find((option) => option.kind === "FIAT_FALLBACK");
    if (fiat === undefined) {
      throw new Error("fixture must include a fiat fallback");
    }
    expect(isOptionExpired(fiat, QUOTE_VALID_UNTIL)).toBe(false);
  });
});
