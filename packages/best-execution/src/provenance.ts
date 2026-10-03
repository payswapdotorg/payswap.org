/**
 * @payswap/best-execution — route provenance (P4-W2-002).
 *
 * Every best-execution decision carries a PROVENANCE CHAIN: which venues
 * were asked and what each returned (quoted, at what freshness, through
 * which provenance and observer, or why not), how every candidate was
 * evaluated dimension by dimension (the full arithmetic trace), what the
 * deterministic gates concluded per candidate, and exactly which route was
 * selected with what margin. Nothing about a decision is unauditable.
 */

import type { NetOutcomeEvaluation } from "./comparator.js";
import type { HealthObservation } from "./outcome-dimensions.js";
import type { QuoteObserver, QuoteProvenance } from "./quote-observation.js";
import type { OptimizationOrigin, VenueId } from "./venue-port.js";

// ---------------------------------------------------------------------------
// Per-venue quote provenance
// ---------------------------------------------------------------------------

/** What one venue returned when asked to quote (recorded for every venue). */
export interface VenueQuoteProvenance {
  readonly venueId: VenueId;
  readonly outcome: "QUOTED" | "UNAVAILABLE" | "OUTCOME_UNKNOWN";
  readonly quoteId?: string;
  readonly quoteSemantics?: "INDICATIVE" | "EXECUTABLE";
  readonly optimizationOrigin?: OptimizationOrigin;
  /** The quote's freshness, recorded verbatim (the observation law). */
  readonly freshness?: { readonly asOfMs: number; readonly maxAgeMs: number };
  /** Through which observation the quote arrived. */
  readonly provenance?: QuoteProvenance;
  readonly observer?: QuoteObserver;
  /** The explicit reason, for UNAVAILABLE / OUTCOME_UNKNOWN outcomes. */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Candidate evaluation traces
// ---------------------------------------------------------------------------

/** The final disposition of one candidate route in a decision. */
export type CandidateStatus =
  /** The chosen best-execution route. */
  | "SELECTED"
  /** Gate-ALLOW, evaluated, ranked below the selection. */
  | "RUNNER_UP"
  /**
   * An unverifiable dimension (stale/unknown health, gate UNKNOWN): the
   * candidate is NOT selectable and NOT failed — UNKNOWN is never
   * converted (INV-X01); only fresh evidence can resolve it.
   */
  | "UNKNOWN"
  /** A hard-constraint violation (policy/health/freshness/semantics/time/risk). */
  | "DISQUALIFIED"
  /** A deterministic security gate BLOCK (terminal for the candidate). */
  | "SECURITY_BLOCKED";

/** One hard-constraint violation that removed a candidate from consideration. */
export interface DisqualificationReason {
  /** Machine code, e.g. `quote_stale`, `venue_not_permitted`. */
  readonly code: string;
  readonly detail: string;
}

/** One dimension that could not be verified from available evidence. */
export interface UnknownEvaluationDimension {
  /** Machine code, e.g. `health_unknown`, `security_gate_unknown`. */
  readonly code: string;
  readonly detail: string;
}

/** The deterministic gate outcome trace of one candidate. */
export interface GateOutcomeTrace {
  readonly gateDecision: "ALLOW" | "BLOCK" | "UNKNOWN" | "NOT_EVALUATED";
  /** The prepared-write digest the gates evaluated, when a write was prepared. */
  readonly writeDigest?: string;
  /** The simulation observation id, when one ran. */
  readonly simulationRef?: string;
  /** Block reason codes, when the gate BLOCKed. */
  readonly blockReasonCodes?: readonly string[];
  /** Unresolved dimension codes, when the gate returned UNKNOWN. */
  readonly unknownDimensionCodes?: readonly string[];
}

/** The full evaluation trace of one candidate route. */
export interface CandidateEvaluationTrace {
  readonly venueId: VenueId;
  readonly quoteId: string;
  readonly quoteProvenance: VenueQuoteProvenance;
  /** The venue health observation the evaluation consumed. */
  readonly health: HealthObservation;
  /** Hard-constraint (policy) assessment results. */
  readonly policyCompliance: { readonly compliant: boolean; readonly violations: readonly string[] };
  /** The net executable economic outcome (the arithmetic trace). */
  readonly economic?: NetOutcomeEvaluation;
  /** The deterministic security gate trace. */
  readonly security: GateOutcomeTrace;
  readonly status: CandidateStatus;
  readonly disqualifications?: readonly DisqualificationReason[];
  readonly unknownDimensions?: readonly UnknownEvaluationDimension[];
}

// ---------------------------------------------------------------------------
// The provenance chain
// ---------------------------------------------------------------------------

/** The selection record inside a provenance chain. */
export interface SelectionProvenance {
  readonly venueId: VenueId;
  readonly quoteId: string;
  readonly routeRef: string;
  readonly routeHash: string;
  readonly netNumeraireMinorUnits: string;
  /** The exact net margin over the runner-up, when a runner-up exists. */
  readonly marginOverRunnerUpMinorUnits?: string;
}

/**
 * The provenance chain of one best-execution decision: every venue asked,
 * every candidate evaluated, every gate outcome, the selection and the
 * referenced evidence.
 */
export interface RouteProvenanceChain {
  readonly executionId: string;
  readonly decidedAt: number;
  /** Best-execution policy reference `${policyId}@${version}`. */
  readonly policyRef: string;
  readonly numeraire: string;
  /** Onchain-security policy reference `${policyId}@${version}`. */
  readonly securityPolicyRef: string;
  readonly venues: readonly VenueQuoteProvenance[];
  readonly candidates: readonly CandidateEvaluationTrace[];
  readonly selection?: SelectionProvenance;
  /** Aggregated evidence references (policy, quotes, writes, simulations, gates). */
  readonly evidenceRefs: readonly string[];
}
