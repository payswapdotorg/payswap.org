/**
 * @payswap/mixed-rail — onchain-lane discovery through the REAL
 * execution plane (Work Order P4-W3-001 hard requirement 1).
 *
 * A lane is the onchain half of a mixed-rail candidate organization. It is
 * proved ONLY through the merged Wave 1/2 kernels — no shadow models:
 *
 * - the venue-port engine (the venue-agnostic best-execution core) runs the
 *   quote → policy → prepare → simulate → gate stages for every candidate;
 * - a lane is provable ONLY when the engine SELECTED a route (which
 *   requires a gate ALLOW, an ACTIVE, eligible ConnectedProtocolInstance
 *   whose capability id is the deterministic protocol capability id, and a
 *   kernel-prepared write with an expected-state diff);
 * - the input-asset grounding is a REAL canonical asset observation
 *   (onchain-domain observation law: freshness, provenance, observer
 *   identity) checked against the kernel's deterministic freshness probe;
 * - the venue packs register behind the engine through their real pack
 *   contract; this module is venue-neutral (no venue-specific vocabulary,
 *   no vendor SDKs — the neutrality law extends to the Lab).
 *
 * Honest discovery outcomes (never fabricated):
 * - LANE_PROVED — the kernel selected and gated a route AND the grounding
 *   observation is present and fresh;
 * - NO_EXECUTABLE_ROUTE — the engine honestly found nothing (the full
 *   provenance chain, including every venue asked and every gate outcome,
 *   is returned verbatim);
 * - LANE_UNPROVED_GROUNDING — the engine selected a route but the asset
 *   observation grounding is missing or stale: the lane is NOT proved and
 *   NOT failed — it is surfaced with its reason, exactly like the two-axis
 *   UNKNOWN discipline (INV-C01/C02) it composes with.
 */

import { BestExecutionEngine } from "@payswap/best-execution";
import type {
  BestExecutionPolicy,
  HealthObservation,
  NetOutcomeEvaluation,
  RouteProvenanceChain,
  SwapRequest,
  VenueProtocolBinding,
  VenueQuote,
} from "@payswap/best-execution";
import type { ExecutionVenue } from "@payswap/best-execution";
import { classifyChainEnvironment, isObservationFresh } from "@payswap/onchain-adapters";
import type { AdapterLifecycleStage, RailEnvironmentClass } from "@payswap/onchain-adapters";
import {
  canonicalAssetRef,
  onchainRailId,
  protocolCapabilityId,
  validateAssetObservation,
  validateConnectedProtocolInstance,
} from "@payswap/onchain-domain";
import type {
  AssetObservation,
  ConnectedProtocolInstance,
} from "@payswap/onchain-domain";
import type {
  ExpectedStateDiff,
  GateDecision,
  OnchainSecurityPolicy,
  OnchainSecurityState,
  PreparedWrite,
  SimulationObservation,
} from "@payswap/onchain-security";
import { validateVenueExtensionPack } from "@payswap/onchain-venues";
import type { VenueExtensionPack } from "@payswap/onchain-venues";
import { venueConnectedProtocolInstance } from "@payswap/onchain-venues";

/** Raised when discovery input is malformed (fail closed, never guessed). */
export class OnchainLaneDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnchainLaneDiscoveryError";
  }
}

/**
 * A proved onchain lane: every artifact is a REAL kernel artifact produced
 * by the engine's prepare/simulate/gate stages (INV-C05 grounding, gate
 * ALLOW, prepared write, expected diff, net-outcome evaluation, venue
 * health) plus the canonical input-asset observation and the deterministic
 * rail/protocol identities.
 */
export interface OnchainLaneProof {
  /** Deterministic lane identity: `onchain-lane:${executionId}:${venueId}:${quoteId}`. */
  readonly laneId: string;
  readonly venueId: string;
  /** The venue's protocol binding (deterministic protocol/chain identity). */
  readonly protocolBinding: VenueProtocolBinding;
  /** The engine-selected quote (the observation-law-carrying venue quote). */
  readonly quote: VenueQuote;
  /** The instance the engine bound the route to (ACTIVE + eligible, INV-C05). */
  readonly instance: ConnectedProtocolInstance;
  readonly routeRef: string;
  readonly routeHash: string;
  /** The kernel-prepared write (gate-ALLOWed). */
  readonly write: PreparedWrite;
  /** The deterministic gate decision (ALLOW — selection requires it). */
  readonly gateDecision: GateDecision;
  readonly expectedDiff: ExpectedStateDiff;
  /** The venue simulation the engine recorded, when the venue supports it. */
  readonly simulation?: SimulationObservation;
  readonly evaluation: NetOutcomeEvaluation;
  readonly health: HealthObservation;
  /** Deterministic rail id from the canonical settlement vocabulary. */
  readonly railId: string;
  /**
   * The chain's environment class, re-derived from the kernel's frozen
   * chain-environment registry (chain identity classifies the environment —
   * distinct from the Lab execution tier every result also carries).
   */
  readonly environmentClass: RailEnvironmentClass;
  /** INV-C08: the venue declared a provider-native benchmark baseline. */
  readonly isVenueNativeBaseline: boolean;
  /** The canonical input-asset observation grounding this lane. */
  readonly inputAssetObservation: AssetObservation;
  /** Which kernel adapter lifecycle stages the lane proof exercised. */
  readonly lifecycleStages: readonly AdapterLifecycleStage[];
  readonly evidenceRefs: readonly string[];
}

/** Discovery input: every instant and policy explicit (deterministic). */
export interface DiscoverOnchainLanesInput {
  readonly engine: BestExecutionEngine;
  readonly executionId: string;
  readonly swap: SwapRequest;
  readonly policy: BestExecutionPolicy;
  readonly security: {
    readonly policy: OnchainSecurityPolicy;
    readonly state: OnchainSecurityState;
  };
  /** Candidate execution scopes — validated by the kernel validator. */
  readonly instances: readonly ConnectedProtocolInstance[];
  /** Canonical asset observations grounding the lanes (observation law). */
  readonly assetObservations: readonly AssetObservation[];
  readonly owner: string;
  readonly beneficiary: string;
  readonly requestedBy: string;
  readonly routeExpiryMs: number;
  readonly at: number;
}

/** Why a selected route still did not yield a proved lane. */
export type OnchainLaneGroundingFailure =
  | "INPUT_ASSET_OBSERVATION_MISSING"
  | "INPUT_ASSET_OBSERVATION_STALE";

export type OnchainLaneDiscoveryResult =
  | {
      readonly status: "LANE_PROVED";
      readonly lane: OnchainLaneProof;
      readonly provenance: RouteProvenanceChain;
    }
  | {
      readonly status: "NO_EXECUTABLE_ROUTE";
      readonly provenance: RouteProvenanceChain;
      readonly detail: string;
    }
  | {
      readonly status: "LANE_UNPROVED_GROUNDING";
      readonly provenance: RouteProvenanceChain;
      readonly reason: OnchainLaneGroundingFailure;
      readonly detail: string;
    };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (Object.isFrozen(value)) {
      return value;
    }
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Proves at most one onchain lane per request: the engine's SELECTED route
 * (the best gate-ALLOWed route), grounded in a fresh canonical asset
 * observation. Every other engine outcome is surfaced honestly with the
 * full kernel provenance chain.
 */
export function discoverOnchainLane(
  input: DiscoverOnchainLanesInput,
): OnchainLaneDiscoveryResult {
  if (input.executionId.length === 0) {
    throw new OnchainLaneDiscoveryError("executionId must not be empty");
  }
  if (!Number.isInteger(input.at) || input.at < 0) {
    throw new OnchainLaneDiscoveryError(
      "at must be a non-negative integer millisecond instant (no ambient clock)",
    );
  }

  // Fail-closed validation of every kernel input BEFORE the engine runs.
  for (const instance of input.instances) {
    validateConnectedProtocolInstance(instance);
  }
  for (const observation of input.assetObservations) {
    validateAssetObservation(observation);
  }

  const decision = input.engine.execute({
    executionId: input.executionId,
    swap: input.swap,
    policy: input.policy,
    security: { policy: input.security.policy, state: input.security.state },
    instances: input.instances,
    owner: input.owner,
    beneficiary: input.beneficiary,
    requestedBy: input.requestedBy,
    routeExpiryMs: input.routeExpiryMs,
    at: input.at,
  });

  if (decision.decision !== "ROUTE_SELECTED") {
    return deepFreeze({
      status: "NO_EXECUTABLE_ROUTE",
      provenance: decision.provenance,
      detail:
        "the best-execution engine found no gate-ALLOWed executable route: no lane is fabricated on top of an empty selection (honest empty state)",
    });
  }

  const selected = decision.selected;

  // The venue object is required to resolve the deterministic protocol
  // binding (the engine binds routes to instances by protocol capability id).
  const venue: ExecutionVenue | undefined = input.engine
    .venues()
    .find((candidate) => candidate.descriptor.venueId === selected.venueId);
  if (venue === undefined) {
    throw new OnchainLaneDiscoveryError(
      `selected venue '${selected.venueId}' is not registered in the engine — the protocol binding cannot be resolved deterministically`,
    );
  }
  const binding = venue.protocol;
  const expectedCapabilityId = protocolCapabilityId(
    binding.protocolKey,
    binding.chainKey,
  );
  const instance: ConnectedProtocolInstance | undefined = input.instances.find(
    (candidate) =>
      candidate.capabilityId === expectedCapabilityId &&
      candidate.protocolKey === binding.protocolKey &&
      candidate.chainKey === binding.chainKey,
  );
  if (instance === undefined) {
    // The engine selected a route, so a matching ACTIVE instance existed at
    // execution time; reaching here means caller input drifted. Fail closed.
    throw new OnchainLaneDiscoveryError(
      `the engine selected venue '${selected.venueId}' but no input instance carries the deterministic capability id '${expectedCapabilityId}' — execution-scope input is inconsistent`,
    );
  }

  // Canonical input-asset grounding (onchain-domain observation law).
  const expectedAssetRef = canonicalAssetRef(
    selected.quote.chain,
    selected.quote.inputAsset.symbol,
  );
  const grounding: AssetObservation | undefined = input.assetObservations.find(
    (candidate) =>
      candidate.chainKey === selected.quote.chain &&
      candidate.assetId === expectedAssetRef &&
      candidate.location.accountRef === input.owner,
  );
  if (grounding === undefined) {
    return deepFreeze({
      status: "LANE_UNPROVED_GROUNDING",
      provenance: decision.provenance,
      reason: "INPUT_ASSET_OBSERVATION_MISSING",
      detail:
        `no canonical asset observation grounds the owner '${input.owner}' position for input asset '${expectedAssetRef}' on chain '${selected.quote.chain}' — the lane is not proved (a catalogue or quote alone never grounds execution, INV-C05 discipline)`,
    });
  }
  if (!isObservationFresh(grounding.freshness, input.at)) {
    return deepFreeze({
      status: "LANE_UNPROVED_GROUNDING",
      provenance: decision.provenance,
      reason: "INPUT_ASSET_OBSERVATION_STALE",
      detail:
        `the input-asset observation '${grounding.observationId}' is stale at the evaluation instant — the position is re-observed, never executed on stale state (kernel freshness law)`,
    });
  }

  const laneId = `onchain-lane:${input.executionId}:${selected.venueId}:${selected.quoteId}`;
  const railId = onchainRailId(selected.quote.chain);
  const evidenceRefs: readonly string[] = Object.freeze([
    ...selected.quote.provenance.evidenceRefs,
    `write:${selected.write.writeDigest}`,
    ...(selected.simulation !== undefined
      ? [`simulation:${selected.simulation.simulationId}`]
      : []),
    `asset-observation:${grounding.observationId}`,
    ...selected.gateDecision.evidenceRefs,
  ]);
  const lifecycleStages: readonly AdapterLifecycleStage[] = Object.freeze([
    "observe",
    "prepare",
    ...(venue.descriptor.supportsSimulation && selected.simulation !== undefined
      ? (["simulate"] as const)
      : []),
  ]);

  const lane: OnchainLaneProof = deepFreeze({
    laneId,
    venueId: selected.venueId,
    protocolBinding: binding,
    quote: selected.quote,
    instance,
    routeRef: selected.routeRef,
    routeHash: selected.routeHash,
    write: selected.write,
    gateDecision: selected.gateDecision,
    expectedDiff: selected.expectedDiff,
    ...(selected.simulation !== undefined
      ? { simulation: selected.simulation }
      : {}),
    evaluation: selected.evaluation,
    health: selected.health,
    railId,
    environmentClass: classifyChainEnvironment(selected.quote.chain),
    isVenueNativeBaseline:
      venue.descriptor.nativeOptimization?.benchmarkBaseline === true,
    inputAssetObservation: grounding,
    lifecycleStages,
    evidenceRefs,
  });

  return deepFreeze({
    status: "LANE_PROVED",
    lane,
    provenance: decision.provenance,
  });
}

// ---------------------------------------------------------------------------
// Venue-pack registration (the execution-plane composition surface)
// ---------------------------------------------------------------------------

/**
 * Builds an engine from REAL venue extension packs: every pack is validated
 * through the canonical pack contract and its venue registered behind the
 * neutral venue port (dependency direction venue → core preserved; this
 * module stays venue-neutral).
 */
export function engineFromVenuePacks(
  packs: readonly VenueExtensionPack[],
): { readonly engine: BestExecutionEngine; readonly venues: readonly ExecutionVenue[] } {
  const engine = new BestExecutionEngine();
  for (const pack of packs) {
    validateVenueExtensionPack(pack);
    engine.register(pack.venue);
  }
  return { engine, venues: engine.venues() };
}

/**
 * The connected protocol instance for a venue pack (the §2A layer-3
 * execution scope), built through the pack contract's own instance helper —
 * ACTIVE and eligible by construction, deterministically linked to the
 * pack's protocol capability id.
 */
export function protocolInstanceForPack(
  pack: VenueExtensionPack,
  input: {
    readonly instanceId: string;
    readonly accountRef: string;
    readonly tenantRef: string;
  },
): ConnectedProtocolInstance {
  validateVenueExtensionPack(pack);
  return venueConnectedProtocolInstance({
    protocolKey: pack.protocol.protocol.protocolKey,
    chainKey: pack.protocol.protocol.chainKey,
    instanceId: input.instanceId,
    providerName: pack.implementation.providerName,
    accountRef: input.accountRef,
    tenantRef: input.tenantRef,
  });
}
