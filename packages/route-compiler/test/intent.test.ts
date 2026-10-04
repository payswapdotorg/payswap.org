/**
 * The canonical Money Movement Intent validation laws (Work Order P4-W4-001).
 *
 * validateMoneyMovementIntent is FAIL-CLOSED: it never repairs, never guesses,
 * never defaults. This suite proves every law of the intent contract
 * adversarially —
 *
 * - identity fields are non-empty strings (intentId, principalRef,
 *   intentAuthorizationRef) — an intent without identity or without its
 *   authorization artifact reference is nothing;
 * - origins and destinations are OBSERVATION-GROUNDED references with a known
 *   kind, canonical chain keys and canonical asset ids
 *   (`${chainKey}/asset:${symbol}`) — never balances, never custody;
 * - money is exact: /^[A-Z]{3}$/ symbols/currencies (the AmountSpec law),
 *   a POSITIVE integer-minor-unit originAmount whose currency matches the
 *   origin, and an arrivalCurrency that matches the destination;
 * - timing is bounded: positive maxSettlementMs, an integer maxRouteHops in
 *   [1, 8] (an unbounded hop count is never authorized), and an expiry
 *   strictly after the declaration instant;
 * - the validated intent is FROZEN and carries EXACTLY the 11 canonical
 *   fields — no balance, no custody, no held-amount state: the intent is
 *   references only (funding is proven at compile time by fresh canonical
 *   observations, never by the intent itself).
 */

import { describe, expect, it } from "vitest";
import {
  validateMoneyMovementIntent,
  InvalidMoneyMovementIntentError,
} from "../src/index.js";
import type { MoneyMovementIntent } from "../src/index.js";
import {
  route1Intent,
  route2Intent,
  route3Intent,
  route4Intent,
} from "./fixtures.js";

/** The 11 canonical fields — and NOTHING else (no balance/custody state). */
const CANONICAL_INTENT_KEYS = [
  "arrivalCurrency",
  "declaredAt",
  "destination",
  "expiresAt",
  "intentAuthorizationRef",
  "intentId",
  "maxRouteHops",
  "maxSettlementMs",
  "origin",
  "originAmount",
  "principalRef",
] as const;

function expectReject(candidate: unknown, message: RegExp): void {
  expect(() => validateMoneyMovementIntent(candidate)).toThrow(
    InvalidMoneyMovementIntentError,
  );
  expect(() => validateMoneyMovementIntent(candidate)).toThrow(message);
}

/** One-field mutation of the valid route-1 base (shallow or one level deep). */
function mutated(
  base: MoneyMovementIntent,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { ...base, ...patch };
}

describe("MoneyMovementIntent validation (fail closed, never repairs)", () => {
  it("rejects null, undefined and non-object candidates", () => {
    expectReject(null, /a Money Movement Intent is required/);
    expectReject(undefined, /a Money Movement Intent is required/);
    expectReject("intent:route-1", /a Money Movement Intent is required/);
    expectReject(42, /a Money Movement Intent is required/);
    // An array is structurally an object but carries no intent fields —
    // fail-closed on the first field check, never accepted.
    expect(() => validateMoneyMovementIntent([])).toThrow(
      InvalidMoneyMovementIntentError,
    );
    expect(() => validateMoneyMovementIntent([])).toThrow(/intentId/);
  });

  it("rejects empty identity fields (intentId, principalRef, intentAuthorizationRef)", () => {
    expectReject(mutated(route1Intent(), { intentId: "" }), /intentId/);
    expectReject(mutated(route1Intent(), { principalRef: "" }), /principalRef/);
    expectReject(
      mutated(route1Intent(), { intentAuthorizationRef: "" }),
      /intentAuthorizationRef/,
    );
  });

  it("rejects an unknown origin kind (the origin vocabulary is closed)", () => {
    expectReject(
      mutated(route1Intent(), { origin: { kind: "CUSTODY_ACCOUNT", accountRef: "a" } }),
      /origin\.kind must be one of/,
    );
    expectReject(
      mutated(route1Intent(), { origin: { kind: "ONCHAIN_WALLET" } }),
      /origin\.chainKey/,
    );
  });

  it("rejects a non-canonical chain key (the canonical chain vocabulary)", () => {
    expectReject(
      mutated(route1Intent(), {
        origin: { ...route1Intent().origin, chainKey: "ethereum" },
      }),
      /canonical chain key/,
    );
    expectReject(
      mutated(route1Intent(), {
        origin: { ...route1Intent().origin, chainKey: "ethereum-mainnet" },
      }),
      /canonical chain key/,
    );
    expectReject(
      mutated(route3Intent(), {
        destination: { ...route3Intent().destination, chainKey: "solana" },
      }),
      /canonical chain key/,
    );
  });

  it("rejects an assetId that is not the canonical `${chainKey}/asset:${symbol}`", () => {
    expectReject(
      mutated(route1Intent(), {
        origin: {
          ...route1Intent().origin,
          assetId: "ethereum:mainnet/asset:USC",
        },
      }),
      /must be the canonical asset reference 'ethereum:mainnet\/asset:ETH'/,
    );
    expectReject(
      mutated(route1Intent(), {
        origin: { ...route1Intent().origin, assetId: "0xbbbb222222222222222222222222222222222222" },
      }),
      /must be the canonical asset reference/,
    );
    expectReject(
      mutated(route3Intent(), {
        destination: {
          ...route3Intent().destination,
          assetId: "ethereum:mainnet/asset:USC",
        },
      }),
      /must be the canonical asset reference 'solana:mainnet-beta\/asset:USC'/,
    );
  });

  it("rejects symbols and currencies that are not uppercase 3-letter codes", () => {
    expectReject(
      mutated(route1Intent(), {
        origin: { ...route1Intent().origin, symbol: "ETHE" },
      }),
      /3-letter/,
    );
    expectReject(
      mutated(route1Intent(), {
        origin: { ...route1Intent().origin, symbol: "eth" },
      }),
      /3-letter/,
    );
    expectReject(
      mutated(route2Intent(), {
        origin: { ...route2Intent().origin, currency: "EURO" },
      }),
      /3-letter/,
    );
    expectReject(
      mutated(route1Intent(), {
        destination: { ...route1Intent().destination, currency: "eUr" },
      }),
      /3-letter/,
    );
    expectReject(
      mutated(route1Intent(), { arrivalCurrency: "EURO" }),
      /3-letter/,
    );
    expectReject(
      mutated(route4Intent(), {
        destination: { ...route4Intent().destination, currency: "DOLLAR" },
      }),
      /3-letter/,
    );
  });

  it("rejects a zero origin amount (a value transfer moves value)", () => {
    expectReject(
      mutated(route1Intent(), {
        originAmount: { currency: "ETH", minorUnits: "0" },
      }),
      /originAmount must be positive/,
    );
    expectReject(
      mutated(route1Intent(), { originAmount: undefined }),
      /originAmount must be a canonical exact-integer AmountSpec/,
    );
    expectReject(
      mutated(route1Intent(), {
        originAmount: { currency: "ETH", minorUnits: "-5" },
      }),
      /originAmount must be a canonical exact-integer AmountSpec/,
    );
  });

  it("rejects an originAmount currency that does not match the origin asset symbol / account currency", () => {
    // ONCHAIN_WALLET origin: the amount must be in the origin asset symbol.
    expectReject(
      mutated(route1Intent(), {
        originAmount: { currency: "USC", minorUnits: "1000000" },
      }),
      /originAmount currency 'USC' must match the origin asset symbol 'ETH'/,
    );
    // EXTERNAL_PROVIDER_ACCOUNT origin: the amount must be the account currency.
    expectReject(
      mutated(route2Intent(), {
        originAmount: { currency: "USD", minorUnits: "10000" },
      }),
      /originAmount currency 'USD' must match the origin account currency 'EUR'/,
    );
  });

  it("rejects an arrivalCurrency that does not match the destination", () => {
    expectReject(
      mutated(route1Intent(), { arrivalCurrency: "USD" }),
      /arrivalCurrency 'USD' must match the destination currency 'EUR'/,
    );
    // ONCHAIN_RECIPIENT destination: the arrival is the destination asset symbol.
    expectReject(
      mutated(route3Intent(), { arrivalCurrency: "ETH" }),
      /arrivalCurrency 'ETH' must match the destination asset symbol 'USC'/,
    );
    expectReject(
      mutated(route4Intent(), { arrivalCurrency: "EUR" }),
      /arrivalCurrency 'EUR' must match the destination currency 'USD'/,
    );
  });

  it("rejects a non-positive maxSettlementMs", () => {
    expectReject(
      mutated(route1Intent(), { maxSettlementMs: 0 }),
      /maxSettlementMs must be positive/,
    );
    expectReject(
      mutated(route1Intent(), { maxSettlementMs: -1 }),
      /maxSettlementMs must be a non-negative integer/,
    );
  });

  it("rejects maxRouteHops 0, 9 and non-integers (bounded hops only)", () => {
    expectReject(
      mutated(route1Intent(), { maxRouteHops: 0 }),
      /maxRouteHops must be an integer in \[1, 8\]/,
    );
    expectReject(
      mutated(route1Intent(), { maxRouteHops: 9 }),
      /maxRouteHops must be an integer in \[1, 8\]/,
    );
    expectReject(
      mutated(route1Intent(), { maxRouteHops: 2.5 }),
      /maxRouteHops must be an integer in \[1, 8\]/,
    );
    expectReject(
      mutated(route1Intent(), { maxRouteHops: "six" }),
      /maxRouteHops must be an integer in \[1, 8\]/,
    );
  });

  it("rejects expiresAt <= declaredAt (an expired window compiles nothing)", () => {
    const base = route1Intent();
    expectReject(
      mutated(base, { expiresAt: base.declaredAt }),
      /expiresAt must be strictly after declaredAt/,
    );
    expectReject(
      mutated(base, { expiresAt: base.declaredAt - 1 }),
      /expiresAt must be strictly after declaredAt/,
    );
  });

  it("accepts all four representative fixture intents, frozen and value-faithful", () => {
    const intents: readonly MoneyMovementIntent[] = [
      route1Intent(),
      route2Intent(),
      route3Intent(),
      route4Intent(),
    ];
    for (const intent of intents) {
      const validated = validateMoneyMovementIntent(intent);
      expect(validated).toEqual(intent);
      expect(Object.isFrozen(validated)).toBe(true);
      expect(Object.isFrozen(validated.origin)).toBe(true);
      expect(Object.isFrozen(validated.destination)).toBe(true);
      // The exact canonical key set — nothing more, nothing less.
      expect(Object.keys(validated).sort()).toEqual([...CANONICAL_INTENT_KEYS]);
    }
  });

  it("the intent carries NO balance/custody state — it is references only", () => {
    const validated = validateMoneyMovementIntent(route1Intent());
    const serialized = JSON.stringify(validated).toLowerCase();
    for (const forbidden of ["balance", "available", "held", "custody", "locked"]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
    // The frozen object exposes exactly the 11 canonical fields: no key can
    // smuggle balance/custody state onto the single source of truth.
    expect(Object.keys(validated)).toHaveLength(11);
    expect(Object.keys(validated.origin).sort()).toEqual([
      "accountRef",
      "assetId",
      "chainKey",
      "kind",
      "symbol",
    ]);
    expect(Object.keys(validated.destination).sort()).toEqual([
      "currency",
      "externalRef",
      "kind",
    ]);
    expect(Object.keys(validated.originAmount).sort()).toEqual([
      "currency",
      "minorUnits",
    ]);
  });
});
