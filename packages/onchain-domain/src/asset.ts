/**
 * @payswap/onchain-domain — asset definitions and observations (P4-W1-001).
 *
 * Assets are DESCRIPTIVE catalogue vocabulary: an AssetDefinition declares
 * what an onchain asset IS (identity, class, exact minor-unit scale, chain
 * scope, provenance). An AssetObservation is an OBSERVATION of external
 * state — a time-stamped report of an amount at an external onchain
 * location, with MANDATORY freshness, provenance and observer identity.
 *
 * INV-C09 / AGENTS.md rule 21 (external balances are observations): an
 * AssetObservation is NEVER PaySwap custody and NEVER a customer balance.
 * It is structurally distinct from any ledger/balance type (nominal
 * `observationKind` brand; no mutable balance-shaped field; mandatory
 * freshness/provenance/observer). It may inform routing, timing and
 * reconciliation only according to its provenance and freshness — it can
 * never be booked as an internal balance. This package constructs NO
 * protocol Money and exposes NO balance arithmetic: money truth stays in
 * the canonical settlement machinery (see ./settlement-mapping.js).
 *
 * INV-F01 (exact money): asset amounts are integer minor units,
 * string-encoded for exactness. Floating-point amounts are rejected.
 */

import { ValidationError } from "@payswap/protocol";
import type { ProvenanceDescriptor } from "@payswap/capabilities";
import type { ObservationFreshness, ObservationProvenance } from "@payswap/connectors";
import { isValidChainKey } from "./family.js";
import type { AssetFamilyExtension } from "./family-extensions.js";
import { validateAssetFamilyExtension } from "./family-extensions.js";

// ---------------------------------------------------------------------------
// Asset definitions (descriptive catalogue — never authority)
// ---------------------------------------------------------------------------

export const ASSET_CLASSES = [
  "NATIVE",
  "TOKEN",
  "WRAPPED",
  "BRIDGED",
  "OTHER",
] as const;

export type AssetClass = (typeof ASSET_CLASSES)[number];

export function isAssetClass(value: unknown): value is AssetClass {
  return (
    typeof value === "string" &&
    (ASSET_CLASSES as readonly unknown[]).includes(value)
  );
}

/**
 * A declared peg claim (descriptive, with provenance). A peg declaration is
 * a CLAIM, never an assumption and never evidence of backing.
 */
export interface PegDeclaration {
  readonly pegKind: "FIAT_PEGGED" | "ASSET_PEGGED" | "UNPEGGED";
  readonly declaredBy: string;
}

/**
 * A declared maximum minor-unit exponent for onchain assets (broader than
 * the ISO-style currency registry bound; still exact integers only).
 */
export const MAX_ASSET_MINOR_UNIT_DIGITS = 18;

/**
 * An onchain asset as a descriptive catalogue entry: canonical identity,
 * symbol, class, exact minor-unit scale, chain scope, optional declared peg
 * claim, provenance and the optional family-scoped extension. Carries NO
 * authorization scope of any kind — asset catalogues never authorize.
 */
export interface AssetDefinition {
  /** Canonical asset identity: `${chainKey}/asset:${symbol}`. */
  readonly assetId: string;
  readonly symbol: string;
  readonly displayName: string;
  readonly assetClass: AssetClass;
  /** Exact integer minor-unit scale (INV-F01). */
  readonly minorUnitDigits: number;
  readonly chainKey: string;
  /** Optional declared peg claim — a claim, never an assumption. */
  readonly declaredPeg?: PegDeclaration;
  readonly provenance: ProvenanceDescriptor;
  /** Optional family-scoped extension — never required by core contracts. */
  readonly familyExtension?: AssetFamilyExtension;
}

/** Deterministic asset identity: `${chainKey}/asset:${symbol}`. */
export function canonicalAssetRef(chainKey: string, symbol: string): string {
  return `${chainKey}/asset:${symbol}`;
}

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const MINOR_UNITS_PATTERN = /^(0|[1-9][0-9]*)$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Runtime validation for an asset definition from untyped sources.
 * Deterministic rules:
 * - assetId === canonicalAssetRef(chainKey, symbol) (deterministic identity);
 * - minorUnitDigits is an integer 0..18 (exact minor-unit scale);
 * - chainKey is canonical; symbol is canonical;
 * - a declared peg is a well-formed claim;
 * - catalogue provenance is present (descriptive declarations carry
 *   provenance — an anonymous asset claim is rejected);
 * - an optional family extension is well-formed.
 */
export function validateAssetDefinition(candidate: unknown): AssetDefinition {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("asset definition must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (!isNonEmptyString(record.symbol) || !SYMBOL_PATTERN.test(record.symbol)) {
    errors.push("symbol must match /^[A-Z0-9][A-Z0-9._-]{0,31}$/");
  }
  if (!isNonEmptyString(record.displayName)) {
    errors.push("displayName must be a non-empty string");
  }
  if (!isAssetClass(record.assetClass)) {
    errors.push(`assetClass must be one of [${ASSET_CLASSES.join(", ")}]`);
  }
  if (!isValidChainKey(record.chainKey)) {
    errors.push("chainKey must be a canonical `${namespace}:${network}` chain key");
  }
  if (
    typeof record.minorUnitDigits !== "number" ||
    !Number.isInteger(record.minorUnitDigits) ||
    record.minorUnitDigits < 0 ||
    record.minorUnitDigits > MAX_ASSET_MINOR_UNIT_DIGITS
  ) {
    errors.push(
      `minorUnitDigits must be an integer between 0 and ${MAX_ASSET_MINOR_UNIT_DIGITS} (exact integer minor units — INV-F01)`,
    );
  }
  const peg = record.declaredPeg;
  let parsedPeg: PegDeclaration | undefined;
  if (peg !== undefined) {
    if (
      peg === null ||
      typeof peg !== "object" ||
      (peg as Readonly<Record<string, unknown>>).pegKind === undefined ||
      !["FIAT_PEGGED", "ASSET_PEGGED", "UNPEGGED"].includes(
        String((peg as Readonly<Record<string, unknown>>).pegKind),
      ) ||
      !isNonEmptyString((peg as Readonly<Record<string, unknown>>).declaredBy)
    ) {
      errors.push(
        "declaredPeg, when present, must be { pegKind: FIAT_PEGGED | ASSET_PEGGED | UNPEGGED, declaredBy }",
      );
    } else {
      parsedPeg = {
        pegKind: (peg as PegDeclaration).pegKind,
        declaredBy: (peg as PegDeclaration).declaredBy,
      };
    }
  }
  const provenance = record.provenance;
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    !isNonEmptyString((provenance as Readonly<Record<string, unknown>>).declaredBy) ||
    !isNonEmptyString((provenance as Readonly<Record<string, unknown>>).artifactRef) ||
    !isNonEmptyString((provenance as Readonly<Record<string, unknown>>).contentHash)
  ) {
    errors.push(
      "provenance must be a ProvenanceDescriptor { declaredBy, artifactRef, contentHash } — a catalogue entry without provenance is rejected",
    );
  }
  const familyExtension = record.familyExtension;
  if (familyExtension !== undefined) {
    try {
      validateAssetFamilyExtension(familyExtension);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (isNonEmptyString(record.symbol) && isValidChainKey(record.chainKey)) {
    const expectedId = canonicalAssetRef(record.chainKey, record.symbol);
    if (record.assetId !== expectedId) {
      errors.push(
        `asset identity is deterministic: assetId must be '${expectedId}' for symbol '${record.symbol}' on chain '${record.chainKey}'`,
      );
    }
  } else if (!isNonEmptyString(record.assetId)) {
    errors.push("assetId must be a non-empty string");
  }

  if (errors.length > 0) {
    throw new ValidationError(`Invalid asset definition: ${errors.join("; ")}`, {
      errors: [...errors],
    });
  }

  const parsedFamilyExtension =
    familyExtension !== undefined ? validateAssetFamilyExtension(familyExtension) : undefined;
  return Object.freeze({
    assetId: record.assetId as string,
    symbol: record.symbol as string,
    displayName: record.displayName as string,
    assetClass: record.assetClass as AssetClass,
    minorUnitDigits: record.minorUnitDigits as number,
    chainKey: record.chainKey as string,
    provenance: Object.freeze({ ...(record.provenance as ProvenanceDescriptor) }),
    ...(parsedPeg !== undefined ? { declaredPeg: Object.freeze(parsedPeg) } : {}),
    ...(parsedFamilyExtension !== undefined ? { familyExtension: parsedFamilyExtension } : {}),
  });
}

// ---------------------------------------------------------------------------
// Exact asset amounts (INV-F01)
// ---------------------------------------------------------------------------

/** Exact onchain asset amount: integer minor units, string-encoded. */
export interface AssetAmount {
  readonly assetId: string;
  readonly minorUnits: string;
}

/**
 * Validates an exact asset amount: non-empty asset id and a non-negative
 * integer decimal string. Floating-point shapes ('1.5', '1e7', '0x10'),
 * negative values and leading zeros are rejected (INV-F01).
 */
export function validateAssetAmount(amount: AssetAmount): void {
  if (amount === null || typeof amount !== "object") {
    throw new ValidationError("asset amount must be an object");
  }
  if (!isNonEmptyString(amount.assetId)) {
    throw new ValidationError("assetId must be a non-empty string");
  }
  if (typeof amount.minorUnits !== "string" || !MINOR_UNITS_PATTERN.test(amount.minorUnits)) {
    throw new ValidationError(
      `minorUnits must be a non-negative integer decimal string without leading zeros (exact integer minor units — INV-F01; no floating-point money), got '${String(amount.minorUnits)}'`,
    );
  }
}

/** Parses the exact minor units of a validated asset amount. */
export function parseAssetAmountMinorUnits(amount: AssetAmount): bigint {
  validateAssetAmount(amount);
  return BigInt(amount.minorUnits);
}

// ---------------------------------------------------------------------------
// Asset observations (external state — NEVER custody, NEVER a balance)
// ---------------------------------------------------------------------------

/** Nominal brand: this value is an external observation, never a balance. */
export const ASSET_OBSERVATION_KIND = "AssetObservation" as const;

/** Who observed the external position (observer identity is mandatory). */
export interface OnchainObserverIdentity {
  /** Opaque observer id (a connector/indexer/operator reference — never key material). */
  readonly observerId: string;
  readonly observerKind:
    | "CHAIN_NODE"
    | "INDEXER"
    | "RPC_PROVIDER"
    | "WALLET_PROVIDER"
    | "OPERATOR"
    | "OTHER";
}

/**
 * An external onchain location where an asset position may reside: the
 * chain plus an opaque holder account/address reference. This is a
 * provider-neutral location shape — family-specific address formats live in
 * family extensions and adapters, never here.
 */
export interface OnchainFundsLocation {
  readonly chainKey: string;
  /** The external holder account/address reference (opaque, neutral). */
  readonly accountRef: string;
  /** Optional instrument reference (e.g. a token account), opaque. */
  readonly instrumentRef?: string;
}

/**
 * A time-stamped observation of an onchain asset position at an external
 * location (INV-C09 / rule 21).
 *
 * STRUCTURALLY NOT A BALANCE: the nominal `observationKind` brand plus the
 * MANDATORY freshness, provenance and observer identity make it
 * non-assignable to and from any ledger/balance type. There is deliberately
 * no mutable balance-shaped field and NO path from this type to PaySwap
 * custody or a customer balance. It can inform routing, payout timing,
 * netting and reconciliation only according to its provenance and
 * freshness.
 */
export interface AssetObservation {
  readonly observationKind: typeof ASSET_OBSERVATION_KIND;
  readonly observationId: string;
  readonly observedAt: string;
  readonly assetId: string;
  readonly chainKey: string;
  readonly location: OnchainFundsLocation;
  /**
   * Exact observed amount. The currency field carries the ASSET id (the
   * shape is the canonical exact-minor-units wire shape; PaySwap money is
   * ISO-currency-scoped and is constructed by the protocol, never here).
   */
  readonly observedAmount: { readonly currency: string; readonly minorUnits: string };
  readonly freshness: ObservationFreshness;
  readonly provenance: ObservationProvenance;
  readonly observer: OnchainObserverIdentity;
}

/**
 * Runtime validation for an asset observation. Freshness, provenance and
 * observer identity are MANDATORY: an observation without them is not
 * evidence of anything. Deterministic consistency rules:
 * - location.chainKey === chainKey;
 * - observedAmount.currency === assetId (the observed amount is in the
 *   observed asset);
 * - minorUnits are exact integer minor units (INV-F01).
 */
export function validateAssetObservation(candidate: unknown): AssetObservation {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("asset observation must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (record.observationKind !== ASSET_OBSERVATION_KIND) {
    errors.push(
      `observationKind must be '${ASSET_OBSERVATION_KIND}' (nominal separation from ledger/balance types — INV-C09)`,
    );
  }
  for (const field of ["observationId", "observedAt", "assetId"] as const) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!isValidChainKey(record.chainKey)) {
    errors.push("chainKey must be a canonical chain key");
  }
  const location = record.location;
  if (
    location === null ||
    typeof location !== "object" ||
    !isValidChainKey((location as Readonly<Record<string, unknown>>).chainKey) ||
    !isNonEmptyString((location as Readonly<Record<string, unknown>>).accountRef)
  ) {
    errors.push(
      "location must be { chainKey, accountRef, instrumentRef? } (an external onchain funds location)",
    );
  } else if (
    (location as OnchainFundsLocation).chainKey !== record.chainKey
  ) {
    errors.push("location.chainKey must match the observation's chainKey");
  }
  const amount = record.observedAmount;
  if (
    amount === null ||
    typeof amount !== "object" ||
    !isNonEmptyString((amount as Readonly<Record<string, unknown>>).currency) ||
    typeof (amount as Readonly<Record<string, unknown>>).minorUnits !== "string" ||
    !MINOR_UNITS_PATTERN.test(String((amount as Readonly<Record<string, unknown>>).minorUnits))
  ) {
    errors.push(
      "observedAmount must be { currency, minorUnits } with exact integer minor units (INV-F01)",
    );
  } else if ((amount as { currency: string }).currency !== record.assetId) {
    errors.push(
      "observedAmount.currency must equal the observed assetId (the amount is denominated in the observed asset)",
    );
  }
  const freshness = record.freshness;
  if (freshness === null || typeof freshness !== "object") {
    errors.push("freshness is MANDATORY on every asset observation (INV-C09)");
  } else {
    const fresh = freshness as Readonly<Record<string, unknown>>;
    if (!isNonEmptyString(fresh.asOf)) {
      errors.push("freshness.asOf must be a non-empty timestamp string");
    }
    if (
      typeof fresh.maxAgeSeconds !== "number" ||
      !Number.isInteger(fresh.maxAgeSeconds) ||
      fresh.maxAgeSeconds <= 0
    ) {
      errors.push("freshness.maxAgeSeconds must be a positive integer");
    }
  }
  const provenance = record.provenance;
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    !isNonEmptyString((provenance as Readonly<Record<string, unknown>>).providerName) ||
    !isNonEmptyString((provenance as Readonly<Record<string, unknown>>).capturedAt)
  ) {
    errors.push("provenance is MANDATORY on every asset observation (INV-C09)");
  }
  const observer = record.observer;
  if (
    observer === null ||
    typeof observer !== "object" ||
    !isNonEmptyString((observer as Readonly<Record<string, unknown>>).observerId)
  ) {
    errors.push("observer identity is MANDATORY on every asset observation (INV-C09)");
  } else {
    const observerKind = (observer as Readonly<Record<string, unknown>>).observerKind;
    const validKinds = [
      "CHAIN_NODE",
      "INDEXER",
      "RPC_PROVIDER",
      "WALLET_PROVIDER",
      "OPERATOR",
      "OTHER",
    ];
    if (!validKinds.includes(String(observerKind))) {
      errors.push(`observer.observerKind must be one of [${validKinds.join(", ")}]`);
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(`Invalid asset observation: ${errors.join("; ")}`, {
      errors: [...errors],
    });
  }
  return candidate as AssetObservation;
}
