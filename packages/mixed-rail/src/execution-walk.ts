/**
 * @payswap/mixed-rail — the deterministic onchain execution walk
 * (Work Order P4-W3-001 hard requirements 4 and 5).
 *
 * Executes a PROVED lane inside Lab simulation: the walk builds the
 * execution observation of the simulated chain, VALIDATES it with the real
 * kernel observation validator (fail closed — a Lab-built observation that
 * violates the kernel's observation law can never exist), and maps it
 * through the canonical onchain-domain settlement vocabulary (rail outcome,
 * settlement-attempt event candidate, rail-operation mapping). No shadow
 * vocabulary: the outcomes are the kernel's own union, verbatim.
 *
 * Fault taxonomy (chain/protocol failures, unfinalized observations, and
 * UNKNOWN — AGENTS.md rule 4):
 * - PROTOCOL_FAILURE — the simulated chain FAILED the operation: the kernel
 *   failure descriptor is carried verbatim (class, description, retry
 *   guidance);
 * - UNFINALIZED_BROADCAST — the operation was submitted but not confirmed
 *   (BROADCAST: submitted-not-final, no finality candidate — rule 29);
 * - OUTCOME_UNKNOWN — external ambiguity (e.g. a reorganized receipt): an
 *   HONEST TERMINAL STATE with its reason. It is never coerced into success
 *   or failure, and the kernel validator structurally forbids attaching a
 *   failure descriptor to it (INV-X01).
 *
 * Lifecycle honesty: the walk records which kernel adapter lifecycle stages
 * it exercised. It NEVER records "authorize" or "broadcast" — the Lab
 * cannot mint authorization (proposal-only, INV-G03 discipline) and never
 * broadcasts anything (AGENTS.md rule 7). A BROADCAST observation produced
 * by the UNFINALIZED_BROADCAST fault models the simulated chain's view of a
 * previously submitted operation; the Lab walk itself still ends at
 * observation time.
 *
 * Stale grounding: a lane whose input-asset observation aged out is NOT
 * executed and NOT failed — GROUNDING_STALE surfaces the re-observe
 * requirement (the kernel staleness law: re-observe, never execute on
 * stale state).
 */

import { isObservationFresh } from "@payswap/onchain-adapters";
import type { AdapterLifecycleStage } from "@payswap/onchain-adapters";
import {
  mapObservationToRailOutcome,
  mapToRailOperation,
  settlementAttemptEventCandidate,
  validateOnchainExecutionObservation,
} from "@payswap/onchain-domain";
import type {
  OnchainExecutionObservation,
  OnchainExecutionOutcome,
  OnchainFailureClass,
  OnchainRailOperationMapping,
  OnchainRailOutcome,
  SettlementAttemptEventCandidate,
} from "@payswap/onchain-domain";
import { ValidationError } from "@payswap/protocol";
import type { OnchainLaneProof } from "./onchain-lane.js";

/** The simulator identity recorded in every observation's provenance. */
export const LAB_LANE_SIMULATOR_ID = "payswap-mixed-rail-simulator" as const;

/** The fault kinds the Lab walk can inject (chain/protocol failures + UNKNOWN). */
export const ONCHAIN_LANE_FAULT_KINDS = [
  "PROTOCOL_FAILURE",
  "UNFINALIZED_BROADCAST",
  "OUTCOME_UNKNOWN",
] as const;
export type OnchainLaneFaultKind = (typeof ONCHAIN_LANE_FAULT_KINDS)[number];

export type OnchainLaneFault =
  | {
      readonly kind: "PROTOCOL_FAILURE";
      readonly failureClass: OnchainFailureClass;
      readonly description: string;
      readonly retryGuidance: "SAFE_TO_RETRY" | "REQUIRES_RECONCILIATION" | "NOT_RETRYABLE";
    }
  | { readonly kind: "UNFINALIZED_BROADCAST" }
  | { readonly kind: "OUTCOME_UNKNOWN"; readonly reason: string };

/** Walk input: every instant explicit (deterministic, no ambient clock). */
export interface ExecuteOnchainLaneInput {
  readonly lane: OnchainLaneProof;
  /** Deterministic evaluation instant (ms). */
  readonly at: number;
  /** Deterministic observation timestamp (ISO; caller-supplied). */
  readonly observedAtIso: string;
  readonly fault?: OnchainLaneFault;
  readonly executionRef?: string;
  readonly observationId?: string;
  readonly externalOperationRef?: string;
  readonly settlementInstructionId?: string;
  readonly settlementAttemptId?: string;
}

export type OnchainLaneExecution =
  | {
      readonly status: "EXECUTED";
      readonly laneId: string;
      readonly venueId: string;
      readonly chainKey: string;
      readonly railId: string;
      /** The kernel outcome vocabulary, verbatim (never coerced). */
      readonly outcome: OnchainExecutionOutcome;
      /** The kernel-validated execution observation. */
      readonly observation: OnchainExecutionObservation;
      /** The canonical rail outcome mapping (kernel vocabulary). */
      readonly railOutcome: OnchainRailOutcome;
      /** The canonical settlement-attempt event candidate. */
      readonly eventCandidate: SettlementAttemptEventCandidate;
      /** The canonical observation → rail-operation mapping. */
      readonly railOperation: OnchainRailOperationMapping;
      /** Kernel lifecycle stages this walk exercised (never authorize/broadcast). */
      readonly lifecycleStages: readonly AdapterLifecycleStage[];
      readonly fault?: OnchainLaneFault;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly status: "GROUNDING_STALE";
      readonly laneId: string;
      readonly venueId: string;
      readonly chainKey: string;
      readonly railId: string;
      readonly reason: string;
      readonly lifecycleStages: readonly ["observe"];
      readonly evidenceRefs: readonly string[];
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
 * Executes one proved lane in Lab simulation. Deterministic: same (lane,
 * at, observedAtIso, fault, ids) → deep-equal result. The observation is
 * validated by the kernel validator and mapped through the canonical
 * settlement vocabulary; UNKNOWN is an honest terminal state.
 */
export function executeOnchainLane(
  input: ExecuteOnchainLaneInput,
): OnchainLaneExecution {
  const { lane } = input;
  if (!Number.isInteger(input.at) || input.at < 0) {
    throw new ValidationError(
      "executeOnchainLane: at must be a non-negative integer millisecond instant",
    );
  }
  if (input.observedAtIso.length === 0) {
    throw new ValidationError(
      "executeOnchainLane: observedAtIso must be a caller-supplied ISO timestamp (no ambient clock)",
    );
  }

  // Staleness law: re-observe, never execute on stale state.
  if (!isObservationFresh(lane.inputAssetObservation.freshness, input.at)) {
    return deepFreeze({
      status: "GROUNDING_STALE",
      laneId: lane.laneId,
      venueId: lane.venueId,
      chainKey: lane.quote.chain,
      railId: lane.railId,
      reason:
        `input-asset observation '${lane.inputAssetObservation.observationId}' aged out at the execution instant — the lane is re-observed, never executed on stale state (kernel staleness law)`,
      lifecycleStages: Object.freeze(["observe"] as const),
      evidenceRefs: Object.freeze([
        `asset-observation:${lane.inputAssetObservation.observationId}`,
      ]),
    });
  }

  const executionRef = input.executionRef ?? `lab-sim-exec:${lane.laneId}`;
  const observationId = input.observationId ?? `lab-sim-obs:${lane.laneId}:1`;
  const externalOperationRef =
    input.externalOperationRef ?? `lab-sim-tx:${lane.laneId}`;
  const evidenceRefs: readonly string[] = Object.freeze([
    ...lane.evidenceRefs,
    `lab-execution:${executionRef}`,
  ]);

  let observation: OnchainExecutionObservation;
  switch (input.fault?.kind) {
    case undefined: {
      // Deterministic happy path: the simulated chain confirms at depth 1
      // with a finality CANDIDATE (candidate-only, protocol-owned finality).
      observation = {
        observationId,
        executionRef,
        observedAt: input.observedAtIso,
        chainKey: lane.quote.chain,
        outcome: "CONFIRMED",
        externalOperationRef,
        finalityCandidate: {
          candidateOnly: true,
          requiresProtocolFinality: true,
          confirmationDepth: 1,
          finalityModel: lane.quote.timeToSettlement.finalityModel,
          reorgDetected: false,
        },
        evidenceRefs,
        provenance: {
          providerName: LAB_LANE_SIMULATOR_ID,
          source: "INTERNAL",
          capturedAt: input.observedAtIso,
        },
      };
      break;
    }
    case "PROTOCOL_FAILURE": {
      observation = {
        observationId,
        executionRef,
        observedAt: input.observedAtIso,
        chainKey: lane.quote.chain,
        outcome: "FAILED",
        externalOperationRef,
        failure: {
          failureClass: input.fault.failureClass,
          description: input.fault.description,
          retryGuidance: input.fault.retryGuidance,
        },
        evidenceRefs,
        provenance: {
          providerName: LAB_LANE_SIMULATOR_ID,
          source: "INTERNAL",
          capturedAt: input.observedAtIso,
        },
      };
      break;
    }
    case "UNFINALIZED_BROADCAST": {
      observation = {
        observationId,
        executionRef,
        observedAt: input.observedAtIso,
        chainKey: lane.quote.chain,
        outcome: "BROADCAST",
        externalOperationRef,
        evidenceRefs,
        provenance: {
          providerName: LAB_LANE_SIMULATOR_ID,
          source: "INTERNAL",
          capturedAt: input.observedAtIso,
        },
      };
      break;
    }
    case "OUTCOME_UNKNOWN": {
      observation = {
        observationId,
        executionRef,
        observedAt: input.observedAtIso,
        chainKey: lane.quote.chain,
        outcome: "OUTCOME_UNKNOWN",
        externalOperationRef,
        unknownReason: input.fault.reason,
        evidenceRefs,
        provenance: {
          providerName: LAB_LANE_SIMULATOR_ID,
          source: "INTERNAL",
          capturedAt: input.observedAtIso,
        },
      };
      break;
    }
  }

  // The REAL kernel observation validator: a Lab-built observation that
  // violates the kernel law (failure on UNKNOWN, finality on BROADCAST,
  // missing unknownReason, empty evidence) fails closed here.
  const validated = validateOnchainExecutionObservation(observation);

  // Canonical settlement vocabulary mapping (the kernel's own functions).
  const railOutcome = mapObservationToRailOutcome(validated);
  const eventCandidate = settlementAttemptEventCandidate(validated);
  const railOperation = mapToRailOperation({
    observation: validated,
    settlementInstructionId:
      input.settlementInstructionId ?? `lab-sim-instruction:${lane.laneId}`,
    settlementAttemptId:
      input.settlementAttemptId ?? `lab-sim-attempt:${lane.laneId}`,
  });
  if (railOperation.railId !== lane.railId) {
    throw new ValidationError(
      `executeOnchainLane: canonical rail id '${railOperation.railId}' disagrees with the lane's deterministic rail id '${lane.railId}' — chain confusion is a first-class threat`,
    );
  }

  const lifecycleStages: readonly AdapterLifecycleStage[] = Object.freeze([
    ...lane.lifecycleStages,
    "observeResult",
    ...(validated.outcome === "CONFIRMED"
      ? (["finality"] as const)
      : []),
    ...(validated.outcome === "OUTCOME_UNKNOWN"
      ? (["reconcile"] as const)
      : []),
  ]);

  return deepFreeze({
    status: "EXECUTED",
    laneId: lane.laneId,
    venueId: lane.venueId,
    chainKey: lane.quote.chain,
    railId: lane.railId,
    outcome: validated.outcome,
    observation: validated,
    railOutcome,
    eventCandidate,
    railOperation,
    lifecycleStages,
    ...(input.fault !== undefined ? { fault: input.fault } : {}),
    evidenceRefs,
  });
}
