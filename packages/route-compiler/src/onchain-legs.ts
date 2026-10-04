/**
 * @payswap/route-compiler — the onchain route legs (Work Order P4-W4-001).
 *
 * Onchain legs are proved ONLY through the merged kernels — no shadow
 * models (the mixed-rail discipline, extended to route compilation):
 *
 * - ONCHAIN_DEX_SWAP — proved through the REAL mixed-rail lane discovery
 *   (discoverOnchainLane), which runs the venue-port best-execution engine
 *   (quote → policy → prepare → simulate → gate) over REAL venue extension
 *   packs. The lane proof — venue quote with freshness/provenance/observer,
 *   gate-ALLOWed prepared write, expected state diff, net-outcome
 *   evaluation, health observation, canonical input-asset observation — is
 *   carried verbatim inside the leg.
 *
 * - ONCHAIN_TRANSFER / ONCHAIN_BRIDGE — proved through the REAL
 *   onchain-security write pipeline: prepareWrite (fail-closed validation,
 *   secret scan, content-addressing) → evaluateOnchainWriteGates (the
 *   deterministic authority: ALLOW/BLOCK/UNKNOWN with guard checks and
 *   evidence refs) → buildExpectedStateDiff (the user-readable expected
 *   state). Transfer and bridge operations are canonical members of the
 *   onchain-domain operation vocabulary ("onchain.transfer",
 *   "onchain.bridge") — this module never invents an operation kind.
 *
 * A BLOCKed or UNKNOWN gate verdict is carried honestly on the leg (the
 * authorization lineage records the verdict verbatim); it never silently
 * disappears and never coerces to executable.
 */

import { ValidationError } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/trust";
import type { AssetObservation, ConnectedProtocolInstance } from "@payswap/onchain-domain";
import { validateAssetObservation } from "@payswap/onchain-domain";
import {
  buildExpectedStateDiff,
  evaluateOnchainWriteGates,
  prepareWrite,
  type ExpectedStateDiff,
  type GateDecision,
  type OnchainSecurityPolicy,
  type OnchainSecurityState,
  type OnchainWriteRequest,
  type PreparedWrite,
} from "@payswap/onchain-security";
import { isObservationFresh } from "@payswap/onchain-adapters";
import {
  discoverOnchainLane,
  type DiscoverOnchainLanesInput,
  type OnchainLaneProof,
} from "@payswap/mixed-rail";
import { BestExecutionEngine } from "@payswap/best-execution";
import type { ExecutionVenue, SwapRequest, BestExecutionPolicy } from "@payswap/best-execution";
import { validateVenueExtensionPack } from "@payswap/onchain-venues";
import type { VenueExtensionPack } from "@payswap/onchain-venues";

/** The onchain leg kinds (route-leg taxonomy, onchain half). */
export const ONCHAIN_LEG_KINDS = [
  "ONCHAIN_DEX_SWAP",
  "ONCHAIN_TRANSFER",
  "ONCHAIN_BRIDGE",
] as const;
export type OnchainLegKind = (typeof ONCHAIN_LEG_KINDS)[number];

/** Raised when onchain-leg construction is malformed (fail closed). */
export class InvalidOnchainLegError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOnchainLegError";
  }
}

// ---------------------------------------------------------------------------
// The DEX swap leg — REAL mixed-rail lane discovery
// ---------------------------------------------------------------------------

export type SwapLaneDiscoveryOutcome =
  | { readonly status: "LANE_PROVED"; readonly lane: OnchainLaneProof }
  | { readonly status: "NO_EXECUTABLE_ROUTE"; readonly detail: string }
  | { readonly status: "LANE_UNPROVED_GROUNDING"; readonly detail: string };

/**
 * Proves one DEX-swap leg through the REAL mixed-rail lane discovery: the
 * engine (built from the caller's venue packs, canonically ordered by
 * venueId so compilation is a pure function of the pack SET) runs the full
 * venue-port pipeline; every honest non-proved outcome is surfaced with its
 * kernel detail, never fabricated into a leg.
 */
export function discoverSwapLane(input: {
  readonly venuePacks: readonly VenueExtensionPack[];
  readonly swap: SwapRequest;
  readonly policy: BestExecutionPolicy;
  readonly security: {
    readonly policy: OnchainSecurityPolicy;
    readonly state: OnchainSecurityState;
  };
  readonly instances: readonly ConnectedProtocolInstance[];
  readonly assetObservations: readonly AssetObservation[];
  readonly owner: string;
  readonly beneficiary: string;
  readonly requestedBy: string;
  readonly routeExpiryMs: number;
  readonly at: number;
}): { readonly outcome: SwapLaneDiscoveryOutcome; readonly venues: readonly ExecutionVenue[] } {
  const sortedPacks = [...input.venuePacks]
    .map((pack) => validateVenueExtensionPack(pack))
    .sort((a, b) =>
      a.venue.descriptor.venueId < b.venue.descriptor.venueId
        ? -1
        : a.venue.descriptor.venueId > b.venue.descriptor.venueId
          ? 1
          : 0,
    );
  const engine = new BestExecutionEngine();
  for (const pack of sortedPacks) {
    engine.register(pack.venue);
  }
  const result = discoverOnchainLane({
    engine,
    executionId: `route-swap:${input.swap.requestId}`,
    swap: input.swap,
    policy: input.policy,
    security: { policy: input.security.policy, state: input.security.state },
    instances: [...input.instances].sort((a, b) =>
      a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0,
    ),
    assetObservations: [...input.assetObservations]
      .map((observation) => validateAssetObservation(observation))
      .sort((a, b) => (a.observationId < b.observationId ? -1 : 1)),
    owner: input.owner,
    beneficiary: input.beneficiary,
    requestedBy: input.requestedBy,
    routeExpiryMs: input.routeExpiryMs,
    at: input.at,
  });
  const outcome: SwapLaneDiscoveryOutcome =
    result.status === "LANE_PROVED"
      ? { status: "LANE_PROVED", lane: result.lane }
      : result.status === "NO_EXECUTABLE_ROUTE"
        ? { status: "NO_EXECUTABLE_ROUTE", detail: result.detail }
        : { status: "LANE_UNPROVED_GROUNDING", detail: result.detail };
  return { outcome, venues: engine.venues() };
}

// ---------------------------------------------------------------------------
// The kernel-prepared transfer / bridge leg (prepare → gate → diff)
// ---------------------------------------------------------------------------

export interface KernelPreparedLegArtifacts {
  readonly write: PreparedWrite;
  readonly gateDecision: GateDecision;
  readonly expectedDiff: ExpectedStateDiff;
}

/**
 * Builds one onchain transfer or bridge hop through the REAL kernel write
 * pipeline. The write request uses the canonical operation vocabulary
 * ("onchain.transfer" / "onchain.bridge"); the gate verdict — ALLOW, BLOCK
 * or UNKNOWN — is returned verbatim as the leg's authorization verdict.
 */
export function prepareOnchainTransferOrBridgeLeg(input: {
  readonly operation: "onchain.transfer" | "onchain.bridge";
  readonly writeId: string;
  readonly asset: { readonly chain: string; readonly assetId: string; readonly symbol: string };
  readonly amount: AmountSpec;
  readonly from: string;
  readonly to: string;
  readonly routeId: string;
  readonly routeHash: string;
  readonly protocol?: OnchainWriteRequest["protocol"];
  readonly expiry: number;
  readonly requestedBy: string;
  readonly settlementInstruction?: OnchainWriteRequest["settlementInstruction"];
  readonly security: {
    readonly policy: OnchainSecurityPolicy;
    readonly state: OnchainSecurityState;
  };
  readonly at: number;
}): KernelPreparedLegArtifacts {
  if (input.operation !== "onchain.transfer" && input.operation !== "onchain.bridge") {
    throw new InvalidOnchainLegError(
      `operation '${input.operation}' is not a canonical route-leg onchain operation (onchain.transfer | onchain.bridge)`,
    );
  }
  const request: OnchainWriteRequest = {
    writeId: input.writeId,
    action: input.operation,
    chain: input.asset.chain,
    transfer: {
      asset: input.asset,
      amount: input.amount,
      from: input.from,
      to: input.to,
    },
    approvals: [],
    route: { routeId: input.routeId, routeHash: input.routeHash },
    ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
    expiry: input.expiry,
    requestedBy: input.requestedBy,
    ...(input.settlementInstruction !== undefined
      ? { settlementInstruction: input.settlementInstruction }
      : {}),
  };
  const write = prepareWrite(request, input.at);
  const gateDecision = evaluateOnchainWriteGates({
    write,
    policy: input.security.policy,
    securityState: input.security.state,
    at: input.at,
  });
  const expectedDiff = buildExpectedStateDiff(write);
  return Object.freeze({ write, gateDecision, expectedDiff });
}

// ---------------------------------------------------------------------------
// Asset-observation freshness (the kernel probe, composed as-is)
// ---------------------------------------------------------------------------

/**
 * The REAL kernel freshness probe composed as-is for route-leg grounding:
 * fresh ⟺ at − asOf ≤ maxAgeSeconds·1000. Stale groundings are honest
 * grounding failures — re-observe, never route on stale state.
 */
export function onchainObservationIsFresh(
  observation: AssetObservation,
  atMs: number,
): boolean {
  return isObservationFresh(observation.freshness, atMs);
}

export type { DiscoverOnchainLanesInput };
