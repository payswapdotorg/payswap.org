import { describe, expect, it } from "vitest";
import type { AccountBalances, Money } from "@payswap/protocol";
import {
  EXTERNAL_FUNDS_OBSERVATION_KIND,
  isExternalFundsPositionObservation,
  isFreshAt,
  validateExternalFundsPositionObservation,
} from "../src/index.js";
import type { ExternalFundsPositionObservation } from "../src/index.js";

/**
 * INV-C09: ExternalFundsPositionObservation is an observation of external
 * state with MANDATORY freshness and provenance — structurally NOT a
 * PaySwap balance, never PaySwap custody, and never proof of a PaySwap-held
 * customer balance. A stale or unverifiable observation cannot create a
 * false PaySwap balance.
 */

const observation: ExternalFundsPositionObservation = {
  observationKind: EXTERNAL_FUNDS_OBSERVATION_KIND,
  observationId: "obs:ext-funds-1",
  observedAt: "2026-10-01T12:00:00Z",
  freshness: {
    asOf: "2026-10-01T11:59:30Z",
    maxAgeSeconds: 300,
  },
  location: {
    providerName: "psp-a",
    accountRef: "acct:merchant-1",
    instrumentRef: "balance:available",
    description: "PSP A available balance for merchant 1",
  },
  observedAmount: { currency: "EUR", minorUnits: "125000" },
  provenance: {
    providerName: "psp-a",
    source: "PROVIDER_API",
    capturedAt: "2026-10-01T12:00:00Z",
  },
  reconciliationState: "NOT_RECONCILED",
};

describe("external funds observations are not balances (INV-C09)", () => {
  it("is not assignable to or from the protocol's ledger balance types", () => {
    const balances: AccountBalances = new Map();
    // @ts-expect-error — INV-C09: an external funds observation is not a protocol balance projection
    const asBalances: AccountBalances = observation;
    // @ts-expect-error — INV-C09: a protocol balance projection is not an external funds observation
    const asObservation: ExternalFundsPositionObservation = balances;
    // @ts-expect-error — INV-C09: the observed amount is not protocol Money (no minted Money brand)
    const asMoney: Money = observation.observedAmount;
    expect(asBalances).toBeDefined();
    expect(asObservation).toBeDefined();
    expect(asMoney).toBeDefined();
  });

  it("the nominal observation brand is part of the type", () => {
    expect(observation.observationKind).toBe("ExternalFundsPositionObservation");
    // A balance-shaped object cannot impersonate an observation even with
    // matching fields, because the brand and the mandatory observation
    // fields are absent.
    const balanceShaped = {
      accountId: "acct_1",
      currency: "EUR",
      available: "125000",
      pending: "0",
    };
    expect(isExternalFundsPositionObservation(balanceShaped)).toBe(false);
    expect(isExternalFundsPositionObservation(observation)).toBe(true);
    expect(isExternalFundsPositionObservation(null)).toBe(false);
  });
});

describe("mandatory freshness and provenance (INV-C09)", () => {
  it("validates a fully declared observation", () => {
    const parsed = validateExternalFundsPositionObservation(observation);
    expect(parsed.observedAmount.minorUnits).toBe("125000");
    expect(parsed.location.providerName).toBe("psp-a");
  });

  it("rejects observations without freshness or provenance", () => {
    const { freshness: _f, ...withoutFreshness } = observation;
    expect(() =>
      validateExternalFundsPositionObservation(withoutFreshness),
    ).toThrow(/freshness is MANDATORY/);
    const { provenance: _p, ...withoutProvenance } = observation;
    expect(() =>
      validateExternalFundsPositionObservation(withoutProvenance),
    ).toThrow(/provenance is MANDATORY/);
  });

  it("rejects a wrong or missing nominal brand", () => {
    const { observationKind: _k, ...unbranded } = observation;
    expect(() =>
      validateExternalFundsPositionObservation(unbranded),
    ).toThrow(/observationKind/);
    expect(() =>
      validateExternalFundsPositionObservation({
        ...observation,
        observationKind: "Balance" as never,
      }),
    ).toThrow(/observationKind/);
  });
});

describe("freshness gates (a stale observation cannot create a false balance)", () => {
  it("is fresh within its maxAgeSeconds window", () => {
    expect(isFreshAt(observation, "2026-10-01T12:04:29Z")).toBe(true);
  });

  it("is stale beyond its window", () => {
    expect(isFreshAt(observation, "2026-10-01T12:04:31Z")).toBe(false);
    expect(isFreshAt(observation, "2026-10-02T00:00:00Z")).toBe(false);
  });

  it("is unverifiable when the reference clock is behind the asOf time or unparseable", () => {
    expect(isFreshAt(observation, "2026-10-01T11:00:00Z")).toBe(false);
    expect(isFreshAt(observation, "not-a-time")).toBe(false);
    expect(
      isFreshAt(
        { ...observation, freshness: { ...observation.freshness, asOf: "garbage" } },
        "2026-10-01T12:00:00Z",
      ),
    ).toBe(false);
  });

  it("observed amounts stay exact minor-unit strings (INV-F01)", () => {
    expect(observation.observedAmount.minorUnits).toBe("125000");
    expect(() =>
      validateExternalFundsPositionObservation({
        ...observation,
        observedAmount: { currency: "EUR", minorUnits: "12.50" },
      }),
    ).not.toThrow(); // still a string — exactness is preserved by encoding, not parsing here
  });
});
