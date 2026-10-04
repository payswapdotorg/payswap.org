/**
 * @payswap/route-compiler — the fiat route legs (Work Order P4-W4-001).
 *
 * Fiat legs are grounded EXACTLY like the kernel grounds onchain legs: a
 * leg exists only on top of a ConnectedCapabilityInstance plus a FRESH
 * canonical CapabilityObservation (INV-C05: a catalogue alone never grounds
 * execution), and the off-ramp payout leg carries the REAL connectors
 * payout gate report — evaluatePayoutGate over a ConnectedInstanceActivation
 * whose separate TransferOutAuthorization is the leg's authorization
 * artifact (connection scope alone NEVER grants transfer-out).
 *
 * Fiat leg vocabulary (per AGENTS.md rule 24, the off-ramp is a
 * Capability/Connector-model capability — no parallel concept):
 *
 * - FIAT_PSP_COLLECT — the customer's fiat is charged at the PSP
 *   (custody: principal payment instrument → external provider);
 * - PSP_STABLECOIN_ISSUANCE — the on-ramp hop: PSP funds become a
 *   fiat-pegged stablecoin minted onchain (custody: provider → onchain
 *   protocol issuer);
 * - OFF_RAMP_PAYOUT — the off-ramp hop: the provider pays fiat OUT to an
 *   explicit external destination (the payout gate + a PayoutDestination;
 *   observation-only provider state per INV-C09 — PaySwap never executes
 *   payouts on its own authority);
 * - BANK_SETTLEMENT — the arrival hop: fiat lands in the principal's
 *   external bank destination (a MerchantSettlementDestination — always
 *   the EXTERNAL destination, never PaySwap custody) and the settlement
 *   result is derived by the canonical payment-plane function
 *   settlementResultFrom, never re-declared.
 *
 * Freshness: the observation law applied to the connector observation
 * shape — observedAt must be within the caller-supplied max-age at the
 * compile instant. Unparseable timestamps fail closed. No ambient clock.
 */

import { ValidationError } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/trust";
import {
  evaluatePayoutGate,
  validateCapabilityObservation,
  type CapabilityDefinition,
  type CapabilityObservation,
  type ConnectedCapabilityInstance,
  type ConnectedInstanceActivation,
  type PayoutDestination,
  type PayoutGateReport,
  type PayoutRequestInit,
} from "@payswap/connectors";
import {
  settlementResultFrom,
  type MerchantSettlementDestination,
  type MerchantSettlementResult,
} from "@payswap/payment";

/** The fiat leg kinds (route-leg taxonomy, fiat half). */
export const FIAT_LEG_KINDS = [
  "FIAT_PSP_COLLECT",
  "PSP_STABLECOIN_ISSUANCE",
  "OFF_RAMP_PAYOUT",
  "BANK_SETTLEMENT",
] as const;
export type FiatLegKind = (typeof FIAT_LEG_KINDS)[number];

/** Raised when fiat-leg grounding is malformed (fail closed). */
export class InvalidFiatLegError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFiatLegError";
  }
}

/**
 * The deterministic identity of one canonical capability observation: the
 * connectors model identifies observations by (instanceId, observedAt,
 * observationVersion); the route vocabulary projects that onto a stable
 * reference id (never a new observation).
 */
export function capabilityObservationId(
  observation: Pick<CapabilityObservation, "instanceId" | "observationVersion">,
): string {
  return `capability-observation:${observation.instanceId}@${observation.observationVersion}`;
}

// ---------------------------------------------------------------------------
// The observation law, applied to connector observations
// ---------------------------------------------------------------------------

export interface FiatObservationFreshnessPolicy {
  readonly maxAgeSeconds: number;
}

/**
 * The kernel freshness law (isObservationFresh semantics) applied to the
 * canonical CapabilityObservation shape: fresh ⟺ the compile instant is
 * within maxAgeSeconds of the observation's observedAt. Fail closed on
 * unparseable timestamps — a timestamp that cannot be judged is never
 * fresh.
 */
export function isCapabilityObservationFresh(
  observation: CapabilityObservation,
  atMs: number,
  policy: FiatObservationFreshnessPolicy,
): boolean {
  if (!Number.isInteger(atMs) || atMs < 0) {
    throw new InvalidFiatLegError(
      "isCapabilityObservationFresh: at must be a non-negative integer millisecond instant (no ambient clock)",
    );
  }
  if (!Number.isInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds <= 0) {
    throw new InvalidFiatLegError(
      "isCapabilityObservationFresh: maxAgeSeconds must be a positive integer",
    );
  }
  const asOfMs = Date.parse(observation.observedAt);
  if (!Number.isFinite(asOfMs)) {
    return false;
  }
  return atMs - asOfMs <= policy.maxAgeSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Fiat leg grounding
// ---------------------------------------------------------------------------

/** The fiat execution-scope grounding: a real instance + a validated, fresh observation. */
export interface FiatLegGrounding {
  readonly instance: ConnectedCapabilityInstance;
  readonly observation: CapabilityObservation;
}

/**
 * Grounds one fiat leg: fail-closed validation of the instance's current
 * observation, the instance must be the observation's subject, and the
 * observation must be fresh at the compile instant. A grounding failure is
 * returned honestly (never a fabricated grounding).
 */
export function groundFiatLeg(input: {
  readonly instance: ConnectedCapabilityInstance;
  readonly observation: CapabilityObservation;
  readonly at: number;
  readonly freshnessPolicy: FiatObservationFreshnessPolicy;
}): { readonly status: "GROUNDED"; readonly grounding: FiatLegGrounding } | { readonly status: "STALE"; readonly reason: string } {
  const observation = validateCapabilityObservation(input.observation);
  if (observation.instanceId !== input.instance.instanceId) {
    throw new InvalidFiatLegError(
      `fiat leg grounding: observation '${capabilityObservationId(observation)}' observes instance '${observation.instanceId}', not '${input.instance.instanceId}' — grounding never crosses instances`,
    );
  }
  if (!isCapabilityObservationFresh(observation, input.at, input.freshnessPolicy)) {
    return {
      status: "STALE",
      reason: `capability observation '${capabilityObservationId(observation)}' (observedAt ${observation.observedAt}) is stale at the compile instant — the provider state is re-observed, never routed on stale state (observation law)`,
    };
  }
  return { status: "GROUNDED", grounding: { instance: input.instance, observation } };
}

// ---------------------------------------------------------------------------
// Provider-native baseline classification (INV-C08)
// ---------------------------------------------------------------------------

/**
 * INV-C08: a fiat capability whose definition declares
 * nativeOptimization.benchmarkBaseline === true is a provider-native
 * incumbent baseline. The compiler keeps such candidates structurally
 * undiscriminated — they are emitted as baseline candidates, never ranked
 * away.
 */
export function isProviderNativeBaselineCapability(
  definition: CapabilityDefinition,
): boolean {
  return definition.nativeOptimization?.benchmarkBaseline === true;
}

// ---------------------------------------------------------------------------
// The off-ramp payout authorization (the REAL payout gate)
// ---------------------------------------------------------------------------

/** Builds the REAL payout request init for one off-ramp payout hop. */
export function offRampPayoutRequestInit(input: {
  readonly connectorCapabilityId: string;
  readonly transferOutAuthorizationId: string;
  readonly destination: PayoutDestination;
  readonly amount: AmountSpec;
  readonly protocolKey: string;
  readonly authorizationEvidenceRef: string;
  readonly requestedAt: string;
  readonly cumulativeDrawnMinor?: number;
}): Omit<PayoutRequestInit, "amountMinor"> & { readonly amountMinor: number } {
  const minor = Number(input.amount.minorUnits);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new InvalidFiatLegError(
      "off-ramp payout amount must be positive integer minor units representable as a safe integer (INV-F01)",
    );
  }
  return Object.freeze({
    connectorCapabilityId: input.connectorCapabilityId,
    transferOutAuthorizationId: input.transferOutAuthorizationId,
    destination: input.destination,
    amountMinor: minor,
    currency: input.amount.currency,
    protocolKey: input.protocolKey,
    authorizationEvidenceRef: input.authorizationEvidenceRef,
    requestedAt: input.requestedAt,
    ...(input.cumulativeDrawnMinor !== undefined
      ? { cumulativeDrawnMinor: input.cumulativeDrawnMinor }
      : {}),
  });
}

/**
 * Evaluates the REAL payout gate for one off-ramp hop: the connectors'
 * evaluatePayoutGate over the activation record (the six gates: grant
 * exists, currency scope, limits, not expired, destination explicit
 * external, provider step-up). The report is the leg's authorization
 * verdict — fail-closed `allowed` is true only when EVERY check passes.
 */
export function evaluateOffRampPayoutGate(
  activation: ConnectedInstanceActivation,
  request: PayoutRequestInit,
): PayoutGateReport {
  return evaluatePayoutGate(activation, request);
}

// ---------------------------------------------------------------------------
// The bank settlement arrival (canonical payment-plane vocabulary)
// ---------------------------------------------------------------------------

/**
 * Derives the canonical settlement result for the bank arrival hop via the
 * payment-plane settlementResultFrom — the destination stays the EXTERNAL
 * bank instrument, never PaySwap custody, and the result is derived (never
 * re-declared).
 */
export function bankSettlementResult(
  destination: MerchantSettlementDestination,
): MerchantSettlementResult {
  return settlementResultFrom(destination);
}

/**
 * Selects the settlement destination for a BANK_ACCOUNT intent destination
 * by exact external reference match. Missing → honest undefined (the caller
 * surfaces it as a grounding failure, never a fabricated destination).
 */
export function settlementDestinationForIntent(
  destinations: readonly MerchantSettlementDestination[],
  intentExternalRef: string,
): MerchantSettlementDestination | undefined {
  return [...destinations]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .find((destination) => destination.externalRef === intentExternalRef);
}
