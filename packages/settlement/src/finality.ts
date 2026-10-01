/**
 * @payswap/settlement — protocol-owned finality (W1-004).
 *
 * INV-F06: no financial mutation bypasses the Financial Protocol Authority —
 * finality is PROTOCOL-OWNED. No component outside the protocol authority can
 * declare financial finality. Concretely, on the settlement plane:
 *
 * - a `FinalityRecord` is constructible ONLY through `FinalityAuthority`
 *   (the record type carries no public constructor);
 * - `declareFinality` requires a PROTOCOL-AUTHORIZED instruction: the
 *   candidate must be exactly one of the settlement instructions the
 *   protocol itself derives from the netting set + obligations
 *   (`verifyProtocolAuthorization` re-derives them with the protocol's own
 *   `netPositions`/`settlementInstructions` and compares canonical content);
 *   a hand-minted or tampered instruction cannot reach finality — and since a
 *   settlement certificate requires a FINAL record, certificates only issue
 *   from protocol-authorized instructions;
 * - the instruction must be FULLY RECONCILED: no attempt may remain
 *   OUTCOME_UNKNOWN and no reconciliation case may remain OPEN (INV-X03), and
 *   at least one attempt must have definitively SUCCEEDED (value moved);
 * - the policy-required proof level must be satisfied by the presented
 *   evidence chain (INV-E03 — low-proof paths cannot finalize high-risk
 *   settlements).
 *
 * INV-X04: terminal transitions are monotonic except EXPLICIT recovery. FINAL
 * is terminal; the only declared exit is the `REVERSE` recovery rule, which
 * is legal ONLY with a compensating-obligation reference — disputes never
 * edit the original transaction, they create separate adjudication and
 * adjustment obligations (SECURITY-EVIDENCE-RECOURSE "Recourse"). The
 * historical FINAL declaration stays in the record's append-only history.
 */

import {
  ValidationError,
  canonicalNetPosition,
  defineStateMachine,
  equals,
  netPositions,
  settlementInstructions,
} from "@payswap/protocol";
import type {
  Money,
  NettingSet,
  Obligation,
  PaySwapErrorDetails,
  SettlementInstruction as ProtocolSettlementInstruction,
  SettlementInstructionId,
  StateMachine,
  TimestampMs,
  TransitionRecord,
} from "@payswap/protocol";
import { proofSatisfaction } from "./proof-policies.js";
import type { ProofContext, ProofPolicy } from "./proof-policies.js";
import type { EvidenceNode } from "./evidence-graph.js";
import type { SettlementInstruction } from "./instructions.js";
import type { SettlementReconciliationAuthority } from "./reconciliation.js";
import { SettlementAttemptLedger } from "./instructions.js";

// ---------------------------------------------------------------------------
// The finality state machine (INV-X04)
// ---------------------------------------------------------------------------

export type FinalityState = "PROVISIONAL" | "FINAL" | "REVERSED";

export type FinalityEvent = "FINALIZE" | "REVERSE";

/**
 * The canonical finality lifecycle. FINAL and REVERSED are terminal and
 * monotonic; the ONLY exit from FINAL is the declared REVERSE recovery rule
 * (INV-X04) — and it requires a compensating obligation (disputes create
 * separate adjustment obligations, never rewrites).
 */
export const finalityStateMachine: StateMachine<FinalityState, FinalityEvent, unknown> =
  defineStateMachine<FinalityState, FinalityEvent, unknown>({
    name: "settlement-finality",
    initial: "PROVISIONAL",
    states: ["PROVISIONAL", "FINAL", "REVERSED"],
    events: ["FINALIZE", "REVERSE"],
    transitions: [
      {
        from: "PROVISIONAL",
        on: "FINALIZE",
        to: "FINAL",
        description: "finality is declarable only by the protocol-owning authority",
      },
    ],
    terminalStates: ["FINAL", "REVERSED"],
    recovery: [
      {
        from: "FINAL",
        on: "REVERSE",
        to: "REVERSED",
        description:
          "explicit recovery only: reversal references a compensating obligation; history is never rewritten",
      },
    ],
  });

/** One recorded finality transition (history is append-only). */
export interface FinalityTransitionRecord extends TransitionRecord<FinalityState, FinalityEvent> {
  readonly recordedAt: TimestampMs;
}

// ---------------------------------------------------------------------------
// Protocol authorization (INV-F06)
// ---------------------------------------------------------------------------

/**
 * The proof that an instruction is protocol-authorized: the netting set and
 * the PENDING obligations the protocol derived the instruction from. The
 * verifier re-derives the protocol settlement instructions from these inputs
 * with the protocol's own functions — the candidate must be one of them.
 */
export interface ProtocolAuthorizationProof {
  readonly nettingSet: NettingSet;
  readonly obligations: readonly Obligation[];
}

/** The deterministic result of a protocol-authorization verification. */
export interface ProtocolAuthorizationVerification {
  readonly authorized: boolean;
  /** The protocol-derived instruction the candidate matched, when authorized. */
  readonly matchedInstruction?: ProtocolSettlementInstruction;
  readonly reasons: readonly string[];
}

/**
 * INV-F06 verification: re-derive the protocol settlement instructions from
 * the netting set + obligations (the protocol's own `netPositions` +
 * `settlementInstructions`) and check that the candidate is exactly one of
 * them — same set, same parties, same exact amount and the byte-identical
 * canonical net position (INV-F07 derivation intact). Anything else — a
 * hand-minted instruction or a tampered amount — is NOT protocol-authorized
 * and can never reach finality.
 *
 * Invalid proof inputs (unknown members, non-PENDING obligations…) propagate
 * the protocol's typed errors: verification fails closed.
 */
export function verifyProtocolAuthorization(
  candidate: ProtocolSettlementInstruction,
  proof: ProtocolAuthorizationProof,
): ProtocolAuthorizationVerification {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("candidate must be a protocol SettlementInstruction");
  }
  if (proof === null || typeof proof !== "object") {
    throw new ValidationError("proof must be a ProtocolAuthorizationProof");
  }
  const positions = netPositions(proof.nettingSet, proof.obligations);
  const derived = settlementInstructions(positions);
  for (const instruction of derived) {
    const sameParties =
      instruction.setId === candidate.setId &&
      instruction.debtor === candidate.debtor &&
      instruction.creditor === candidate.creditor;
    const sameAmount = equals(instruction.amount, candidate.amount);
    const sameDerivation =
      canonicalNetPosition(instruction.fromNetPosition) ===
      canonicalNetPosition(candidate.fromNetPosition);
    if (sameParties && sameAmount && sameDerivation) {
      return Object.freeze({
        authorized: true,
        matchedInstruction: instruction,
        reasons: Object.freeze(["PROTOCOL_DERIVATION_MATCHED"]),
      });
    }
  }
  return Object.freeze({
    authorized: false,
    reasons: Object.freeze([
      "NO_PROTOCOL_DERIVATION_MATCHED",
      `derived:${derived.length}`,
    ]),
  });
}

// ---------------------------------------------------------------------------
// The finality record
// ---------------------------------------------------------------------------

/** INV-F06 violation: the instruction is not protocol-authorized. */
export class FinalityNotProtocolAuthorizedError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = "FinalityNotProtocolAuthorizedError";
  }
}

/** Finality preconditions (reconciliation completeness) unmet. */
export class FinalityPreconditionsUnmetError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = "FinalityPreconditionsUnmetError";
  }
}

/** INV-E03 violation: the policy-required proof level was not presented. */
export class FinalityInsufficientProofError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = "FinalityInsufficientProofError";
  }
}

/** Finality record id conflicts are never reused. */
export class FinalityRecordConflictError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = "FinalityRecordConflictError";
  }
}

/**
 * The immutable finality record. Constructible ONLY through
 * `FinalityAuthority` (INV-F06) — there is no exported constructor and the
 * authority is the single component that verifies protocol authorization,
 * reconciliation completeness and proof satisfaction before FINALIZE.
 */
export interface FinalityRecord {
  readonly finalityId: string;
  readonly instructionId: SettlementInstructionId;
  readonly amount: Money;
  readonly state: FinalityState;
  /** The proof levels measured at declaration (INV-E03 evidence). */
  readonly proof: { readonly required: string; readonly achieved: string };
  /** Reconciliation cases resolved for this instruction (INV-X03 evidence). */
  readonly reconciliationRefs: readonly string[];
  readonly declaredAt?: TimestampMs;
  readonly reversedAt?: TimestampMs;
  /** REQUIRED when REVERSED — the compensating obligation (INV-X04 recovery). */
  readonly compensatingObligationRef?: string;
  readonly history: readonly FinalityTransitionRecord[];
}

// ---------------------------------------------------------------------------
// The authority
// ---------------------------------------------------------------------------

export interface DeclareFinalityInput {
  readonly finalityId: string;
  readonly instruction: SettlementInstruction;
  readonly authorization: ProtocolAuthorizationProof;
  readonly policy: ProofPolicy;
  readonly proofContext: ProofContext;
  readonly evidence: readonly EvidenceNode[];
  readonly now: TimestampMs;
}

/**
 * The settlement-plane finality authority. FINALITY IS PROTOCOL-OWNED
 * (INV-F06): every declaration re-verifies that the instruction is exactly a
 * protocol-derived settlement instruction, that the instruction is fully
 * reconciled (INV-X03) and that the policy-required proof is satisfied
 * (INV-E03). Nothing outside this authority can mint a `FinalityRecord`.
 */
export class FinalityAuthority {
  readonly #ledger: SettlementAttemptLedger;
  readonly #reconciliation: SettlementReconciliationAuthority;
  readonly #records = new Map<string, FinalityRecord>();
  readonly #finalityByInstruction = new Map<SettlementInstructionId, string>();

  constructor(ledger: SettlementAttemptLedger, reconciliation: SettlementReconciliationAuthority) {
    this.#ledger = ledger;
    this.#reconciliation = reconciliation;
  }

  /**
   * Declare financial finality for one settlement instruction. Checks, in
   * order (all typed, all fail-closed):
   *
   * 1. INV-F06 — the instruction is protocol-authorized (re-derived from the
   *    netting set + obligations with the protocol's own functions);
   * 2. INV-X03 — the instruction is fully reconciled: no OUTCOME_UNKNOWN
   *    attempt remains, no reconciliation case is OPEN, and at least one
   *    attempt definitively SUCCEEDED;
   * 3. INV-E03 — the presented evidence chain meets the policy-required
   *    proof level for the instruction's risk context (with INV-E04 caps).
   *
   * Refund/dispute symmetry: the same authority finalizes reverse-pathway
   * instructions (the proof context carries the direction; the required level
   * is symmetric by construction).
   */
  declareFinality(input: DeclareFinalityInput): FinalityRecord {
    if (input === null || typeof input !== "object") {
      throw new ValidationError("declare-finality input must be an object");
    }
    if (typeof input.finalityId !== "string" || input.finalityId.length === 0) {
      throw new ValidationError("finalityId must be a non-empty string");
    }
    if (this.#records.has(input.finalityId)) {
      throw new FinalityRecordConflictError(
        `finality record '${input.finalityId}' already exists — ids are never reused`,
        { finalityId: input.finalityId },
      );
    }
    const existingForInstruction = this.#finalityByInstruction.get(input.instruction.id);
    if (existingForInstruction !== undefined) {
      throw new FinalityRecordConflictError(
        `instruction '${input.instruction.id}' already has finality record '${existingForInstruction}' — finality is declared once per instruction; adjustments are new obligations`,
        { finalityId: input.finalityId, instructionId: input.instruction.id },
      );
    }
    if (input.instruction === null || typeof input.instruction !== "object") {
      throw new ValidationError("instruction must be a SettlementInstruction");
    }
    if (typeof input.now !== "bigint") {
      throw new ValidationError("now must be a bigint TimestampMs");
    }

    // 1. INV-F06: protocol-owned finality.
    const verification = verifyProtocolAuthorization(input.instruction, input.authorization);
    if (!verification.authorized) {
      throw new FinalityNotProtocolAuthorizedError(
        "INV-F06: financial finality is protocol-owned — the instruction does not match any protocol-derived settlement instruction for the presented authorization proof",
        {
          finalityId: input.finalityId,
          instructionId: input.instruction.id,
          reasons: [...verification.reasons],
        },
      );
    }

    // 2. INV-X03: reconciliation completeness for this instruction.
    const attempts = this.#ledger.attemptsForInstruction(input.instruction.id);
    const unresolved = attempts.filter((attempt) => attempt.state === "OUTCOME_UNKNOWN");
    const openCases = this.#reconciliation.openCasesForInstruction(input.instruction.id);
    const succeeded = attempts.filter((attempt) => attempt.state === "SUCCEEDED");
    const preconditionFailures: string[] = [];
    if (unresolved.length > 0) {
      preconditionFailures.push(
        `OUTCOME_UNKNOWN_ATTEMPTS:${unresolved.map((attempt) => attempt.attemptId).join(",")}`,
      );
    }
    if (openCases.length > 0) {
      preconditionFailures.push(
        `OPEN_RECONCILIATION_CASES:${openCases.map((record) => record.caseId).join(",")}`,
      );
    }
    if (succeeded.length === 0) {
      preconditionFailures.push("NO_SUCCEEDED_ATTEMPT");
    }
    if (preconditionFailures.length > 0) {
      throw new FinalityPreconditionsUnmetError(
        "INV-X03: finality requires a fully reconciled instruction — ambiguity must be resolved through reconciliation before finality",
        { finalityId: input.finalityId, failures: preconditionFailures },
      );
    }

    // 3. INV-E03: policy-required proof.
    const satisfaction = proofSatisfaction(input.policy, input.proofContext, input.evidence);
    if (!satisfaction.satisfied) {
      throw new FinalityInsufficientProofError(
        "INV-E03: finality requires the policy-required proof — the presented evidence chain is insufficient",
        {
          finalityId: input.finalityId,
          policyId: input.policy.policyId,
          required: satisfaction.required,
          achieved: satisfaction.achieved,
          gaps: [...satisfaction.gaps],
        },
      );
    }

    // Kernel machine: PROVISIONAL --FINALIZE--> FINAL (INV-X04 discipline).
    const transition = finalityStateMachine.transition("PROVISIONAL", "FINALIZE");
    const record: FinalityRecord = Object.freeze({
      finalityId: input.finalityId,
      instructionId: input.instruction.id,
      amount: input.instruction.amount,
      state: transition.to,
      proof: Object.freeze({
        required: satisfaction.required,
        achieved: satisfaction.achieved,
      }),
      reconciliationRefs: Object.freeze(
        this.#reconciliation
          .casesForInstruction(input.instruction.id)
          .map((recordCase) => recordCase.caseId),
      ),
      declaredAt: input.now,
      history: Object.freeze([
        Object.freeze({
          from: transition.from,
          on: transition.on,
          to: transition.to,
          viaRecovery: transition.viaRecovery,
          recordedAt: input.now,
        }),
      ]),
    });
    this.#records.set(record.finalityId, record);
    this.#finalityByInstruction.set(record.instructionId, record.finalityId);
    return record;
  }

  /**
   * The explicit FINAL → REVERSED recovery (INV-X04). Legal ONLY with a
   * compensating-obligation reference: disputes never edit the original
   * transaction — the reversal names the separate adjustment obligation that
   * compensates it, and the historical FINAL declaration stays in the
   * append-only history.
   */
  reverse(
    finalityId: string,
    input: {
      readonly compensatingObligationRef: string;
      readonly now: TimestampMs;
    },
  ): FinalityRecord {
    const existing = this.#records.get(finalityId);
    if (existing === undefined) {
      throw new ValidationError(`unknown finality record: ${finalityId}`);
    }
    if (input === null || typeof input !== "object") {
      throw new ValidationError("reverse input must be an object");
    }
    if (typeof input.compensatingObligationRef !== "string" || input.compensatingObligationRef.length === 0) {
      throw new ValidationError(
        "a finality reversal requires a compensating obligation reference — disputes create separate adjustment obligations, never rewrites",
      );
    }
    if (typeof input.now !== "bigint") {
      throw new ValidationError("now must be a bigint TimestampMs");
    }
    const transition = finalityStateMachine.transition(existing.state, "REVERSE");
    const record: FinalityRecord = Object.freeze({
      ...existing,
      state: transition.to,
      reversedAt: input.now,
      compensatingObligationRef: input.compensatingObligationRef,
      history: Object.freeze([
        ...existing.history,
        Object.freeze({
          from: transition.from,
          on: transition.on,
          to: transition.to,
          viaRecovery: transition.viaRecovery,
          recordedAt: input.now,
        }),
      ]),
    });
    this.#records.set(finalityId, record);
    return record;
  }

  /** One finality record by id (frozen, immutable). */
  record(finalityId: string): FinalityRecord | undefined {
    return this.#records.get(finalityId);
  }

  /** All records, in declaration order (audit view). */
  allRecords(): readonly FinalityRecord[] {
    return [...this.#records.values()];
  }
}
