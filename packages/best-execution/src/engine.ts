/**
 * @payswap/best-execution — the best-execution engine (P4-W2-002).
 *
 * The deterministic orchestrator (no ambient clock — callers pass `at`; no
 * randomness; venues are consulted in registration order):
 *
 *   1. QUOTE — every registered venue is asked to quote; each outcome
 *      (QUOTE / UNAVAILABLE / OUTCOME_UNKNOWN) is recorded in the
 *      provenance chain. UNKNOWN is never converted into a failure
 *      (INV-X01).
 *   2. HARD CONSTRAINTS — compliance, risk, policy, health, freshness,
 *      quote semantics, time budget and execution scope are evaluated
 *      BEFORE any soft optimization (AGENTS.md rule 14). A violation
 *      disqualifies the candidate with an explicit reason; an unverifiable
 *      dimension (stale health, gate UNKNOWN) holds the candidate as
 *      UNKNOWN — never selectable, never silently converted.
 *   3. NET OUTCOME — every surviving candidate's dimensions are valued
 *      through the policy's explicit conversion table (exact arithmetic,
 *      full trace; no hidden constants).
 *   4. SECURITY GATES — every non-disqualified candidate route flows
 *      through the onchain-security kernel: the venue plans the kernel
 *      write, the core prepares it (prepareWrite), simulates it when the
 *      venue supports simulation, and runs the deterministic gates
 *      (evaluateOnchainWriteGates). A BLOCK kills the candidate; UNKNOWN
 *      surfaces; only ALLOW is selectable. NO venue path bypasses the
 *      gates — selection structurally requires a recorded ALLOW decision
 *      bound to the prepared write digest.
 *   5. RANK + SELECT — ALLOW candidates are ranked by net executable
 *      outcome (deterministic tie-breakers) and the best is selected with
 *      its user-readable expected-state diff.
 *
 * The selected route carries its quote and health observations so its
 * validity can be re-checked deterministically at any later instant
 * (stale-route invalidation law: a route whose inputs age out is
 * invalidated, never executed as-is).
 */

import { ValidationError } from "@payswap/protocol";
import type { ConnectedProtocolInstance } from "@payswap/onchain-domain";
import { protocolCapabilityId, validateConnectedProtocolInstance } from "@payswap/onchain-domain";
import type {
  ExpectedStateDiff,
  GateDecision,
  OnchainSecurityState,
  PreparedWrite,
  SimulationObservation,
} from "@payswap/onchain-security";
import {
  buildExpectedStateDiff,
  contentDigest,
  evaluateOnchainWriteGates,
  prepareWrite,
  recordSimulation,
} from "@payswap/onchain-security";
import type { OnchainSecurityPolicy } from "@payswap/onchain-security";
import type { NetOutcomeEvaluation, RankableCandidate } from "./comparator.js";
import { evaluateNetOutcome, rankCandidates } from "./comparator.js";
import { RouteInvalidatedError, VenueRegistryError } from "./errors.js";
import type { HealthObservation } from "./outcome-dimensions.js";
import { isHealthObservationStale, riskClassRank } from "./outcome-dimensions.js";
import type { BestExecutionPolicy } from "./policy.js";
import { validateBestExecutionPolicy } from "./policy.js";
import type {
  CandidateEvaluationTrace,
  CandidateStatus,
  DisqualificationReason,
  RouteProvenanceChain,
  VenueQuoteProvenance,
} from "./provenance.js";
import { isQuoteStale } from "./quote-observation.js";
import type { QuoteObserver, QuoteProvenance } from "./quote-observation.js";
import type { ExecutionVenue, SwapRequest, VenueQuote, VenueQuoteOutcome } from "./venue-port.js";
import { validateSwapRequest, validateVenueDescriptor, validateVenueQuote } from "./venue-port.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** One best-execution request (every input explicit and deterministic). */
export interface BestExecutionRequest {
  readonly executionId: string;
  readonly swap: SwapRequest;
  readonly policy: BestExecutionPolicy;
  readonly security: {
    readonly policy: OnchainSecurityPolicy;
    readonly state: OnchainSecurityState;
  };
  /**
   * The genuinely connected protocol instances (§2A layer 3) the engine may
   * plan writes through. The engine binds each candidate to the instance
   * whose capabilityId matches the venue's protocol capability id AND whose
   * authorization is ACTIVE and eligibility true (INV-C05: the catalogue
   * never authorizes).
   */
  readonly instances: readonly ConnectedProtocolInstance[];
  /** The account whose assets the swap spends. */
  readonly owner: string;
  /** The recipient of the swap output. */
  readonly beneficiary: string;
  readonly requestedBy: string;
  /** Absolute expiry (ms) of the planned write (must be after `at`). */
  readonly routeExpiryMs: number;
  /** The deterministic evaluation instant (ms). */
  readonly at: number;
}

// ---------------------------------------------------------------------------
// The selected route + the decision
// ---------------------------------------------------------------------------

/** The selected best-execution route, with everything needed to execute it. */
export interface SelectedRoute {
  readonly routeRef: string;
  readonly routeHash: string;
  readonly venueId: string;
  readonly quoteId: string;
  readonly quote: VenueQuote;
  readonly health: HealthObservation;
  /** The kernel-prepared write (already gate-ALLOWed). */
  readonly write: PreparedWrite;
  readonly simulation?: SimulationObservation;
  readonly gateDecision: GateDecision;
  readonly expectedDiff: ExpectedStateDiff;
  readonly evaluation: NetOutcomeEvaluation;
}

export type BestExecutionDecision =
  | {
      readonly decision: "ROUTE_SELECTED";
      readonly selected: SelectedRoute;
      readonly ranking: readonly CandidateEvaluationTrace[];
      readonly provenance: RouteProvenanceChain;
    }
  | {
      readonly decision: "NO_EXECUTABLE_ROUTE";
      readonly ranking: readonly CandidateEvaluationTrace[];
      readonly provenance: RouteProvenanceChain;
      readonly detail: string;
    };

// ---------------------------------------------------------------------------
// Stale-route invalidation (the deterministic freshness law)
// ---------------------------------------------------------------------------

/** Why a selected route was invalidated (which input aged out). */
export interface StaleRouteReason {
  readonly code: "QUOTE_STALE" | "HEALTH_OBSERVATION_STALE";
  readonly venueId: string;
  readonly quoteId?: string;
  readonly detail: string;
}

export type RouteValidity =
  | { readonly valid: true; readonly checkedAt: number }
  | {
      readonly valid: false;
      readonly checkedAt: number;
      readonly reasons: readonly StaleRouteReason[];
    };

/**
 * Deterministically checks a selected route's validity at `at`: the route is
 * invalid exactly when its quote or health observation has aged past the
 * mandatory freshness bounds. At exactly maxAge of age it is still valid.
 */
export function checkSelectedRouteValidity(
  decision: BestExecutionDecision,
  at: number,
): RouteValidity {
  if (!Number.isInteger(at) || at < 0) {
    throw new ValidationError("the validity instant `at` must be a non-negative integer (ms)");
  }
  if (decision.decision !== "ROUTE_SELECTED") {
    throw new ValidationError(
      "route validity applies to a ROUTE_SELECTED decision (there is no route to invalidate otherwise)",
    );
  }
  const { selected } = decision;
  const reasons: StaleRouteReason[] = [];
  if (isQuoteStale(selected.quote.freshness, at)) {
    reasons.push({
      code: "QUOTE_STALE",
      venueId: selected.venueId,
      quoteId: selected.quoteId,
      detail: `quote ${selected.quoteId} observed at ${selected.quote.freshness.asOfMs} with max age ${selected.quote.freshness.maxAgeMs}ms is stale at ${at}`,
    });
  }
  if (isHealthObservationStale(selected.health, at)) {
    reasons.push({
      code: "HEALTH_OBSERVATION_STALE",
      venueId: selected.venueId,
      detail: `venue health observed at ${selected.health.observedAtMs} with max age ${selected.health.maxAgeMs}ms is stale at ${at}`,
    });
  }
  if (reasons.length > 0) {
    return { valid: false, checkedAt: at, reasons: Object.freeze(reasons) };
  }
  return { valid: true, checkedAt: at };
}

/** Fail-closed assertion: an invalidated route never proceeds. */
export function assertSelectedRouteValid(
  decision: BestExecutionDecision,
  at: number,
): void {
  const validity = checkSelectedRouteValidity(decision, at);
  if (!validity.valid) {
    throw new RouteInvalidatedError(
      `the selected route is invalidated at ${at}: ${validity.reasons
        .map((reason) => `${reason.code} (${reason.detail})`)
        .join("; ")} — re-request best execution from fresh observations (a stale route is never repaired or executed)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal candidate accumulation (mutable; frozen into traces at the end)
// ---------------------------------------------------------------------------

/** The internal lifecycle of a candidate between assessment and gating. */
type InternalCandidateStatus = CandidateStatus | "PENDING_GATES";

interface MutableGateTrace {
  gateDecision: "ALLOW" | "BLOCK" | "UNKNOWN" | "NOT_EVALUATED";
  writeDigest?: string;
  simulationRef?: string;
  blockReasonCodes?: string[];
  unknownDimensionCodes?: string[];
}

interface CandidateState {
  readonly venue: ExecutionVenue;
  readonly quote: VenueQuote;
  readonly health: HealthObservation;
  readonly disqualifications: DisqualificationReason[];
  readonly unknownDimensions: { code: string; detail: string }[];
  readonly policyViolations: string[];
  status: InternalCandidateStatus;
  evaluation?: NetOutcomeEvaluation;
  readonly security: MutableGateTrace;
  preparedWrite?: PreparedWrite;
  simulation?: SimulationObservation;
  gate?: GateDecision;
}

/**
 * Defensive extraction of a quote's provenance-carrying parts: a
 * MALFORMED quote still gets its provenance recorded (the candidate is
 * disqualified by validation — the decision itself never crashes on venue
 * garbage).
 */
function quoteProvenanceParts(
  quote: Partial<VenueQuote>,
): {
  quoteId?: string;
  quoteSemantics?: "INDICATIVE" | "EXECUTABLE";
  optimizationOrigin?: "PROVIDER_NATIVE" | "COMPOSED";
  freshness?: { asOfMs: number; maxAgeMs: number };
  provenance?: QuoteProvenance;
  observer?: QuoteObserver;
} {
  return {
    ...(isNonEmptyString(quote.quoteId) ? { quoteId: quote.quoteId } : {}),
    ...(quote.quoteSemantics === "INDICATIVE" || quote.quoteSemantics === "EXECUTABLE"
      ? { quoteSemantics: quote.quoteSemantics }
      : {}),
    ...(quote.optimizationOrigin === "PROVIDER_NATIVE" || quote.optimizationOrigin === "COMPOSED"
      ? { optimizationOrigin: quote.optimizationOrigin }
      : {}),
    ...(quote.freshness !== null &&
    typeof quote.freshness === "object" &&
    typeof quote.freshness.asOfMs === "number" &&
    typeof quote.freshness.maxAgeMs === "number"
      ? { freshness: { asOfMs: quote.freshness.asOfMs, maxAgeMs: quote.freshness.maxAgeMs } }
      : {}),
    ...(quote.provenance !== null && typeof quote.provenance === "object"
      ? { provenance: quote.provenance }
      : {}),
    ...(quote.observer !== null && typeof quote.observer === "object"
      ? { observer: quote.observer }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** The venue-agnostic best-execution engine. */
export class BestExecutionEngine {
  readonly #venues: ExecutionVenue[] = [];

  /** Registers a venue (duplicate venue ids are rejected). */
  register(venue: ExecutionVenue): void {
    validateVenueDescriptor(venue.descriptor);
    if (
      this.#venues.some(
        (registered) => registered.descriptor.venueId === venue.descriptor.venueId,
      )
    ) {
      throw new VenueRegistryError(
        `a venue with id '${venue.descriptor.venueId}' is already registered — venue identity is unique`,
      );
    }
    if (venue.descriptor.supportsSimulation && venue.simulate === undefined) {
      throw new VenueRegistryError(
        `venue '${venue.descriptor.venueId}' declares simulation support but provides no simulate function (fail closed — declared support must be real)`,
      );
    }
    this.#venues.push(venue);
  }

  /** The registered venues, in registration order. */
  venues(): readonly ExecutionVenue[] {
    return [...this.#venues];
  }

  /** Runs one deterministic best-execution request. */
  execute(request: BestExecutionRequest): BestExecutionDecision {
    validateEngineRequest(request);
    const { swap, policy, security, at } = request;

    const venueOutcomes: VenueQuoteProvenance[] = [];
    const candidates: CandidateState[] = [];

    // Stage 1 — QUOTE (every venue, registration order).
    for (const venue of this.#venues) {
      const health = venue.observeHealth(at);
      const outcome = venue.quote(swap, at);
      venueOutcomes.push(this.#venueProvenance(venue, outcome));
      if (outcome.kind !== "QUOTE") {
        continue;
      }
      candidates.push(
        this.#assessCandidate(venue, outcome.quote, swap, policy, health, request),
      );
    }

    // Stage 4 — SECURITY GATES for every candidate not already disqualified.
    for (const candidate of candidates) {
      if (candidate.status === "DISQUALIFIED") {
        continue;
      }
      this.#runGates(candidate, request);
    }

    // Stage 5 — RANK + SELECT over gate-ALLOW candidates.
    const selectable = candidates.filter(
      (candidate): candidate is CandidateState & { status: "RUNNER_UP" | "PENDING_GATES" } =>
        (candidate.status === "PENDING_GATES" || candidate.status === "RUNNER_UP") &&
        candidate.gate?.decision === "ALLOW" &&
        candidate.preparedWrite !== undefined,
    );
    const ranked = rankCandidates(
      selectable.map((candidate) => ({
        quote: candidate.quote,
        evaluation: candidate.evaluation as NetOutcomeEvaluation,
      })),
      policy,
    );

    const evidenceRefs = this.#collectEvidence(request, candidates);

    if (ranked.length === 0) {
      return Object.freeze({
        decision: "NO_EXECUTABLE_ROUTE" as const,
        ranking: Object.freeze(candidates.map((candidate) => this.#trace(candidate, undefined))),
        provenance: Object.freeze({
          executionId: request.executionId,
          decidedAt: at,
          policyRef: `${policy.policyId}@${policy.version}`,
          numeraire: policy.numeraire,
          securityPolicyRef: `${security.policy.policyId}@${security.policy.version}`,
          venues: Object.freeze(venueOutcomes),
          candidates: Object.freeze(
            candidates.map((candidate) => this.#trace(candidate, undefined)),
          ),
          evidenceRefs: Object.freeze(evidenceRefs),
        }),
        detail: this.#noRouteDetail(candidates, venueOutcomes),
      });
    }

    const best = ranked[0] as RankableCandidate;
    const bestCandidate = selectable.find(
      (candidate) => candidate.quote.quoteId === best.quote.quoteId,
    ) as CandidateState;
    const runnerUp = ranked[1];
    const routeRef = `${request.executionId}/route/${best.quote.venueId}/${best.quote.quoteId}`;
    const routeHash = contentDigest({
      executionId: request.executionId,
      venueId: best.quote.venueId,
      quoteId: best.quote.quoteId,
      writeDigest: (bestCandidate.preparedWrite as PreparedWrite).writeDigest,
      worstCaseOutput: best.quote.slippage.worstCaseOutput,
    });
    const expectedDiff = buildExpectedStateDiff(
      bestCandidate.preparedWrite as PreparedWrite,
      bestCandidate.simulation,
    );

    bestCandidate.status = "SELECTED";
    for (const candidate of candidates) {
      if (candidate === bestCandidate) {
        continue;
      }
      if (candidate.status === "PENDING_GATES") {
        candidate.status = "RUNNER_UP";
      }
    }

    const selected: SelectedRoute = Object.freeze({
      routeRef,
      routeHash,
      venueId: best.quote.venueId,
      quoteId: best.quote.quoteId,
      quote: best.quote,
      health: bestCandidate.health,
      write: bestCandidate.preparedWrite as PreparedWrite,
      ...(bestCandidate.simulation !== undefined
        ? { simulation: bestCandidate.simulation }
        : {}),
      gateDecision: bestCandidate.gate as GateDecision,
      expectedDiff,
      evaluation: best.evaluation,
    });

    const traces = candidates.map((candidate) =>
      this.#trace(candidate, bestCandidate === candidate ? best : undefined),
    );

    return Object.freeze({
      decision: "ROUTE_SELECTED" as const,
      selected,
      ranking: Object.freeze(traces),
      provenance: Object.freeze({
        executionId: request.executionId,
        decidedAt: at,
        policyRef: `${policy.policyId}@${policy.version}`,
        numeraire: policy.numeraire,
        securityPolicyRef: `${security.policy.policyId}@${security.policy.version}`,
        venues: Object.freeze(venueOutcomes),
        candidates: Object.freeze(traces),
        selection: Object.freeze({
          venueId: best.quote.venueId,
          quoteId: best.quote.quoteId,
          routeRef,
          routeHash,
          netNumeraireMinorUnits: best.evaluation.netNumeraireMinorUnits,
          ...(runnerUp !== undefined
            ? {
                marginOverRunnerUpMinorUnits: (
                  BigInt(best.evaluation.netNumeraireMinorUnits) -
                  BigInt(runnerUp.evaluation.netNumeraireMinorUnits)
                ).toString(),
              }
            : {}),
        }),
        evidenceRefs: Object.freeze(evidenceRefs),
      }),
    });
  }

  // -------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------

  #venueProvenance(
    venue: ExecutionVenue,
    outcome: VenueQuoteOutcome,
  ): VenueQuoteProvenance {
    const venueId = venue.descriptor.venueId;
    if (outcome.kind !== "QUOTE") {
      return Object.freeze({
        venueId,
        outcome: outcome.kind,
        reason: outcome.reason,
      });
    }
    return Object.freeze({
      venueId,
      outcome: "QUOTED" as const,
      ...quoteProvenanceParts((outcome.quote ?? {}) as Partial<VenueQuote>),
    });
  }

  /** Stage 2 (hard constraints) + stage 3 (net evaluation). */
  #assessCandidate(
    venue: ExecutionVenue,
    quote: VenueQuote,
    swap: SwapRequest,
    policy: BestExecutionPolicy,
    health: HealthObservation,
    request: BestExecutionRequest,
  ): CandidateState {
    const disqualifications: DisqualificationReason[] = [];
    const unknownDimensions: { code: string; detail: string }[] = [];
    const policyViolations: string[] = [];
    const at = request.at;

    // Quote validation (fail closed — a malformed quote disqualifies, never crashes).
    try {
      validateVenueQuote(quote);
    } catch (error) {
      disqualifications.push({
        code: "quote_validation_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return this.#newCandidate(
        venue,
        quote,
        health,
        disqualifications,
        unknownDimensions,
        policyViolations,
        "DISQUALIFIED",
        undefined,
      );
    }

    // Binding to the request.
    const bindingViolations: string[] = [];
    if (quote.requestId !== swap.requestId) {
      bindingViolations.push(
        `quote requestId '${quote.requestId}' does not match the swap request '${swap.requestId}'`,
      );
    }
    if (quote.chain !== swap.chain) {
      bindingViolations.push("quote chain does not match the swap request chain");
    }
    if (quote.swapKind !== swap.swapKind) {
      bindingViolations.push("quote swap kind does not match the swap request");
    }
    if (
      quote.inputAsset.assetId !== swap.inputAsset.assetId ||
      quote.outputAsset.assetId !== swap.outputAsset.assetId
    ) {
      bindingViolations.push("quote assets do not match the swap request assets");
    }
    // The quoted input/output must bind to the requested swap side.
    if (swap.swapKind === "EXACT_INPUT") {
      if (
        quote.inputAmount.currency !== swap.amount.currency ||
        quote.inputAmount.minorUnits !== swap.amount.minorUnits
      ) {
        bindingViolations.push(
          "an EXACT_INPUT quote must consume exactly the requested input amount",
        );
      }
    } else if (
      quote.slippage.worstCaseOutput.currency !== swap.amount.currency ||
      quote.slippage.worstCaseOutput.minorUnits !== swap.amount.minorUnits
    ) {
      bindingViolations.push(
        "an EXACT_OUTPUT quote must guarantee exactly the requested output amount",
      );
    }
    if (bindingViolations.length > 0) {
      disqualifications.push({
        code: "quote_request_mismatch",
        detail: bindingViolations.join("; "),
      });
    }

    // Freshness law: a stale quote is deterministically invalidated.
    if (isQuoteStale(quote.freshness, at)) {
      disqualifications.push({
        code: "quote_stale",
        detail: `quote ${quote.quoteId} observed at ${quote.freshness.asOfMs} with max age ${quote.freshness.maxAgeMs}ms is stale at ${at}`,
      });
    }

    // Quote semantics: an INDICATIVE quote was never executable — it can
    // never be selected as an execution route (no fake quote-to-success).
    if (quote.quoteSemantics !== "EXECUTABLE") {
      disqualifications.push({
        code: "quote_not_executable",
        detail:
          `quote ${quote.quoteId} is INDICATIVE: an indicative quote was never executable and is never selected ` +
          "(the quote->executed transition requires a real execution observation)",
      });
    }

    // Policy hard constraints (rule 14: before any soft optimization).
    if (
      policy.allowedVenues !== undefined &&
      !policy.allowedVenues.includes(quote.venueId)
    ) {
      policyViolations.push(`venue '${quote.venueId}' is not in the policy allowlist`);
    }
    if (
      policy.maxRouteHops !== undefined &&
      quote.routeShape.length > policy.maxRouteHops
    ) {
      policyViolations.push(
        `route has ${quote.routeShape.length} hops, exceeding the policy bound ${policy.maxRouteHops}`,
      );
    }
    if (quote.timeToSettlement.estimatedMs > policy.maxSettlementMs) {
      disqualifications.push({
        code: "settlement_too_slow",
        detail: `estimated settlement ${quote.timeToSettlement.estimatedMs}ms exceeds the policy budget ${policy.maxSettlementMs}ms`,
      });
    }
    if (
      riskClassRank(quote.failureRisk.riskClass) > riskClassRank(policy.maxFailureRiskClass)
    ) {
      disqualifications.push({
        code: "failure_risk_above_tolerance",
        detail: `declared failure risk class ${quote.failureRisk.riskClass} exceeds the policy cap ${policy.maxFailureRiskClass}`,
      });
    }
    for (const violation of policyViolations) {
      disqualifications.push({ code: "venue_not_permitted_by_policy", detail: violation });
    }

    // Health (an observation with its own freshness law).
    if (health.status === "UNHEALTHY") {
      disqualifications.push({
        code: "venue_unhealthy",
        detail: `venue health observation reports UNHEALTHY (observed at ${health.observedAtMs})`,
      });
    } else if (
      health.status === "DEGRADED" &&
      policy.degradedVenuePolicy === "DISQUALIFY"
    ) {
      disqualifications.push({
        code: "venue_degraded",
        detail: "venue health observation reports DEGRADED and the policy disqualifies degraded venues",
      });
    } else if (health.status === "UNKNOWN" || isHealthObservationStale(health, at)) {
      unknownDimensions.push({
        code: "health_unknown",
        detail:
          health.status === "UNKNOWN"
            ? "the venue health observation reports UNKNOWN — not selectable without fresh evidence (INV-X01)"
            : `the venue health observation (at ${health.observedAtMs}, max age ${health.maxAgeMs}ms) is stale at ${at} — not selectable without fresh evidence (INV-X01)`,
      });
    }

    // Execution scope (INV-C05): a genuinely connected, ACTIVE, eligible
    // instance bound to this venue's protocol capability id.
    if (this.#executionScopeFor(venue, request.instances) === undefined) {
      disqualifications.push({
        code: "no_execution_scope",
        detail: `no connected protocol instance is bound to venue '${venue.descriptor.venueId}' (protocol capability ${protocolCapabilityId(venue.protocol.protocolKey, venue.protocol.chainKey)}) with ACTIVE authorization and positive eligibility — the catalogue never authorizes (INV-C05)`,
      });
    }

    // Net evaluation (stage 3) — runs for every candidate that produced a
    // well-formed quote, so the provenance carries the numbers even when a
    // hard constraint removed the candidate from selection.
    let evaluation: NetOutcomeEvaluation | undefined;
    try {
      evaluation = evaluateNetOutcome({ quote, policy });
    } catch (error) {
      disqualifications.push({
        code: "net_evaluation_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const status: InternalCandidateStatus =
      disqualifications.length > 0
        ? "DISQUALIFIED"
        : unknownDimensions.length > 0
          ? "UNKNOWN"
          : "PENDING_GATES";
    return this.#newCandidate(
      venue,
      quote,
      health,
      disqualifications,
      unknownDimensions,
      policyViolations,
      status,
      evaluation,
    );
  }

  #executionScopeFor(
    venue: ExecutionVenue,
    instances: readonly ConnectedProtocolInstance[],
  ): ConnectedProtocolInstance | undefined {
    const expectedCapabilityId = protocolCapabilityId(
      venue.protocol.protocolKey,
      venue.protocol.chainKey,
    );
    return instances.find(
      (instance) =>
        instance.capabilityId === expectedCapabilityId &&
        instance.protocolKey === venue.protocol.protocolKey &&
        instance.chainKey === venue.protocol.chainKey &&
        instance.authorization.status === "ACTIVE" &&
        instance.eligibility.eligible,
    );
  }

  /** Stage 4 — the security gates (no venue path bypasses them). */
  #runGates(candidate: CandidateState, request: BestExecutionRequest): void {
    const venue = candidate.venue;
    const instance = this.#executionScopeFor(venue, request.instances);
    if (instance === undefined) {
      // Already disqualified in assessment; gates are not evaluable.
      return;
    }
    const routeRef = `${request.executionId}/route/${candidate.quote.venueId}/${candidate.quote.quoteId}`;
    const routeHash = contentDigest({
      executionId: request.executionId,
      venueId: candidate.quote.venueId,
      quoteId: candidate.quote.quoteId,
      worstCaseOutput: candidate.quote.slippage.worstCaseOutput,
    });

    try {
      const writeRequest = venue.planWrite({
        quote: candidate.quote,
        instance,
        owner: request.owner,
        beneficiary: request.beneficiary,
        routeRef,
        routeHash,
        expiryMs: request.routeExpiryMs,
        requestedBy: request.requestedBy,
      });
      const prepared = prepareWrite(writeRequest, request.at);
      candidate.preparedWrite = prepared;

      if (venue.descriptor.supportsSimulation && venue.simulate !== undefined) {
        const simulation = recordSimulation(venue.simulate(prepared, request.at));
        if (simulation.writeId !== prepared.writeId) {
          throw new ValidationError(
            `venue simulation observes write '${simulation.writeId}', not the prepared write '${prepared.writeId}'`,
          );
        }
        candidate.simulation = simulation;
      }

      const gate = evaluateOnchainWriteGates({
        write: prepared,
        ...(candidate.simulation !== undefined
          ? { simulation: candidate.simulation }
          : {}),
        policy: request.security.policy,
        securityState: request.security.state,
        at: request.at,
      });
      candidate.gate = gate;
      candidate.security.writeDigest = prepared.writeDigest;

      if (gate.decision === "BLOCK") {
        candidate.status = "SECURITY_BLOCKED";
        candidate.security.gateDecision = "BLOCK";
        candidate.security.blockReasonCodes = gate.reasons.map((reason) => reason.code);
      } else if (gate.decision === "UNKNOWN") {
        candidate.status = "UNKNOWN";
        candidate.security.gateDecision = "UNKNOWN";
        candidate.security.unknownDimensionCodes = gate.dimensions.map(
          (dimension) => dimension.code,
        );
        for (const dimension of gate.dimensions) {
          candidate.unknownDimensions.push({
            code: "security_gate_unknown",
            detail: `${dimension.code}: ${dimension.message}`,
          });
        }
      } else {
        candidate.security.gateDecision = "ALLOW";
        if (candidate.simulation !== undefined) {
          candidate.security.simulationRef = candidate.simulation.simulationId;
        }
      }
    } catch (error) {
      // A venue that cannot produce a gate-evaluable write is disqualified —
      // never selected, never crashed.
      candidate.disqualifications.push({
        code: "gate_evaluation_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      candidate.status = "DISQUALIFIED";
      candidate.security.gateDecision = "NOT_EVALUATED";
    }
  }

  #newCandidate(
    venue: ExecutionVenue,
    quote: VenueQuote,
    health: HealthObservation,
    disqualifications: DisqualificationReason[],
    unknownDimensions: { code: string; detail: string }[],
    policyViolations: string[],
    status: InternalCandidateStatus,
    evaluation?: NetOutcomeEvaluation,
  ): CandidateState {
    return {
      venue,
      quote,
      health,
      disqualifications,
      unknownDimensions,
      policyViolations,
      status,
      ...(evaluation !== undefined ? { evaluation } : {}),
      security: { gateDecision: "NOT_EVALUATED" },
    };
  }

  #trace(
    candidate: CandidateState,
    selected: RankableCandidate | undefined,
  ): CandidateEvaluationTrace {
    const isSelected = selected !== undefined;
    // The candidate's venue identity comes from the REGISTERED venue (the
    // authoritative id), never from the (possibly malformed) quote.
    const venueId = candidate.venue.descriptor.venueId;
    return {
      venueId,
      quoteId: candidate.quote.quoteId,
      quoteProvenance: {
        venueId,
        outcome: "QUOTED",
        ...quoteProvenanceParts(candidate.quote as Partial<VenueQuote>),
      },
      health: candidate.health,
      policyCompliance: {
        compliant: candidate.policyViolations.length === 0,
        violations: Object.freeze([...candidate.policyViolations]),
      },
      ...(candidate.evaluation !== undefined ? { economic: candidate.evaluation } : {}),
      security: Object.freeze({
        gateDecision: candidate.security.gateDecision,
        ...(candidate.security.writeDigest !== undefined
          ? { writeDigest: candidate.security.writeDigest }
          : {}),
        ...(candidate.security.simulationRef !== undefined
          ? { simulationRef: candidate.security.simulationRef }
          : {}),
        ...(candidate.security.blockReasonCodes !== undefined
          ? { blockReasonCodes: Object.freeze(candidate.security.blockReasonCodes) }
          : {}),
        ...(candidate.security.unknownDimensionCodes !== undefined
          ? { unknownDimensionCodes: Object.freeze(candidate.security.unknownDimensionCodes) }
          : {}),
      }),
      status: isSelected
        ? "SELECTED"
        : candidate.status === "PENDING_GATES"
          ? "RUNNER_UP"
          : candidate.status,
      ...(candidate.disqualifications.length > 0
        ? { disqualifications: Object.freeze(candidate.disqualifications) }
        : {}),
      ...(candidate.unknownDimensions.length > 0
        ? { unknownDimensions: Object.freeze(candidate.unknownDimensions) }
        : {}),
    };
  }

  #collectEvidence(
    request: BestExecutionRequest,
    candidates: readonly CandidateState[],
  ): string[] {
    const refs: string[] = [
      `best-execution-policy:${request.policy.policyId}@${request.policy.version}`,
      `security-policy:${request.security.policy.policyId}@${request.security.policy.version}`,
    ];
    for (const candidate of candidates) {
      if (
        candidate.quote.provenance !== null &&
        candidate.quote.provenance !== undefined &&
        Array.isArray(candidate.quote.provenance.evidenceRefs)
      ) {
        refs.push(...candidate.quote.provenance.evidenceRefs);
      }
      if (candidate.preparedWrite !== undefined) {
        refs.push(`write:${candidate.preparedWrite.writeDigest}`);
      }
      if (candidate.simulation !== undefined) {
        refs.push(`simulation:${candidate.simulation.simulationId}`);
      }
    }
    return refs;
  }

  #noRouteDetail(
    candidates: readonly CandidateState[],
    venueOutcomes: readonly VenueQuoteProvenance[],
  ): string {
    if (candidates.length === 0) {
      const unknowns = venueOutcomes.filter(
        (outcome) => outcome.outcome === "OUTCOME_UNKNOWN",
      ).length;
      return `no venue produced a quote (${venueOutcomes.length} venues asked; ${unknowns} returned OUTCOME_UNKNOWN — recorded, never converted to failure)`;
    }
    const blocked = candidates.filter(
      (candidate) => candidate.status === "SECURITY_BLOCKED",
    ).length;
    const unknown = candidates.filter(
      (candidate) => candidate.status === "UNKNOWN",
    ).length;
    const disqualified = candidates.filter(
      (candidate) => candidate.status === "DISQUALIFIED",
    ).length;
    return `${candidates.length} quote(s) considered: ${disqualified} disqualified by hard constraints, ${blocked} security-blocked, ${unknown} held UNKNOWN (INV-X01) — no gate-ALLOWed executable route remains`;
  }
}

/** Validates the engine request (fail closed, deterministic). */
function validateEngineRequest(request: BestExecutionRequest): void {
  if (!isNonEmptyString(request.executionId)) {
    throw new ValidationError("executionId must be a non-empty string");
  }
  validateSwapRequest(request.swap);
  validateBestExecutionPolicy(request.policy);
  if (
    !isNonEmptyString(request.security.policy.policyId) ||
    !Number.isInteger(request.security.policy.version) ||
    request.security.policy.version < 1
  ) {
    throw new ValidationError(
      "the onchain-security policy must carry a non-empty policyId and a positive integer version",
    );
  }
  for (const instance of request.instances) {
    validateConnectedProtocolInstance(instance);
  }
  if (!isNonEmptyString(request.owner) || !isNonEmptyString(request.beneficiary)) {
    throw new ValidationError("owner and beneficiary must be non-empty account references");
  }
  if (!isNonEmptyString(request.requestedBy)) {
    throw new ValidationError("requestedBy must be a non-empty principal reference");
  }
  if (!Number.isInteger(request.at) || request.at < 0) {
    throw new ValidationError("`at` must be a non-negative integer (ms) — there is no ambient clock");
  }
  if (!Number.isInteger(request.routeExpiryMs) || request.routeExpiryMs <= request.at) {
    throw new ValidationError(
      "routeExpiryMs must be an integer absolute instant strictly after `at` (an expired route never validates)",
    );
  }
}
