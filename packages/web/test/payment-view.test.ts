import { describe, expect, it } from "vitest";

import {
  LINK_TEST_RETAINER,
  PAY_TEST_FAILED_INSUFFICIENT,
  PAY_TEST_FIXTURES,
  PAY_TEST_PARTIAL_REFUND,
  PAY_TEST_PROCESSING,
  PAY_TEST_SUCCEEDED_CROSS_RAIL,
} from "../src/app/app/payments/_server/test-fixtures";
import {
  composeRegistrySentence,
  crossRailSentence,
  errorReasonIdFromApiCode,
  failureReasonFor,
  formatEventTimestamp,
  formatMinorUnits,
  formatMoney,
  fundingRailLabel,
  isCrossRail,
  linkEstimateLine,
  netAmountFor,
  parseAmountToMinorUnits,
  paymentPrimaryAction,
  paymentStrapline,
  refundAvailableFor,
  refundConsequenceLine,
  refundRemainingLine,
  refundTotalsFor,
  subtractMoney,
} from "../src/app/app/payments/_view/payment-view";

/**
 * UX-004 — the payment view-model: PURE derivations for the money-movement
 * workflows and the object-detail anatomy. Money is exact integer minor-unit
 * arithmetic (BigInt only — a float must never appear on a money path), the
 * failure-reason bridge is fail-closed against the certified registry, and
 * the cross-rail sentence renders whenever source ≠ settlement.
 */

describe("money math is exact (INV-F01 — never a float)", () => {
  it("formats minor units without rounding", () => {
    expect(formatMinorUnits("25000000", "USDC")).toBe("25");
    expect(formatMinorUnits("1", "USDC")).toBe("0.000001");
    expect(formatMinorUnits("1050", "EUR")).toBe("10.50");
    expect(formatMinorUnits("1234567", "USD")).toBe("12,345.67");
    expect(formatMinorUnits("123456700", "USD")).toBe("1,234,567");
    expect(formatMinorUnits("1000000000000000000", "ETH")).toBe("1");
  });

  it("renders an invalid minor-units string verbatim (never invents digits)", () => {
    expect(formatMinorUnits("not-a-number", "USDC")).toBe("not-a-number");
    expect(formatMinorUnits("", "EUR")).toBe("");
  });

  it("formats the X CUR cell shape (contract 03 §2.1)", () => {
    expect(formatMoney({ minorUnits: "25000000", currency: "usdc" })).toBe("25 USDC");
    expect(formatMoney({ minorUnits: "1050", currency: "EUR" })).toBe("10.50 EUR");
  });

  it("parses human amounts into exact minor units (or blocks, never rounds)", () => {
    expect(parseAmountToMinorUnits("25", "USDC")).toBe("25000000");
    expect(parseAmountToMinorUnits("10.5", "EUR")).toBe("1050");
    expect(parseAmountToMinorUnits("1,000", "USD")).toBe("100000");
    expect(parseAmountToMinorUnits("0", "USDC")).toBeNull();
    expect(parseAmountToMinorUnits("abc", "USDC")).toBeNull();
    expect(parseAmountToMinorUnits("-5", "USDC")).toBeNull();
    // One fractional digit more than USDC's 6 decimals: blocked, not rounded.
    expect(parseAmountToMinorUnits("0.0000001", "USDC")).toBeNull();
  });

  it("subtracts exactly (the net-amount derivation)", () => {
    expect(
      subtractMoney(
        { minorUnits: "25000000", currency: "USDC" },
        { minorUnits: "880000", currency: "USDC" },
      ),
    ).toEqual({ minorUnits: "24120000", currency: "USDC" });
    expect(subtractMoney({ minorUnits: "x", currency: "USDC" }, { minorUnits: "1", currency: "USDC" })).toBeNull();
    expect(
      netAmountFor({
        ...PAY_TEST_SUCCEEDED_CROSS_RAIL,
      }),
    ).toEqual({ minorUnits: "24120000", currency: "USDC" });
  });
});

describe("the failure-reason bridge is fail-closed against the certified registry", () => {
  it("maps the API's error codes onto registry ids through ONE typed table", () => {
    expect(errorReasonIdFromApiCode("insufficient_balance")).toBe("insufficient-balance");
    expect(errorReasonIdFromApiCode("no_viable_route")).toBe("route-unavailable");
    expect(errorReasonIdFromApiCode("policy_blocked")).toBe("blocked-by-security-policy");
    expect(errorReasonIdFromApiCode("cancelled_by_user")).toBe("cancelled-by-user");
  });

  it("an unmapped code maps to null — never an invented label", () => {
    expect(errorReasonIdFromApiCode("some_new_provider_code")).toBeNull();
  });

  it("looks registry reasons up by id (unknown ids render nothing, fail-closed)", () => {
    expect(failureReasonFor("insufficient-balance")?.label).toBe("Insufficient balance");
    expect(failureReasonFor(undefined)).toBeNull();
    // @ts-expect-error — an id outside the registry must not type-check OR render
    expect(failureReasonFor("not-a-reason")).toBeNull();
  });

  it("composes the contract-07 §4 anatomy sentence from the registry row", () => {
    const sentence = composeRegistrySentence("insufficient-balance");
    expect(sentence).toContain("Insufficient balance — The source wallet holds less than the payment amount.");
    expect(sentence).toContain("You can: Top up the source wallet or switch to another rail.");
  });

  it("the failed TEST fixture carries a registry id that composes cleanly", () => {
    expect(PAY_TEST_FAILED_INSUFFICIENT.failureReasonId).toBe("insufficient-balance");
    expect(composeRegistrySentence("insufficient-balance")).not.toBeNull();
  });
});

describe("the cross-rail disclosure (contract 05 §2.3 — mandatory)", () => {
  it("detects cross-asset settlements", () => {
    expect(isCrossRail(PAY_TEST_SUCCEEDED_CROSS_RAIL)).toBe(true);
    // Same asset, same rail: not cross-rail.
    expect(isCrossRail(PAY_TEST_PARTIAL_REFUND)).toBe(false);
    expect(isCrossRail(PAY_TEST_PROCESSING)).toBe(false);
  });

  it("composes the sentence naming BOTH assets and rails", () => {
    expect(crossRailSentence(PAY_TEST_SUCCEEDED_CROSS_RAIL)).toBe(
      "Customer paid USDC on Base (USDC); settled to you in EUR via SEPA",
    );
  });

  it("100% of cross-asset TEST fixtures carry a settlement (so the sentence can render)", () => {
    for (const payment of PAY_TEST_FIXTURES) {
      if (isCrossRail(payment)) {
        expect(payment.settlement).toBeDefined();
        expect(crossRailSentence(payment)).toMatch(/Customer paid .+ on .+; settled to you in .+ via /);
      }
    }
  });
});

describe("refund totals and the remaining-amount line (W4)", () => {
  it("computes refunded/remaining exactly, and partial-ness", () => {
    const totals = refundTotalsFor(PAY_TEST_PARTIAL_REFUND);
    expect(totals.refunded).toEqual({ minorUnits: "10000000", currency: "USDC" });
    expect(totals.remaining).toEqual({ minorUnits: "15000000", currency: "USDC" });
    expect(totals.partial).toBe(true);
  });

  it("a fully unrefunded payment has the whole amount remaining", () => {
    const totals = refundTotalsFor(PAY_TEST_SUCCEEDED_CROSS_RAIL);
    expect(totals.partial).toBe(false);
    expect(totals.remaining).toEqual({ minorUnits: "25000000", currency: "USDC" });
  });

  it("the remaining line renders only for partial refunds", () => {
    expect(refundRemainingLine(PAY_TEST_PARTIAL_REFUND)).toBe(
      "15 USDC still refundable on this payment",
    );
    expect(refundRemainingLine(PAY_TEST_SUCCEEDED_CROSS_RAIL)).toBeNull();
  });

  it("the consequence line names the rail and the fee honesty", () => {
    expect(refundConsequenceLine(PAY_TEST_PARTIAL_REFUND)).toBe(
      "Returns to the customer on Base (USDC); fees are not returned.",
    );
  });

  it("refunds are available on succeeded/partially-refunded payments only", () => {
    expect(refundAvailableFor(PAY_TEST_SUCCEEDED_CROSS_RAIL)).toBe(true);
    expect(refundAvailableFor(PAY_TEST_PARTIAL_REFUND)).toBe(true);
    expect(refundAvailableFor(PAY_TEST_PROCESSING)).toBe(false);
    expect(refundAvailableFor(PAY_TEST_FAILED_INSUFFICIENT)).toBe(false);
  });
});

describe("the detail-header derivations", () => {
  it("the strapline names the counterparty (contract 05 §2.1)", () => {
    expect(paymentStrapline(PAY_TEST_SUCCEEDED_CROSS_RAIL)).toBe("Charged to Amara Okafor");
  });

  it("the primary action is the object's most likely next move", () => {
    expect(paymentPrimaryAction(PAY_TEST_SUCCEEDED_CROSS_RAIL)).toEqual({ kind: "refund" });
    expect(paymentPrimaryAction(PAY_TEST_PARTIAL_REFUND)).toEqual({ kind: "refund" });
    expect(paymentPrimaryAction(PAY_TEST_FAILED_INSUFFICIENT)).toEqual({ kind: "retry" });
    expect(paymentPrimaryAction(PAY_TEST_PROCESSING)).toEqual({ kind: "send-receipt" });
  });

  it("timestamps render stable UTC strings (invalid ISO passes through verbatim)", () => {
    expect(formatEventTimestamp("2026-10-06T09:12:00Z")).toBe("2026-10-06 09:12 UTC");
    expect(formatEventTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("funding rails carry human labels", () => {
    expect(fundingRailLabel("manual-entry")).toBe("Manual entry");
    expect(fundingRailLabel("on-file")).toBe("Method on file");
    expect(fundingRailLabel("hosted-link")).toBe("Hosted link");
  });
});

describe("the W2 live estimate (exact integer math, labeled an estimate)", () => {
  it("with no fee: 1 × amount = amount · Total", () => {
    const { estimate, total } = linkEstimateLine(
      "Design retainer — October",
      { minorUnits: "25000000", currency: "USDC" },
      0n,
    );
    expect(estimate).toBe("1 × 25 USDC = 25 USDC · Total 25 USDC");
    expect(total).toEqual({ minorUnits: "25000000", currency: "USDC" });
  });

  it("with the managed-delivery fee the estimate states it and adds it exactly", () => {
    const { estimate, total } = linkEstimateLine(
      "Design retainer — October",
      { minorUnits: "25000000", currency: "USDC" },
      350n,
    );
    // 3.5% of 25 USDC = 0.875 USDC (875000 minor units), exact.
    expect(total).toEqual({ minorUnits: "25875000", currency: "USDC" });
    expect(estimate).toContain("Managed-delivery fee 3.5%");
    expect(estimate).toContain("Estimated total 25.875000 USDC");
    expect(estimate).toContain("1 × 25 USDC = 25 USDC");
  });

  it("the TEST link fixture carries the CTA wording and methods list", () => {
    expect(LINK_TEST_RETAINER.cta).toBe("pay");
    expect(LINK_TEST_RETAINER.methods).toEqual([
      "USDC on Base",
      "Card (Stripe)",
      "Mobile money (MTN)",
    ]);
  });
});
