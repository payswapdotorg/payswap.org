/**
 * @payswap/route-compiler — the deterministic route-plan execution walk
 * (Work Order P4-W4-001, task-packet hard requirement 2).
 *
 * walkRoutePlan executes a compiled plan hop by hop in Lab-discipline
 * simulation (never production — the same non-production stance as the
 * mixed-rail execution walk), with per-leg fault injection:
 *
 * - ONCHAIN legs run through the REAL mixed-rail executor: DEX-swap legs
 *   through executeOnchainLane verbatim; kernel-prepared transfer/bridge
 *   legs through the same observation law (kernel-validated observations
 *   mapped through the canonical onchain-domain settlement vocabulary:
 *   rail outcome, settlement-attempt event candidate, rail operation).
 *
 * - FIAT legs resolve to the canonical settlement event candidates
 *   (CONFIRM_SUCCEEDED / CONFIRM_FAILED / OUTCOME_UNKNOWN — the same
 *   union the onchain mapping emits): provider-owned finality, observed
 *   as provider state (PayoutObservation for payout hops), never minted.
 *
 * - STRIPE legs resolve ONLY through provider-verified settlement
 *   observations (verificationStatus SUCCESS | FAILURE | OUTCOME_UNKNOWN)
 *   — the provider-verified-effects law: no synthetic Stripe balance
 *   effect can exist.
 *
 * Failure semantics (INV-X01/X02/X03, preserved at EVERY leg):
 * - a leg that fails definitively STOPS the route: downstream legs are
 *   NOT_EXECUTED with their honest reason — a failed leg never corrupts
 *   the rest of the route's honest state;
 * - an OUTCOME_UNKNOWN leg also stops the route (value position unknown —
 *   downstream execution would be blind) and routes the WHOLE partial
 *   state to reconciliation exactly like the single-rail lifecycle:
 *   blindRetryForbidden, SETTLEMENT_RECONCILIATION_AUTHORITY the only
 *   resolver (the onchain-adapters reconcile pattern);
 * - a SUBMITTED-not-final leg stops the route with the honest pending
 *   state (rule 29: submitted ≠ finality) and re-observation checks;
 * - a stale grounding is never executed (re-observe law).
 *
 * The walk records, at every stop, exactly WHERE the value honestly sits
 * (custodyAtStop) — no hidden custody, even mid-failure.
 */

import { ValidationError } from "@payswap/protocol";
import { executeOnchainLane, type OnchainLaneFault } from "@payswap/mixed-rail";
import {
  mapObservationToRailOutcome,
  mapToRailOperation,
  onchainRailId,
  settlementAttemptEventCandidate,
  validateOnchainExecutionObservation,
  type OnchainExecutionObservation,
  type OnchainRailOperationMapping,
  type OnchainRailOutcome,
  type SettlementAttemptEventCandidate,
} from "@payswap/onchain-domain";
import type { ChainFinalityModel, OnchainFailureClass } from "@payswap/onchain-domain";
import { payoutObservation } from "@payswap/connectors";
import { capabilityObservationId } from "./fiat-legs.js";
import type { PayoutObservation } from "@payswap/connectors";
import type { RouteLeg, RoutePlan } from "./route-plan.js";
import {
  validateStripeSettlementObservation,
  type StripeSettlementObservation,
} from "./stripe-legs.js";
import type { CustodyParty } from "./leg-contracts.js";

type KernelWriteLeg = Extract<RouteLeg, { legKind: "ONCHAIN_TRANSFER" }> | Extract<
  RouteLeg,
  { legKind: "ONCHAIN_BRIDGE" }
>;

/** Raised when walk input is malformed or the walk would fabricate execution (fail closed). */
export class RouteWalkError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "RouteWalkError";
  }
}

// ---------------------------------------------------------------------------
// Fault taxonomy (injectable at EVERY leg)
// ---------------------------------------------------------------------------

export const ROUTE_LEG_FAULT_KINDS = [
  "ONCHAIN_PROTOCOL_FAILURE",
  "ONCHAIN_UNFINALIZED_BROADCAST",
  "ONCHAIN_OUTCOME_UNKNOWN",
  "FIAT_OUTCOME_UNKNOWN",
  "FIAT_DEFINITIVE_FAILED",
  "STRIPE_OUTCOME_UNKNOWN",
] as const;
export type RouteLegFaultKind = (typeof ROUTE_LEG_FAULT_KINDS)[number];

export type RouteLegFault =
  | {
      readonly kind: "ONCHAIN_PROTOCOL_FAILURE";
      readonly failureClass: OnchainFailureClass;
      readonly description: string;
      readonly retryGuidance: "SAFE_TO_RETRY" | "REQUIRES_RECONCILIATION" | "NOT_RETRYABLE";
    }
  | { readonly kind: "ONCHAIN_UNFINALIZED_BROADCAST" }
  | { readonly kind: "ONCHAIN_OUTCOME_UNKNOWN"; readonly reason: string }
  | { readonly kind: "FIAT_OUTCOME_UNKNOWN"; readonly reason: string }
  | { readonly kind: "FIAT_DEFINITIVE_FAILED"; readonly reason: string }
  | { readonly kind: "STRIPE_OUTCOME_UNKNOWN"; readonly reason: string };

// ---------------------------------------------------------------------------
// Walk input / per-leg outcomes
// ---------------------------------------------------------------------------

export interface WalkRoutePlanInput {
  readonly plan: RoutePlan;
  /** Deterministic evaluation instant (ms). */
  readonly at: number;
  /** Deterministic observation timestamp (ISO, caller-supplied). */
  readonly observedAtIso: string;
  /** Fault injection keyed by legId (at most one fault per leg). */
  readonly faults?: Readonly<Record<string, RouteLegFault>>;
  /**
   * The chain finality model per chainKey for kernel-prepared legs
   * (grounded upstream in chain descriptors — never guessed here).
   */
  readonly onchainFinalityModels?: Readonly<Record<string, ChainFinalityModel>>;
}

export type LegExecutionOutcomeStatus =
  | "OBSERVED_FINALITY_CANDIDATE"
  | "SUBMITTED_NOT_FINAL"
  | "DEFINITIVE_FAILED"
  | "OUTCOME_UNKNOWN"
  | "NOT_EXECUTED"
  | "GROUNDING_STALE";

export interface RouteLegExecution {
  readonly legId: string;
  readonly legKind: RouteLeg["legKind"];
  readonly status: LegExecutionOutcomeStatus;
  /** The custody transfer this leg effected (or would have effected) — referenced, never re-declared. */
  readonly custodyTo: CustodyParty;
  /** Canonical settlement event candidate (present for executed onchain/fiat/stripe legs). */
  readonly eventCandidate?: SettlementAttemptEventCandidate;
  /** Present for executed onchain legs: the kernel observation + canonical mapping. */
  readonly onchain?: {
    readonly observation: OnchainExecutionObservation;
    readonly railOutcome: OnchainRailOutcome;
    readonly railOperation: OnchainRailOperationMapping;
  };
  /** Present for executed payout legs: the canonical provider payout observation. */
  readonly payoutObservation?: PayoutObservation;
  /** Present for executed Stripe legs: the provider-verified settlement observation. */
  readonly stripeObservation?: StripeSettlementObservation;
  readonly failure?: {
    readonly failureClass: string;
    readonly description: string;
    readonly retryGuidance: "SAFE_TO_RETRY" | "REQUIRES_RECONCILIATION" | "NOT_RETRYABLE";
  };
  readonly unknownReason?: string;
  readonly notExecutedReason?: string;
  readonly evidenceRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Route-level outcome (UNKNOWN/reconciliation semantics preserved)
// ---------------------------------------------------------------------------

export interface RouteReconciliationPlan {
  readonly operationKind: "RouteReconciliationPlan";
  readonly planId: string;
  readonly reasons: readonly string[];
  readonly externalChecks: readonly {
    readonly check: string;
    readonly providerNames: readonly string[];
  }[];
  readonly blindRetryForbidden: true;
  readonly resolver: "SETTLEMENT_RECONCILIATION_AUTHORITY";
}

export type RouteWalkResultStatus =
  | "ROUTE_COMPLETED_ALL_LEGS_OBSERVED"
  | "ROUTE_PENDING_FINALITY"
  | "ROUTE_REQUIRES_RECONCILIATION"
  | "ROUTE_STOPPED_DEFINITIVE_FAILURE"
  | "ROUTE_GROUNDING_STALE";

export interface RouteWalkResult {
  readonly planId: string;
  readonly intentRef: string;
  readonly status: RouteWalkResultStatus;
  readonly legExecutions: readonly RouteLegExecution[];
  /** Where the value honestly sits at the stop (no hidden custody, even mid-failure). */
  readonly custodyAtStop: { readonly party: CustodyParty; readonly assetRef: string } | undefined;
  /** Present when status is ROUTE_REQUIRES_RECONCILIATION (INV-X03: the only resolver). */
  readonly reconciliation?: RouteReconciliationPlan;
  readonly evidenceRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function toOnchainLaneFault(fault: RouteLegFault): OnchainLaneFault {
  switch (fault.kind) {
    case "ONCHAIN_PROTOCOL_FAILURE":
      return {
        kind: "PROTOCOL_FAILURE",
        failureClass: fault.failureClass,
        description: fault.description,
        retryGuidance: fault.retryGuidance,
      };
    case "ONCHAIN_UNFINALIZED_BROADCAST":
      return { kind: "UNFINALIZED_BROADCAST" };
    case "ONCHAIN_OUTCOME_UNKNOWN":
      return { kind: "OUTCOME_UNKNOWN", reason: fault.reason };
    default:
      throw new RouteWalkError(
        `fault kind '${fault.kind}' is not an onchain fault — fault injection is typed per rail family`,
      );
  }
}

function buildKernelLegObservation(
  leg: KernelWriteLeg,
  fault: RouteLegFault | undefined,
  observedAtIso: string,
  finalityModel: ChainFinalityModel,
): OnchainExecutionObservation {
  const chainKey = leg.write.chain;
  const executionRef = `route-walk-exec:${leg.legId}`;
  const observationId = `route-walk-obs:${leg.legId}:1`;
  const externalOperationRef = `route-walk-tx:${leg.legId}`;
  const evidenceRefs = [
    ...leg.evidenceRefs,
    `route-walk:${leg.legId}`,
  ];
  const provenance = {
    providerName: "payswap-route-compiler-walk",
    source: "INTERNAL" as const,
    capturedAt: observedAtIso,
  };
  if (fault === undefined) {
      return validateOnchainExecutionObservation({
        observationId,
        executionRef,
        observedAt: observedAtIso,
        chainKey,
        outcome: "CONFIRMED",
        externalOperationRef,
        finalityCandidate: {
          candidateOnly: true,
          requiresProtocolFinality: true,
          confirmationDepth: 1,
          finalityModel,
          reorgDetected: false,
        },
        evidenceRefs,
        provenance,
      });
  }
  switch (fault.kind) {
    case "ONCHAIN_PROTOCOL_FAILURE":
      return validateOnchainExecutionObservation({
        observationId,
        executionRef,
        observedAt: observedAtIso,
        chainKey,
        outcome: "FAILED",
        externalOperationRef,
        failure: {
          failureClass: fault.failureClass,
          description: fault.description,
          retryGuidance: fault.retryGuidance,
        },
        evidenceRefs,
        provenance,
      });
    case "ONCHAIN_UNFINALIZED_BROADCAST":
      return validateOnchainExecutionObservation({
        observationId,
        executionRef,
        observedAt: observedAtIso,
        chainKey,
        outcome: "BROADCAST",
        externalOperationRef,
        evidenceRefs,
        provenance,
      });
    case "ONCHAIN_OUTCOME_UNKNOWN":
      return validateOnchainExecutionObservation({
        observationId,
        executionRef,
        observedAt: observedAtIso,
        chainKey,
        outcome: "OUTCOME_UNKNOWN",
        externalOperationRef,
        unknownReason: fault.reason,
        evidenceRefs,
        provenance,
      });
    default:
      throw new RouteWalkError(
        `fault kind '${fault.kind}' cannot be injected into an onchain kernel-prepared leg`,
      );
  }
}

function fiatEventCandidate(
  status: "OBSERVED_FINALITY_CANDIDATE" | "DEFINITIVE_FAILED" | "OUTCOME_UNKNOWN",
): SettlementAttemptEventCandidate {
  switch (status) {
    case "OBSERVED_FINALITY_CANDIDATE":
      return { kind: "EVENT_CANDIDATE", event: "CONFIRM_SUCCEEDED" };
    case "DEFINITIVE_FAILED":
      return { kind: "EVENT_CANDIDATE", event: "CONFIRM_FAILED" };
    case "OUTCOME_UNKNOWN":
      return { kind: "EVENT_CANDIDATE", event: "OUTCOME_UNKNOWN" };
  }
}

/**
 * Executes one compiled route plan hop by hop. Deterministic: same (plan,
 * at, observedAtIso, faults, finality models) → deep-equal result.
 * Failure at ANY leg preserves UNKNOWN/reconciliation semantics and never
 * corrupts the honest state of the rest of the route.
 */
export function walkRoutePlan(input: WalkRoutePlanInput): RouteWalkResult {
  const { plan } = input;
  if (!Number.isInteger(input.at) || input.at < 0) {
    throw new RouteWalkError(
      "walkRoutePlan: at must be a non-negative integer millisecond instant (no ambient clock)",
    );
  }
  if (input.observedAtIso.length === 0) {
    throw new RouteWalkError(
      "walkRoutePlan: observedAtIso must be a caller-supplied ISO timestamp",
    );
  }
  if (plan.candidateStatus === "INELIGIBLE_CANDIDATE") {
    throw new RouteWalkError(
      `plan '${plan.planId}' is an INELIGIBLE_CANDIDATE — walking an ineligible plan would fabricate execution (fail closed; the ineligibility reasons are on the plan)`,
    );
  }

  const faults = input.faults ?? {};
  const legExecutions: RouteLegExecution[] = [];
  let stopped = false;
  let stopStatus: RouteWalkResultStatus | undefined;
  let custodyAtStop: { party: CustodyParty; assetRef: string } | undefined;
  const reconciliationReasons: string[] = [];
  const reconciliationChecks: { check: string; providerNames: string[] }[] = [];
  const evidenceRefs: string[] = [];

  for (const leg of plan.legs) {
    if (stopped) {
      legExecutions.push({
        legId: leg.legId,
        legKind: leg.legKind,
        status: "NOT_EXECUTED",
        custodyTo: leg.custody.to,
        notExecutedReason:
          "an upstream leg did not reach an observed finality candidate — downstream hops never execute on an unresolved route (the honest partial state)",
        evidenceRefs: [],
      });
      continue;
    }

    const fault = faults[leg.legId];
    if (fault !== undefined && !ROUTE_LEG_FAULT_KINDS.includes(fault.kind)) {
      throw new RouteWalkError(`unknown fault kind '${(fault as { kind: string }).kind}'`);
    }

    const groundingFailure = leg.stateGrounding.groundingFailures.length > 0;
    if (groundingFailure) {
      legExecutions.push({
        legId: leg.legId,
        legKind: leg.legKind,
        status: "GROUNDING_STALE",
        custodyTo: leg.custody.to,
        notExecutedReason: leg.stateGrounding.groundingFailures.join("; "),
        evidenceRefs: [],
      });
      stopStatus = "ROUTE_GROUNDING_STALE";
      stopped = true;
      custodyAtStop = { party: leg.custody.from, assetRef: leg.custody.assetRef };
      continue;
    }

    switch (leg.legKind) {
      case "ONCHAIN_DEX_SWAP": {
        const execution = executeOnchainLane({
          lane: leg.lane,
          at: input.at,
          observedAtIso: input.observedAtIso,
          ...(fault !== undefined ? { fault: toOnchainLaneFault(fault) } : {}),
          executionRef: `route-walk-exec:${leg.legId}`,
          observationId: `route-walk-obs:${leg.legId}:1`,
          externalOperationRef: `route-walk-tx:${leg.legId}`,
          settlementInstructionId: `settlement-instruction:${leg.intentRef}`,
          settlementAttemptId: `settlement-attempt:${leg.intentRef}:${leg.legId}`,
        });
        if (execution.status === "GROUNDING_STALE") {
          legExecutions.push({
            legId: leg.legId,
            legKind: leg.legKind,
            status: "GROUNDING_STALE",
            custodyTo: leg.custody.to,
            notExecutedReason: execution.reason,
            evidenceRefs: [...execution.evidenceRefs],
          });
          stopStatus = "ROUTE_GROUNDING_STALE";
          stopped = true;
          custodyAtStop = { party: leg.custody.from, assetRef: leg.custody.assetRef };
          break;
        }
        evidenceRefs.push(...execution.evidenceRefs);
        const status: LegExecutionOutcomeStatus =
          execution.outcome === "CONFIRMED"
            ? "OBSERVED_FINALITY_CANDIDATE"
            : execution.outcome === "BROADCAST"
              ? "SUBMITTED_NOT_FINAL"
              : execution.outcome === "FAILED"
                ? "DEFINITIVE_FAILED"
                : "OUTCOME_UNKNOWN";
        legExecutions.push({
          legId: leg.legId,
          legKind: leg.legKind,
          status,
          custodyTo: leg.custody.to,
          eventCandidate: execution.eventCandidate,
          onchain: {
            observation: execution.observation,
            railOutcome: execution.railOutcome,
            railOperation: execution.railOperation,
          },
          ...(execution.outcome === "FAILED" && execution.observation.failure !== undefined
            ? { failure: execution.observation.failure }
            : {}),
          ...(execution.outcome === "OUTCOME_UNKNOWN"
            ? { unknownReason: execution.observation.unknownReason }
            : {}),
          evidenceRefs: [...execution.evidenceRefs],
        });
        if (status === "OBSERVED_FINALITY_CANDIDATE") {
          custodyAtStop = { party: leg.custody.to, assetRef: leg.custody.assetRef };
        } else {
          applyStop(status, leg, execution.observation.unknownReason);
        }
        break;
      }
      case "ONCHAIN_TRANSFER":
      case "ONCHAIN_BRIDGE": {
        const finalityModel = input.onchainFinalityModels?.[leg.write.chain];
        if (finalityModel === undefined) {
          throw new RouteWalkError(
            `walkRoutePlan: no chain finality model is grounded for chain '${leg.write.chain}' — finality models are caller-supplied chain knowledge, never guessed`,
          );
        }
        const observation = buildKernelLegObservation(
          leg,
          fault,
          input.observedAtIso,
          finalityModel,
        );
        const railOutcome = mapObservationToRailOutcome(observation);
        const eventCandidate = settlementAttemptEventCandidate(observation);
        const railOperation = mapToRailOperation({
          observation,
          settlementInstructionId: `settlement-instruction:${leg.intentRef}`,
          settlementAttemptId: `settlement-attempt:${leg.intentRef}:${leg.legId}`,
        });
        if (railOperation.railId !== onchainRailId(leg.write.chain)) {
          throw new RouteWalkError(
            `walkRoutePlan: canonical rail id '${railOperation.railId}' disagrees with the write chain '${leg.write.chain}' — chain confusion is a first-class threat`,
          );
        }
        evidenceRefs.push(...observation.evidenceRefs);
        const status: LegExecutionOutcomeStatus =
          observation.outcome === "CONFIRMED"
            ? "OBSERVED_FINALITY_CANDIDATE"
            : observation.outcome === "BROADCAST"
              ? "SUBMITTED_NOT_FINAL"
              : observation.outcome === "FAILED"
                ? "DEFINITIVE_FAILED"
                : "OUTCOME_UNKNOWN";
        legExecutions.push({
          legId: leg.legId,
          legKind: leg.legKind,
          status,
          custodyTo: leg.custody.to,
          eventCandidate,
          onchain: { observation, railOutcome, railOperation },
          ...(observation.failure !== undefined ? { failure: observation.failure } : {}),
          ...(observation.unknownReason !== undefined
            ? { unknownReason: observation.unknownReason }
            : {}),
          evidenceRefs: [...observation.evidenceRefs],
        });
        if (status === "OBSERVED_FINALITY_CANDIDATE") {
          custodyAtStop = { party: leg.custody.to, assetRef: leg.custody.assetRef };
        } else {
          applyStop(status, leg, observation.unknownReason);
        }
        break;
      }
      case "FIAT_PSP_COLLECT":
      case "PSP_STABLECOIN_ISSUANCE": {
        const providerName = leg.instance.providerName;
        if (fault?.kind === "FIAT_DEFINITIVE_FAILED") {
          legExecutions.push({
            legId: leg.legId,
            legKind: leg.legKind,
            status: "DEFINITIVE_FAILED",
            custodyTo: leg.custody.to,
            eventCandidate: fiatEventCandidate("DEFINITIVE_FAILED"),
            failure: {
              failureClass: "PROVIDER_DEFINED",
              description: fault.reason,
              retryGuidance: "REQUIRES_RECONCILIATION",
            },
            evidenceRefs: [
              `provider:${providerName}`,
              `route-walk:${leg.legId}`,
            ],
          });
          applyStop("DEFINITIVE_FAILED", leg, undefined, [providerName]);
        } else if (fault?.kind === "FIAT_OUTCOME_UNKNOWN") {
          legExecutions.push({
            legId: leg.legId,
            legKind: leg.legKind,
            status: "OUTCOME_UNKNOWN",
            custodyTo: leg.custody.to,
            eventCandidate: fiatEventCandidate("OUTCOME_UNKNOWN"),
            unknownReason: fault.reason,
            evidenceRefs: [`provider:${providerName}`, `route-walk:${leg.legId}`],
          });
          applyStop("OUTCOME_UNKNOWN", leg, fault.reason, [providerName]);
        } else {
          if (fault !== undefined) {
            throw new RouteWalkError(
              `fault kind '${fault.kind}' cannot be injected into a fiat leg '${leg.legId}' — fault injection is typed per rail family`,
            );
          }
          legExecutions.push({
            legId: leg.legId,
            legKind: leg.legKind,
            status: "OBSERVED_FINALITY_CANDIDATE",
            custodyTo: leg.custody.to,
            eventCandidate: fiatEventCandidate("OBSERVED_FINALITY_CANDIDATE"),
            evidenceRefs: [
              `${capabilityObservationId(leg.observation)}`,
              `provider:${providerName}`,
              `route-walk:${leg.legId}`,
            ],
          });
          custodyAtStop = { party: leg.custody.to, assetRef: leg.custody.assetRef };
        }
        break;
      }
      case "OFF_RAMP_PAYOUT": {
        const providerName = leg.instance.providerName;
        const payoutRef = `route-walk-payout:${leg.legId}`;
        if (fault?.kind === "FIAT_DEFINITIVE_FAILED") {
          const observation = payoutObservation({
            observationId: `route-walk-payout-obs:${leg.legId}`,
            observedAt: input.observedAtIso,
            providerPayoutRef: payoutRef,
            providerName,
            status: "failed",
            provenanceSource: "PROVIDER_API",
          });
          legExecutions.push({
            legId: leg.legId,
            legKind: leg.legKind,
            status: "DEFINITIVE_FAILED",
            custodyTo: leg.custody.to,
            eventCandidate: fiatEventCandidate("DEFINITIVE_FAILED"),
            payoutObservation: observation,
            failure: {
              failureClass: "PROVIDER_DEFINED",
              description: fault.reason,
              retryGuidance: "REQUIRES_RECONCILIATION",
            },
            evidenceRefs: [`payout-observation:${observation.observationId}`],
          });
          applyStop("DEFINITIVE_FAILED", leg, undefined, [providerName]);
        } else if (fault?.kind === "FIAT_OUTCOME_UNKNOWN") {
          const observation = payoutObservation({
            observationId: `route-walk-payout-obs:${leg.legId}`,
            observedAt: input.observedAtIso,
            providerPayoutRef: payoutRef,
            providerName,
            status: "unknown",
            provenanceSource: "PROVIDER_API",
          });
          legExecutions.push({
            legId: leg.legId,
            legKind: leg.legKind,
            status: "OUTCOME_UNKNOWN",
            custodyTo: leg.custody.to,
            eventCandidate: fiatEventCandidate("OUTCOME_UNKNOWN"),
            payoutObservation: observation,
            unknownReason: fault.reason,
            evidenceRefs: [`payout-observation:${observation.observationId}`],
          });
          applyStop("OUTCOME_UNKNOWN", leg, fault.reason, [providerName]);
        } else {
          if (fault !== undefined) {
            throw new RouteWalkError(
              `fault kind '${fault.kind}' cannot be injected into the payout leg '${leg.legId}' — fault injection is typed per rail family`,
            );
          }
          const observation = payoutObservation({
            observationId: `route-walk-payout-obs:${leg.legId}`,
            observedAt: input.observedAtIso,
            providerPayoutRef: payoutRef,
            providerName,
            status: "paid",
            provenanceSource: "PROVIDER_API",
          });
          legExecutions.push({
            legId: leg.legId,
            legKind: leg.legKind,
            status: "OBSERVED_FINALITY_CANDIDATE",
            custodyTo: leg.custody.to,
            eventCandidate: fiatEventCandidate("OBSERVED_FINALITY_CANDIDATE"),
            payoutObservation: observation,
            evidenceRefs: [
              `payout-observation:${observation.observationId}`,
              `payout-gate:${leg.instance.instanceId}`,
            ],
          });
          custodyAtStop = { party: leg.custody.to, assetRef: leg.custody.assetRef };
        }
        break;
      }
      case "BANK_SETTLEMENT": {
        if (fault?.kind === "FIAT_OUTCOME_UNKNOWN") {
          legExecutions.push({
            legId: leg.legId,
            legKind: leg.legKind,
            status: "OUTCOME_UNKNOWN",
            custodyTo: leg.custody.to,
            eventCandidate: fiatEventCandidate("OUTCOME_UNKNOWN"),
            unknownReason: fault.reason,
            evidenceRefs: [
              `settlement-destination:${leg.settlementResult.destinationId}`,
              `route-walk:${leg.legId}`,
            ],
          });
          applyStop("OUTCOME_UNKNOWN", leg, fault.reason, ["bank-settlement-observation"]);
        } else if (fault?.kind === "FIAT_DEFINITIVE_FAILED") {
          legExecutions.push({
            legId: leg.legId,
            legKind: leg.legKind,
            status: "DEFINITIVE_FAILED",
            custodyTo: leg.custody.to,
            eventCandidate: fiatEventCandidate("DEFINITIVE_FAILED"),
            failure: {
              failureClass: "PROVIDER_DEFINED",
              description: fault.reason,
              retryGuidance: "REQUIRES_RECONCILIATION",
            },
            evidenceRefs: [
              `settlement-destination:${leg.settlementResult.destinationId}`,
              `route-walk:${leg.legId}`,
            ],
          });
          applyStop("DEFINITIVE_FAILED", leg, undefined, ["bank-settlement-observation"]);
        } else {
          if (fault !== undefined) {
            throw new RouteWalkError(
              `fault kind '${fault.kind}' cannot be injected into the bank settlement leg '${leg.legId}' — fault injection is typed per rail family`,
            );
          }
          legExecutions.push({
            legId: leg.legId,
            legKind: leg.legKind,
            status: "OBSERVED_FINALITY_CANDIDATE",
            custodyTo: leg.custody.to,
            eventCandidate: fiatEventCandidate("OBSERVED_FINALITY_CANDIDATE"),
            evidenceRefs: [
              `settlement-destination:${leg.settlementResult.destinationId}`,
              `route-walk:${leg.legId}`,
            ],
          });
          custodyAtStop = { party: leg.custody.to, assetRef: leg.custody.assetRef };
        }
        break;
      }
      case "STRIPE_CRYPTO_SETTLEMENT": {
        const observation = validateStripeSettlementObservation(
          fault?.kind === "STRIPE_OUTCOME_UNKNOWN"
            ? {
                observationId: `route-walk-stripe-obs:${leg.legId}`,
                stripeAccountRef:
                  leg.custody.to.kind === "STRIPE_MERCHANT_BALANCE"
                    ? leg.custody.to.stripeAccountRef
                    : "unknown",
                observedAt: input.observedAtIso,
                verificationStatus: "OUTCOME_UNKNOWN",
                unknownReason: fault.reason,
              }
            : {
                observationId: `route-walk-stripe-obs:${leg.legId}`,
                stripeAccountRef:
                  leg.custody.to.kind === "STRIPE_MERCHANT_BALANCE"
                    ? leg.custody.to.stripeAccountRef
                    : "unknown",
                observedAt: input.observedAtIso,
                verificationStatus: "SUCCESS",
                verificationRef: `stripe-verification:${leg.legId}`,
              },
        );
        if (fault !== undefined && fault.kind !== "STRIPE_OUTCOME_UNKNOWN") {
          throw new RouteWalkError(
            `fault kind '${fault.kind}' cannot be injected into the Stripe leg '${leg.legId}' — fault injection is typed per rail family`,
          );
        }
        const isUnknown = observation.verificationStatus === "OUTCOME_UNKNOWN";
        const status: LegExecutionOutcomeStatus = isUnknown
          ? "OUTCOME_UNKNOWN"
          : "OBSERVED_FINALITY_CANDIDATE";
        legExecutions.push({
          legId: leg.legId,
          legKind: leg.legKind,
          status,
          custodyTo: leg.custody.to,
          eventCandidate:
            status === "OUTCOME_UNKNOWN"
              ? { kind: "EVENT_CANDIDATE", event: "OUTCOME_UNKNOWN" }
              : { kind: "EVENT_CANDIDATE", event: "CONFIRM_SUCCEEDED" },
          stripeObservation: observation,
          ...(isUnknown ? { unknownReason: observation.unknownReason } : {}),
          evidenceRefs: [
            `stripe-settlement-observation:${observation.observationId}`,
            `route-walk:${leg.legId}`,
          ],
        });
        if (!isUnknown) {
          custodyAtStop = { party: leg.custody.to, assetRef: leg.custody.assetRef };
        } else {
          applyStop("OUTCOME_UNKNOWN", leg, observation.unknownReason, ["stripe"]);
        }
        break;
      }
    }
  }

  function applyStop(
    status: Exclude<LegExecutionOutcomeStatus, "OBSERVED_FINALITY_CANDIDATE" | "NOT_EXECUTED">,
    leg: RouteLeg,
    unknownReason: string | undefined,
    providerNames: readonly string[] = [],
  ): void {
    stopped = true;
    custodyAtStop = custodyAtStop ?? { party: leg.custody.from, assetRef: leg.custody.assetRef };
    if (status === "OUTCOME_UNKNOWN") {
      stopStatus = "ROUTE_REQUIRES_RECONCILIATION";
      reconciliationReasons.push(
        `leg '${leg.legId}' (${leg.legKind}) resolved OUTCOME_UNKNOWN${
          unknownReason !== undefined ? `: ${unknownReason}` : ""
        } — UNKNOWN is an honest terminal state (INV-X01)`,
      );
      reconciliationReasons.push(
        `the value position between '${describe(leg.custody.from)}' and '${describe(
          leg.custody.to,
        )}' is UNKNOWN — reconciliation resolves it; blind retry is forbidden (INV-X02)`,
      );
      reconciliationChecks.push({
        check: "re-observe the external outcome through the provider(s) and the chain",
        providerNames: [...providerNames],
      });
    } else if (status === "SUBMITTED_NOT_FINAL") {
      stopStatus = stopStatus ?? "ROUTE_PENDING_FINALITY";
      reconciliationReasons.push(
        `leg '${leg.legId}' (${leg.legKind}) is submitted-not-final (rule 29: submitted is not finality)`,
      );
    } else if (status === "DEFINITIVE_FAILED") {
      stopStatus = "ROUTE_STOPPED_DEFINITIVE_FAILURE";
    } else {
      stopStatus = "ROUTE_GROUNDING_STALE";
    }
  }

  const anyPending = legExecutions.some((execution) => execution.status === "SUBMITTED_NOT_FINAL");
  const finalStatus: RouteWalkResultStatus =
    stopStatus ??
    (anyPending ? "ROUTE_PENDING_FINALITY" : "ROUTE_COMPLETED_ALL_LEGS_OBSERVED");

  const reconciliation: RouteReconciliationPlan | undefined =
    finalStatus === "ROUTE_REQUIRES_RECONCILIATION"
      ? Object.freeze({
          operationKind: "RouteReconciliationPlan",
          planId: plan.planId,
          reasons: Object.freeze(reconciliationReasons),
          externalChecks: Object.freeze(reconciliationChecks),
          blindRetryForbidden: true,
          resolver: "SETTLEMENT_RECONCILIATION_AUTHORITY",
        })
      : undefined;

  return deepFreeze({
    planId: plan.planId,
    intentRef: plan.intentRef,
    status: finalStatus,
    legExecutions: Object.freeze(legExecutions),
    custodyAtStop,
    ...(reconciliation !== undefined ? { reconciliation } : {}),
    evidenceRefs: Object.freeze([...new Set(evidenceRefs)]),
  });
}

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

function describe(party: CustodyParty): string {
  switch (party.kind) {
    case "ONCHAIN_WALLET":
      return `wallet:${party.accountRef}`;
    case "EXTERNAL_PROVIDER":
      return `provider:${party.providerName}`;
    case "EXTERNAL_BANK_INSTRUMENT":
      return `bank:${party.externalRef}`;
    case "ONCHAIN_PROTOCOL":
      return `protocol:${party.protocolKey}@${party.chainKey}`;
    case "STRIPE_MERCHANT_BALANCE":
      return `stripe-balance:${party.stripeAccountRef}`;
  }
}
