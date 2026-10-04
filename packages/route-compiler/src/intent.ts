/**
 * @payswap/route-compiler — the canonical Money Movement Intent
 * (Work Order P4-W4-001).
 *
 * DOMAIN-MODEL (§ "intent"): "EconomicGoal; EconomicProgram;
 * MoneyMovementIntent; ServiceAccessIntent; IntentArchetype; constraints;
 * compiler contracts". No intent package existed in the repository before
 * this work order; this module declares the canonical MoneyMovementIntent —
 * AN EXECUTABLE VALUE-TRANSFER DEMAND (FROZEN-ARCHITECTURE §1) — as the
 * compiler's input contract, and it is the SINGLE SOURCE OF TRUTH for the
 * movement being compiled (the no-duplicate-ledger law):
 *
 * - every route plan and every route leg REFERENCES the intent
 *   (`intentRef: intentId`) and never re-declares the origin, destination,
 *   amount or authorization of the movement;
 * - the intent is DELIBERATELY MINIMAL: it says WHAT moves (origin amount),
 *   WHERE FROM (a funds origin), WHERE TO (a funds destination), for WHOM
 *   (principal ref), under WHICH authorization artifact
 *   (`intentAuthorizationRef` — an opaque reference to the trust-plane
 *   authorization artifact; this package never re-declares that authority)
 *   and under which timing constraints. HOW it moves is the compiler's
 *   output, never the intent's content;
 * - money is exact integer minor units (INV-F01) via the canonical
 *   trust-plane AmountSpec; onchain symbols and fiat currencies share the
 *   same /^[A-Z]{3}$/ shape exactly as the venue-port and AmountSpec laws
 *   already require;
 * - origins and destinations are OBSERVATION-GROUNDED references (a wallet
 *   account on a chain, an external provider account, an external bank
 *   account, a Stripe merchant balance reference) — they are NOT balances
 *   and NOT custody: the movement's funding is proven at compile time by
 *   fresh canonical observations (the observation law), never by the intent
 *   itself;
 * - no raw secret material can appear on an intent (fail-closed validation
 *   mirrors the kernel secret law — assertNoSecretMaterial is applied by the
 *   callers that build kernel artifacts from these shapes).
 */

import { ValidationError } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/trust";
import { validateAmountSpec } from "@payswap/trust";
import { isValidChainKey } from "@payswap/onchain-domain";

/** Raised when a Money Movement Intent violates its contract (fail closed). */
export class InvalidMoneyMovementIntentError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyMovementIntentError";
  }
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidMoneyMovementIntentError(
      `MoneyMovementIntent.${field} must be a non-empty string`,
    );
  }
  return value;
}

function requireCurrency(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field);
  if (!CURRENCY_PATTERN.test(text)) {
    throw new InvalidMoneyMovementIntentError(
      `MoneyMovementIntent.${field} '${text}' must be an uppercase 3-letter currency/symbol code (the AmountSpec law)`,
    );
  }
  return text;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidMoneyMovementIntentError(
      `MoneyMovementIntent.${field} must be a non-negative integer (caller-supplied, no ambient clock)`,
    );
  }
  return value;
}

/** Where the money starts: a principal-controlled onchain wallet, or an external provider account. */
export type IntentFundsOrigin =
  | {
      readonly kind: "ONCHAIN_WALLET";
      readonly chainKey: string;
      readonly accountRef: string;
      /** Canonical onchain asset reference (`${chainKey}/asset:${symbol}`). */
      readonly assetId: string;
      readonly symbol: string;
    }
  | {
      readonly kind: "EXTERNAL_PROVIDER_ACCOUNT";
      readonly providerName: string;
      readonly accountRef: string;
      readonly currency: string;
    };

/** Where the money must arrive: an external bank account, an onchain recipient, or a Stripe merchant balance. */
export type IntentFundsDestination =
  | {
      readonly kind: "BANK_ACCOUNT";
      /** The external bank reference exactly as the payout provider addresses it. */
      readonly externalRef: string;
      readonly currency: string;
    }
  | {
      readonly kind: "ONCHAIN_RECIPIENT";
      readonly chainKey: string;
      readonly accountRef: string;
      readonly assetId: string;
      readonly symbol: string;
    }
  | {
      readonly kind: "STRIPE_MERCHANT_BALANCE";
      readonly stripeAccountRef: string;
      readonly currency: string;
    };

export const INTENT_FUNDS_ORIGIN_KINDS = [
  "ONCHAIN_WALLET",
  "EXTERNAL_PROVIDER_ACCOUNT",
] as const;

export const INTENT_FUNDS_DESTINATION_KINDS = [
  "BANK_ACCOUNT",
  "ONCHAIN_RECIPIENT",
  "STRIPE_MERCHANT_BALANCE",
] as const;

/**
 * The canonical Money Movement Intent: ONE executable value-transfer demand.
 * The single source of truth every compiled route plan references.
 */
export interface MoneyMovementIntent {
  /** Deterministic intent identity (e.g. `intent:<tenant>:<id>`). */
  readonly intentId: string;
  /** Principal reference (opaque; the trust plane owns principal identity). */
  readonly principalRef: string;
  readonly origin: IntentFundsOrigin;
  readonly destination: IntentFundsDestination;
  /**
   * The exact amount leaving the origin (INV-F01). For ONCHAIN_WALLET
   * origins the currency is the origin asset symbol; for provider accounts
   * it is the provider account currency. Everything downstream (swap
   * inputs, payout amounts) is derived by the compiler from observations
   * and conversion groundings — never re-declared here.
   */
  readonly originAmount: AmountSpec;
  /** The currency/symbol the movement must arrive in. */
  readonly arrivalCurrency: string;
  readonly maxSettlementMs: number;
  readonly maxRouteHops: number;
  /**
   * The authorization artifact root of the movement — an opaque reference
   * (e.g. `authz:intent-001`). Every leg's authorization lineage references
   * it; this package never interprets or re-declares the authority itself.
   */
  readonly intentAuthorizationRef: string;
  /** Declared-at instant (ms, caller-supplied). */
  readonly declaredAt: number;
  /** Absolute expiry (ms): routes compiled after this instant are refused. */
  readonly expiresAt: number;
}

function validateOrigin(origin: unknown): IntentFundsOrigin {
  if (origin === null || typeof origin !== "object") {
    throw new InvalidMoneyMovementIntentError("MoneyMovementIntent.origin is required");
  }
  const record = origin as Readonly<Record<string, unknown>>;
  const kind = record["kind"];
  if (kind === "ONCHAIN_WALLET") {
    const chainKey = requireNonEmptyString(record["chainKey"], "origin.chainKey");
    if (!isValidChainKey(chainKey)) {
      throw new InvalidMoneyMovementIntentError(
        `MoneyMovementIntent.origin.chainKey '${chainKey}' must be a canonical chain key (<network>:<segment>)`,
      );
    }
    const symbol = requireCurrency(record["symbol"], "origin.symbol");
    const assetId = requireNonEmptyString(record["assetId"], "origin.assetId");
    if (assetId !== `${chainKey}/asset:${symbol}`) {
      throw new InvalidMoneyMovementIntentError(
        `MoneyMovementIntent.origin.assetId '${assetId}' must be the canonical asset reference '${chainKey}/asset:${symbol}'`,
      );
    }
    return Object.freeze({
      kind: "ONCHAIN_WALLET" as const,
      chainKey,
      accountRef: requireNonEmptyString(record["accountRef"], "origin.accountRef"),
      assetId,
      symbol,
    });
  }
  if (kind === "EXTERNAL_PROVIDER_ACCOUNT") {
    return Object.freeze({
      kind: "EXTERNAL_PROVIDER_ACCOUNT" as const,
      providerName: requireNonEmptyString(record["providerName"], "origin.providerName"),
      accountRef: requireNonEmptyString(record["accountRef"], "origin.accountRef"),
      currency: requireCurrency(record["currency"], "origin.currency"),
    });
  }
  throw new InvalidMoneyMovementIntentError(
    `MoneyMovementIntent.origin.kind must be one of [${INTENT_FUNDS_ORIGIN_KINDS.join(", ")}] (got: ${String(kind)})`,
  );
}

function validateDestination(destination: unknown): IntentFundsDestination {
  if (destination === null || typeof destination !== "object") {
    throw new InvalidMoneyMovementIntentError("MoneyMovementIntent.destination is required");
  }
  const record = destination as Readonly<Record<string, unknown>>;
  const kind = record["kind"];
  if (kind === "BANK_ACCOUNT") {
    return Object.freeze({
      kind: "BANK_ACCOUNT" as const,
      externalRef: requireNonEmptyString(record["externalRef"], "destination.externalRef"),
      currency: requireCurrency(record["currency"], "destination.currency"),
    });
  }
  if (kind === "ONCHAIN_RECIPIENT") {
    const chainKey = requireNonEmptyString(record["chainKey"], "destination.chainKey");
    if (!isValidChainKey(chainKey)) {
      throw new InvalidMoneyMovementIntentError(
        `MoneyMovementIntent.destination.chainKey '${chainKey}' must be a canonical chain key`,
      );
    }
    const symbol = requireCurrency(record["symbol"], "destination.symbol");
    const assetId = requireNonEmptyString(record["assetId"], "destination.assetId");
    if (assetId !== `${chainKey}/asset:${symbol}`) {
      throw new InvalidMoneyMovementIntentError(
        `MoneyMovementIntent.destination.assetId '${assetId}' must be the canonical asset reference '${chainKey}/asset:${symbol}'`,
      );
    }
    return Object.freeze({
      kind: "ONCHAIN_RECIPIENT" as const,
      chainKey,
      accountRef: requireNonEmptyString(record["accountRef"], "destination.accountRef"),
      assetId,
      symbol,
    });
  }
  if (kind === "STRIPE_MERCHANT_BALANCE") {
    return Object.freeze({
      kind: "STRIPE_MERCHANT_BALANCE" as const,
      stripeAccountRef: requireNonEmptyString(
        record["stripeAccountRef"],
        "destination.stripeAccountRef",
      ),
      currency: requireCurrency(record["currency"], "destination.currency"),
    });
  }
  throw new InvalidMoneyMovementIntentError(
    `MoneyMovementIntent.destination.kind must be one of [${INTENT_FUNDS_DESTINATION_KINDS.join(", ")}] (got: ${String(kind)})`,
  );
}

/**
 * Fail-closed structural validation of a Money Movement Intent. Returns a
 * frozen intent or throws InvalidMoneyMovementIntentError — never repairs,
 * never guesses.
 */
export function validateMoneyMovementIntent(candidate: unknown): MoneyMovementIntent {
  if (candidate === null || typeof candidate !== "object") {
    throw new InvalidMoneyMovementIntentError("a Money Movement Intent is required");
  }
  const record = candidate as Readonly<Record<string, unknown>>;

  const intentId = requireNonEmptyString(record["intentId"], "intentId");
  const principalRef = requireNonEmptyString(record["principalRef"], "principalRef");
  const origin = validateOrigin(record["origin"]);
  const destination = validateDestination(record["destination"]);

  const originAmount = record["originAmount"];
  try {
    validateAmountSpec(originAmount as AmountSpec);
  } catch {
    throw new InvalidMoneyMovementIntentError(
      "MoneyMovementIntent.originAmount must be a canonical exact-integer AmountSpec (INV-F01)",
    );
  }
  const amount = originAmount as AmountSpec;
  if (amount.minorUnits === "0") {
    throw new InvalidMoneyMovementIntentError(
      "MoneyMovementIntent.originAmount must be positive — a value transfer moves value (INV-F01)",
    );
  }
  const expectedOriginCurrency =
    origin.kind === "ONCHAIN_WALLET" ? origin.symbol : origin.currency;
  if (amount.currency !== expectedOriginCurrency) {
    throw new InvalidMoneyMovementIntentError(
      `MoneyMovementIntent.originAmount currency '${amount.currency}' must match the origin ${
        origin.kind === "ONCHAIN_WALLET" ? "asset symbol" : "account currency"
      } '${expectedOriginCurrency}'`,
    );
  }

  const arrivalCurrency = requireCurrency(record["arrivalCurrency"], "arrivalCurrency");
  const expectedArrival =
    destination.kind === "ONCHAIN_RECIPIENT" ? destination.symbol : destination.currency;
  if (arrivalCurrency !== expectedArrival) {
    throw new InvalidMoneyMovementIntentError(
      `MoneyMovementIntent.arrivalCurrency '${arrivalCurrency}' must match the destination ${
        destination.kind === "ONCHAIN_RECIPIENT" ? "asset symbol" : "currency"
      } '${expectedArrival}'`,
    );
  }

  const maxSettlementMs = (() => {
    const value = requireNonNegativeInteger(record["maxSettlementMs"], "maxSettlementMs");
    if (value <= 0) {
      throw new InvalidMoneyMovementIntentError(
        "MoneyMovementIntent.maxSettlementMs must be positive",
      );
    }
    return value;
  })();
  const maxRouteHops = (() => {
    const raw = record["maxRouteHops"];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 8) {
      throw new InvalidMoneyMovementIntentError(
        "MoneyMovementIntent.maxRouteHops must be an integer in [1, 8] — an unbounded hop count is never authorized",
      );
    }
    return raw;
  })();

  const intentAuthorizationRef = requireNonEmptyString(
    record["intentAuthorizationRef"],
    "intentAuthorizationRef",
  );
  const declaredAt = requireNonNegativeInteger(record["declaredAt"], "declaredAt");
  const expiresAt = requireNonNegativeInteger(record["expiresAt"], "expiresAt");
  if (expiresAt <= declaredAt) {
    throw new InvalidMoneyMovementIntentError(
      "MoneyMovementIntent.expiresAt must be strictly after declaredAt — an already-expired authorization window compiles nothing",
    );
  }

  return Object.freeze({
    intentId,
    principalRef,
    origin,
    destination,
    originAmount: amount,
    arrivalCurrency,
    maxSettlementMs,
    maxRouteHops,
    intentAuthorizationRef,
    declaredAt,
    expiresAt,
  });
}
