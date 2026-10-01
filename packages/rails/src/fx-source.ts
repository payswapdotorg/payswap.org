/**
 * FX source adapter — European Central Bank daily reference rates over the
 * REAL public reference feed (W1-005).
 *
 * FROZEN-ARCHITECTURE §10 + INV-F09: "FX values are exact/provenanced".
 * Every quote produced here:
 * - is an EXACT rational (bigint numerator/denominator) parsed from the
 *   publisher's decimal STRINGS — no floating point anywhere (INV-F01);
 * - carries full provenance: publisher (European Central Bank), the exact
 *   reference (publication date + endpoint), the observation timestamp, and
 *   any spread/fee disclosure with its own provenance (INV-F09);
 * - is constructed through the protocol kernel's `defineFxQuote`, so a
 *   quote without provenance cannot exist;
 * - is UNKNOWN when the feed is unreachable, when the pair is not
 *   published, or when the reference is STALE — never a fabricated rate,
 *   with the provenance of the last observation RETAINED in the UNKNOWN
 *   result (staleness → UNKNOWN + provenance retained).
 *
 * The ECB publishes EUR-base reference rates on TARGET working days. The
 * observation timestamp is conservatively taken as the START of the
 * publication day (UTC) — the source never claims fresher than truth. The
 * default staleness window (96h) covers weekends; callers tighten it.
 *
 * Real endpoint (exercised by the live suite):
 * https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
 */

import { ValidationError } from "@payswap/protocol";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import { defineFxQuote, fromMinorUnits, registerCurrency, currencyCode } from "@payswap/protocol";
import type { CurrencyCode, FxQuote } from "@payswap/protocol";
import type {
  CapabilityObservation,
} from "@payswap/connectors";
import { observeCapability, unknownReachabilityObservation } from "@payswap/connectors";
import {
  RailProviderError,
  RailTransportError,
  exactRationalFromDecimal,
  realHttpTransport,
  routableRailImplication,
  isoTimestamp,
} from "./support.js";
import type { HttpTransport, RailImplication } from "./support.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const ECB_FX_SOURCE_ID = "fx.ecb.reference_rates" as const;
export const ECB_FX_SOURCE_PROVIDER_NAME = "ecb-reference-rates" as const;

/** The genuinely reachable public reference feed exercised in Stage 5. */
export const ECB_REFERENCE_RATES_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml" as const;

/** Default staleness window: 96h covers a weekend publication gap. */
export const DEFAULT_FX_MAX_AGE_MS = 96n * 3_600_000n;

/** Default quote time-to-live (the quote is a candidate, not a lock). */
export const DEFAULT_FX_QUOTE_TTL_MS = 3_600_000n;

/**
 * ISO-4217 minor-unit exponents for the currencies the ECB reference feed
 * publishes (registration into the protocol currency registry is idempotent;
 * a conflicting re-registration is rejected by the registry itself).
 */
export const ECB_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  AUD: 2, BGN: 2, BRL: 2, CAD: 2, CHF: 2, CNY: 2, CZK: 2, DKK: 2,
  EUR: 2, GBP: 2, HKD: 2, HUF: 2, IDR: 2, ILS: 2, INR: 2, ISK: 0,
  JPY: 0, KRW: 0, MXN: 2, MYR: 2, NOK: 2, NZD: 2, PHP: 2, PLN: 2,
  RON: 2, SEK: 2, SGD: 2, THB: 2, TRY: 2, USD: 2, ZAR: 2,
});

/**
 * Brands a published ECB currency as a protocol CurrencyCode, registering
 * its ISO exponent idempotently. Currencies outside the ECB table must
 * already be registered by the operator (or the quote stays UNKNOWN).
 */
export function ecbCurrencyCode(code: string): CurrencyCode {
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) {
    throw new ValidationError(`currency code '${String(code)}' must be three uppercase A-Z letters`);
  }
  const exponent = ECB_CURRENCY_EXPONENTS[code];
  if (exponent !== undefined) {
    return registerCurrency(code, exponent);
  }
  return currencyCode(code);
}

// ---------------------------------------------------------------------------
// The reference-rate document (deterministic, exact)
// ---------------------------------------------------------------------------

/** One published EUR-base reference rate as an exact rational. */
export interface ReferenceRate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** A parsed ECB daily reference-rates document. */
export interface ReferenceRateDocument {
  /** Publisher's publication date, `YYYY-MM-DD`. */
  readonly publicationDate: string;
  /** EUR-base rates keyed by ISO 4217 code (exact rationals). */
  readonly rates: ReadonlyMap<string, ReferenceRate>;
  readonly publisher: string;
  readonly endpoint: string;
}

const ECB_TIME_RE = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*\/?>/;
const ECB_RATE_RE = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"](\d+(?:\.\d+)?)['"]\s*\/>/g;

/**
 * Deterministic parser for the ECB daily reference-rates XML. Rates are
 * extracted as DECIMAL STRINGS and converted to exact rationals — JSON/XML
 * numbers are never routed through floating point (INV-F01).
 */
export function parseEcbReferenceRatesXml(
  xml: string,
  endpoint: string = ECB_REFERENCE_RATES_URL,
): ReferenceRateDocument {
  if (typeof xml !== "string" || xml.length === 0) {
    throw new ValidationError("reference-rates XML must be a non-empty string");
  }
  const timeMatch = ECB_TIME_RE.exec(xml);
  if (timeMatch === null || timeMatch[1] === undefined) {
    throw new ValidationError("reference-rates XML carries no publication time");
  }
  const rates = new Map<string, ReferenceRate>();
  for (const match of xml.matchAll(ECB_RATE_RE)) {
    const currency = match[1];
    const decimal = match[2];
    if (currency === undefined || decimal === undefined) {
      continue;
    }
    rates.set(currency, exactRationalFromDecimal(decimal));
  }
  if (rates.size === 0) {
    throw new ValidationError("reference-rates XML carries no rates");
  }
  return Object.freeze({
    publicationDate: timeMatch[1],
    rates,
    publisher: "European Central Bank",
    endpoint,
  });
}

/** Conservative observation timestamp: start of the publication day (UTC). */
export function referenceObservationTimestampMs(document: ReferenceRateDocument): TimestampMs {
  const parsed = Date.parse(`${document.publicationDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    throw new ValidationError(
      `publication date '${document.publicationDate}' is not a parseable calendar date`,
    );
  }
  return BigInt(parsed);
}

// ---------------------------------------------------------------------------
// Quote construction (pure + deterministic — offline-testable)
// ---------------------------------------------------------------------------

/** An operator-configured spread/fee disclosure (its provenance is mandatory). */
export interface FxSpreadDisclosure {
  readonly basisPoints: bigint;
  readonly disclosedBy: string;
  readonly reference: string;
}

export interface FxFeeDisclosure {
  /** Fixed fee in the pair's quote currency, exact minor units. */
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly disclosedBy: string;
  readonly reference: string;
}

export interface FxQuoteRequest {
  readonly base: string;
  readonly quote: string;
  /** Evaluation time — deterministic (no ambient clock). */
  readonly now: TimestampMs;
  /** Maximum tolerated reference age (default 96h). */
  readonly maxAgeMs?: bigint;
  /** Quote validity window (default 1h). */
  readonly quoteTtlMs?: bigint;
  readonly spread?: FxSpreadDisclosure;
  readonly fee?: FxFeeDisclosure;
}

/** Provenance retained on an UNKNOWN quote result (INV-F09 — never dropped). */
export interface FxUnknownProvenance {
  readonly rateSource: string;
  readonly rateSourceRef: string;
  /** Observation timestamp of the last seen document, when one was seen. */
  readonly observedAt?: string;
  readonly attemptedAt: string;
}

export type FxQuoteResult =
  | { readonly status: "QUOTE"; readonly quote: FxQuote }
  | {
      readonly status: "UNKNOWN";
      readonly reason:
        | "STALE"
        | "UNREACHABLE"
        | "PAIR_NOT_PUBLISHED"
        | "REFERENCE_AHEAD_OF_CLOCK"
        | "MALFORMED_REFERENCE";
      readonly provenance: FxUnknownProvenance;
    };

/**
 * Exact cross-rate from EUR-base reference rates:
 * rate(B→Q) = rate(EUR→Q) / rate(EUR→B) — computed by bigint
 * cross-multiplication, always exact (INV-F01). EUR legs resolve directly.
 */
export function crossRateFromReferenceRates(
  document: ReferenceRateDocument,
  base: string,
  quote: string,
): ReferenceRate {
  if (base === quote) {
    throw new ValidationError("an FX pair must cross two distinct currencies");
  }
  if (base === "EUR") {
    const quoteRate = document.rates.get(quote);
    if (quoteRate === undefined) {
      throw new ValidationError(`reference rates do not publish ${quote}`);
    }
    return quoteRate;
  }
  if (quote === "EUR") {
    const baseRate = document.rates.get(base);
    if (baseRate === undefined) {
      throw new ValidationError(`reference rates do not publish ${base}`);
    }
    // B→EUR is the inverse of EUR→B: d/n.
    return { numerator: baseRate.denominator, denominator: baseRate.numerator };
  }
  const baseRate = document.rates.get(base);
  const quoteRate = document.rates.get(quote);
  if (baseRate === undefined || quoteRate === undefined) {
    const missing =
      baseRate === undefined ? base : quote;
    throw new ValidationError(`reference rates do not publish ${missing}`);
  }
  // (nQ/dQ) / (nB/dB) = (nQ·dB) / (dQ·nB)
  return {
    numerator: quoteRate.numerator * baseRate.denominator,
    denominator: quoteRate.denominator * baseRate.numerator,
  };
}

/**
 * Deterministically builds (or refuses) a quote from a reference document.
 * Refusals are UNKNOWN results with the provenance RETAINED:
 * - STALE — the reference is older than the request's max-age window;
 * - PAIR_NOT_PUBLISHED — the ECB does not publish one of the legs;
 * - REFERENCE_AHEAD_OF_CLOCK — the publication is ahead of `now` (skew);
 * a fabricated rate never appears (INV-F09, INV-X01 discipline).
 */
export function buildEcbQuote(
  document: ReferenceRateDocument,
  request: FxQuoteRequest,
): FxQuoteResult {
  const attemptedAt = isoTimestamp(request.now);
  const provenanceBase = {
    rateSource: `${ECB_FX_SOURCE_PROVIDER_NAME}`,
    rateSourceRef: `ecb-daily:${document.publicationDate}@${document.endpoint}`,
  };
  const observedAtMs = referenceObservationTimestampMs(document);
  if (observedAtMs > request.now) {
    return {
      status: "UNKNOWN",
      reason: "REFERENCE_AHEAD_OF_CLOCK",
      provenance: {
        ...provenanceBase,
        observedAt: isoTimestamp(observedAtMs),
        attemptedAt,
      },
    };
  }
  const maxAgeMs = request.maxAgeMs ?? DEFAULT_FX_MAX_AGE_MS;
  if (request.now - observedAtMs > maxAgeMs) {
    return {
      status: "UNKNOWN",
      reason: "STALE",
      provenance: {
        ...provenanceBase,
        observedAt: isoTimestamp(observedAtMs),
        attemptedAt,
      },
    };
  }
  if (request.base === request.quote) {
    throw new ValidationError("an FX pair must cross two distinct currencies");
  }
  let rate: ReferenceRate;
  try {
    rate = crossRateFromReferenceRates(document, request.base, request.quote);
  } catch {
    return {
      status: "UNKNOWN",
      reason: "PAIR_NOT_PUBLISHED",
      provenance: {
        ...provenanceBase,
        observedAt: isoTimestamp(observedAtMs),
        attemptedAt,
      },
    };
  }
  const baseCurrency = ecbCurrencyCode(request.base);
  const quoteCurrency = ecbCurrencyCode(request.quote);
  const quoteTtlMs = request.quoteTtlMs ?? DEFAULT_FX_QUOTE_TTL_MS;
  if (quoteTtlMs <= 0n) {
    throw new ValidationError("quoteTtlMs must be positive");
  }
  const quote = defineFxQuote({
    id: `fx-ecb-${document.publicationDate}-${request.base}-${request.quote}`,
    pair: { base: baseCurrency, quote: quoteCurrency },
    rate: { numerator: rate.numerator, denominator: rate.denominator },
    providerRef: `ecb-reference-rates:${document.publicationDate}`,
    quotedAt: request.now,
    expiresAt: request.now + quoteTtlMs,
    provenance: {
      rateSource: `${ECB_FX_SOURCE_PROVIDER_NAME} (${document.publisher})`,
      rateSourceRef: `ecb-daily:${document.publicationDate}@${document.endpoint}`,
      observedAt: observedAtMs,
      ...(request.spread !== undefined
        ? {
            spread: {
              disclosedBy: request.spread.disclosedBy,
              reference: request.spread.reference,
              basisPoints: request.spread.basisPoints,
            },
          }
        : {}),
      ...(request.fee !== undefined
        ? {
            fee: {
              disclosedBy: request.fee.disclosedBy,
              reference: request.fee.reference,
              amount: fromMinorUnits(
                ecbCurrencyCode(request.fee.currency),
                request.fee.amountMinor,
              ),
            },
          }
        : {}),
    },
  });
  return { status: "QUOTE", quote };
}

// ---------------------------------------------------------------------------
// The source (real endpoint; injectable transport for offline tests)
// ---------------------------------------------------------------------------

export interface EcbReferenceFxSourceConfig {
  readonly clock: ProtocolClock;
  readonly endpoint?: string;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

/**
 * The ECB reference-rate FX source. `fetchReferenceRates()` contacts the
 * REAL public feed; `quote()` fetches then builds deterministically. A
 * transport failure yields an UNKNOWN result with the attempt provenance —
 * never a fabricated rate and never a thrown business outcome.
 */
export class EcbReferenceFxSource {
  readonly #clock: ProtocolClock;
  readonly #endpoint: string;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;

  constructor(config: EcbReferenceFxSourceConfig) {
    this.#clock = config.clock;
    this.#endpoint = config.endpoint ?? ECB_REFERENCE_RATES_URL;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  /** The source identity (INV-F09 rateSource). */
  sourceId(): string {
    return ECB_FX_SOURCE_ID;
  }

  /** Fetches and parses the current reference-rate document (real feed). */
  async fetchReferenceRates(): Promise<ReferenceRateDocument> {
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(this.#endpoint, {
        method: "GET",
        headers: { Accept: "application/xml, text/xml, */*" },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(
        `reference-rate feed unreachable: ${this.#endpoint}`,
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `reference-rate feed answered HTTP ${response.status}`,
        { endpoint: this.#endpoint, httpStatus: response.status },
      );
    }
    return parseEcbReferenceRatesXml(response.bodyText, this.#endpoint);
  }

  /**
   * Quotes one pair at `now`. UNKNOWN (never a fabricated rate) when the
   * feed is unreachable, the reference is stale, the pair is unpublished or
   * the reference is ahead of the clock — always with provenance retained.
   */
  async quote(request: FxQuoteRequest): Promise<FxQuoteResult> {
    const attemptedAt = isoTimestamp(request.now);
    let document: ReferenceRateDocument;
    try {
      document = await this.fetchReferenceRates();
    } catch (error) {
      if (error instanceof RailTransportError || error instanceof RailProviderError) {
        return {
          status: "UNKNOWN",
          reason: "UNREACHABLE",
          provenance: {
            rateSource: ECB_FX_SOURCE_PROVIDER_NAME,
            rateSourceRef: this.#endpoint,
            attemptedAt,
          },
        };
      }
      if (error instanceof ValidationError) {
        // The feed answered but the document is unusable — NO reference was
        // obtained, so NO quote may be fabricated.
        return {
          status: "UNKNOWN",
          reason: "MALFORMED_REFERENCE",
          provenance: {
            rateSource: ECB_FX_SOURCE_PROVIDER_NAME,
            rateSourceRef: this.#endpoint,
            attemptedAt,
          },
        };
      }
      throw error;
    }
    return buildEcbQuote(document, request);
  }

  /** Read-only probe of the reference feed — reachability only. */
  async health(): Promise<{
    readonly status: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
    readonly lastCheckedAt: string;
    readonly degradedReasons: readonly string[];
  }> {
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    try {
      await this.fetchReferenceRates();
      return { status: "HEALTHY", lastCheckedAt, degradedReasons: [] };
    } catch (error) {
      return {
        status: "UNKNOWN",
        lastCheckedAt,
        degradedReasons: [
          `reference feed unreachable (never a business outcome): ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  /**
   * Two-axis availability observation backed by a LIVE feed probe
   * (INV-C01/C02 — never fabricated).
   */
  async availabilityObservation(input: {
    readonly instanceId: string;
    readonly observationVersion: number;
  }): Promise<CapabilityObservation> {
    const observedAt = isoTimestamp(this.#clock.now());
    let reachable = false;
    try {
      await this.fetchReferenceRates();
      reachable = true;
    } catch {
      reachable = false;
    }
    if (!reachable) {
      return unknownReachabilityObservation({
        instanceId: input.instanceId,
        observedAt,
        observationVersion: input.observationVersion,
        lastKnownCapabilityState: "AVAILABLE",
        reason:
          "reference-rate feed unreachable — source availability UNKNOWN (INV-C01/C02)",
        provenance: {
          providerName: ECB_FX_SOURCE_PROVIDER_NAME,
          source: "INTERNAL",
          capturedAt: observedAt,
        },
      });
    }
    return observeCapability({
      instanceId: input.instanceId,
      observedAt,
      observationVersion: input.observationVersion,
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
      eligibility: "UNKNOWN",
      health: { status: "HEALTHY", lastCheckedAt: observedAt },
      provenance: {
        providerName: ECB_FX_SOURCE_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: observedAt,
      },
    });
  }

  /** INV-NC04 gate: an UNKNOWN source is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(ECB_FX_SOURCE_ID, availability);
  }
}
