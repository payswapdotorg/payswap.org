/**
 * Reconciliation — the authority for ambiguous external effects (W3-003).
 *
 * FROZEN-ARCHITECTURE §22 ("UNKNOWN always requires reconciliation") +
 * INVARIANTS:
 *
 * - INV-X01: UNKNOWN is NEVER mapped to FAILED. `classifyProviderOutcome`
 *   returns `OUTCOME_UNKNOWN` for any provider state whose failure metadata
 *   declares `ambiguity: OUTCOME_UNKNOWN` — and nothing in this package can
 *   coerce that into a failure; the protocol kernel's `isFailureOutcome`
 *   semantics treat ambiguity as "not a definitive failure".
 * - INV-X02: UNKNOWN external writes are never blindly retried — the
 *   classification carries `requiresReconciliation: true` and the retry path
 *   in attempts.ts fails closed on OUTCOME_UNKNOWN.
 * - INV-X03: reconciliation is AUTHORITATIVE for ambiguous external effects:
 *   an OUTCOME_UNKNOWN attempt can ONLY be resolved through a
 *   `ReconciliationResolution` issued here, backed by provider evidence
 *   linked to the attempt (INV-E02). There is no other exit.
 *
 * Provider outages and connector failures never fabricate PaySwap business
 * outcomes: an unresolvable case stays OPEN, it is never turned into a
 * settlement, a failure or a success.
 */

import { ValidationError } from "@payswap/protocol";
import type { PrincipalRef, TimestampMs } from "@payswap/protocol";
import type { ProviderStateEnvelope } from "@payswap/connectors";
import type {
  ExecutionAttempt,
  ExecutionAttemptId,
  ProviderExecutionEvidenceDraft,
} from "./attempts.js";
import { ExecutionAttemptLedger } from "./attempts.js";

declare const ReconciliationCaseIdBrand: unique symbol;

/** Branded id of one reconciliation case. */
export type ReconciliationCaseId = string & {
  readonly [ReconciliationCaseIdBrand]: "ReconciliationCaseId";
};

// ---------------------------------------------------------------------------
// Provider outcome classification (INV-X01)
// ---------------------------------------------------------------------------

/**
 * The canonical outcome classification of a provider state envelope.
 * `OUTCOME_UNKNOWN` is a FIRST-CLASS outcome that requires reconciliation —
 * it is never mapped to FAILED and never treated as success.
 */
export type ProviderOutcomeClassification =
  | {
      readonly outcome: "OUTCOME_UNKNOWN";
      readonly requiresReconciliation: true;
    }
  | {
      readonly outcome: "FAILED";
      readonly retryable: boolean;
    }
  | { readonly outcome: "SUCCEEDED" }
  | { readonly outcome: "AWAITING_CUSTOMER_ACTION" }
  | { readonly outcome: "ASYNC_PROCESSING" };

/**
 * Deterministically classify a provider state envelope (INV-C06-preserved
 * state, INV-X01 discipline). Decision order (documented, total):
 * 1. failure.ambiguity === OUTCOME_UNKNOWN → OUTCOME_UNKNOWN (requires
 *    reconciliation — NEVER FAILED, no matter what else the envelope says);
 * 2. failure present (ambiguity NONE) → FAILED (retryable per provider);
 * 3. classification.requiresCustomerAction / actionRequired present →
 *    AWAITING_CUSTOMER_ACTION (actionable, never a generic error);
 * 4. classification.isTerminal → SUCCEEDED;
 * 5. otherwise → ASYNC_PROCESSING.
 */
export function classifyProviderOutcome(
  envelope: ProviderStateEnvelope,
): ProviderOutcomeClassification {
  if (envelope === null || typeof envelope !== "object") {
    throw new ValidationError("a ProviderStateEnvelope is required");
  }
  const failure = envelope.failure;
  if (failure !== undefined && failure.ambiguity === "OUTCOME_UNKNOWN") {
    return { outcome: "OUTCOME_UNKNOWN", requiresReconciliation: true };
  }
  if (failure !== undefined) {
    return { outcome: "FAILED", retryable: failure.retryable };
  }
  if (
    envelope.classification.requiresCustomerAction ||
    envelope.actionRequired !== undefined
  ) {
    return { outcome: "AWAITING_CUSTOMER_ACTION" };
  }
  if (envelope.classification.isTerminal) {
    return { outcome: "SUCCEEDED" };
  }
  return { outcome: "ASYNC_PROCESSING" };
}

// ---------------------------------------------------------------------------
// Cases and resolutions (INV-X03)
// ---------------------------------------------------------------------------

/** Why a case exists. */
export type ReconciliationReason =
  | "EXTERNAL_AMBIGUITY"
  | "PROVIDER_OUTAGE_UNKNOWN_EFFECT"
  | "PARTIAL_EFFECT_AMBIGUITY";

export type ReconciliationResolutionOutcome =
  | "CONFIRMED_SUCCEEDED"
  | "CONFIRMED_FAILED";

export interface ReconciliationResolution {
  readonly caseId: ReconciliationCaseId;
  readonly outcome: ReconciliationResolutionOutcome;
  readonly resolvedBy: PrincipalRef;
  /** Provider evidence backing the resolution — REQUIRED (INV-E02). */
  readonly evidence: readonly ProviderExecutionEvidenceDraft[];
  readonly resolvedAt: TimestampMs;
  readonly note?: string;
}

export interface ReconciliationCase {
  readonly caseId: ReconciliationCaseId;
  readonly attemptId: ExecutionAttemptId;
  readonly reason: ReconciliationReason;
  readonly status: "OPEN" | "RESOLVED";
  readonly openedAt: TimestampMs;
  /** Present iff RESOLVED — the immutable resolution record (INV-E05). */
  readonly resolution?: ReconciliationResolution;
}

export interface OpenReconciliationCaseInput {
  readonly caseId: string;
  readonly attemptId: ExecutionAttemptId;
  readonly reason: ReconciliationReason;
  readonly now: TimestampMs;
}

export interface ResolveReconciliationCaseInput {
  readonly caseId: string;
  readonly outcome: ReconciliationResolutionOutcome;
  readonly resolvedBy: PrincipalRef;
  readonly evidence: readonly ProviderExecutionEvidenceDraft[];
  readonly now: TimestampMs;
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// The authority
// ---------------------------------------------------------------------------

/**
 * The reconciliation authority (INV-X03). The ONLY component that can move an
 * OUTCOME_UNKNOWN attempt to a definitive outcome, always with linked
 * provider evidence, always as an immutable resolution record.
 */
export class ReconciliationAuthority {
  readonly #ledger: ExecutionAttemptLedger;
  readonly #cases = new Map<string, ReconciliationCase>();
  readonly #openByAttempt = new Map<string, string>();

  constructor(ledger: ExecutionAttemptLedger) {
    this.#ledger = ledger;
  }

  /**
   * Open a case for an ambiguous attempt. The attempt MUST currently be in
   * OUTCOME_UNKNOWN — an ambiguity is exactly what a case exists for. One
   * OPEN case per attempt (re-opening a resolved case is forbidden: history
   * is immutable, a new ambiguity is a new attempt's ambiguity).
   */
  openCase(input: OpenReconciliationCaseInput): ReconciliationCase {
    if (input === null || typeof input !== "object") {
      throw new ValidationError("open-case input must be an object");
    }
    if (typeof input.caseId !== "string" || input.caseId.length === 0) {
      throw new ValidationError("caseId must be a non-empty string");
    }
    if (this.#cases.has(input.caseId)) {
      throw new ValidationError(`reconciliation case '${input.caseId}' already exists`);
    }
    const attempt = this.#ledger.attempt(input.attemptId);
    if (attempt === undefined) {
      throw new ValidationError(
        `cannot open a reconciliation case for unknown attempt '${input.attemptId}'`,
      );
    }
    if (attempt.state !== "OUTCOME_UNKNOWN") {
      throw new ValidationError(
        `reconciliation cases exist for ambiguous external effects: attempt '${input.attemptId}' is '${attempt.state}', not OUTCOME_UNKNOWN (INV-X03)`,
      );
    }
    const openCaseId = this.#openByAttempt.get(input.attemptId);
    if (openCaseId !== undefined) {
      throw new ValidationError(
        `attempt '${input.attemptId}' already has OPEN case '${openCaseId}'`,
      );
    }
    const reconciliationCase: ReconciliationCase = Object.freeze({
      caseId: input.caseId as ReconciliationCaseId,
      attemptId: input.attemptId,
      reason: input.reason,
      status: "OPEN",
      openedAt: input.now,
    });
    this.#cases.set(reconciliationCase.caseId, reconciliationCase);
    this.#openByAttempt.set(input.attemptId, reconciliationCase.caseId);
    return reconciliationCase;
  }

  /**
   * Resolve an OPEN case — the authoritative transition of an ambiguous
   * external effect into a definitive outcome (INV-X03). Resolution REQUIRES
   * provider evidence linked to the ambiguous attempt (INV-E02); the attempt
   * then leaves OUTCOME_UNKNOWN through the reconciliation events, which are
   * fireable ONLY with this resolution (enforced by the ledger).
   */
  resolveCase(input: ResolveReconciliationCaseInput): ReconciliationResolution {
    if (input === null || typeof input !== "object") {
      throw new ValidationError("resolve-case input must be an object");
    }
    const existing = this.#cases.get(input.caseId);
    if (existing === undefined) {
      throw new ValidationError(`unknown reconciliation case: ${input.caseId}`);
    }
    if (existing.status !== "OPEN") {
      throw new ValidationError(
        `reconciliation case '${input.caseId}' is already RESOLVED — resolutions are immutable (INV-E05)`,
      );
    }
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new ValidationError(
        "a reconciliation resolution requires provider evidence linked to the ambiguous attempt (INV-E02/INV-X03)",
      );
    }
    const resolution: ReconciliationResolution = Object.freeze({
      caseId: existing.caseId,
      outcome: input.outcome,
      resolvedBy: Object.freeze({ ...input.resolvedBy }),
      evidence: Object.freeze([...input.evidence]),
      resolvedAt: input.now,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    this.#ledger.advance(
      existing.attemptId,
      input.outcome === "CONFIRMED_SUCCEEDED"
        ? "RECONCILE_RESOLVED_SUCCEEDED"
        : "RECONCILE_RESOLVED_FAILED",
      {
        now: input.now,
        evidence: input.evidence,
        resolution: {
          resolvedOutcome: input.outcome,
          resolvedBy: input.resolvedBy,
          evidence: input.evidence,
          caseId: input.caseId,
        },
      },
    );
    const resolved: ReconciliationCase = Object.freeze({
      ...existing,
      status: "RESOLVED",
      resolution,
    });
    this.#cases.set(resolved.caseId, resolved);
    this.#openByAttempt.delete(resolved.attemptId);
    return resolution;
  }

  /** One case by id. */
  case(caseId: string): ReconciliationCase | undefined {
    return this.#cases.get(caseId);
  }

  /** The OPEN case for an attempt, when one exists. */
  openCaseFor(attemptId: ExecutionAttemptId): ReconciliationCase | undefined {
    const caseId = this.#openByAttempt.get(attemptId);
    return caseId === undefined ? undefined : this.#cases.get(caseId);
  }

  /** All cases, in opening order. */
  allCases(): readonly ReconciliationCase[] {
    return [...this.#cases.values()];
  }
}

// ---------------------------------------------------------------------------
// Ambiguity helpers
// ---------------------------------------------------------------------------

/**
 * Retry admissibility for an attempt under the INV-X02 discipline:
 * OUTCOME_UNKNOWN requires reconciliation; a definitive FAILED outcome is
 * retryable only when the capability declared SAFE_TO_RETRY (INV-O01).
 */
export function retryRequiresReconciliation(
  attempt: Pick<ExecutionAttempt, "state" | "retryPolicy">,
): boolean {
  if (attempt.state === "OUTCOME_UNKNOWN") {
    return true;
  }
  if (attempt.state === "FAILED") {
    return attempt.retryPolicy !== "SAFE_TO_RETRY";
  }
  return false;
}
