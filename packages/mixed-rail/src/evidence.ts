/**
 * @payswap/mixed-rail — exact evidence records (Work Order P4-W3-001
 * hard requirement 5: "every Lab simulation outcome carries a provenance
 * chain (which capabilities, which observations at what freshness, through
 * which venue/lane), the onchain-domain observation law applied").
 *
 * An onchain lane's evidence record names, exactly:
 * - WHICH capability: the deterministic protocol capability id + the
 *   connected instance id (INV-C05 execution scope) + provider name;
 * - WHICH observations at WHAT freshness: the venue quote's freshness
 *   (asOfMs/maxAgeMs — the quote observation law) AND the canonical asset
 *   observation's freshness (asOf/maxAgeSeconds — the onchain-domain
 *   observation law), plus the observation id;
 * - THROUGH which venue/lane: venue id, lane id, deterministic rail id;
 * - WHAT outcome: the kernel execution outcome, when the walk ran;
 * - WHICH evidence nodes: the verbatim kernel evidence refs (quote
 *   provenance, write digest, simulation id, gate evidence, execution).
 *
 * The record digest uses the kernel's own deterministic content digest
 * (bigint-safe canonical serialization) — tamper detection is structural.
 */

import { contentDigest } from "@payswap/onchain-security";
import type { OnchainExecutionOutcome } from "@payswap/onchain-domain";
import type { OnchainLaneProof } from "./onchain-lane.js";
import type { OnchainLaneExecution } from "./execution-walk.js";

/** The exact evidence record of one onchain lane (kernel artifacts only). */
export interface OnchainLaneEvidenceRecord {
  readonly laneId: string;
  readonly venueId: string;
  /** The deterministic protocol capability id (which capability). */
  readonly protocolCapabilityId: string;
  /** The connected instance id (the execution scope, INV-C05). */
  readonly instanceId: string;
  readonly providerName: string;
  /** The deterministic rail id (through which lane). */
  readonly railId: string;
  readonly chainKey: string;
  /** INV-C08: this lane is a provider-native incumbent baseline. */
  readonly incumbentBaseline: boolean;
  /** The venue quote's freshness (the quote observation law), verbatim. */
  readonly quoteFreshness: { readonly asOfMs: number; readonly maxAgeMs: number };
  /** The canonical asset observation's freshness (observation law), verbatim. */
  readonly assetObservationFreshness: { readonly asOf: string; readonly maxAgeSeconds: number };
  readonly assetObservationId: string;
  /** The kernel execution outcome, when the walk ran (never coerced). */
  readonly outcome?: OnchainExecutionOutcome;
  readonly evidenceRefs: readonly string[];
}

/**
 * Builds the exact evidence record of a lane, folding in the execution
 * outcome (with its kernel evidence refs) when the Lab walk ran.
 */
export function buildOnchainLaneEvidence(
  lane: OnchainLaneProof,
  execution?: OnchainLaneExecution,
): OnchainLaneEvidenceRecord {
  const evidenceRefs: readonly string[] = Object.freeze([
    ...lane.evidenceRefs,
    ...(execution !== undefined ? [...execution.evidenceRefs] : []),
  ]);
  return Object.freeze({
    laneId: lane.laneId,
    venueId: lane.venueId,
    protocolCapabilityId: lane.instance.capabilityId,
    instanceId: lane.instance.instanceId,
    providerName: lane.instance.providerName,
    railId: lane.railId,
    chainKey: lane.quote.chain,
    incumbentBaseline: lane.isVenueNativeBaseline,
    quoteFreshness: {
      asOfMs: lane.quote.freshness.asOfMs,
      maxAgeMs: lane.quote.freshness.maxAgeMs,
    },
    assetObservationFreshness: {
      asOf: lane.inputAssetObservation.freshness.asOf,
      maxAgeSeconds: lane.inputAssetObservation.freshness.maxAgeSeconds,
    },
    assetObservationId: lane.inputAssetObservation.observationId,
    ...(execution !== undefined && execution.status === "EXECUTED"
      ? { outcome: execution.outcome }
      : {}),
    evidenceRefs,
  });
}

/** Deterministic digest of a lane's evidence record (tamper detection). */
export function laneEvidenceDigest(record: OnchainLaneEvidenceRecord): string {
  return contentDigest(record);
}
