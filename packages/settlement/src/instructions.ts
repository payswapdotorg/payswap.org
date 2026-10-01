/**
 * @payswap/settlement — settlement instructions and attempts (W1-004).
 *
 * PAYMENT-OPERATING-PLANE "canonical payment lifecycle" tail:
 * … external rail effect → evidence/finality → settlement allocation →
 * reconciliation → receipt/complete. This module owns the settlement leg.
 *
 * `SettlementInstruction` EXTENDS the protocol-owned settlement instruction
 * from temporal netting (W1-003 `netting.settlementInstructions`): the
 * settlement plane CONSUMES the protocol derivation (INV-F07 gross
 * derivation preserved verbatim via `fromNetPosition`) and adds the
 * payment-plane enrichment — remittance references preserved end-to-end, the
 * EXTERNAL merchant settlement destination (never PaySwap custody) and the
 * authorization lineage references every consequential action must carry.
 *
 * `SettlementAttempt` is the idempotent, retry-safe attempt record for
 * executing one settlement instruction against an external rail:
 *
 * - INV-F05: one idempotency key maps to one authoritative attempt result —
 *   enforced through the protocol kernel's `IdempotencyRegistrar`
 *   (BEGIN/REPLAY/CONFLICT discipline; a conflicting key re-use throws).
 * - INV-O01: async settlement commands are retry-safe — a definitively FAILED
 *   attempt may be retried under the SAME idempotency key, which re-arms the
 *   scope exactly like the kernel's retry semantics (a NEW attempt record is
 *   created; the failed one stays FAILED forever — history is append-only).
 * - INV-X01: UNKNOWN is a first-class state (`OUTCOME_UNKNOWN`), never FAILED.
 * - INV-X02: an UNKNOWN external write is NEVER blindly retried —
 *   `requestRetry` fails closed on OUTCOME_UNKNOWN.
 * - INV-X03: leaving `OUTCOME_UNKNOWN` is possible ONLY through a
 *   reconciliation resolution (`resolveUnknown` demands one, and it must
 *   carry provider evidence); there is no other exit from ambiguity.
 * - INV-X04: terminal states are monotonic (the protocol kernel machine
 *   throws `TerminalStateViolationError` on any non-recovery exit); a retry
 *   never rewrites the failed attempt — it mints a new record.
 * - INV-E02: recording any external outcome REQUIRES linked evidence ids
 *   (the evidence graph owns the nodes; the attempt carries the linkage).
 */

import {
  InMemoryIdempotencyRegistrar,
  PaySwapError,
  ValidationError,
  asSettlementInstructionId,
  defineStateMachine,
  isPositive,
} from "@payswap/protocol";
import type {
  IdempotencyRecord,
  IdempotencyRegistrar,
  Money,
  NetPosition,
  PaySwapErrorDetails,
  PrincipalRef,
  SettlementInstruction as ProtocolSettlementInstruction,
  SettlementInstructionId,
  StateMachine,
  TimestampMs,
  TransitionRecord,
} from "@payswap/protocol";
import type { DocumentAllocation, RemittanceDocumentKind } from "@payswap/payment";

declare const SettlementAttemptIdBrand: unique symbol;

/** Branded id of one settlement attempt. */
export type SettlementAttemptId = string & {
  readonly [SettlementAttemptIdBrand]: "SettlementAttemptId";
};

/** Brand a validated string as a `SettlementAttemptId`. */
export function asSettlementAttemptId(value: string): SettlementAttemptId {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("SettlementAttemptId must be a non-empty string");
  }
  if (value.length > 256) {
    throw new ValidationError("SettlementAttemptId exceeds 256 characters");
  }
  if (value.trim() !== value) {
    throw new ValidationError("SettlementAttemptId must not carry surrounding whitespace");
  }
  return value as SettlementAttemptId;
}

// ---------------------------------------------------------------------------
// Settlement instructions (protocol derivation + payment-plane enrichment)
// ---------------------------------------------------------------------------

/** One business document this settlement settles (remittance reference). */
export interface RemittanceDocumentRef {
  readonly documentKind: RemittanceDocumentKind;
  readonly documentId: string;
}

/**
 * A protocol netting-derived settlement instruction enriched with the
 * payment-plane settlement semantics. The protocol part (id, set, parties,
 * amount, `fromNetPosition` with its INV-F07 gross derivation) is consumed
 * verbatim — never re-derived here.
 */
export interface SettlementInstruction extends ProtocolSettlementInstruction {
  /**
   * Remittance references preserved end-to-end: the document allocations of
   * the payments whose obligations this instruction settles, carried verbatim
   * from the payment plane (PAYMENT-OPERATING-PLANE RemittanceAllocation).
   */
  readonly remittance: readonly DocumentAllocation[];
  /** Free-form remittance information the payer required (preserved verbatim). */
  readonly remittanceInfo?: string;
  /** The EXTERNAL merchant settlement destination — never PaySwap custody. */
  readonly settlementDestinationId: string;
  /**
   * INV-E01: authorization lineage references (mandate/approval artifact ids)
   * — a consequential action without authorization refs is unconstructible.
   */
  readonly authorizationRefs: readonly string[];
  readonly issuedAt: TimestampMs;
}

/** Options for `deriveSettlementInstruction`. */
export interface DeriveSettlementInstructionInput {
  readonly protocolInstruction: ProtocolSettlementInstruction;
  readonly remittance: readonly DocumentAllocation[];
  readonly remittanceInfo?: string;
  readonly settlementDestinationId: string;
  readonly authorizationRefs: readonly string[];
  readonly issuedAt: TimestampMs;
}

/**
 * Construct a validated, frozen settlement instruction from a PROTOCOL-derived
 * instruction. Validation is all-or-nothing:
 * - the protocol instruction must be well-formed (branded id, positive exact
 *   Money, net position present);
 * - each remittance allocation must be positive exact Money in the
 *   instruction's currency with a unique (documentKind, documentId);
 * - the settlement destination must be identified (it stays external);
 * - at least one authorization reference must be present (INV-E01).
 */
export function deriveSettlementInstruction(
  input: DeriveSettlementInstructionInput,
): SettlementInstruction {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("derive input must be a DeriveSettlementInstructionInput object");
  }
  const protocolInstruction = input.protocolInstruction;
  if (protocolInstruction === null || typeof protocolInstruction !== "object") {
    throw new ValidationError("protocolInstruction must be a protocol SettlementInstruction");
  }
  asSettlementInstructionId(protocolInstruction.id);
  if (
    protocolInstruction.amount === null ||
    typeof protocolInstruction.amount !== "object" ||
    typeof protocolInstruction.amount.value !== "bigint"
  ) {
    throw new ValidationError("protocol instruction amount must be exact Money (INV-F01)");
  }
  if (!isPositive(protocolInstruction.amount)) {
    throw new ValidationError("a settlement instruction amount must be positive");
  }
  if (protocolInstruction.fromNetPosition === null || typeof protocolInstruction.fromNetPosition !== "object") {
    throw new ValidationError("protocol instruction must carry its net position (INV-F07 derivation)");
  }
  if (typeof input.settlementDestinationId !== "string" || input.settlementDestinationId.length === 0) {
    throw new ValidationError("settlementDestinationId must be a non-empty string (external destination)");
  }
  if (!Array.isArray(input.authorizationRefs) || input.authorizationRefs.length === 0) {
    throw new ValidationError(
      "INV-E01: a settlement instruction requires at least one authorization lineage reference",
    );
  }
  for (const ref of input.authorizationRefs) {
    if (typeof ref !== "string" || ref.length === 0) {
      throw new ValidationError("authorization refs must be non-empty strings");
    }
  }
  if (typeof input.issuedAt !== "bigint") {
    throw new ValidationError("issuedAt must be a bigint TimestampMs");
  }
  if (!Array.isArray(input.remittance)) {
    throw new ValidationError("remittance must be an array of DocumentAllocation");
  }
  const seen = new Set<string>();
  const remittance: DocumentAllocation[] = [];
  for (const allocation of input.remittance) {
    if (allocation === null || typeof allocation !== "object") {
      throw new ValidationError("each remittance allocation must be a DocumentAllocation");
    }
    if (
      typeof allocation.documentKind !== "string" ||
      allocation.documentKind.length === 0 ||
      typeof allocation.documentId !== "string" ||
      allocation.documentId.length === 0
    ) {
      throw new ValidationError("each remittance allocation must carry documentKind and documentId");
    }
    const key = `${allocation.documentKind}:${allocation.documentId}`;
    if (seen.has(key)) {
      throw new ValidationError(`a document may appear at most once in the remittance: ${key}`);
    }
    seen.add(key);
    if (
      allocation.allocatedAmount === null ||
      typeof allocation.allocatedAmount !== "object" ||
      typeof allocation.allocatedAmount.value !== "bigint" ||
      typeof allocation.allocatedAmount.currency !== "string"
    ) {
      throw new ValidationError(`allocation for ${key} must be exact Money`);
    }
    if (allocation.allocatedAmount.currency !== protocolInstruction.amount.currency) {
      throw new ValidationError(
        `allocation for ${key} must be in the instruction currency ${String(protocolInstruction.amount.currency)}`,
      );
    }
    if (!isPositive(allocation.allocatedAmount)) {
      throw new ValidationError(`allocation for ${key} must be positive`);
    }
    remittance.push(Object.freeze({ ...allocation, allocatedAmount: allocation.allocatedAmount }));
  }
  if (
    input.remittanceInfo !== undefined &&
    (typeof input.remittanceInfo !== "string" || input.remittanceInfo.length === 0)
  ) {
    throw new ValidationError("remittanceInfo must be a non-empty string when present");
  }

  return Object.freeze({
    ...protocolInstruction,
    remittance: Object.freeze(remittance),
    ...(input.remittanceInfo !== undefined ? { remittanceInfo: input.remittanceInfo } : {}),
    settlementDestinationId: input.settlementDestinationId,
    authorizationRefs: Object.freeze([...input.authorizationRefs]),
    issuedAt: input.issuedAt,
  });
}

/**
 * Deterministic deduplicated document-reference view of the instruction's
 * remittance (first-appearance order): "which business documents did this
 * settlement settle?" — preserved end-to-end for the merchant's AR system.
 */
export function remittanceDocumentRefs(
  instruction: SettlementInstruction,
): readonly RemittanceDocumentRef[] {
  const seen = new Set<string>();
  const refs: RemittanceDocumentRef[] = [];
  for (const allocation of instruction.remittance) {
    const key = `${allocation.documentKind}:${allocation.documentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(
      Object.freeze({
        documentKind: allocation.documentKind,
        documentId: allocation.documentId,
      }),
    );
  }
  return Object.freeze(refs);
}

// ---------------------------------------------------------------------------
// Settlement attempts (INV-F05 / INV-O01 / INV-X01..X04 / INV-E02)
// ---------------------------------------------------------------------------

export type SettlementAttemptState =
  | "PENDING"
  | "IN_FLIGHT"
  | "OUTCOME_UNKNOWN"
  | "SUCCEEDED"
  | "FAILED";

export type SettlementAttemptEvent =
  | "START"
  | "CONFIRM_SUCCEEDED"
  | "CONFIRM_FAILED"
  | "OUTCOME_UNKNOWN"
  | "RECONCILE_RESOLVED_SUCCEEDED"
  | "RECONCILE_RESOLVED_FAILED";

/**
 * The canonical settlement attempt lifecycle (protocol kernel machine).
 * SUCCEEDED and FAILED are TERMINAL and monotonic (INV-X04): a retry mints a
 * NEW attempt record — the failed record is never rewritten.
 * `OUTCOME_UNKNOWN` is deliberately non-terminal and can ONLY be exited via
 * the reconciliation resolution events (INV-X03) — there is no declared rule
 * from OUTCOME_UNKNOWN to any ordinary event, and no coercion to FAILED
 * exists anywhere (INV-X01).
 */
export const settlementAttemptStateMachine: StateMachine<
  SettlementAttemptState,
  SettlementAttemptEvent,
  unknown
> = defineStateMachine<SettlementAttemptState, SettlementAttemptEvent, unknown>({
  name: "settlement-attempt",
  initial: "PENDING",
  states: ["PENDING", "IN_FLIGHT", "OUTCOME_UNKNOWN", "SUCCEEDED", "FAILED"],
  events: [
    "START",
    "CONFIRM_SUCCEEDED",
    "CONFIRM_FAILED",
    "OUTCOME_UNKNOWN",
    "RECONCILE_RESOLVED_SUCCEEDED",
    "RECONCILE_RESOLVED_FAILED",
  ],
  transitions: [
    { from: "PENDING", on: "START", to: "IN_FLIGHT", description: "pure local start — no external effect yet" },
    { from: "IN_FLIGHT", on: "CONFIRM_SUCCEEDED", to: "SUCCEEDED" },
    { from: "IN_FLIGHT", on: "CONFIRM_FAILED", to: "FAILED" },
    { from: "IN_FLIGHT", on: "OUTCOME_UNKNOWN", to: "OUTCOME_UNKNOWN" },
    { from: "OUTCOME_UNKNOWN", on: "RECONCILE_RESOLVED_SUCCEEDED", to: "SUCCEEDED" },
    { from: "OUTCOME_UNKNOWN", on: "RECONCILE_RESOLVED_FAILED", to: "FAILED" },
  ],
  terminalStates: ["SUCCEEDED", "FAILED"],
});

/** One recorded state transition on an attempt (history is append-only). */
export interface SettlementTransitionRecord
  extends TransitionRecord<SettlementAttemptState, SettlementAttemptEvent> {
  readonly recordedAt: TimestampMs;
  readonly evidenceIds: readonly string[];
  /** Present when the transition was a reconciliation resolution (INV-X03). */
  readonly resolutionCaseId?: string;
}

/**
 * The reconciliation resolution authority required to leave OUTCOME_UNKNOWN
 * (INV-X03). Only the settlement reconciliation authority produces these —
 * the ledger verifies the resolution matches the event and carries evidence.
 */
export interface UnknownOutcomeResolution {
  readonly resolvedOutcome: "CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED";
  readonly resolvedBy: PrincipalRef;
  readonly caseId: string;
  readonly evidenceIds: readonly string[];
}

/** The definitive or ambiguous outcome of an external settlement write. */
export type ExternalOutcome = "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";

/** The immutable settlement attempt record. */
export interface SettlementAttempt {
  readonly attemptId: SettlementAttemptId;
  readonly instructionId: SettlementInstructionId;
  /** The rail this attempt executes on (proof-policy risk dimension). */
  readonly rail: string;
  readonly state: SettlementAttemptState;
  readonly idempotencyKey: string;
  readonly principal: PrincipalRef;
  readonly commandHash: string;
  /** Linked evidence node ids (the evidence graph owns the nodes — INV-E02). */
  readonly evidenceIds: readonly string[];
  readonly createdAt: TimestampMs;
  readonly updatedAt: TimestampMs;
  readonly history: readonly SettlementTransitionRecord[];
  /** Present iff the ambiguity was resolved through reconciliation (INV-X03). */
  readonly resolution?: UnknownOutcomeResolution;
}

export interface BeginSettlementAttemptInput {
  readonly attemptId: string;
  readonly instructionId: string;
  readonly rail: string;
  readonly idempotencyKey: string;
  readonly principal: PrincipalRef;
  readonly now: TimestampMs;
}

export type BeginSettlementAttemptOutcome =
  | { readonly kind: "BEGIN"; readonly attempt: SettlementAttempt }
  | {
      /** INV-F05: one idempotency key maps to one authoritative attempt. */
      readonly kind: "REPLAY";
      readonly attempt: SettlementAttempt;
      readonly record: IdempotencyRecord;
    };

/** INV-F05 violation: same idempotency key, different command. */
export class SettlementAttemptConflictError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "SETTLEMENT_ATTEMPT_CONFLICT",
      category: "CONFLICT",
      message,
      details,
    });
  }
}

/** INV-X02: an UNKNOWN external write cannot be blindly retried. */
export class SettlementRetryForbiddenError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "SETTLEMENT_RETRY_FORBIDDEN",
      category: "EXTERNAL_AMBIGUITY",
      message,
      details,
    });
  }
}

/** INV-E02: an external outcome was recorded without linked evidence. */
export class SettlementEvidenceRequiredError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "SETTLEMENT_EVIDENCE_REQUIRED",
      category: "VALIDATION",
      message,
      details,
    });
  }
}

/** Deterministic FNV-1a 64 (binding, never security). */
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
export function settlementCommandHash(input: {
  readonly instructionId: SettlementInstructionId;
  readonly rail: string;
  readonly principal: PrincipalRef;
}): string {
  return fnv1a64(
    `settlement-attempt|${input.instructionId}|${input.rail}|${input.principal.principalType}:${input.principal.principalId}`,
  );
}

/** Deterministic result hash for a terminalized attempt (replay equality). */
export function settlementResultHash(attempt: SettlementAttempt): string {
  return fnv1a64(`settlement-attempt-result|${attempt.attemptId}|${attempt.state}`);
}

/**
 * The settlement attempt ledger: idempotent, retry-safe, evidence-linked.
 * Deterministic reference implementation over the protocol kernel's
 * idempotency registrar (production replaces persistence, not semantics).
 */
export class SettlementAttemptLedger {
  readonly #registrar: IdempotencyRegistrar;
  readonly #attempts = new Map<string, SettlementAttempt>();
  readonly #byInstruction = new Map<string, SettlementAttempt[]>();

  constructor(registrar?: IdempotencyRegistrar) {
    this.#registrar = registrar ?? new InMemoryIdempotencyRegistrar();
  }

  /**
   * Begin an attempt under the INV-F05 discipline: the
   * (settlement.attempt, principal, key) scope maps to one authoritative
   * attempt. In-flight/completed duplicates REPLAY; a different command under
   * the same key CONFLICTS.
   */
  begin(input: BeginSettlementAttemptInput): BeginSettlementAttemptOutcome {
    if (input === null || typeof input !== "object") {
      throw new ValidationError("attempt begin input must be an object");
    }
    const attemptId = asSettlementAttemptId(input.attemptId);
    const instructionId = asSettlementInstructionId(input.instructionId);
    if (typeof input.rail !== "string" || input.rail.length === 0) {
      throw new ValidationError("attempt rail must be a non-empty string");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new ValidationError("idempotencyKey is required (INV-F05)");
    }
    if (input.principal === null || typeof input.principal !== "object") {
      throw new ValidationError("principal is required");
    }
    if (typeof input.now !== "bigint") {
      throw new ValidationError("now must be a bigint TimestampMs");
    }
    if (this.#attempts.has(attemptId)) {
      throw new ValidationError(`settlement attempt id '${attemptId}' is already recorded`);
    }

    const scope = {
      commandType: "settlement.attempt",
      principal: input.principal,
      key: input.idempotencyKey,
    };
    const commandHash = settlementCommandHash({
      instructionId,
      rail: input.rail,
      principal: input.principal,
    });
    const outcome = this.#registrar.begin(scope, commandHash);
    if (outcome.kind === "CONFLICT") {
      throw new SettlementAttemptConflictError(
        `INV-F05: idempotency key '${input.idempotencyKey}' is already bound to a different command`,
        { principal: input.principal.principalId, commandHash },
      );
    }
    if (outcome.kind === "REPLAY") {
      const existing = this.#findAttemptByScope(scope, commandHash);
      if (existing !== undefined) {
        return { kind: "REPLAY", attempt: existing, record: outcome.record };
      }
      throw new SettlementAttemptConflictError(
        `INV-F05: idempotency key '${input.idempotencyKey}' replays a command this ledger did not record`,
        { commandHash },
      );
    }

    const attempt: SettlementAttempt = Object.freeze({
      attemptId,
      instructionId,
      rail: input.rail,
      state: "PENDING",
      idempotencyKey: input.idempotencyKey,
      principal: Object.freeze({ ...input.principal }),
      commandHash,
      evidenceIds: Object.freeze([]),
      createdAt: input.now,
      updatedAt: input.now,
      history: Object.freeze([]),
    });
    this.#attempts.set(attemptId, attempt);
    const list = this.#byInstruction.get(instructionId) ?? [];
    list.push(attempt);
    this.#byInstruction.set(instructionId, list);
    return { kind: "BEGIN", attempt };
  }

  /** Start the attempt (pure local transition — no evidence required). */
  start(attemptId: string, now: TimestampMs): SettlementAttempt {
    return this.#advance(attemptId, "START", { evidenceIds: [], now });
  }

  /**
   * Record the outcome of the external settlement write (INV-E02: linked
   * evidence ids REQUIRED — even for ambiguity, the ambiguity observation
   * itself is evidence). Only legal from IN_FLIGHT; an OUTCOME_UNKNOWN
   * attempt must be resolved through reconciliation (INV-X03) — recording a
   * definitive outcome directly from ambiguity is structurally refused.
   */
  recordExternalOutcome(
    attemptId: string,
    outcome: ExternalOutcome,
    evidenceIds: readonly string[],
    now: TimestampMs,
  ): SettlementAttempt {
    if (outcome !== "SUCCEEDED" && outcome !== "FAILED" && outcome !== "OUTCOME_UNKNOWN") {
      throw new ValidationError(`unknown external outcome '${String(outcome)}'`);
    }
    const event: SettlementAttemptEvent =
      outcome === "SUCCEEDED"
        ? "CONFIRM_SUCCEEDED"
        : outcome === "FAILED"
          ? "CONFIRM_FAILED"
          : "OUTCOME_UNKNOWN";
    const current = this.#attempts.get(attemptId);
    if (current === undefined) {
      throw new ValidationError(`unknown settlement attempt: ${attemptId}`);
    }
    if (current.state === "OUTCOME_UNKNOWN") {
      throw new ValidationError(
        "INV-X03: an OUTCOME_UNKNOWN settlement attempt can only leave its state through a reconciliation resolution — never through a direct outcome write and never through retry",
        { attemptId, state: current.state },
      );
    }
    return this.#advance(attemptId, event, { evidenceIds, now });
  }

  /**
   * Resolve an OUTCOME_UNKNOWN attempt through a reconciliation resolution
   * (INV-X03 — the ONLY exit from ambiguity). The resolution must match the
   * resolution event, be issued by a principal, and carry evidence.
   */
  resolveUnknown(
    attemptId: string,
    resolution: UnknownOutcomeResolution,
    now: TimestampMs,
  ): SettlementAttempt {
    if (resolution === null || typeof resolution !== "object") {
      throw new ValidationError("resolution must be an UnknownOutcomeResolution");
    }
    const current = this.#attempts.get(attemptId);
    if (current === undefined) {
      throw new ValidationError(`unknown settlement attempt: ${attemptId}`);
    }
    if (current.state !== "OUTCOME_UNKNOWN") {
      throw new ValidationError(
        `reconciliation resolutions apply only to OUTCOME_UNKNOWN attempts (attempt is '${current.state}')`,
        { attemptId, state: current.state },
      );
    }
    if (typeof resolution.caseId !== "string" || resolution.caseId.length === 0) {
      throw new ValidationError("INV-X03: a resolution must reference its reconciliation case");
    }
    if (resolution.resolvedBy === null || typeof resolution.resolvedBy !== "object") {
      throw new ValidationError("INV-X03: a resolution must name the resolving principal");
    }
    if (!Array.isArray(resolution.evidenceIds) || resolution.evidenceIds.length === 0) {
      throw new SettlementEvidenceRequiredError(
        "INV-E02/INV-X03: a reconciliation resolution must carry provider evidence linked to the ambiguous attempt",
        { attemptId, caseId: resolution.caseId },
      );
    }
    const event: SettlementAttemptEvent =
      resolution.resolvedOutcome === "CONFIRMED_SUCCEEDED"
        ? "RECONCILE_RESOLVED_SUCCEEDED"
        : "RECONCILE_RESOLVED_FAILED";
    const attempt = this.#advance(attemptId, event, {
      evidenceIds: resolution.evidenceIds,
      now,
      resolution,
    });
    return attempt;
  }

  /**
   * Attach additional evidence ids to an attempt (INV-E02), e.g. webhook
   * evidence arriving after the effect. Append-only (INV-E05): already-linked
   * ids are not duplicated.
   */
  attachEvidence(attemptId: string, evidenceIds: readonly string[], now: TimestampMs): SettlementAttempt {
    const current = this.#attempts.get(attemptId);
    if (current === undefined) {
      throw new ValidationError(`unknown settlement attempt: ${attemptId}`);
    }
    if (!Array.isArray(evidenceIds)) {
      throw new ValidationError("evidenceIds must be an array of evidence node ids");
    }
    const linked = new Set(current.evidenceIds);
    const additions: string[] = [];
    for (const id of evidenceIds) {
      if (typeof id !== "string" || id.length === 0) {
        throw new ValidationError("evidence ids must be non-empty strings");
      }
      if (!linked.has(id)) {
        linked.add(id);
        additions.push(id);
      }
    }
    if (additions.length === 0) {
      return current;
    }
    const next: SettlementAttempt = Object.freeze({
      ...current,
      evidenceIds: Object.freeze([...current.evidenceIds, ...additions]),
      updatedAt: now,
    });
    this.#attempts.set(attemptId, next);
    this.#replaceInInstructionIndex(next);
    return next;
  }

  /**
   * INV-X02: UNKNOWN external writes are never blindly retried. Retrying is
   * admissible ONLY for definitively FAILED attempts (INV-O01): the idempotency
   * scope re-arms and a NEW attempt record is minted under the same key — the
   * FAILED record stays FAILED (INV-X04, history append-only).
   */
  requestRetry(attemptId: string, retryAttemptId: string, now: TimestampMs): SettlementAttempt {
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) {
      throw new ValidationError(`unknown settlement attempt: ${attemptId}`);
    }
    if (attempt.state === "OUTCOME_UNKNOWN") {
      throw new SettlementRetryForbiddenError(
        "INV-X02: the external settlement write outcome is UNKNOWN — a blind retry is forbidden; reconciliation must resolve the ambiguity first (INV-X03)",
        { attemptId, state: attempt.state },
      );
    }
    if (attempt.state !== "FAILED") {
      throw new SettlementRetryForbiddenError(
        `only definitively FAILED settlement attempts may be retried (attempt is '${attempt.state}')`,
        { attemptId, state: attempt.state },
      );
    }
    const outcome = this.begin({
      attemptId: retryAttemptId,
      instructionId: attempt.instructionId,
      rail: attempt.rail,
      idempotencyKey: attempt.idempotencyKey,
      principal: attempt.principal,
      now,
    });
    return outcome.attempt;
  }

  /** The current record of one attempt. */
  attempt(attemptId: string): SettlementAttempt | undefined {
    return this.#attempts.get(attemptId);
  }

  /** All attempts recorded for one instruction (in recording order). */
  attemptsForInstruction(instructionId: string): readonly SettlementAttempt[] {
    return [...(this.#byInstruction.get(instructionId) ?? [])];
  }

  /** Does the instruction still carry an unresolved ambiguity? (INV-X03) */
  hasOpenAmbiguity(instructionId: string): boolean {
    return this.attemptsForInstruction(instructionId).some(
      (attempt) => attempt.state === "OUTCOME_UNKNOWN",
    );
  }

  // -- internals ------------------------------------------------------------

  #advance(
    attemptId: string,
    event: SettlementAttemptEvent,
    input: {
      readonly evidenceIds: readonly string[];
      readonly now: TimestampMs;
      readonly resolution?: UnknownOutcomeResolution;
    },
  ): SettlementAttempt {
    const current = this.#attempts.get(attemptId);
    if (current === undefined) {
      throw new ValidationError(`unknown settlement attempt: ${attemptId}`);
    }
    if (input === null || typeof input !== "object" || typeof input.now !== "bigint") {
      throw new ValidationError("advance input must carry now: TimestampMs");
    }
    if (!Array.isArray(input.evidenceIds)) {
      throw new ValidationError("evidenceIds must be an array");
    }

    // INV-E02: every event that represents an external effect requires linked
    // provider evidence (START is the only pure local transition).
    if (event !== "START" && input.evidenceIds.length === 0) {
      throw new SettlementEvidenceRequiredError(
        `INV-E02: event '${event}' on settlement attempt '${attemptId}' represents an external effect and requires linked evidence`,
        { attemptId, event },
      );
    }
    for (const id of input.evidenceIds) {
      if (typeof id !== "string" || id.length === 0) {
        throw new ValidationError("evidence ids must be non-empty strings");
      }
    }

    // INV-X04 (via the protocol kernel machine): monotonic terminals — a
    // terminal attempt can never move; OUTCOME_UNKNOWN has no ordinary exit.
    const transition = settlementAttemptStateMachine.transition(current.state, event);

    const linked = new Set(current.evidenceIds);
    for (const id of input.evidenceIds) {
      linked.add(id);
    }
    const record: SettlementTransitionRecord = Object.freeze({
      from: transition.from,
      on: transition.on,
      to: transition.to,
      viaRecovery: transition.viaRecovery,
      recordedAt: input.now,
      evidenceIds: Object.freeze([...input.evidenceIds]),
      ...(input.resolution !== undefined ? { resolutionCaseId: input.resolution.caseId } : {}),
    });
    const next: SettlementAttempt = Object.freeze({
      ...current,
      state: transition.to,
      evidenceIds: Object.freeze([...linked]),
      updatedAt: input.now,
      history: Object.freeze([...current.history, record]),
      ...(input.resolution !== undefined ? { resolution: Object.freeze({ ...input.resolution }) } : {}),
    });
    this.#attempts.set(attemptId, next);
    this.#replaceInInstructionIndex(next);

    // INV-F05/INV-O01 idempotency discipline at terminalization:
    // FAILED → the registrar FAILED status (a retry re-arms the scope);
    // other terminals → COMPLETED with the deterministic result hash.
    if (
      settlementAttemptStateMachine.isTerminal(transition.to) &&
      !settlementAttemptStateMachine.isTerminal(current.state)
    ) {
      if (transition.to === "FAILED") {
        this.#registrar.fail({
          commandType: "settlement.attempt",
          principal: next.principal,
          key: next.idempotencyKey,
        });
      } else {
        this.#registrar.complete(
          {
            commandType: "settlement.attempt",
            principal: next.principal,
            key: next.idempotencyKey,
          },
          settlementResultHash(next),
        );
      }
    }
    return next;
  }

  #findAttemptByScope(
    scope: { commandType: string; principal: PrincipalRef; key: string },
    commandHash: string,
  ): SettlementAttempt | undefined {
    // The authoritative attempt for a scope is the LATEST one recorded under
    // it (a retry mints a new record; the earlier FAILED record stays in
    // history but is no longer the authoritative result).
    let found: SettlementAttempt | undefined;
    for (const attempt of this.#attempts.values()) {
      if (
        attempt.idempotencyKey === scope.key &&
        attempt.principal.principalType === scope.principal.principalType &&
        attempt.principal.principalId === scope.principal.principalId &&
        attempt.commandHash === commandHash
      ) {
        found = attempt;
      }
    }
    return found;
  }

  #replaceInInstructionIndex(next: SettlementAttempt): void {
    const list = this.#byInstruction.get(next.instructionId);
    if (list === undefined) {
      this.#byInstruction.set(next.instructionId, [next]);
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
