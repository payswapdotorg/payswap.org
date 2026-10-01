/**
 * @payswap/settlement — reconciliation: the ONLY definitive resolver of
 * ambiguous external effects on the settlement plane (W1-004).
 *
 * FROZEN-ARCHITECTURE §22 + INVARIANTS:
 *
 * - INV-X03: an UNKNOWN settlement outcome can ONLY resolve through a
 *   `SettlementReconciliationCase` issued by `SettlementReconciliationAuthority`
 *   — never through retry, never through a direct write. Provider outages and
 *   connector failures never fabricate PaySwap business outcomes: an
 *   unresolvable case stays OPEN.
 * - INV-X01: UNKNOWN is never mapped to FAILED — the outcome classifier
 *   consumed from @payswap/execution (`classifyProviderOutcome`) keeps
 *   OUTCOME_UNKNOWN a first-class ambiguous outcome.
 * - INV-C06: provider state envelopes and provider revisions are reconciled
 *   WITHOUT overwriting canonical history — `ProviderRevisionLedger` is
 *   append-only; a divergent re-record of the same revision is rejected.
 * - INV-C09: `ExternalFundsPositionObservation` is reconciled with mandatory
 *   freshness + provenance checks and is NEVER booked as PaySwap custody —
 *   the reconciliation result is structurally incapable of representing a
 *   balance or a booking.
 *
 * Payment-plane reconciliation subjects (PAYMENT-OPERATING-PLANE):
 * - translated payment-method paths (attempts carry the instruction, the
 *   instruction preserves remittance references end-to-end);
 * - recurring mandate renewals (`reconcileMandateRenewal` — a renewal that
 *   silently expands authority is reported, never absorbed);
 * - off-network check/cash/external-payment records (`reconcileOffNetworkRecord`
 *   — they never imply PaySwap execution);
 * - refund/dispute symmetry (REFUND_DISPUTE_SYMMETRY cases).
 */

import { ValidationError } from "@payswap/protocol";
import type {
  PaySwapErrorDetails,
  PrincipalRef,
  SettlementInstructionId,
  TimestampMs,
} from "@payswap/protocol";
import { classifyProviderOutcome } from "@payswap/execution";
import {
  isExternalFundsPositionObservation,
  isFreshAt,
  validateExternalFundsPositionObservation,
} from "@payswap/connectors";
import type {
  ExternalFundsPositionObservation,
  ProviderStateEnvelope,
} from "@payswap/connectors";
import { isPaySwapExecutedSettlement } from "@payswap/payment";
import type { OffNetworkPaymentRecord, RecurringMandate } from "@payswap/payment";
import { SettlementAttemptLedger } from "./instructions.js";
import type { SettlementAttemptId } from "./instructions.js";

declare const ReconciliationCaseIdBrand: unique symbol;

/** Branded id of one settlement reconciliation case. */
export type ReconciliationCaseId = string & {
  readonly [ReconciliationCaseIdBrand]: "ReconciliationCaseId";
};

/** Brand a validated string as a `ReconciliationCaseId`. */
export function asReconciliationCaseId(value: string): ReconciliationCaseId {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("ReconciliationCaseId must be a non-empty string");
  }
  if (value.length > 256) {
    throw new ValidationError("ReconciliationCaseId exceeds 256 characters");
  }
  if (value.trim() !== value) {
    throw new ValidationError("ReconciliationCaseId must not carry surrounding whitespace");
  }
  return value as ReconciliationCaseId;
}

// ---------------------------------------------------------------------------
// Outcome classification (INV-X01 — consumed from @payswap/execution)
// ---------------------------------------------------------------------------

/** The recordable external outcome of a settlement write, from provider state. */
export type RecordableSettlementOutcome = "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";

/**
 * Consume the canonical provider-outcome classifier (W3-003) and narrow it to
 * the settlement-recordable outcomes. An ambiguous provider state (INV-X01)
 * maps to OUTCOME_UNKNOWN — NEVER to FAILED. Non-outcome states (customer
 * action required, async processing) are NOT recordable outcomes: they are
 * reported so the caller waits, acts, or observes again.
 */
export function settlementOutcomeFromProviderState(
  envelope: ProviderStateEnvelope,
):
  | { readonly recordable: true; readonly outcome: RecordableSettlementOutcome }
  | { readonly recordable: false; readonly reason: "AWAITING_CUSTOMER_ACTION" | "ASYNC_PROCESSING" } {
  if (envelope === null || typeof envelope !== "object") {
    throw new ValidationError("a ProviderStateEnvelope is required");
  }
  const classification = classifyProviderOutcome(envelope);
  switch (classification.outcome) {
    case "SUCCEEDED":
      return { recordable: true, outcome: "SUCCEEDED" };
    case "FAILED":
      return { recordable: true, outcome: "FAILED" };
    case "OUTCOME_UNKNOWN":
      // INV-X01: ambiguity is ambiguity — never coerced into FAILED.
      return { recordable: true, outcome: "OUTCOME_UNKNOWN" };
    case "AWAITING_CUSTOMER_ACTION":
      return { recordable: false, reason: "AWAITING_CUSTOMER_ACTION" };
    case "ASYNC_PROCESSING":
      return { recordable: false, reason: "ASYNC_PROCESSING" };
  }
}

// ---------------------------------------------------------------------------
// Cases and resolutions (INV-X03)
// ---------------------------------------------------------------------------

/** Why a settlement reconciliation case exists. */
export type ReconciliationReason =
  | "EXTERNAL_AMBIGUITY"
  | "PROVIDER_OUTAGE_UNKNOWN_EFFECT"
  | "PROVIDER_REVISION_DIVERGENCE"
  | "MANDATE_RENEWAL_AMBIGUITY"
  | "OFF_NETWORK_RECORD_AMBIGUITY"
  | "EXTERNAL_FUNDS_DISCREPANCY"
  | "REFUND_DISPUTE_AMBIGUITY";

/**
 * What a case reconciles. SETTLEMENT_ATTEMPT is the ambiguous-external-write
 * case (INV-X03); the remaining subjects cover the payment-plane
 * reconciliation requirements (provider revisions, external funds
 * observations, recurring mandate renewals, off-network records, refund /
 * dispute symmetry).
 */
export type ReconciliationSubject =
  | { readonly kind: "SETTLEMENT_ATTEMPT"; readonly attemptId: SettlementAttemptId }
  | {
      readonly kind: "PROVIDER_REVISION";
      readonly providerName: string;
      readonly objectType: string;
      readonly externalId: string;
    }
  | { readonly kind: "EXTERNAL_FUNDS_OBSERVATION"; readonly observationId: string }
  | { readonly kind: "RECURRING_MANDATE_RENEWAL"; readonly mandateId: string; readonly renewalRef: string }
  | { readonly kind: "OFF_NETWORK_RECORD"; readonly recordId: string }
  | { readonly kind: "REFUND_DISPUTE_SYMMETRY"; readonly originalRef: string; readonly adjustmentRef: string };

export type ReconciliationResolutionOutcome =
  | "CONFIRMED_SUCCEEDED"
  | "CONFIRMED_FAILED"
  | "MATCHED"
  | "DISCREPANCY_RECORDED";

/** The immutable resolution record (INV-E05). */
export interface SettlementReconciliationResolution {
  readonly caseId: ReconciliationCaseId;
  readonly outcome: ReconciliationResolutionOutcome;
  readonly resolvedBy: PrincipalRef;
  /** Evidence node/graph ids backing the resolution — REQUIRED (INV-E02). */
  readonly evidenceIds: readonly string[];
  readonly resolvedAt: TimestampMs;
  readonly note?: string;
}

/** One reconciliation case. */
export interface SettlementReconciliationCase {
  readonly caseId: ReconciliationCaseId;
  readonly subject: ReconciliationSubject;
  readonly reason: ReconciliationReason;
  readonly status: "OPEN" | "RESOLVED";
  /** Links the case to the settlement instruction it affects (finality gate). */
  readonly instructionRef?: SettlementInstructionId;
  readonly openedAt: TimestampMs;
  /** Present iff RESOLVED — the immutable resolution record (INV-E05). */
  readonly resolution?: SettlementReconciliationResolution;
}

export interface OpenCaseInput {
  readonly caseId: string;
  readonly subject: ReconciliationSubject;
  readonly reason: ReconciliationReason;
  readonly instructionRef?: string;
  readonly now: TimestampMs;
}

export interface ResolveCaseInput {
  readonly caseId: string;
  readonly outcome: ReconciliationResolutionOutcome;
  readonly resolvedBy: PrincipalRef;
  readonly evidenceIds: readonly string[];
  readonly now: TimestampMs;
  readonly note?: string;
}

/** Case lifecycle violation (duplicate/open/resolved conflicts). */
export class ReconciliationCaseError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = "ReconciliationCaseError";
  }
}

/**
 * The settlement reconciliation authority (INV-X03). The ONLY component that
 * can move an OUTCOME_UNKNOWN settlement attempt to a definitive outcome,
 * always with linked evidence, always as an immutable resolution record.
 */
export class SettlementReconciliationAuthority {
  readonly #ledger: SettlementAttemptLedger;
  readonly #cases = new Map<string, SettlementReconciliationCase>();
  readonly #openByAttempt = new Map<string, string>();

  constructor(ledger: SettlementAttemptLedger) {
    this.#ledger = ledger;
  }

  /**
   * Open a case. For a SETTLEMENT_ATTEMPT subject the attempt MUST currently
   * be OUTCOME_UNKNOWN (an ambiguity is exactly what a case exists for) and
   * the case inherits the attempt's instruction reference. One OPEN case per
   * ambiguous attempt; resolved cases are never re-opened (INV-E05).
   */
  openCase(input: OpenCaseInput): SettlementReconciliationCase {
    if (input === null || typeof input !== "object") {
      throw new ValidationError("open-case input must be an object");
    }
    const caseId = asReconciliationCaseId(input.caseId);
    if (this.#cases.has(caseId)) {
      throw new ReconciliationCaseError(`reconciliation case '${caseId}' already exists`);
    }
    if (input.subject === null || typeof input.subject !== "object") {
      throw new ValidationError("subject must be a ReconciliationSubject");
    }
    let instructionRef: SettlementInstructionId | undefined =
      typeof input.instructionRef === "string" && input.instructionRef.length > 0
        ? (input.instructionRef as SettlementInstructionId)
        : undefined;
    if (input.subject.kind === "SETTLEMENT_ATTEMPT") {
      const attempt = this.#ledger.attempt(input.subject.attemptId);
      if (attempt === undefined) {
        throw new ReconciliationCaseError(
          `cannot open a reconciliation case for unknown settlement attempt '${input.subject.attemptId}'`,
        );
      }
      if (attempt.state !== "OUTCOME_UNKNOWN") {
        throw new ReconciliationCaseError(
          `reconciliation cases exist for ambiguous external effects: attempt '${input.subject.attemptId}' is '${attempt.state}', not OUTCOME_UNKNOWN (INV-X03)`,
          { attemptId: input.subject.attemptId, state: attempt.state },
        );
      }
      const openCaseId = this.#openByAttempt.get(input.subject.attemptId);
      if (openCaseId !== undefined) {
        throw new ReconciliationCaseError(
          `attempt '${input.subject.attemptId}' already has OPEN case '${openCaseId}'`,
        );
      }
      instructionRef = attempt.instructionId;
    }
    const record: SettlementReconciliationCase = Object.freeze({
      caseId,
      subject: Object.freeze({ ...input.subject }) as ReconciliationSubject,
      reason: input.reason,
      status: "OPEN",
      ...(instructionRef !== undefined ? { instructionRef } : {}),
      openedAt: input.now,
    });
    this.#cases.set(caseId, record);
    if (input.subject.kind === "SETTLEMENT_ATTEMPT") {
      this.#openByAttempt.set(input.subject.attemptId, caseId);
    }
    return record;
  }

  /**
   * Resolve an OPEN case — the authoritative transition of an ambiguous
   * external effect into a definitive outcome (INV-X03). Resolution REQUIRES
   * linked evidence (INV-E02); the ambiguous attempt then leaves
   * OUTCOME_UNKNOWN through the reconciliation resolution events, which are
   * fireable ONLY with this resolution (enforced by the attempt ledger).
   */
  resolveCase(input: ResolveCaseInput): SettlementReconciliationResolution {
    if (input === null || typeof input !== "object") {
      throw new ValidationError("resolve-case input must be an object");
    }
    const existing = this.#cases.get(input.caseId);
    if (existing === undefined) {
      throw new ReconciliationCaseError(`unknown reconciliation case: ${input.caseId}`);
    }
    if (existing.status !== "OPEN") {
      throw new ReconciliationCaseError(
        `reconciliation case '${input.caseId}' is already RESOLVED — resolutions are immutable (INV-E05)`,
        { caseId: input.caseId },
      );
    }
    if (input.resolvedBy === null || typeof input.resolvedBy !== "object") {
      throw new ValidationError("resolve-case input must name the resolving principal");
    }
    if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length === 0) {
      throw new ValidationError(
        "INV-E02/INV-X03: a reconciliation resolution requires evidence linked to the ambiguous effect",
      );
    }
    for (const id of input.evidenceIds) {
      if (typeof id !== "string" || id.length === 0) {
        throw new ValidationError("evidence ids must be non-empty strings");
      }
    }
    if (
      input.note !== undefined &&
      (typeof input.note !== "string" || input.note.length === 0)
    ) {
      throw new ValidationError("note must be a non-empty string when present");
    }

    if (existing.subject.kind === "SETTLEMENT_ATTEMPT") {
      if (input.outcome !== "CONFIRMED_SUCCEEDED" && input.outcome !== "CONFIRMED_FAILED") {
        throw new ReconciliationCaseError(
          "an ambiguous settlement attempt resolves to CONFIRMED_SUCCEEDED or CONFIRMED_FAILED only",
          { caseId: input.caseId, outcome: input.outcome },
        );
      }
      this.#ledger.resolveUnknown(existing.subject.attemptId, {
        resolvedOutcome: input.outcome,
        resolvedBy: input.resolvedBy,
        caseId: existing.caseId,
        evidenceIds: Object.freeze([...input.evidenceIds]),
      }, input.now);
    }

    const resolution: SettlementReconciliationResolution = Object.freeze({
      caseId: existing.caseId,
      outcome: input.outcome,
      resolvedBy: Object.freeze({ ...input.resolvedBy }),
      evidenceIds: Object.freeze([...input.evidenceIds]),
      resolvedAt: input.now,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    const resolved: SettlementReconciliationCase = Object.freeze({
      ...existing,
      status: "RESOLVED",
      resolution,
    });
    this.#cases.set(resolved.caseId, resolved);
    if (existing.subject.kind === "SETTLEMENT_ATTEMPT") {
      this.#openByAttempt.delete(existing.subject.attemptId);
    }
    return resolution;
  }

  /** One case by id. */
  case(caseId: string): SettlementReconciliationCase | undefined {
    return this.#cases.get(caseId);
  }

  /** The OPEN case for an ambiguous attempt, when one exists. */
  openCaseForAttempt(attemptId: SettlementAttemptId): SettlementReconciliationCase | undefined {
    const caseId = this.#openByAttempt.get(attemptId);
    return caseId === undefined ? undefined : this.#cases.get(caseId);
  }

  /** All cases tied to one instruction (finality completeness gate). */
  casesForInstruction(instructionId: string): readonly SettlementReconciliationCase[] {
    return [...this.#cases.values()].filter(
      (record) => record.instructionRef === instructionId,
    );
  }

  /** OPEN cases tied to one instruction — these block finality (INV-X03). */
  openCasesForInstruction(instructionId: string): readonly SettlementReconciliationCase[] {
    return this.casesForInstruction(instructionId).filter((record) => record.status === "OPEN");
  }

  /** All cases, in opening order (audit view). */
  allCases(): readonly SettlementReconciliationCase[] {
    return [...this.#cases.values()];
  }
}

// ---------------------------------------------------------------------------
// Provider revision reconciliation (INV-C06 — append, never overwrite)
// ---------------------------------------------------------------------------

/** One immutable provider-revision entry in canonical history. */
export interface ProviderRevisionEntry {
  readonly providerName: string;
  readonly objectType: string;
  readonly externalId: string;
  readonly revision: string;
  readonly envelope: ProviderStateEnvelope;
  readonly observedAt: TimestampMs;
}

/** INV-C06 violation: an attempt to overwrite canonical provider history. */
export class ProviderRevisionConflictError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = "ProviderRevisionConflictError";
  }
}

/**
 * The append-only provider revision ledger (INV-C06). Provider state
 * envelopes arrive as revisions; every observation is APPENDED to the
 * per-object canonical history in arrival order. Re-recording the same
 * (provider, object, revision) with byte-identical content is an idempotent
 * replay; any content difference is REJECTED — canonical history is never
 * overwritten, and reconciliation reads the history rather than rewriting it.
 */
export class ProviderRevisionLedger {
  readonly #entries: ProviderRevisionEntry[] = [];
  readonly #byKey = new Map<string, ProviderRevisionEntry>();
  readonly #byObject = new Map<string, ProviderRevisionEntry[]>();

  /** Append one observed revision to canonical history. */
  append(envelope: ProviderStateEnvelope, now: TimestampMs): ProviderRevisionEntry {
    if (envelope === null || typeof envelope !== "object") {
      throw new ValidationError("a ProviderStateEnvelope is required");
    }
    if (typeof now !== "bigint") {
      throw new ValidationError("now must be a bigint TimestampMs");
    }
    const providerName = envelope.provider.name;
    const objectType = envelope.object.objectType;
    const externalId = envelope.object.externalId;
    const revision = envelope.revision;
    if (
      typeof providerName !== "string" || providerName.length === 0 ||
      typeof objectType !== "string" || objectType.length === 0 ||
      typeof externalId !== "string" || externalId.length === 0 ||
      typeof revision !== "string" || revision.length === 0
    ) {
      throw new ValidationError("the envelope must carry provider, object and revision identities");
    }
    const key = `${providerName}|${objectType}|${externalId}|${revision}`;
    const entry: ProviderRevisionEntry = Object.freeze({
      providerName,
      objectType,
      externalId,
      revision,
      envelope: Object.freeze(envelope),
      observedAt: now,
    });
    const existing = this.#byKey.get(key);
    if (existing !== undefined) {
      if (JSON.stringify(existing.envelope) !== JSON.stringify(envelope)) {
        // INV-C06: canonical history is append-only — a divergent re-record
        // of the same revision is an overwrite attempt, never absorbed.
        throw new ProviderRevisionConflictError(
          `INV-C06: revision '${revision}' of ${providerName}/${objectType}/${externalId} is already recorded in canonical history and cannot be overwritten`,
          { providerName, objectType, externalId, revision },
        );
      }
      return existing; // idempotent re-observation of the identical revision
    }
    this.#byKey.set(key, entry);
    this.#entries.push(entry);
    const objectKey = `${providerName}|${objectType}|${externalId}`;
    const list = this.#byObject.get(objectKey) ?? [];
    list.push(entry);
    this.#byObject.set(objectKey, list);
    return entry;
  }

  /** Canonical history of one provider object, in append order (never rewritten). */
  history(providerName: string, objectType: string, externalId: string): readonly ProviderRevisionEntry[] {
    return [...(this.#byObject.get(`${providerName}|${objectType}|${externalId}`) ?? [])];
  }

  /** The latest appended revision of one provider object, if observed. */
  latest(providerName: string, objectType: string, externalId: string): ProviderRevisionEntry | undefined {
    const list = this.#byObject.get(`${providerName}|${objectType}|${externalId}`);
    return list === undefined || list.length === 0 ? undefined : list[list.length - 1];
  }

  /** All entries in append order (audit view). */
  allEntries(): readonly ProviderRevisionEntry[] {
    return [...this.#entries];
  }
}

// ---------------------------------------------------------------------------
// External funds observation reconciliation (INV-C09)
// ---------------------------------------------------------------------------

export type ExternalFundsReconciliationOutcome = "MATCHED" | "DISCREPANCY" | "STALE_NOT_USABLE";

/**
 * The reconciliation result of an external funds observation. STRUCTURALLY
 * NOT A BOOKING (INV-C09): the type carries NO monetary amount and NO
 * balance-shaped field — it cannot represent, create or update PaySwap
 * custody. `custodyBooking` is the literal 'NONE' so every reader observes
 * the invariant explicitly.
 */
export interface ExternalFundsReconciliationResult {
  readonly outcome: ExternalFundsReconciliationOutcome;
  readonly observationId: string;
  readonly referenceTime: string;
  readonly fresh: boolean;
  readonly provenanceVerified: boolean;
  /** INV-C09: this result books nothing. The literal makes it observable. */
  readonly custodyBooking: "NONE";
}

export interface ReconcileExternalFundsInput {
  readonly observation: ExternalFundsPositionObservation;
  /** Expected observed position, minor units as exact decimal string. */
  readonly expectedMinorUnits: string;
  /** Reference time for the freshness check (deterministic — no ambient clock). */
  readonly referenceTime: string;
  /** When provided, provenance must name this provider (mismatch → not verified). */
  readonly expectedProviderName?: string;
}

/**
 * Reconcile one external funds position observation against the expected
 * position, with MANDATORY freshness + provenance checks (INV-C09):
 *
 * - the observation is validated with the canonical connectors validator
 *   (freshness and provenance are mandatory — an observation without them is
 *   not evidence of anything and throws);
 * - a STALE observation (per its own maxAgeSeconds window at the reference
 *   time) yields STALE_NOT_USABLE — it can never reconcile and never create a
 *   false balance;
 * - a fresh observation matches or discrepancies on the exact minor units;
 * - the result is never a custody booking: the external position remains an
 *   observation of external state.
 */
export function reconcileExternalFundsObservation(
  input: ReconcileExternalFundsInput,
): ExternalFundsReconciliationResult {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("reconcile input must be a ReconcileExternalFundsInput object");
  }
  // Canonical validation: freshness + provenance mandatory (INV-C09).
  const observation = validateExternalFundsPositionObservation(input.observation);
  if (typeof input.expectedMinorUnits !== "string" || input.expectedMinorUnits.length === 0) {
    throw new ValidationError("expectedMinorUnits must be a non-empty exact decimal string");
  }
  if (typeof input.referenceTime !== "string" || input.referenceTime.length === 0) {
    throw new ValidationError("referenceTime must be a non-empty timestamp string");
  }
  const fresh = isFreshAt(observation, input.referenceTime);
  let provenanceVerified =
    observation.provenance.providerName === observation.location.providerName;
  if (input.expectedProviderName !== undefined) {
    provenanceVerified =
      provenanceVerified && observation.provenance.providerName === input.expectedProviderName;
  }
  if (!fresh) {
    return Object.freeze({
      outcome: "STALE_NOT_USABLE",
      observationId: observation.observationId,
      referenceTime: input.referenceTime,
      fresh: false,
      provenanceVerified,
      custodyBooking: "NONE",
    });
  }
  const observed = observation.observedAmount.minorUnits;
  const matches =
    /^\d+$/.test(observed) &&
    /^\d+$/.test(input.expectedMinorUnits) &&
    observed === input.expectedMinorUnits;
  return Object.freeze({
    outcome: matches ? "MATCHED" : "DISCREPANCY",
    observationId: observation.observationId,
    referenceTime: input.referenceTime,
    fresh: true,
    provenanceVerified,
    custodyBooking: "NONE",
  });
}

/** Structural guard: is the candidate an external funds observation (INV-C09)? */
export function isExternalFundsObservationCandidate(value: unknown): boolean {
  return isExternalFundsPositionObservation(value);
}

// ---------------------------------------------------------------------------
// Recurring mandate renewal reconciliation (PAYMENT-OPERATING-PLANE)
// ---------------------------------------------------------------------------

/** The deterministic outcome of reconciling a recurring mandate renewal. */
export interface MandateRenewalReconciliation {
  readonly outcome: "RENEWAL_AUTHORIZED" | "AUTHORITY_EXPANSION";
  /** Every expansion dimension found — empty when the renewal is authorized. */
  readonly reasons: readonly string[];
  readonly renewedMandateId: string;
  readonly previousMandateId: string;
}

/**
 * Reconcile a recurring mandate renewal: "no recurring renewal may silently
 * expand authority" (PAYMENT-OPERATING-PLANE). The renewal is authorized only
 * when the renewed mandate does not expand ANY authority dimension relative
 * to the previous mandate: payer, payee, scope and method unchanged; the
 * per-charge maximum and the charge ceiling are NOT raised; and the renewal
 * covers a clean successor period rather than extending the previous
 * validity window. Renewal from EXPIRED is a NEW mandate with fresh
 * authorization (the payment plane enforces this); reconciliation verifies
 * the authority envelope never grew. An expansion is REPORTED, never silently
 * absorbed — the caller must record a DISCREPANCY_RECORDED resolution on the
 * renewal's case.
 */
export function reconcileMandateRenewal(input: {
  readonly renewed: RecurringMandate;
  readonly previous: RecurringMandate;
}): MandateRenewalReconciliation {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("reconcile input must carry renewed and previous mandates");
  }
  const { renewed, previous } = input;
  if (renewed === null || typeof renewed !== "object") {
    throw new ValidationError("renewed must be a RecurringMandate");
  }
  if (previous === null || typeof previous !== "object") {
    throw new ValidationError("previous must be a RecurringMandate");
  }
  const reasons: string[] = [];
  if (renewed.payer !== previous.payer) reasons.push("PAYER_CHANGED");
  if (renewed.payee !== previous.payee) reasons.push("PAYEE_CHANGED");
  if (renewed.method !== previous.method) reasons.push("METHOD_CHANGED");
  if (renewed.scope !== previous.scope) reasons.push("SCOPE_BROADENED");
  if (renewed.maxAmountPerCharge.currency !== previous.maxAmountPerCharge.currency) {
    reasons.push("CHARGE_CURRENCY_CHANGED");
  } else if (renewed.maxAmountPerCharge.value > previous.maxAmountPerCharge.value) {
    reasons.push("CHARGE_MAXIMUM_RAISED");
  }
  if (
    previous.schedule.maxCharges > 0n &&
    renewed.schedule.maxCharges > previous.schedule.maxCharges
  ) {
    reasons.push("CHARGE_CEILING_RAISED");
  }
  // A clean successor period (validFrom at/after the previous expiry) is a
  // legitimate renewal; a renewal that OVERLAPS the previous validity while
  // ending later extends the total authority window.
  if (renewed.validFrom < previous.expiresAt && renewed.expiresAt > previous.expiresAt) {
    reasons.push("VALIDITY_EXTENDED");
  }
  return Object.freeze({
    outcome: reasons.length === 0 ? "RENEWAL_AUTHORIZED" : "AUTHORITY_EXPANSION",
    reasons: Object.freeze(reasons),
    renewedMandateId: renewed.id,
    previousMandateId: previous.id,
  });
}

// ---------------------------------------------------------------------------
// Off-network record reconciliation (PAYMENT-OPERATING-PLANE)
// ---------------------------------------------------------------------------

/** The deterministic outcome of reconciling an off-network payment record. */
export interface OffNetworkRecordReconciliation {
  readonly outcome: "MATCHED" | "DISCREPANCY";
  readonly reasons: readonly string[];
  readonly recordId: string;
  /** PAYMENT-OPERATING-PLANE: an off-network record NEVER implies PaySwap execution. */
  readonly orchestratedBy: "EXTERNAL_PARTY";
  readonly payswapExecuted: false;
}

/**
 * Reconcile an off-network check/cash/external-payment record against the
 * expected external movement. The record must carry evidence, match the
 * expected amount and external reference, and — structurally — it can never
 * be counted as a PaySwap-executed settlement: `isPaySwapExecutedSettlement`
 * (payment plane type guard) is applied and reported as `false`.
 */
export function reconcileOffNetworkRecord(input: {
  readonly record: OffNetworkPaymentRecord;
  readonly expected: {
    readonly currency: string;
    readonly minorUnits: string;
    readonly externalRef: string;
  };
}): OffNetworkRecordReconciliation {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("reconcile input must carry record and expected movement");
  }
  const record = input.record;
  if (record === null || typeof record !== "object") {
    throw new ValidationError("record must be an OffNetworkPaymentRecord");
  }
  const expected = input.expected;
  if (expected === null || typeof expected !== "object") {
    throw new ValidationError("expected must describe the expected external movement");
  }
  const reasons: string[] = [];
  if (record.evidence.length === 0) reasons.push("NO_EVIDENCE");
  if (record.amount.currency !== expected.currency) reasons.push("CURRENCY_MISMATCH");
  if (record.amount.value.toString() !== expected.minorUnits) reasons.push("AMOUNT_MISMATCH");
  if (record.externalRef !== expected.externalRef) reasons.push("EXTERNAL_REF_MISMATCH");
  // PAYMENT-OPERATING-PLANE: an off-network record can NEVER be counted as a
  // PaySwap-executed settlement — the payment-plane type guard is applied and
  // a (structurally impossible) positive result fails closed.
  if (isPaySwapExecutedSettlement(record)) {
    throw new ValidationError(
      "invariant violation: an off-network record was presented as a PaySwap-executed settlement",
    );
  }
  return Object.freeze({
    outcome: reasons.length === 0 ? "MATCHED" : "DISCREPANCY",
    reasons: Object.freeze(reasons),
    recordId: record.id,
    orchestratedBy: record.orchestratedBy,
    payswapExecuted: false,
  });
}
