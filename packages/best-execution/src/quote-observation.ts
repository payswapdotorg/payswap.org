/**
 * @payswap/best-execution — the quote observation law (P4-W2-002).
 *
 * A venue quote is an OBSERVATION of external venue state (the onchain-domain
 * observation law, INV-C09 / rule 21 discipline): it is never financial
 * truth, never custody and never finality. Structural requirements mirrored
 * from the domain law:
 * - MANDATORY freshness: a quote without { asOfMs, maxAgeMs } is not
 *   evidence of anything and never validates;
 * - MANDATORY provenance: who produced it, through which source, when, with
 *   non-empty evidence references (INV-E02);
 * - MANDATORY observer identity: which observer captured it.
 *
 * Staleness is DETERMINISTIC: a quote is stale at instant `at` exactly when
 * (at − asOfMs) > maxAgeMs. At exactly maxAgeMs of age it is still fresh
 * (the bound is inclusive); one millisecond later it is not. There is no
 * ambient clock anywhere — every caller passes the instant.
 */

import { ValidationError } from "@payswap/protocol";

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** Freshness bounds of a quote observation (mandatory on every quote). */
export interface QuoteFreshness {
  /** The instant (ms) the quote was valid as of. */
  readonly asOfMs: number;
  /** The maximum tolerated age (ms) — a positive integer. */
  readonly maxAgeMs: number;
}

/** Validates quote freshness (fail closed: no freshness, no evidence). */
export function validateQuoteFreshness(freshness: QuoteFreshness): void {
  if (freshness === null || typeof freshness !== "object") {
    throw new ValidationError("quote freshness is MANDATORY (the observation law)");
  }
  if (
    !Number.isInteger(freshness.asOfMs) ||
    freshness.asOfMs < 0
  ) {
    throw new ValidationError("quote freshness.asOfMs must be a non-negative integer (ms)");
  }
  if (
    !Number.isInteger(freshness.maxAgeMs) ||
    freshness.maxAgeMs <= 0
  ) {
    throw new ValidationError(
      "quote freshness.maxAgeMs must be a positive integer (ms) — a quote without a freshness bound is not evidence",
    );
  }
}

/** Deterministic staleness probe: stale ⟺ (at − asOfMs) > maxAgeMs. */
export function isQuoteStale(freshness: QuoteFreshness, at: number): boolean {
  validateQuoteFreshness(freshness);
  if (!Number.isInteger(at) || at < 0) {
    throw new ValidationError("the staleness probe instant `at` must be a non-negative integer (ms)");
  }
  return at - freshness.asOfMs > freshness.maxAgeMs;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** How the quote was sourced. */
export type QuoteSourceKind =
  | "VENUE_API"
  | "RFQ"
  | "SOLVER"
  | "INDEXED_POOL_STATE"
  | "OPERATOR"
  | "INTERNAL";

export const QUOTE_SOURCE_KINDS: readonly QuoteSourceKind[] = [
  "VENUE_API",
  "RFQ",
  "SOLVER",
  "INDEXED_POOL_STATE",
  "OPERATOR",
  "INTERNAL",
];

/** Quote provenance: mandatory on every quote observation. */
export interface QuoteProvenance {
  readonly providerName: string;
  readonly source: QuoteSourceKind;
  readonly capturedAtMs: number;
  /** Evidence node references (INV-E02 — mandatory, never empty). */
  readonly evidenceRefs: readonly string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Validates quote provenance (fail closed). */
export function validateQuoteProvenance(provenance: QuoteProvenance): void {
  if (provenance === null || typeof provenance !== "object") {
    throw new ValidationError("quote provenance is MANDATORY (the observation law)");
  }
  if (!isNonEmptyString(provenance.providerName)) {
    throw new ValidationError("quote provenance.providerName must be a non-empty string");
  }
  if (
    typeof provenance.source !== "string" ||
    !QUOTE_SOURCE_KINDS.includes(provenance.source)
  ) {
    throw new ValidationError(
      `quote provenance.source must be one of [${QUOTE_SOURCE_KINDS.join(", ")}]`,
    );
  }
  if (
    !Number.isInteger(provenance.capturedAtMs) ||
    provenance.capturedAtMs < 0
  ) {
    throw new ValidationError("quote provenance.capturedAtMs must be a non-negative integer (ms)");
  }
  if (!Array.isArray(provenance.evidenceRefs) || provenance.evidenceRefs.length === 0) {
    throw new ValidationError(
      "quote provenance.evidenceRefs is MANDATORY and non-empty: an observation without linked evidence is not evidence (INV-E02)",
    );
  }
  for (const ref of provenance.evidenceRefs) {
    if (!isNonEmptyString(ref)) {
      throw new ValidationError("quote provenance.evidenceRefs entries must be non-empty strings");
    }
  }
}

// ---------------------------------------------------------------------------
// Observer identity
// ---------------------------------------------------------------------------

export type QuoteObserverKind =
  | "VENUE_NODE"
  | "VENUE_API"
  | "INDEXER"
  | "RPC_PROVIDER"
  | "OPERATOR"
  | "OTHER";

export const QUOTE_OBSERVER_KINDS: readonly QuoteObserverKind[] = [
  "VENUE_NODE",
  "VENUE_API",
  "INDEXER",
  "RPC_PROVIDER",
  "OPERATOR",
  "OTHER",
];

/** Who observed the quote (mandatory observer identity). */
export interface QuoteObserver {
  readonly observerId: string;
  readonly observerKind: QuoteObserverKind;
}

/** Validates the observer identity (fail closed). */
export function validateQuoteObserver(observer: QuoteObserver): void {
  if (observer === null || typeof observer !== "object") {
    throw new ValidationError("quote observer identity is MANDATORY (the observation law)");
  }
  if (!isNonEmptyString(observer.observerId)) {
    throw new ValidationError("quote observer.observerId must be a non-empty string");
  }
  if (
    typeof observer.observerKind !== "string" ||
    !QUOTE_OBSERVER_KINDS.includes(observer.observerKind)
  ) {
    throw new ValidationError(
      `quote observer.observerKind must be one of [${QUOTE_OBSERVER_KINDS.join(", ")}]`,
    );
  }
}
