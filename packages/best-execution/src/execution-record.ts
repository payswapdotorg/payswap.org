/**
 * @payswap/best-execution — the route execution record: the quote→executed
 * transition law (P4-W2-002).
 *
 * A QUOTE IS NOT AN OUTCOME. The transition from a selected (quoted) route
 * to an EXECUTED state is admissible ONLY through a REAL EXECUTION
 * OBSERVATION validated by the canonical onchain-domain validator and
 * bound to this route's execution reference:
 *
 * - BROADCAST observations (submitted ≠ finality — AGENTS.md rule 29)
 *   produce EXECUTION_BROADCAST, never an executed state;
 * - a CONFIRMED observation WITHOUT a finality candidate produces
 *   EXECUTION_CONFIRMED_OBSERVED — still not an executed state;
 * - a CONFIRMED observation WITH a finality CANDIDATE produces
 *   EXECUTED_CANDIDATE — a CANDIDATE ONLY (finality is protocol-owned,
 *   INV-F06; an observer can never declare financial finality);
 * - an OUTCOME_UNKNOWN observation produces EXECUTION_OUTCOME_UNKNOWN —
 *   reconciliation-requiring, NEVER converted into success or failure
 *   (INV-X01). A later CONFIRMED/FAILED observation resolves it (that
 *   later observation IS the reconciliation evidence);
 * - a FAILED observation produces EXECUTION_FAILED (terminal).
 *
 * There is NO API in this module that accepts a quote (or anything else)
 * and produces an executed state: `recordExecutionObservation` is the only
 * path, and it demands the observation. The negative suite attacks exactly
 * this seam.
 *
 * Stale-route discipline: every pre-execution step (write preparation, gate
 * recording, broadcast handoff) re-checks the selected route's validity at
 * the caller-supplied instant — an invalidated route is re-selected from
 * fresh observations, never repaired (mirrors the kernel's VOIDED law).
 */

import { ValidationError } from "@payswap/protocol";
import type { OnchainExecutionObservation, OnchainFinalityCandidate } from "@payswap/onchain-domain";
import { validateOnchainExecutionObservation } from "@payswap/onchain-domain";
import type { GateDecision, PreparedWrite } from "@payswap/onchain-security";
import { ExecutionTransitionError } from "./errors.js";
import type { BestExecutionDecision } from "./engine.js";
import { assertSelectedRouteValid } from "./engine.js";

// ---------------------------------------------------------------------------
// The status vocabulary
// ---------------------------------------------------------------------------

export const ROUTE_EXECUTION_STATUSES = [
  /** A route was selected (decision made); nothing has been executed. */
  "ROUTE_SELECTED",
  /** The kernel write was prepared and bound to this record. */
  "WRITE_PREPARED",
  /** The deterministic gates ALLOWed the prepared write. */
  "GATED_ALLOW",
  /**
   * The deterministic gates BLOCKed the prepared write before submission —
   * the route is killed (rule 27: terminal, nothing was ever submitted).
   */
  "ROUTE_BLOCKED",
  /** The signing request was handed off for broadcast (submitted ≠ finality). */
  "EXECUTION_SUBMITTED",
  /** An execution observation reports BROADCAST — submitted, NOT executed. */
  "EXECUTION_BROADCAST",
  /**
   * An execution observation reports CONFIRMED without a finality candidate
   * — observed confirmed, still NOT an executed state.
   */
  "EXECUTION_CONFIRMED_OBSERVED",
  /**
   * An execution observation reports CONFIRMED with a finality CANDIDATE —
   * an executed CANDIDATE ONLY (finality is protocol-owned, INV-F06).
   * Terminal for this record.
   */
  "EXECUTED_CANDIDATE",
  /** An execution observation reports FAILED (definitive). Terminal. */
  "EXECUTION_FAILED",
  /**
   * An execution observation reports OUTCOME_UNKNOWN — reconciliation-
   * requiring (INV-X01/X02); resolvable only by a later observation.
   */
  "EXECUTION_OUTCOME_UNKNOWN",
] as const;

export type RouteExecutionStatus = (typeof ROUTE_EXECUTION_STATUSES)[number];

/** The statuses from which a further execution observation may arrive. */
const OBSERVATION_ADMISSIBLE_STATUSES: readonly RouteExecutionStatus[] = [
  "EXECUTION_SUBMITTED",
  "EXECUTION_BROADCAST",
  "EXECUTION_CONFIRMED_OBSERVED",
  "EXECUTION_OUTCOME_UNKNOWN",
];

/** One recorded execution observation (already domain-validated). */
export interface RecordedExecutionObservation {
  readonly observation: OnchainExecutionObservation;
  readonly recordedAt: number;
  readonly resultingStatus: RouteExecutionStatus;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * The single-use execution record of one selected best-execution route.
 * Terminal states: EXECUTED_CANDIDATE and EXECUTION_FAILED (INV-X04
 * terminal discipline — no revival, no mutation of recorded evidence).
 */
export class RouteExecutionRecord {
  readonly #decision: BestExecutionDecision & { decision: "ROUTE_SELECTED" };
  readonly #executionRef: string;
  readonly #observations: RecordedExecutionObservation[] = [];
  #status: RouteExecutionStatus = "ROUTE_SELECTED";
  #write?: PreparedWrite;
  #gate?: GateDecision;
  #handoffRef?: string;

  private constructor(
    decision: BestExecutionDecision & { decision: "ROUTE_SELECTED" },
  ) {
    this.#decision = decision;
    this.#executionRef = `best-execution:${decision.provenance.executionId}`;
  }

  /**
   * Opens the execution record for a ROUTE_SELECTED decision. The record
   * binds to the decision's selected route; every later step re-checks the
   * route's freshness against the decision's quote and health observations.
   */
  static open(
    decision: BestExecutionDecision,
  ): RouteExecutionRecord {
    if (decision.decision !== "ROUTE_SELECTED") {
      throw new ExecutionTransitionError(
        "an execution record opens only on a ROUTE_SELECTED decision — there is no route to execute otherwise",
      );
    }
    return new RouteExecutionRecord(decision);
  }

  /** The execution reference external observations must bind to. */
  get executionRef(): string {
    return this.#executionRef;
  }

  get status(): RouteExecutionStatus {
    return this.#status;
  }

  get selectedRouteRef(): string {
    return this.#decision.selected.routeRef;
  }

  /** The recorded observations, in arrival order (append-only evidence). */
  observations(): readonly RecordedExecutionObservation[] {
    return [...this.#observations];
  }

  /** The finality CANDIDATE of the executed state, when one was observed. */
  get finalityCandidate(): OnchainFinalityCandidate | undefined {
    if (this.#status !== "EXECUTED_CANDIDATE") {
      return undefined;
    }
    const confirming = [...this.#observations]
      .reverse()
      .find((recorded) => recorded.observation.outcome === "CONFIRMED");
    return confirming?.observation.finalityCandidate;
  }

  /**
   * Records the kernel-prepared write (must bind to the selected route's
   * write digest; the route must still be fresh at `at`).
   */
  recordPreparedWrite(write: PreparedWrite, at: number): void {
    this.#requireStatus("ROUTE_SELECTED", "recordPreparedWrite");
    assertSelectedRouteValid(this.#decision, at);
    if (write.writeDigest !== this.#decision.selected.write.writeDigest) {
      throw new ExecutionTransitionError(
        `the prepared write digest '${write.writeDigest}' does not bind to the selected route's write '${this.#decision.selected.write.writeDigest}' — the executed write is exactly the gate-evaluated write, never a substitute`,
      );
    }
    this.#write = write;
    this.#status = "WRITE_PREPARED";
  }

  /**
   * Records the gate decision for the prepared write. Only an ALLOW
   * proceeds: a BLOCK never executes (rule 27 — terminal), and an UNKNOWN
   * is never converted into an allowance (INV-X01).
   */
  recordGateDecision(gate: GateDecision, at: number): void {
    this.#requireStatus("WRITE_PREPARED", "recordGateDecision");
    assertSelectedRouteValid(this.#decision, at);
    if (gate.decision === "BLOCK") {
      this.#status = "ROUTE_BLOCKED";
      this.#gate = gate;
      throw new ExecutionTransitionError(
        "the deterministic gates BLOCKed this route: a BLOCKed route never proceeds to execution (AGENTS.md rule 27)",
      );
    }
    if (gate.decision === "UNKNOWN") {
      this.#gate = gate;
      throw new ExecutionTransitionError(
        "the deterministic gates returned UNKNOWN: UNKNOWN is never converted into an allowance (INV-X01) — resolve with fresh evidence and re-run best execution",
      );
    }
    this.#gate = gate;
    this.#status = "GATED_ALLOW";
  }

  /**
   * Records the broadcast handoff (the trusted-surface signing request
   * reference). Submission is not finality (rule 29) — this only marks the
   * route as submitted for observation.
   */
  recordBroadcastHandoff(handoffRef: string, at: number): void {
    this.#requireStatus("GATED_ALLOW", "recordBroadcastHandoff");
    assertSelectedRouteValid(this.#decision, at);
    if (handoffRef.length === 0) {
      throw new ValidationError("handoffRef must be a non-empty string");
    }
    this.#handoffRef = handoffRef;
    this.#status = "EXECUTION_SUBMITTED";
  }

  /**
   * THE ONLY PATH TO AN EXECUTED STATE. Records a real execution
   * observation (validated by the canonical onchain-domain validator and
   * bound to this record's execution reference) and advances the status
   * exactly per the observation's outcome:
   * - BROADCAST → EXECUTION_BROADCAST (not executed);
   * - CONFIRMED + finality candidate → EXECUTED_CANDIDATE (candidate only);
   * - CONFIRMED without candidate → EXECUTION_CONFIRMED_OBSERVED;
   * - FAILED → EXECUTION_FAILED (terminal);
   * - OUTCOME_UNKNOWN → EXECUTION_OUTCOME_UNKNOWN (reconciliation-requiring;
   *   a later observation resolves it).
   *
   * A quote can NEVER be recorded here — only an execution observation.
   */
  recordExecutionObservation(
    observation: unknown,
    at: number,
  ): RouteExecutionStatus {
    if (!OBSERVATION_ADMISSIBLE_STATUSES.includes(this.#status)) {
      throw new ExecutionTransitionError(
        `an execution observation is recordable only after broadcast handoff (or while an earlier observation is unresolved), but the record is ${this.#status}`,
      );
    }
    if (!Number.isInteger(at) || at < 0) {
      throw new ValidationError("`at` must be a non-negative integer (ms)");
    }
    // The canonical domain validator runs FIRST: a malformed observation is
    // never recorded, never interpreted, never guessed.
    const validated = validateOnchainExecutionObservation(observation);
    if (validated.executionRef !== this.#executionRef) {
      throw new ExecutionTransitionError(
        `the execution observation binds to executionRef '${validated.executionRef}', not this route's '${this.#executionRef}' — an observation of a different execution is not evidence of this one`,
      );
    }
    if (validated.chainKey !== this.#decision.selected.quote.chain) {
      throw new ExecutionTransitionError(
        `the execution observation reports chain '${validated.chainKey}', not the route's chain '${this.#decision.selected.quote.chain}'`,
      );
    }

    let resultingStatus: RouteExecutionStatus;
    switch (validated.outcome) {
      case "BROADCAST":
        resultingStatus = "EXECUTION_BROADCAST";
        break;
      case "CONFIRMED":
        resultingStatus =
          validated.finalityCandidate !== undefined
            ? "EXECUTED_CANDIDATE"
            : "EXECUTION_CONFIRMED_OBSERVED";
        break;
      case "FAILED":
        resultingStatus = "EXECUTION_FAILED";
        break;
      case "OUTCOME_UNKNOWN":
        resultingStatus = "EXECUTION_OUTCOME_UNKNOWN";
        break;
    }

    this.#observations.push(
      Object.freeze({
        observation: validated,
        recordedAt: at,
        resultingStatus,
      }),
    );
    this.#status = resultingStatus;
    return resultingStatus;
  }

  /**
   * True exactly when the route reached the EXECUTED_CANDIDATE state —
   * which by construction required a CONFIRMED execution observation
   * carrying a finality CANDIDATE (candidate-only; never final).
   */
  get isExecutedCandidate(): boolean {
    return this.#status === "EXECUTED_CANDIDATE";
  }

  /** The broadcast handoff reference, when the handoff was recorded. */
  get broadcastHandoffRef(): string | undefined {
    return this.#handoffRef;
  }

  #requireStatus(expected: RouteExecutionStatus, operation: string): void {
    if (this.#status !== expected) {
      throw new ExecutionTransitionError(
        `operation '${operation}' requires status ${expected}, but the record is ${this.#status}`,
      );
    }
  }
}
