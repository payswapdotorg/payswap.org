/**
 * ExecutionAttempt — idempotent, retry-safe execution attempts (W3-003).
 *
 * FROZEN-ARCHITECTURE §22 / LOSSLESS-CONNECTOR-CAPABILITY-MODEL §3 /
 * PAYMENT-OPERATING-PLANE ("PaymentAttempt"):
 *
 * An ExecutionAttempt is the immutable record of one step of an ExecutionPlan
 * being executed against a ConnectedCapabilityInstance. It carries strategy,
 * capability, provider, authorization, idempotency, state, external
 * references and proof/evidence.
 *
 * - INV-F05: one idempotency key maps to one authoritative attempt result —
 *   enforced through the protocol kernel's `IdempotencyRegistrar`
 *   (BEGIN/REPLAY/CONFLICT); a conflicting re-use of a key throws.
 * - INV-O01: async commands are retry-safe — a definitively FAILED attempt
 *   whose capability declares `SAFE_TO_RETRY` may be re-armed; a FAILED →
 *   BEGIN re-arm is exactly the kernel's retry semantics.
 * - INV-X01/INV-X02: UNKNOWN is a first-class state (`OUTCOME_UNKNOWN`),
 *   never FAILED, and an UNKNOWN external write is NEVER blindly retried —
 *   `requestRetry` refuses until reconciliation resolves the ambiguity.
 * - INV-X03: leaving `OUTCOME_UNKNOWN` requires a reconciliation resolution
 *   carrying provider evidence (see reconciliation.ts — the authority).
 * - INV-X04: terminal transitions are monotonic except the explicit
 *   `RECOVER` recovery rule — enforced by the protocol kernel's state
 *   machine (`TerminalStateViolationError`).
 * - INV-E02: every external effect carries execution evidence linked to the
 *   attempt — evidence is stamped with the attempt id by the ledger, never
 *   forgeable by callers.
 * - INV-E05: recorded evidence is immutable — append-only, frozen, and
 *   conflicting re-records of the same evidence id are rejected.
 * - INV-C06: the latest ProviderStateEnvelope is preserved verbatim on the
 *   attempt; canonical state controls protocol truth, provider state remains
 *   available for customer action, reconciliation, support and audit.
 */

import { PaySwapError, ValidationError, defineStateMachine, InMemoryIdempotencyRegistrar } from "@payswap/protocol";
import type {
  IdempotencyRecord,
  IdempotencyRegistrar,
  PaySwapErrorDetails,
  PrincipalRef,
  StateMachine,
  TimestampMs,
  TransitionRecord,
} from "@payswap/protocol";
import { isEvidenceKind, isExecutionMode } from "@payswap/connectors";
import type {
  CancellationPolicy,
  CompensationDeclaration,
  EvidenceKind,
  ExecutionMode,
  ProviderStateEnvelope,
} from "@payswap/connectors";

declare const ExecutionAttemptIdBrand: unique symbol;

/** Branded id of one execution attempt. */
export type ExecutionAttemptId = string & {
  readonly [ExecutionAttemptIdBrand]: "ExecutionAttemptId";
};

/** Brand a validated string as an `ExecutionAttemptId`. */
export function asExecutionAttemptId(value: string): ExecutionAttemptId {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("ExecutionAttemptId must be a non-empty string");
  }
  if (value.length > 256) {
    throw new ValidationError("ExecutionAttemptId exceeds 256 characters");
  }
  if (value.trim() !== value) {
    throw new ValidationError("ExecutionAttemptId must not carry surrounding whitespace");
  }
  return value as ExecutionAttemptId;
}

// ---------------------------------------------------------------------------
// The attempt state machine (INV-X04 via the protocol kernel)
// ---------------------------------------------------------------------------

export type ExecutionAttemptState =
  | "PENDING"
  | "IN_FLIGHT"
  | "AWAITING_CUSTOMER_ACTION"
  | "PARTIALLY_EXECUTED"
  | "OUTCOME_UNKNOWN"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "COMPENSATED"
  | "RECOVERED";

export type ExecutionAttemptEvent =
  | "START"
  | "PROVIDER_ACTION_REQUIRED"
  | "CUSTOMER_ACTION_COMPLETED"
  | "PARTIAL_EFFECT"
  | "COMPLETE"
  | "CONFIRM_SUCCEEDED"
  | "CONFIRM_FAILED"
  | "EXTERNAL_OUTCOME_UNKNOWN"
  | "CANCEL"
  | "COMPENSATE"
  | "RECONCILE_RESOLVED_SUCCEEDED"
  | "RECONCILE_RESOLVED_FAILED"
  | "RECOVER";

/**
 * The canonical attempt lifecycle. Terminal states (SUCCEEDED, FAILED,
 * CANCELLED, COMPENSATED, RECOVERED) are monotonic: the ONLY exit from a
 * terminal state is the explicit `RECOVER` recovery rule (FAILED → RECOVERED,
 * INV-X04). `OUTCOME_UNKNOWN` is deliberately NON-terminal and reachable ONLY
 * through reconciliation resolutions (INV-X03) — it can never be coerced into
 * FAILED or SUCCEEDED by an ordinary event (INV-X01).
 */
export const attemptStateMachine: StateMachine<
  ExecutionAttemptState,
  ExecutionAttemptEvent,
  unknown
> = defineStateMachine<ExecutionAttemptState, ExecutionAttemptEvent, unknown>({
  name: "execution-attempt",
  initial: "PENDING",
  states: [
    "PENDING",
    "IN_FLIGHT",
    "AWAITING_CUSTOMER_ACTION",
    "PARTIALLY_EXECUTED",
    "OUTCOME_UNKNOWN",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
    "COMPENSATED",
    "RECOVERED",
  ],
  events: [
    "START",
    "PROVIDER_ACTION_REQUIRED",
    "CUSTOMER_ACTION_COMPLETED",
    "PARTIAL_EFFECT",
    "COMPLETE",
    "CONFIRM_SUCCEEDED",
    "CONFIRM_FAILED",
    "EXTERNAL_OUTCOME_UNKNOWN",
    "CANCEL",
    "COMPENSATE",
    "RECONCILE_RESOLVED_SUCCEEDED",
    "RECONCILE_RESOLVED_FAILED",
    "RECOVER",
  ],
  transitions: [
    { from: "PENDING", on: "START", to: "IN_FLIGHT" },
    { from: "PENDING", on: "CANCEL", to: "CANCELLED" },
    { from: "IN_FLIGHT", on: "CONFIRM_SUCCEEDED", to: "SUCCEEDED" },
    { from: "IN_FLIGHT", on: "CONFIRM_FAILED", to: "FAILED" },
    { from: "IN_FLIGHT", on: "EXTERNAL_OUTCOME_UNKNOWN", to: "OUTCOME_UNKNOWN" },
    { from: "IN_FLIGHT", on: "PROVIDER_ACTION_REQUIRED", to: "AWAITING_CUSTOMER_ACTION" },
    { from: "IN_FLIGHT", on: "PARTIAL_EFFECT", to: "PARTIALLY_EXECUTED" },
    { from: "IN_FLIGHT", on: "CANCEL", to: "CANCELLED" },
    { from: "AWAITING_CUSTOMER_ACTION", on: "CUSTOMER_ACTION_COMPLETED", to: "IN_FLIGHT" },
    { from: "AWAITING_CUSTOMER_ACTION", on: "CONFIRM_SUCCEEDED", to: "SUCCEEDED" },
    { from: "AWAITING_CUSTOMER_ACTION", on: "CONFIRM_FAILED", to: "FAILED" },
    { from: "AWAITING_CUSTOMER_ACTION", on: "EXTERNAL_OUTCOME_UNKNOWN", to: "OUTCOME_UNKNOWN" },
    { from: "AWAITING_CUSTOMER_ACTION", on: "CANCEL", to: "CANCELLED" },
    { from: "PARTIALLY_EXECUTED", on: "COMPLETE", to: "SUCCEEDED" },
    { from: "PARTIALLY_EXECUTED", on: "CONFIRM_FAILED", to: "FAILED" },
    { from: "PARTIALLY_EXECUTED", on: "COMPENSATE", to: "COMPENSATED" },
    { from: "PARTIALLY_EXECUTED", on: "EXTERNAL_OUTCOME_UNKNOWN", to: "OUTCOME_UNKNOWN" },
    { from: "OUTCOME_UNKNOWN", on: "RECONCILE_RESOLVED_SUCCEEDED", to: "SUCCEEDED" },
    { from: "OUTCOME_UNKNOWN", on: "RECONCILE_RESOLVED_FAILED", to: "FAILED" },
  ],
  terminalStates: ["SUCCEEDED", "FAILED", "CANCELLED", "COMPENSATED", "RECOVERED"],
  recovery: [{ from: "FAILED", on: "RECOVER", to: "RECOVERED" }],
});

/** One recorded state transition on an attempt (history is append-only). */
export interface AttemptTransitionRecord extends TransitionRecord<ExecutionAttemptState, ExecutionAttemptEvent> {
  readonly recordedAt: TimestampMs;
  readonly evidenceIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Provider execution evidence (INV-E02 / INV-E05)
// ---------------------------------------------------------------------------

/**
 * Evidence draft supplied by callers; the LEDGER stamps the attempt link, so
 * evidence can never be forged onto an attempt it does not belong to.
 */
export interface ProviderExecutionEvidenceDraft {
  readonly evidenceId: string;
  readonly kind: EvidenceKind;
  /** Reference to the external artifact (provider operation id, webhook id…). */
  readonly evidenceRef: string;
  /** The lossless provider state observed with this evidence (INV-C06). */
  readonly providerState?: ProviderStateEnvelope;
  readonly recordedAt: TimestampMs;
}

/** Provider execution evidence linked to one attempt (INV-E02). */
export interface ProviderExecutionEvidence extends ProviderExecutionEvidenceDraft {
  readonly attemptId: ExecutionAttemptId;
}

function isProviderStateEnvelopeShaped(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<ProviderStateEnvelope>).revision === "string" &&
    (value as Partial<ProviderStateEnvelope>).classification !== undefined
  );
}

function validateEvidenceDraft(draft: ProviderExecutionEvidenceDraft): void {
  if (draft === null || typeof draft !== "object") {
    throw new ValidationError("evidence draft must be an object");
  }
  if (typeof draft.evidenceId !== "string" || draft.evidenceId.length === 0) {
    throw new ValidationError("evidence draft must carry a non-empty evidenceId");
  }
  if (!isEvidenceKind(draft.kind)) {
    throw new ValidationError(
      `evidence draft kind '${String(draft.kind)}' is not a canonical EvidenceKind (W2-003 vocabulary)`,
    );
  }
  if (typeof draft.evidenceRef !== "string" || draft.evidenceRef.length === 0) {
    throw new ValidationError("evidence draft must carry a non-empty evidenceRef");
  }
  if (typeof draft.recordedAt !== "bigint") {
    throw new ValidationError("evidence draft recordedAt must be a bigint TimestampMs");
  }
  if (draft.providerState !== undefined && !isProviderStateEnvelopeShaped(draft.providerState)) {
    throw new ValidationError(
      "evidence draft providerState, when present, must be a ProviderStateEnvelope (INV-C06)",
    );
  }
}

// ---------------------------------------------------------------------------
// The attempt record
// ---------------------------------------------------------------------------

/** The resolution authority required to leave OUTCOME_UNKNOWN (INV-X03). */
export interface UnknownOutcomeResolution {
  readonly resolvedOutcome: "CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED";
  readonly resolvedBy: PrincipalRef;
  readonly evidence: readonly ProviderExecutionEvidenceDraft[];
  readonly caseId: string;
}

/** The immutable execution attempt record. */
export interface ExecutionAttempt {
  readonly attemptId: ExecutionAttemptId;
  readonly planId: string;
  readonly stepId: string;
  readonly executionMode: ExecutionMode;
  readonly capabilityInstanceId: string;
  readonly capabilityId: string;
  readonly retryPolicy: "SAFE_TO_RETRY" | "REQUIRES_RECONCILIATION";
  readonly semantics: {
    readonly cancellation: CancellationPolicy;
    readonly compensation: CompensationDeclaration;
  };
  readonly state: ExecutionAttemptState;
  readonly idempotencyKey: string;
  readonly principal: PrincipalRef;
  readonly commandHash: string;
  readonly createdAt: TimestampMs;
  readonly updatedAt: TimestampMs;
  readonly history: readonly AttemptTransitionRecord[];
  readonly evidence: readonly ProviderExecutionEvidence[];
  /** Latest lossless provider state (INV-C06), if observed. */
  readonly providerState?: ProviderStateEnvelope;
}

export interface BeginExecutionAttemptInput {
  readonly attemptId: string;
  readonly planId: string;
  readonly stepId: string;
  readonly executionMode: ExecutionMode;
  readonly capabilityInstanceId: string;
  readonly capabilityId: string;
  readonly retryPolicy: "SAFE_TO_RETRY" | "REQUIRES_RECONCILIATION";
  readonly cancellation: CancellationPolicy;
  readonly compensation: CompensationDeclaration;
  readonly idempotencyKey: string;
  readonly principal: PrincipalRef;
  readonly now: TimestampMs;
}

export type BeginAttemptOutcome =
  | { readonly kind: "BEGIN"; readonly attempt: ExecutionAttempt }
  | {
      /** INV-F05: one idempotency key maps to one authoritative attempt. */
      readonly kind: "REPLAY";
      readonly attempt: ExecutionAttempt;
      readonly record: IdempotencyRecord;
    };

/** INV-F05 violation: same idempotency key, different command. */
export class AttemptIdempotencyConflictError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "ATTEMPT_IDEMPOTENCY_CONFLICT",
      category: "CONFLICT",
      message,
      details,
    });
  }
}

/** INV-X02: an UNKNOWN external write cannot be blindly retried. */
export class AttemptRetryForbiddenError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "ATTEMPT_RETRY_FORBIDDEN",
      category: "EXTERNAL_AMBIGUITY",
      message,
      details,
    });
  }
}

/** Evidence immutability violation (INV-E05). */
export class EvidenceImmutabilityError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "EVIDENCE_IMMUTABILITY_VIOLATION",
      category: "CONFLICT",
      message,
      details,
    });
  }
}

export interface AdvanceAttemptInput {
  /** Provider evidence for this transition — REQUIRED for any external effect (INV-E02). */
  readonly evidence?: readonly ProviderExecutionEvidenceDraft[];
  /** REQUIRED for RECONCILE_RESOLVED_* events (INV-X03: reconciliation is the authority). */
  readonly resolution?: UnknownOutcomeResolution;
  /** Latest lossless provider state (INV-C06). */
  readonly providerState?: ProviderStateEnvelope;
  readonly now: TimestampMs;
}

// ---------------------------------------------------------------------------
// Deterministic command hashing (FNV-1a 64 — binding, not security)
// ---------------------------------------------------------------------------

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash ^= BigInt(code);
    hash *= 0x100000001b3n;
    hash &= 0xffff_ffff_ffff_ffffn;
  }
  return hash.toString(16);
}

/** Deterministic command hash binding an attempt to its execution identity. */
export function attemptCommandHash(input: {
  readonly planId: string;
  readonly stepId: string;
  readonly capabilityInstanceId: string;
  readonly executionMode: ExecutionMode;
  readonly principal: PrincipalRef;
}): string {
  return fnv1a64(
    `execution-attempt|${input.planId}|${input.stepId}|${input.capabilityInstanceId}|${input.executionMode}|${input.principal.principalType}:${input.principal.principalId}`,
  );
}

/** Deterministic result hash for a completed attempt (replay equality). */
export function attemptResultHash(attempt: ExecutionAttempt): string {
  return fnv1a64(`execution-attempt-result|${attempt.attemptId}|${attempt.state}`);
}

// ---------------------------------------------------------------------------
// Cancellation policy (consumed vocabulary, deterministic evaluation)
// ---------------------------------------------------------------------------

/**
 * Deterministic cancellation admissibility from the capability's declared
 * `CancellationPolicy` (W2-003 vocabulary) and the current attempt state.
 */
export function cancellationAllowed(
  policy: CancellationPolicy,
  state: ExecutionAttemptState,
): boolean {
  switch (policy) {
    case "NOT_SUPPORTED":
      return false;
    case "BEFORE_EXECUTION":
      return state === "PENDING";
    case "UNTIL_SETTLEMENT":
      return !attemptStateMachine.isTerminal(state) && state !== "OUTCOME_UNKNOWN";
    case "PROVIDER_DEFINED":
      return !attemptStateMachine.isTerminal(state) && state !== "OUTCOME_UNKNOWN";
  }
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * The execution attempt ledger: idempotent, retry-safe, evidence-preserving.
 * Deterministic reference implementation over the protocol kernel's
 * idempotency registrar; the storage-agnostic contract is the class shape
 * itself (production replaces persistence, not semantics).
 */
export class ExecutionAttemptLedger {
  readonly #registrar: IdempotencyRegistrar;
  readonly #attempts = new Map<string, ExecutionAttempt>();
  readonly #byPlan = new Map<string, ExecutionAttempt[]>();
  readonly #evidenceById = new Map<string, ProviderExecutionEvidence>();

  constructor(registrar?: IdempotencyRegistrar) {
    this.#registrar = registrar ?? new InMemoryIdempotencyRegistrar();
  }

  /**
   * Begin an attempt under INV-F05 discipline: the (commandType, principal,
   * key) scope maps to one authoritative attempt. In-flight duplicates REPLAY
   * the recorded attempt; a different command under the same key CONFLICTS.
   */
  begin(input: BeginExecutionAttemptInput): BeginAttemptOutcome {
    if (input === null || typeof input !== "object") {
      throw new ValidationError("attempt begin input must be an object");
    }
    const attemptId = asExecutionAttemptId(input.attemptId);
    if (!isExecutionMode(input.executionMode)) {
      throw new ValidationError(
        "executionMode is REQUIRED and explicit on every attempt (INV-C07)",
      );
    }
    for (const field of ["planId", "stepId", "capabilityInstanceId", "capabilityId"] as const) {
      if (typeof input[field] !== "string" || input[field].length === 0) {
        throw new ValidationError(`${field} must be a non-empty string`);
      }
    }
    if (
      input.retryPolicy !== "SAFE_TO_RETRY" &&
      input.retryPolicy !== "REQUIRES_RECONCILIATION"
    ) {
      throw new ValidationError(
        "retryPolicy must mirror the capability's IdempotencyDeclaration.retryPolicy (W2-003)",
      );
    }
    if (input.idempotencyKey === null || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new ValidationError("idempotencyKey is required (INV-F05)");
    }
    if (typeof input.now !== "bigint") {
      throw new ValidationError("now must be a bigint TimestampMs");
    }
    if (this.#attempts.has(attemptId)) {
      throw new ValidationError(`attempt id '${attemptId}' is already recorded`);
    }

    const scope = {
      commandType: "execution.attempt",
      principal: input.principal,
      key: input.idempotencyKey,
    };
    const commandHash = attemptCommandHash({
      planId: input.planId,
      stepId: input.stepId,
      capabilityInstanceId: input.capabilityInstanceId,
      executionMode: input.executionMode,
      principal: input.principal,
    });
    const outcome = this.#registrar.begin(scope, commandHash);
    if (outcome.kind === "CONFLICT") {
      throw new AttemptIdempotencyConflictError(
        `INV-F05: idempotency key '${input.idempotencyKey}' is already bound to a different command`,
        { principal: input.principal.principalId, commandHash },
      );
    }
    if (outcome.kind === "REPLAY") {
      const existing = this.#findAttemptByScope(scope, commandHash);
      if (existing !== undefined) {
        return { kind: "REPLAY", attempt: existing, record: outcome.record };
      }
      // The registrar knows the scope but this ledger never recorded it:
      // a different ledger instance shares the registrar. Fail closed.
      throw new AttemptIdempotencyConflictError(
        `INV-F05: idempotency key '${input.idempotencyKey}' replays a command this ledger did not record`,
        { commandHash },
      );
    }

    const attempt: ExecutionAttempt = Object.freeze({
      attemptId,
      planId: input.planId,
      stepId: input.stepId,
      executionMode: input.executionMode,
      capabilityInstanceId: input.capabilityInstanceId,
      capabilityId: input.capabilityId,
      retryPolicy: input.retryPolicy,
      semantics: Object.freeze({
        cancellation: input.cancellation,
        compensation: input.compensation,
      }),
      state: "PENDING",
      idempotencyKey: input.idempotencyKey,
      principal: Object.freeze({ ...input.principal }),
      commandHash,
      createdAt: input.now,
      updatedAt: input.now,
      history: Object.freeze([]),
      evidence: Object.freeze([]),
    });
    this.#attempts.set(attemptId, attempt);
    const list = this.#byPlan.get(attempt.planId) ?? [];
    list.push(attempt);
    this.#byPlan.set(attempt.planId, list);
    return { kind: "BEGIN", attempt };
  }

  /**
   * Advance an attempt by a declared event. Enforces:
   * - INV-X04 (via the kernel state machine): monotonic terminals, explicit
   *   recovery only;
   * - INV-E02: any transition representing an external effect REQUIRES linked
   *   provider evidence;
   * - INV-X03: leaving OUTCOME_UNKNOWN requires a reconciliation resolution
   *   whose outcome matches the event and whose evidence is linked;
   * - INV-E05: recorded evidence is immutable (append-only).
   */
  advance(
    attemptId: string,
    event: ExecutionAttemptEvent,
    input: AdvanceAttemptInput,
  ): ExecutionAttempt {
    const current = this.#attempts.get(attemptId);
    if (current === undefined) {
      throw new ValidationError(`unknown execution attempt: ${attemptId}`);
    }
    if (input === null || typeof input !== "object" || typeof input.now !== "bigint") {
      throw new ValidationError("advance input must carry now: TimestampMs");
    }

    // INV-X03: leaving OUTCOME_UNKNOWN is possible ONLY through a
    // reconciliation resolution carrying provider evidence.
    if (current.state === "OUTCOME_UNKNOWN") {
      if (event !== "RECONCILE_RESOLVED_SUCCEEDED" && event !== "RECONCILE_RESOLVED_FAILED") {
        throw new ValidationError(
          "INV-X03: an OUTCOME_UNKNOWN attempt can only leave its state through a reconciliation resolution (RECONCILE_RESOLVED_SUCCEEDED | RECONCILE_RESOLVED_FAILED)",
        );
      }
      const resolution = input.resolution;
      if (resolution === undefined || resolution === null) {
        throw new ValidationError(
          "INV-X03: resolving an OUTCOME_UNKNOWN attempt requires a reconciliation resolution",
        );
      }
      if (resolution.evidence.length === 0) {
        throw new ValidationError(
          "INV-X03: a reconciliation resolution must carry provider evidence",
        );
      }
      if (
        (event === "RECONCILE_RESOLVED_SUCCEEDED" && resolution.resolvedOutcome !== "CONFIRMED_SUCCEEDED") ||
        (event === "RECONCILE_RESOLVED_FAILED" && resolution.resolvedOutcome !== "CONFIRMED_FAILED")
      ) {
        throw new ValidationError(
          "INV-X03: the resolution outcome must match the reconciliation event",
        );
      }
    } else if (event === "RECONCILE_RESOLVED_SUCCEEDED" || event === "RECONCILE_RESOLVED_FAILED") {
      throw new ValidationError(
        "reconciliation resolution events apply only to OUTCOME_UNKNOWN attempts",
      );
    }

    // INV-X04: the kernel machine throws TerminalStateViolationError for any
    // non-recovery exit from a terminal state, and IllegalTransitionError for
    // undeclared moves.
    const transition = attemptStateMachine.transition(current.state, event);

    const drafts = input.evidence ?? [];
    const evidenceRequires = eventRequiresProviderEvidence(current.state, event);
    if (evidenceRequires && drafts.length === 0) {
      throw new ValidationError(
        `INV-E02: event '${event}' on attempt state '${current.state}' represents an external effect and requires linked provider execution evidence`,
      );
    }
    const stamped = this.#stampEvidence(current, drafts);

    const record: AttemptTransitionRecord = Object.freeze({
      from: transition.from,
      on: transition.on,
      to: transition.to,
      viaRecovery: transition.viaRecovery,
      recordedAt: input.now,
      evidenceIds: Object.freeze(stamped.map((entry) => entry.evidenceId)),
    });
    // INV-C06: the latest observed provider state is preserved verbatim.
    const latestEvidenceState = [...stamped]
      .reverse()
      .find((entry) => entry.providerState !== undefined)?.providerState;
    const nextProviderState =
      latestEvidenceState ?? input.providerState ?? current.providerState;
    const next: ExecutionAttempt = Object.freeze({
      ...current,
      state: transition.to,
      updatedAt: input.now,
      history: Object.freeze([...current.history, record]),
      evidence: Object.freeze([...current.evidence, ...stamped]),
      ...(nextProviderState !== undefined ? { providerState: nextProviderState } : {}),
    });
    this.#attempts.set(attemptId, next);
    this.#replaceInPlanIndex(next);

    // INV-F05/INV-O01 idempotency discipline at terminalization:
    // - the FIRST terminalization of a non-terminal attempt binds the scope:
    //   FAILED → the registrar's FAILED status (retry re-arms — INV-O01),
    //   other terminals → COMPLETED with a deterministic result hash
    //   (replay equality on re-completion);
    // - an explicit RECOVER out of a terminal state is a recorded recovery,
    //   not a new authoritative command result: the registrar is untouched
    //   and the immutable history carries the recovery (INV-X04/INV-E05).
    if (
      attemptStateMachine.isTerminal(transition.to) &&
      !attemptStateMachine.isTerminal(current.state)
    ) {
      if (transition.to === "FAILED") {
        this.#registrar.fail({
          commandType: "execution.attempt",
          principal: next.principal,
          key: next.idempotencyKey,
        });
      } else {
        this.#registrar.complete(
          {
            commandType: "execution.attempt",
            principal: next.principal,
            key: next.idempotencyKey,
          },
          attemptResultHash(next),
        );
      }
    }
    return next;
  }

  /**
   * INV-X02: UNKNOWN external writes are never blindly retried. Retrying is
   * admissible ONLY for definitively FAILED attempts whose capability
   * declared SAFE_TO_RETRY (INV-O01); everything else — and above all
   * OUTCOME_UNKNOWN — fails closed.
   */
  requestRetry(
    attemptId: string,
    retryAttemptId: string,
    now: TimestampMs,
  ): ExecutionAttempt {
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) {
      throw new ValidationError(`unknown execution attempt: ${attemptId}`);
    }
    if (attempt.state === "OUTCOME_UNKNOWN") {
      throw new AttemptRetryForbiddenError(
        "INV-X02: the external write outcome is UNKNOWN — a blind retry is forbidden; reconciliation must resolve the ambiguity first (INV-X03)",
        { attemptId, state: attempt.state },
      );
    }
    if (attempt.state !== "FAILED") {
      throw new AttemptRetryForbiddenError(
        `only definitively FAILED attempts may be retried (attempt is '${attempt.state}')`,
        { attemptId, state: attempt.state },
      );
    }
    if (attempt.retryPolicy !== "SAFE_TO_RETRY") {
      throw new AttemptRetryForbiddenError(
        "the capability declares REQUIRES_RECONCILIATION: this failure must be reconciled, not retried (INV-X02)",
        { attemptId, retryPolicy: attempt.retryPolicy },
      );
    }
    // INV-F05/INV-O01: the registrar re-arms the FAILED scope (BEGIN again).
    return this.begin({
      attemptId: retryAttemptId,
      planId: attempt.planId,
      stepId: attempt.stepId,
      executionMode: attempt.executionMode,
      capabilityInstanceId: attempt.capabilityInstanceId,
      capabilityId: attempt.capabilityId,
      retryPolicy: attempt.retryPolicy,
      cancellation: attempt.semantics.cancellation,
      compensation: attempt.semantics.compensation,
      idempotencyKey: attempt.idempotencyKey,
      principal: attempt.principal,
      now,
    }).attempt;
  }

  /**
   * Attach additional provider evidence to an attempt (INV-E02), e.g. webhook
   * evidence arriving after the effect. Append-only and immutable (INV-E05).
   */
  attachEvidence(
    attemptId: string,
    drafts: readonly ProviderExecutionEvidenceDraft[],
  ): ExecutionAttempt {
    const current = this.#attempts.get(attemptId);
    if (current === undefined) {
      throw new ValidationError(`unknown execution attempt: ${attemptId}`);
    }
    const stamped = this.#stampEvidence(current, drafts);
    if (stamped.length === 0) {
      return current;
    }
    const latestEvidenceState = [...stamped]
      .reverse()
      .find((entry) => entry.providerState !== undefined)?.providerState;
    const next: ExecutionAttempt = Object.freeze({
      ...current,
      evidence: Object.freeze([...current.evidence, ...stamped]),
      ...(latestEvidenceState !== undefined ? { providerState: latestEvidenceState } : {}),
    });
    this.#attempts.set(attemptId, next);
    this.#replaceInPlanIndex(next);
    return next;
  }

  /** The current record of one attempt. */
  attempt(attemptId: string): ExecutionAttempt | undefined {
    return this.#attempts.get(attemptId);
  }

  /** All attempts recorded for one plan (in recording order). */
  attemptsForPlan(planId: string): readonly ExecutionAttempt[] {
    return [...(this.#byPlan.get(planId) ?? [])];
  }

  /** The evidence recorded for one attempt, in recording order (INV-E02). */
  evidenceFor(attemptId: string): readonly ProviderExecutionEvidence[] {
    const attempt = this.#attempts.get(attemptId);
    return attempt === undefined ? [] : [...attempt.evidence];
  }

  /** Evidence lookup by id (immutable once recorded). */
  evidenceById(evidenceId: string): ProviderExecutionEvidence | undefined {
    return this.#evidenceById.get(evidenceId);
  }

  // -- internals ------------------------------------------------------------

  #stampEvidence(
    attempt: ExecutionAttempt,
    drafts: readonly ProviderExecutionEvidenceDraft[],
  ): ProviderExecutionEvidence[] {
    const stamped: ProviderExecutionEvidence[] = [];
    for (const draft of drafts) {
      validateEvidenceDraft(draft);
      const existing = this.#evidenceById.get(draft.evidenceId);
      if (existing !== undefined) {
        if (existing.evidenceRef !== draft.evidenceRef || existing.attemptId !== attempt.attemptId) {
          throw new EvidenceImmutabilityError(
            `INV-E05: evidence '${draft.evidenceId}' is already recorded and immutable`,
            { evidenceId: draft.evidenceId, recordedFor: existing.attemptId },
          );
        }
        continue; // idempotent re-record of identical evidence
      }
      const evidence: ProviderExecutionEvidence = Object.freeze({
        evidenceId: draft.evidenceId,
        kind: draft.kind,
        evidenceRef: draft.evidenceRef,
        ...(draft.providerState !== undefined ? { providerState: draft.providerState } : {}),
        recordedAt: draft.recordedAt,
        attemptId: attempt.attemptId,
      });
      this.#evidenceById.set(evidence.evidenceId, evidence);
      stamped.push(evidence);
    }
    return stamped;
  }

  #findAttemptByScope(
    scope: { commandType: string; principal: PrincipalRef; key: string },
    commandHash: string,
  ): ExecutionAttempt | undefined {
    for (const attempt of this.#attempts.values()) {
      if (
        attempt.idempotencyKey === scope.key &&
        attempt.principal.principalType === scope.principal.principalType &&
        attempt.principal.principalId === scope.principal.principalId &&
        attempt.commandHash === commandHash
      ) {
        return attempt;
      }
    }
    return undefined;
  }

  #replaceInPlanIndex(next: ExecutionAttempt): void {
    const list = this.#byPlan.get(next.planId);
    if (list === undefined) {
      this.#byPlan.set(next.planId, [next]);
      return;
    }
    const index = list.findIndex((entry) => entry.attemptId === next.attemptId);
    if (index >= 0) {
      list[index] = next;
    } else {
      list.push(next);
    }
  }
}

/**
 * Deterministic evidence gating (INV-E02): an event represents an external
 * effect — and therefore REQUIRES linked provider evidence — unless it is a
 * pure local transition (START, or a cancellation before anything was sent).
 */
export function eventRequiresProviderEvidence(
  from: ExecutionAttemptState,
  event: ExecutionAttemptEvent,
): boolean {
  if (event === "START") {
    return false;
  }
  if (event === "CANCEL" && from === "PENDING") {
    return false;
  }
  return true;
}
