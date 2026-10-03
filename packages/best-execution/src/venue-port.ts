/**
 * @payswap/best-execution — the neutral execution-venue port (P4-W2-002).
 *
 * THE CORE IS VENUE-AGNOSTIC (hard requirement): no venue is hard-coded
 * into this package. An execution venue is an opaque registration behind
 * the ExecutionVenue port:
 * - `descriptor` declares what the venue serves (chains, swap kinds, quote
 *   semantics, slippage protection, simulation support) and — when the
 *   venue ships its own routing — its PROVIDER-NATIVE OPTIMIZATION with
 *   `benchmarkBaseline: true` (INV-C08 / AGENTS.md rule 20: provider-native
 *   optimization is an incumbent baseline, always representable and never
 *   structurally disadvantaged vs composed routing);
 * - `protocol` binds the venue to its onchain-domain protocol identity
 *   (protocolKey + chainKey → the deterministic protocol capability id);
 * - `quote` produces QUOTE observations carrying the full observation law
 *   (freshness, provenance, observer), or UNAVAILABLE, or OUTCOME_UNKNOWN
 *   (INV-X01: never a fabricated quote);
 * - `planWrite` translates a selected quote into a kernel-ready
 *   OnchainWriteRequest — venue-specific shapes (router calldata, approval
 *   shape, intent payload) live in the venue pack, never in this core;
 * - `observeHealth` produces the venue health observation.
 *
 * Venue packs implement this port in their own packages
 * (@payswap/onchain-venues); the dependency direction is strictly
 * venue → core (adversarially scanned in test/adversarial.test.ts).
 */

import { ValidationError } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/trust";
import { validateAmountSpec } from "@payswap/trust";
import type { SwapKind } from "@payswap/onchain-domain";
import type { ConnectedProtocolInstance } from "@payswap/onchain-domain";
import type {
  AssetIdentity,
  OnchainWriteRequest,
  PreparedWrite,
  SimulationObservation,
} from "@payswap/onchain-security";
import { validateAssetIdentity } from "@payswap/onchain-security";
import { isValidChainKey } from "@payswap/onchain-domain";
import type {
  BridgeCostDisclosure,
  FailureRiskDisclosure,
  FxCostDisclosure,
  GasCostDisclosure,
  HealthObservation,
  LiquidityImpactDisclosure,
  QuoteFee,
  SlippageDisclosure,
  TimeToSettlementDisclosure,
} from "./outcome-dimensions.js";
import {
  validateBridgeCostDisclosure,
  validateFailureRiskDisclosure,
  validateFxCostDisclosure,
  validateGasCostDisclosure,
  validateHealthObservation,
  validateLiquidityImpactDisclosure,
  validateQuoteFee,
  validateSlippageDisclosure,
  validateTimeToSettlementDisclosure,
} from "./outcome-dimensions.js";
import type {
  QuoteFreshness,
  QuoteObserver,
  QuoteProvenance,
} from "./quote-observation.js";
import {
  validateQuoteFreshness,
  validateQuoteObserver,
  validateQuoteProvenance,
} from "./quote-observation.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// Venue identity + descriptors
// ---------------------------------------------------------------------------

/** An opaque venue identity (never interpreted by the core). */
export type VenueId = string;

const VENUE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

/** Where a route's optimization originated. */
export type OptimizationOrigin = "PROVIDER_NATIVE" | "COMPOSED";

/**
 * The venue's own optimization declaration (INV-C08 / rule 20): a venue
 * that ships router-native routing declares it here and is recorded as the
 * incumbent baseline. `benchmarkBaseline` is a literal `true` type.
 */
export interface VenueNativeOptimizationDeclaration {
  readonly optimizationKind: string;
  readonly benchmarkBaseline: true;
  readonly description: string;
}

/** What a venue declares about itself (descriptive — never authority). */
export interface VenueDescriptor {
  readonly venueId: VenueId;
  readonly displayName: string;
  /** Chain keys this venue serves (canonical). */
  readonly chains: readonly string[];
  readonly swapKinds: readonly SwapKind[];
  readonly quoteSemantics: "INDICATIVE" | "EXECUTABLE";
  readonly slippageProtection: "DECLARED_LIMIT" | "PROVIDER_DEFINED";
  readonly supportsSimulation: boolean;
  readonly nativeOptimization?: VenueNativeOptimizationDeclaration;
}

export function validateVenueDescriptor(descriptor: VenueDescriptor): void {
  if (descriptor === null || typeof descriptor !== "object") {
    throw new ValidationError("a venue descriptor must be an object");
  }
  if (!isNonEmptyString(descriptor.venueId) || !VENUE_ID_PATTERN.test(descriptor.venueId)) {
    throw new ValidationError(
      "venueId must match /^[a-z0-9][a-z0-9._:-]{0,63}$/ (an opaque venue identity)",
    );
  }
  if (!isNonEmptyString(descriptor.displayName)) {
    throw new ValidationError("displayName must be a non-empty string");
  }
  if (!Array.isArray(descriptor.chains) || descriptor.chains.length === 0) {
    throw new ValidationError("chains must be a non-empty array of canonical chain keys");
  }
  for (const chain of descriptor.chains) {
    if (!isValidChainKey(chain)) {
      throw new ValidationError(
        `chains contains '${String(chain)}' which is not a canonical chain key`,
      );
    }
  }
  if (!Array.isArray(descriptor.swapKinds) || descriptor.swapKinds.length === 0) {
    throw new ValidationError("swapKinds must be a non-empty array (EXACT_INPUT and/or EXACT_OUTPUT)");
  }
  for (const kind of descriptor.swapKinds) {
    if (kind !== "EXACT_INPUT" && kind !== "EXACT_OUTPUT") {
      throw new ValidationError("swapKinds entries must be EXACT_INPUT or EXACT_OUTPUT");
    }
  }
  if (descriptor.quoteSemantics !== "INDICATIVE" && descriptor.quoteSemantics !== "EXECUTABLE") {
    throw new ValidationError("quoteSemantics must be INDICATIVE or EXECUTABLE");
  }
  if (
    descriptor.slippageProtection !== "DECLARED_LIMIT" &&
    descriptor.slippageProtection !== "PROVIDER_DEFINED"
  ) {
    throw new ValidationError("slippageProtection must be DECLARED_LIMIT or PROVIDER_DEFINED");
  }
  if (typeof descriptor.supportsSimulation !== "boolean") {
    throw new ValidationError("supportsSimulation must be a boolean");
  }
  if (descriptor.nativeOptimization !== undefined) {
    const optimization = descriptor.nativeOptimization;
    if (
      optimization === null ||
      typeof optimization !== "object" ||
      !isNonEmptyString(optimization.optimizationKind) ||
      optimization.benchmarkBaseline !== true ||
      !isNonEmptyString(optimization.description)
    ) {
      throw new ValidationError(
        "nativeOptimization, when present, must declare { optimizationKind, benchmarkBaseline: true, description } (INV-C08 incumbent baseline)",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The swap request (neutral)
// ---------------------------------------------------------------------------

/** A neutral swap request the engine broadcasts to every registered venue. */
export interface SwapRequest {
  readonly requestId: string;
  readonly chain: string;
  readonly inputAsset: AssetIdentity;
  readonly outputAsset: AssetIdentity;
  readonly swapKind: SwapKind;
  /** For EXACT_INPUT: the exact input amount; for EXACT_OUTPUT: the exact output amount. */
  readonly amount: AmountSpec;
  /** Caller-declared slippage tolerance bound in basis points (0..10000), when any. */
  readonly maxSlippageBasisPoints?: number;
}

export function validateSwapRequest(request: SwapRequest): void {
  if (request === null || typeof request !== "object") {
    throw new ValidationError("a swap request must be an object");
  }
  if (!isNonEmptyString(request.requestId)) {
    throw new ValidationError("requestId must be a non-empty string");
  }
  if (!isValidChainKey(request.chain)) {
    throw new ValidationError("chain must be a canonical chain key");
  }
  validateAssetIdentity(request.inputAsset);
  validateAssetIdentity(request.outputAsset);
  if (request.inputAsset.chain !== request.chain || request.outputAsset.chain !== request.chain) {
    throw new ValidationError(
      "one swap request targets exactly one chain: both assets must live on the request chain",
    );
  }
  if (request.swapKind !== "EXACT_INPUT" && request.swapKind !== "EXACT_OUTPUT") {
    throw new ValidationError("swapKind must be EXACT_INPUT or EXACT_OUTPUT");
  }
  validateAmountSpec(request.amount);
  const expectedCurrency =
    request.swapKind === "EXACT_INPUT" ? request.inputAsset.symbol : request.outputAsset.symbol;
  if (request.amount.currency !== expectedCurrency) {
    throw new ValidationError(
      `amount.currency '${request.amount.currency}' must be the ${request.swapKind === "EXACT_INPUT" ? "input" : "output"} asset symbol '${expectedCurrency}'`,
    );
  }
  if (request.maxSlippageBasisPoints !== undefined) {
    if (
      !Number.isInteger(request.maxSlippageBasisPoints) ||
      request.maxSlippageBasisPoints < 0 ||
      request.maxSlippageBasisPoints > 10_000
    ) {
      throw new ValidationError(
        "maxSlippageBasisPoints, when present, must be an integer in [0, 10000]",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The venue quote (an OBSERVATION carrying the full observation law)
// ---------------------------------------------------------------------------

/** One descriptive hop of a quoted route's shape (venue-owned detail). */
export interface RouteHopDescriptor {
  readonly venue: VenueId;
  readonly chain: string;
  readonly protocolId?: string;
  readonly description: string;
}

function validateRouteHopDescriptor(hop: RouteHopDescriptor): void {
  if (hop === null || typeof hop !== "object") {
    throw new ValidationError("a route hop descriptor must be an object");
  }
  if (!isNonEmptyString(hop.venue)) {
    throw new ValidationError("route hop venue must be a non-empty venue id");
  }
  if (!isValidChainKey(hop.chain)) {
    throw new ValidationError("route hop chain must be a canonical chain key");
  }
  if (hop.protocolId !== undefined && !isNonEmptyString(hop.protocolId)) {
    throw new ValidationError("route hop protocolId, when present, must be a non-empty string");
  }
  if (!isNonEmptyString(hop.description)) {
    throw new ValidationError("route hop description must be a non-empty string");
  }
}

/**
 * A venue quote — an OBSERVATION of what the venue would execute, carrying
 * every net-outcome dimension as an explicit typed disclosure plus the
 * mandatory freshness/provenance/observer law.
 */
export interface VenueQuote {
  readonly quoteId: string;
  readonly venueId: VenueId;
  readonly requestId: string;
  readonly chain: string;
  readonly swapKind: SwapKind;
  readonly inputAsset: AssetIdentity;
  readonly outputAsset: AssetIdentity;
  /**
   * The exact input amount the route consumes (denominated in
   * inputAsset). For EXACT_INPUT this equals the request's amount; for
   * EXACT_OUTPUT it is the venue's quoted required input.
   */
  readonly inputAmount: AmountSpec;
  readonly quoteSemantics: "INDICATIVE" | "EXECUTABLE";
  readonly fees: readonly QuoteFee[];
  readonly gasCost?: GasCostDisclosure;
  readonly bridgeCost?: BridgeCostDisclosure;
  readonly fxCost?: FxCostDisclosure;
  readonly slippage: SlippageDisclosure;
  readonly liquidityImpact?: LiquidityImpactDisclosure;
  readonly failureRisk: FailureRiskDisclosure;
  readonly timeToSettlement: TimeToSettlementDisclosure;
  readonly routeShape: readonly RouteHopDescriptor[];
  readonly optimizationOrigin: OptimizationOrigin;
  readonly freshness: QuoteFreshness;
  readonly provenance: QuoteProvenance;
  readonly observer: QuoteObserver;
}

/**
 * Runtime validation for a venue quote (fail closed). Deterministic
 * coupling rules:
 * - the input amount is denominated in the input asset;
 * - the worst-case output is denominated in the output asset;
 * - the route shape is non-empty and every hop is well-formed;
 * - the observation law (freshness, provenance, observer) is enforced.
 */
export function validateVenueQuote(quote: VenueQuote): void {
  if (quote === null || typeof quote !== "object") {
    throw new ValidationError("a venue quote must be an object");
  }
  const errors: string[] = [];
  for (const field of ["quoteId", "venueId", "requestId"] as const) {
    if (!isNonEmptyString(quote[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!isValidChainKey(quote.chain)) {
    errors.push("chain must be a canonical chain key");
  }
  if (quote.swapKind !== "EXACT_INPUT" && quote.swapKind !== "EXACT_OUTPUT") {
    errors.push("swapKind must be EXACT_INPUT or EXACT_OUTPUT");
  }
  try {
    validateAssetIdentity(quote.inputAsset);
    validateAssetIdentity(quote.outputAsset);
    if (quote.inputAsset.chain !== quote.chain || quote.outputAsset.chain !== quote.chain) {
      errors.push("a quote's assets live on the quote's chain (one quote, one chain)");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    validateAmountSpec(quote.inputAmount);
    if (quote.inputAmount.currency !== quote.inputAsset.symbol) {
      errors.push("inputAmount.currency must be the input asset symbol");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (quote.quoteSemantics !== "INDICATIVE" && quote.quoteSemantics !== "EXECUTABLE") {
    errors.push("quoteSemantics must be INDICATIVE or EXECUTABLE");
  }
  if (!Array.isArray(quote.fees)) {
    errors.push("fees must be an array (possibly empty — the venue's explicit fee set)");
  } else {
    for (const fee of quote.fees) {
      try {
        validateQuoteFee(fee);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (quote.gasCost !== undefined) {
    try {
      validateGasCostDisclosure(quote.gasCost);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (quote.bridgeCost !== undefined) {
    try {
      validateBridgeCostDisclosure(quote.bridgeCost);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (quote.fxCost !== undefined) {
    try {
      validateFxCostDisclosure(quote.fxCost);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    validateSlippageDisclosure(quote.slippage);
    if (
      quote.slippage.worstCaseOutput.currency !== quote.outputAsset.symbol
    ) {
      errors.push("slippage.worstCaseOutput must be denominated in the output asset");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (quote.liquidityImpact !== undefined) {
    try {
      validateLiquidityImpactDisclosure(quote.liquidityImpact);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    validateFailureRiskDisclosure(quote.failureRisk);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    validateTimeToSettlementDisclosure(quote.timeToSettlement);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(quote.routeShape) || quote.routeShape.length === 0) {
    errors.push("routeShape must be a non-empty array of hop descriptors");
  } else {
    for (const hop of quote.routeShape) {
      try {
        validateRouteHopDescriptor(hop);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (quote.optimizationOrigin !== "PROVIDER_NATIVE" && quote.optimizationOrigin !== "COMPOSED") {
    errors.push("optimizationOrigin must be PROVIDER_NATIVE or COMPOSED");
  }
  try {
    validateQuoteFreshness(quote.freshness);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    validateQuoteProvenance(quote.provenance);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    validateQuoteObserver(quote.observer);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length > 0) {
    throw new ValidationError(`Invalid venue quote: ${errors.join("; ")}`, {
      errors: [...errors],
    });
  }
}

// ---------------------------------------------------------------------------
// The quote outcome (UNKNOWN-capable — INV-X01)
// ---------------------------------------------------------------------------

/**
 * The result of asking a venue to quote: a QUOTE, an explicit UNAVAILABLE
 * (the venue does not serve this request), or OUTCOME_UNKNOWN (the venue
 * could not determine a quote — never a fabricated one).
 */
export type VenueQuoteOutcome =
  | { readonly kind: "QUOTE"; readonly quote: VenueQuote }
  | { readonly kind: "UNAVAILABLE"; readonly reason: string }
  | { readonly kind: "OUTCOME_UNKNOWN"; readonly reason: string };

export function validateVenueQuoteOutcome(outcome: VenueQuoteOutcome): void {
  if (outcome === null || typeof outcome !== "object") {
    throw new ValidationError("a venue quote outcome must be an object");
  }
  if (outcome.kind === "QUOTE") {
    validateVenueQuote(outcome.quote);
    return;
  }
  if (outcome.kind === "UNAVAILABLE" || outcome.kind === "OUTCOME_UNKNOWN") {
    if (!isNonEmptyString(outcome.reason)) {
      throw new ValidationError(`an ${outcome.kind} venue outcome requires an explicit reason`);
    }
    return;
  }
  throw new ValidationError(
    "venue quote outcome must be QUOTE, UNAVAILABLE or OUTCOME_UNKNOWN",
  );
}

// ---------------------------------------------------------------------------
// The venue port + execution-scope binding
// ---------------------------------------------------------------------------

/**
 * The venue's onchain-domain protocol binding: protocolKey + chainKey are
 * the deterministic inputs of the canonical protocol reference and the
 * protocol capability id (see @payswap/onchain-domain onchain-protocol.ts).
 */
export interface VenueProtocolBinding {
  readonly protocolKey: string;
  readonly chainKey: string;
}

/** The input the venue needs to plan the kernel write for a selected route. */
export interface VenueWritePlanningInput {
  readonly quote: VenueQuote;
  /**
   * The genuinely connected protocol instance (§2A layer 3) — the ONLY
   * protocol-shaped authorization scope. The engine validates the binding
   * (capability id, eligibility, ACTIVE authorization) before calling
   * planWrite: the catalogue never authorizes (INV-C05).
   */
  readonly instance: ConnectedProtocolInstance;
  /** The account whose assets the swap spends. */
  readonly owner: string;
  /** The recipient of the swap output. */
  readonly beneficiary: string;
  readonly routeRef: string;
  readonly routeHash: string;
  /** Absolute expiry (ms) of the planned write. */
  readonly expiryMs: number;
  readonly requestedBy: string;
}

/**
 * THE neutral execution-venue port. Venue packs implement this; the core
 * knows venues only through it. `simulate` is optional (declared via
 * descriptor.supportsSimulation — a venue that declares support must
 * provide it; the engine enforces the consistency).
 */
export interface ExecutionVenue {
  readonly descriptor: VenueDescriptor;
  readonly protocol: VenueProtocolBinding;
  quote(request: SwapRequest, at: number): VenueQuoteOutcome;
  observeHealth(at: number): HealthObservation;
  planWrite(input: VenueWritePlanningInput): OnchainWriteRequest;
  simulate?(write: PreparedWrite, at: number): SimulationObservation;
}
