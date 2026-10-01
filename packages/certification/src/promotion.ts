/**
 * Production promotion and rollback artifacts (W2-006; FROZEN-ARCHITECTURE
 * §19; LAB.md "Promotion"; INV-L03, INV-L04, INV-C03; AGENTS.md rules 8/14).
 *
 * This ledger owns the PRODUCTION promotion/rollback ARTIFACTS on top of the
 * Lab's versioned promotion: a production promotion order is a versioned,
 * content-digested artifact that references (i) the immutable published
 * candidate version, (ii) the Lab promotion order that advanced the
 * candidate to PRODUCTION, (iii) a PASSED certification suite evaluation,
 * (iv) a PASSED uniform gate wall result and (v) a PASSED security review.
 *
 * SECURITY FAILURES HALT PROMOTION IRREVERSIBLY: an order whose security
 * review failed can never be completed, re-submitted or resumed — the halt
 * is recorded and only a NEW order carrying a verified remediation package
 * can ever promote the subject again (./security-gates.js).
 *
 * Rollback APPENDS a reversal record; history is never deleted (INV-L03).
 * Evaluation history is append-only and immutable (INV-L04 discipline).
 * Retirement appends a going-forward record and preserves in-flight history
 * (INV-C03 discipline).
 *
 * BOUNDARY DESIGN — structural consumption: the Lab's promotion order and
 * candidate shapes are consumed through structural view interfaces (the
 * concrete artifacts are assignable to them); the promotion vocabulary
 * (stages, order kinds, evidence refs) is owned by the Lab package and only
 * VALIDATED here, never redefined.
 *
 * INV-G03 discipline: a production promotion ORDER is an artifact. Applying
 * it to production traffic is a protocol-authority operation outside this
 * ledger; nothing here mutates financial state.
 *
 * Deterministic only: order ids are caller-declared, digests are content
 * addresses over the order content, timestamps are caller-declared strings.
 */

import { contentDigest } from "./digest.js";
import type { SuiteEvaluationResult, SuiteSubjectRef } from "./suites.js";
import type {
  RemediationPackage,
  SecurityGateFailure,
  SecurityReviewOutcome,
  StructuralImmuneState,
} from "./security-gates.js";
import { verifyRemediationPackage } from "./security-gates.js";
import type { UniformGateWallResult } from "./uniform-gates.js";

// ---------------------------------------------------------------------------
// Structural views of the Lab promotion machinery
// ---------------------------------------------------------------------------

/** Structural view of one Lab evidence reference. */
export interface StructuralLabEvidenceRef {
  readonly evidenceId: string;
  readonly kind: string;
  readonly artifactRef: string;
  readonly contentDigest: string;
}

/**
 * Structural view of the Lab's versioned promotion order. The concrete
 * promotion order (ADVANCE/ROLLBACK/RETIRE over the DRAFT…RETIRED stage
 * machine, with candidateVersion + content digests) is assignable to this
 * view; the stage/order vocabulary is validated at runtime, never redefined.
 */
export interface StructuralLabPromotionOrder {
  readonly orderId: string;
  readonly orderKind: string;
  readonly candidateId: string;
  readonly candidateVersion: number;
  readonly fromStage: string;
  readonly toStage: string;
  readonly evidence: readonly StructuralLabEvidenceRef[];
  readonly orderedAt: string;
  readonly orderDigest: string;
}

// ---------------------------------------------------------------------------
// Production artifacts
// ---------------------------------------------------------------------------

/** The production lifecycle stage of one subject. */
export const PRODUCTION_STAGES = [
  "NOT_IN_PRODUCTION",
  "PRODUCTION",
  "ROLLED_BACK",
  "RETIRED",
] as const;
export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

/** A versioned production PROMOTION order (immutable artifact). */
export interface ProductionPromotionOrder {
  readonly productionOrderId: string;
  readonly orderKind: "PROMOTE";
  readonly subject: SuiteSubjectRef;
  /** Version of the immutable published subject snapshot this order promotes. */
  readonly subjectVersion: number;
  readonly labOrder: StructuralLabPromotionOrder;
  readonly suiteEvaluation: SuiteEvaluationResult;
  readonly uniformGate: UniformGateWallResult;
  readonly securityReview: SecurityReviewOutcome;
  /** Remediation presented with this order, when a prior halt existed. */
  readonly remediation?: RemediationPackage;
  readonly orderedAt: string;
  readonly orderDigest: string;
}

/**
 * A versioned production ROLLBACK order: the reversal RECORD of a specific
 * promotion order. Appended — the reversed order stays in history forever
 * (INV-L03: promotion is reversible; history is never deleted).
 */
export interface ProductionRollbackOrder {
  readonly productionOrderId: string;
  readonly orderKind: "ROLLBACK";
  /** The versioned PROMOTE order this reversal record reverses. */
  readonly reversesOrderId: string;
  readonly subject: SuiteSubjectRef;
  readonly subjectVersion: number;
  readonly reason: string;
  readonly orderedAt: string;
  readonly orderDigest: string;
}

/**
 * A going-forward production retirement record (INV-C03 discipline):
 * retirement marks the subject unavailable going forward; every prior
 * artifact and evaluation entry is preserved untouched.
 */
export interface ProductionRetirementOrder {
  readonly productionOrderId: string;
  readonly orderKind: "RETIRE";
  readonly subject: SuiteSubjectRef;
  readonly subjectVersion: number;
  readonly reason: string;
  readonly orderedAt: string;
  readonly orderDigest: string;
}

/** Any production artifact, discriminated by order kind. */
export type ProductionArtifact =
  | ProductionPromotionOrder
  | ProductionRollbackOrder
  | ProductionRetirementOrder;

/** An irreversible security halt over one attempted order. */
export interface SecurityHaltRecord {
  readonly haltId: string;
  readonly attemptedOrderId: string;
  readonly subject: SuiteSubjectRef;
  readonly securityFailures: readonly SecurityGateFailure[];
  readonly haltedAt: string;
}

/** An immutable evaluation-history entry (INV-L04 discipline). */
export interface EvaluationHistoryEntry {
  readonly entryId: string;
  readonly subject: SuiteSubjectRef;
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly evaluationDigest: string;
  readonly recordedAt: string;
}

/** Raised for any illegal production artifact operation. */
export class ProductionPromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionPromotionError";
  }
}

/**
 * Raised when a promotion attempt is halted by a FAILED security gate. The
 * attempted order is dead: only a NEW order with a verified remediation
 * package can promote the subject again.
 */
export class SecurityHaltError extends Error {
  readonly attemptedOrderId: string;
  readonly securityFailures: readonly SecurityGateFailure[];

  constructor(
    attemptedOrderId: string,
    failures: readonly SecurityGateFailure[],
  ) {
    super(
      `SECURITY HALT: promotion order '${attemptedOrderId}' is blocked by failed security gates (${failures
        .map((failure) => failure.failure)
        .join(", ")}). The halt is irreversible: only a NEW order carrying remediation evidence can promote this subject again`,
    );
    this.name = "SecurityHaltError";
    this.attemptedOrderId = attemptedOrderId;
    this.securityFailures = failures;
  }
}

// ---------------------------------------------------------------------------
// The production promotion ledger
// ---------------------------------------------------------------------------

/**
 * The append-only production promotion ledger: versioned promotion orders,
 * rollback reversal records, retirement records, security halts and the
 * immutable evaluation history.
 */
export class ProductionPromotionLedger {
  private readonly artifacts: ProductionArtifact[] = [];
  private readonly artifactsById = new Map<string, ProductionArtifact>();
  private readonly halts: SecurityHaltRecord[] = [];
  private readonly evaluationEntries: EvaluationHistoryEntry[] = [];
  private readonly evaluationEntryIds = new Set<string>();
  private readonly stages = new Map<string, ProductionStage>();

  /** The current production stage of a subject (default NOT_IN_PRODUCTION). */
  currentProductionStage(subjectId: string): ProductionStage {
    return this.stages.get(subjectId) ?? "NOT_IN_PRODUCTION";
  }

  /** The append-only artifact history of a subject, oldest first. */
  historyFor(subjectId: string): readonly ProductionArtifact[] {
    return Object.freeze(
      this.artifacts.filter((artifact) => artifact.subject.subjectId === subjectId),
    );
  }

  /** Every artifact ever appended, in append order. Never rewritten. */
  allArtifacts(): readonly ProductionArtifact[] {
    return Object.freeze([...this.artifacts]);
  }

  /** Every security halt ever recorded, in order. Never rewritten. */
  haltedOrders(): readonly SecurityHaltRecord[] {
    return Object.freeze([...this.halts]);
  }

  /** Halts recorded for a subject that no later order has remediated. */
  unremediatedHaltsFor(subjectId: string): readonly SecurityHaltRecord[] {
    const remediatedHaltIds = new Set(
      this.artifacts
        .filter(
          (artifact): artifact is ProductionPromotionOrder =>
            artifact.orderKind === "PROMOTE" && artifact.remediation !== undefined,
        )
        .map((order) => order.remediation?.haltedOrderRef),
    );
    return this.halts.filter(
      (halt) =>
        halt.subject.subjectId === subjectId &&
        !remediatedHaltIds.has(halt.haltId),
    );
  }

  // -- evaluation history (INV-L04 discipline) -------------------------------

  /**
   * Appends an immutable evaluation-history entry. Entries can never be
   * modified, removed or re-ordered; duplicate entry ids are rejected.
   */
  recordEvaluation(input: {
    readonly entryId: string;
    readonly subject: SuiteSubjectRef;
    readonly suiteEvaluation: SuiteEvaluationResult;
    readonly recordedAt: string;
  }): EvaluationHistoryEntry {
    if (input.entryId.length === 0) {
      throw new ProductionPromotionError("entryId must not be empty");
    }
    if (input.recordedAt.length === 0) {
      throw new ProductionPromotionError("recordedAt must not be empty");
    }
    if (this.evaluationEntryIds.has(input.entryId)) {
      throw new ProductionPromotionError(
        `evaluation history entry '${input.entryId}' already exists: evaluation history is immutable (INV-L04)`,
      );
    }
    const entry: EvaluationHistoryEntry = Object.freeze({
      entryId: input.entryId,
      subject: input.subject,
      suiteId: input.suiteEvaluation.suiteId,
      suiteVersion: input.suiteEvaluation.suiteVersion,
      evaluationDigest: input.suiteEvaluation.evaluationDigest,
      recordedAt: input.recordedAt,
    });
    this.evaluationEntries.push(entry);
    this.evaluationEntryIds.add(input.entryId);
    return entry;
  }

  /** The immutable evaluation history of a subject, oldest first. */
  evaluationHistoryFor(subjectId: string): readonly EvaluationHistoryEntry[] {
    return Object.freeze(
      this.evaluationEntries.filter(
        (entry) => entry.subject.subjectId === subjectId,
      ),
    );
  }

  /** Every evaluation entry ever recorded, in append order. */
  allEvaluationEntries(): readonly EvaluationHistoryEntry[] {
    return Object.freeze([...this.evaluationEntries]);
  }

  // -- production promotion (the HALT gate lives here) -----------------------

  /**
   * Orders a versioned production promotion. Hard preconditions, in order:
   *
   * 1. SECURITY FIRST: a FAILED security review halts the order
   *    IRREVERSIBLY (SecurityHaltError) — there is no override path, and the
   *    halted order id can never be completed afterwards;
   * 2. if unremediated halts exist for the subject, the order MUST carry a
   *    remediation package (closed advisories + non-empty evidence),
   *    verified against the immune state;
   * 3. the certification suite evaluation must have PASSED;
   * 4. the uniform gate wall must have PASSED (identical for every mode);
   * 5. the Lab order must be an ADVANCE to the PRODUCTION stage referencing
   *    a published candidate version (versioned promotion — INV-L03);
   * 6. the subject version must reference an immutable published snapshot.
   *
   * On success the order is appended together with its evaluation-history
   * entry; both are immutable from then on.
   */
  orderProductionPromotion(input: {
    readonly productionOrderId: string;
    readonly subject: SuiteSubjectRef;
    readonly subjectVersion: number;
    readonly labOrder: StructuralLabPromotionOrder;
    readonly suiteEvaluation: SuiteEvaluationResult;
    readonly uniformGate: UniformGateWallResult;
    readonly securityReview: SecurityReviewOutcome;
    readonly remediation?: RemediationPackage;
    readonly immune: StructuralImmuneState;
    readonly orderedAt: string;
  }): ProductionPromotionOrder {
    if (input.productionOrderId.length === 0) {
      throw new ProductionPromotionError("productionOrderId must not be empty");
    }
    if (this.artifactsById.has(input.productionOrderId)) {
      throw new ProductionPromotionError(
        `production order '${input.productionOrderId}' already exists (append-only ledger: order ids are never reused)`,
      );
    }
    if (input.subject.subjectId.length === 0 || input.subject.version.length === 0) {
      throw new ProductionPromotionError("subject references must be complete");
    }
    if (input.orderedAt.length === 0) {
      throw new ProductionPromotionError("orderedAt must not be empty");
    }
    if (input.subjectVersion < 1) {
      throw new ProductionPromotionError(
        "subjectVersion must reference a published immutable snapshot (>= 1)",
      );
    }
    if (input.labOrder.candidateVersion < 1) {
      throw new ProductionPromotionError(
        "the Lab promotion order must reference a published candidate version (>= 1) — unversioned promotion is forbidden (INV-L03)",
      );
    }
    if (input.labOrder.orderKind !== "ADVANCE" || input.labOrder.toStage !== "PRODUCTION") {
      throw new ProductionPromotionError(
        `the Lab order '${input.labOrder.orderId}' is a ${input.labOrder.orderKind} to ${input.labOrder.toStage}; production promotion requires an ADVANCE order that reached the PRODUCTION stage`,
      );
    }
    if (input.labOrder.candidateId !== input.subject.subjectId) {
      throw new ProductionPromotionError(
        `the Lab order promotes candidate '${input.labOrder.candidateId}' but the subject is '${input.subject.subjectId}'`,
      );
    }

    // 1. SECURITY FIRST — a failed gate halts the order irreversibly.
    if (!input.securityReview.passed) {
      const halt: SecurityHaltRecord = Object.freeze({
        haltId: `halt:${input.productionOrderId}`,
        attemptedOrderId: input.productionOrderId,
        subject: input.subject,
        securityFailures: input.securityReview.failures,
        haltedAt: input.orderedAt,
      });
      this.halts.push(halt);
      throw new SecurityHaltError(
        input.productionOrderId,
        input.securityReview.failures,
      );
    }

    // 2. Unremediated halts demand remediation evidence on THIS new order.
    const unremediated = this.unremediatedHaltsFor(input.subject.subjectId);
    if (unremediated.length > 0) {
      if (input.remediation === undefined) {
        throw new ProductionPromotionError(
          `subject '${input.subject.subjectId}' has ${unremediated.length} unremediated security halt(s) (${unremediated
            .map((halt) => halt.haltId)
            .join(", ")}): promotion is blocked until a NEW order carries remediation evidence`,
        );
      }
      const violations = verifyRemediationPackage({
        remediation: input.remediation,
        immune: input.immune,
      });
      if (violations.length > 0) {
        throw new ProductionPromotionError(
          `remediation package rejected: ${violations.join("; ")}`,
        );
      }
      const referencesHalt = unremediated.some(
        (halt) => halt.haltId === input.remediation?.haltedOrderRef,
      );
      if (!referencesHalt) {
        throw new ProductionPromotionError(
          `the remediation package must reference one of the unremediated halts (${unremediated
            .map((halt) => halt.haltId)
            .join(", ")})`,
        );
      }
    } else if (input.remediation !== undefined) {
      // Remediation without a halt is still verified: closed advisories and
      // complete evidence are mandatory whenever a package is presented.
      const violations = verifyRemediationPackage({
        remediation: input.remediation,
        immune: input.immune,
      });
      if (violations.length > 0) {
        throw new ProductionPromotionError(
          `remediation package rejected: ${violations.join("; ")}`,
        );
      }
    }

    // 3. The certification suite must have passed.
    if (!input.suiteEvaluation.passed) {
      throw new ProductionPromotionError(
        `the certification suite evaluation for '${input.subject.subjectId}' did not pass (failed gates: ${input.suiteEvaluation.failedGates.join(", ")}; missing evidence: ${input.suiteEvaluation.missingEvidenceKinds.join(", ")})`,
      );
    }
    if (input.suiteEvaluation.subject.subjectId !== input.subject.subjectId) {
      throw new ProductionPromotionError(
        "the suite evaluation must be for the promoted subject",
      );
    }

    // 4. The uniform gate wall must have passed — for every mode.
    if (!input.uniformGate.passed) {
      throw new ProductionPromotionError(
        `the uniform gate wall rejected candidate '${input.uniformGate.candidateId}': no execution mode can bypass the authorization/compliance/evidence gates (INV-C07)`,
      );
    }
    if (input.uniformGate.candidateId !== input.subject.subjectId) {
      throw new ProductionPromotionError(
        "the uniform gate wall result must be for the promoted candidate",
      );
    }

    // 5. Stage sanity: the subject must not already be in production.
    const stage = this.currentProductionStage(input.subject.subjectId);
    if (stage === "PRODUCTION") {
      throw new ProductionPromotionError(
        `subject '${input.subject.subjectId}' is already in production; promote a NEW version instead`,
      );
    }
    if (stage === "RETIRED") {
      throw new ProductionPromotionError(
        `subject '${input.subject.subjectId}' is retired; retirement is a going-forward record — promote a new subject version instead`,
      );
    }

    const order: ProductionPromotionOrder = Object.freeze({
      productionOrderId: input.productionOrderId,
      orderKind: "PROMOTE",
      subject: input.subject,
      subjectVersion: input.subjectVersion,
      labOrder: input.labOrder,
      suiteEvaluation: input.suiteEvaluation,
      uniformGate: input.uniformGate,
      securityReview: input.securityReview,
      ...(input.remediation !== undefined
        ? { remediation: input.remediation }
        : {}),
      orderedAt: input.orderedAt,
      orderDigest: contentDigest({
        productionOrderId: input.productionOrderId,
        subject: input.subject,
        subjectVersion: input.subjectVersion,
        labOrderId: input.labOrder.orderId,
        labOrderDigest: input.labOrder.orderDigest,
        suiteEvaluationDigest: input.suiteEvaluation.evaluationDigest,
        uniformGateDigest: input.uniformGate.wallDigest,
        securityReviewDigest: input.securityReview.reviewDigest,
        orderedAt: input.orderedAt,
      }),
    });
    this.artifacts.push(order);
    this.artifactsById.set(order.productionOrderId, order);
    this.stages.set(input.subject.subjectId, "PRODUCTION");
    this.recordEvaluation({
      entryId: `eval:${order.productionOrderId}`,
      subject: input.subject,
      suiteEvaluation: input.suiteEvaluation,
      recordedAt: input.orderedAt,
    });
    return order;
  }

  // -- rollback (append-only reversal records) -------------------------------

  /**
   * Orders a versioned production rollback: APPENDS a reversal record that
   * references the exact PROMOTE order being reversed. The reversed order
   * and every evaluation entry remain in history (INV-L03).
   */
  orderRollback(input: {
    readonly productionOrderId: string;
    readonly reversesOrderId: string;
    readonly reason: string;
    readonly orderedAt: string;
  }): ProductionRollbackOrder {
    if (input.productionOrderId.length === 0) {
      throw new ProductionPromotionError("productionOrderId must not be empty");
    }
    if (this.artifactsById.has(input.productionOrderId)) {
      throw new ProductionPromotionError(
        `production order '${input.productionOrderId}' already exists (append-only ledger: order ids are never reused)`,
      );
    }
    if (input.reason.length === 0) {
      throw new ProductionPromotionError("rollback reason must not be empty");
    }
    if (input.orderedAt.length === 0) {
      throw new ProductionPromotionError("orderedAt must not be empty");
    }
    const reversed = this.artifactsById.get(input.reversesOrderId);
    if (reversed === undefined) {
      throw new ProductionPromotionError(
        `rollback references unknown production order '${input.reversesOrderId}': a rollback is a reversal RECORD of an existing versioned promotion order — it cannot exist without one`,
      );
    }
    if (reversed.orderKind !== "PROMOTE") {
      throw new ProductionPromotionError(
        `only a PROMOTE order can be reversed; '${input.reversesOrderId}' is a ${reversed.orderKind}`,
      );
    }
    const subjectId = reversed.subject.subjectId;
    const stage = this.currentProductionStage(subjectId);
    if (stage !== "PRODUCTION") {
      throw new ProductionPromotionError(
        `subject '${subjectId}' is ${stage}; only a subject currently in production can be rolled back`,
      );
    }
    const order: ProductionRollbackOrder = Object.freeze({
      productionOrderId: input.productionOrderId,
      orderKind: "ROLLBACK",
      reversesOrderId: input.reversesOrderId,
      subject: reversed.subject,
      subjectVersion: reversed.subjectVersion,
      reason: input.reason,
      orderedAt: input.orderedAt,
      orderDigest: contentDigest({
        productionOrderId: input.productionOrderId,
        reversesOrderId: input.reversesOrderId,
        subjectId,
        subjectVersion: reversed.subjectVersion,
        reason: input.reason,
        orderedAt: input.orderedAt,
      }),
    });
    this.artifacts.push(order);
    this.artifactsById.set(order.productionOrderId, order);
    this.stages.set(subjectId, "ROLLED_BACK");
    return order;
  }

  // -- retirement (going-forward; history preserved — INV-C03) ---------------

  /**
   * Retires a subject from production: APPENDS a going-forward retirement
   * record. In-flight history — promotions, rollbacks, evaluation entries —
   * is preserved untouched (INV-C03).
   */
  retireFromProduction(input: {
    readonly productionOrderId: string;
    readonly subject: SuiteSubjectRef;
    readonly subjectVersion: number;
    readonly reason: string;
    readonly orderedAt: string;
  }): ProductionRetirementOrder {
    if (input.productionOrderId.length === 0) {
      throw new ProductionPromotionError("productionOrderId must not be empty");
    }
    if (this.artifactsById.has(input.productionOrderId)) {
      throw new ProductionPromotionError(
        `production order '${input.productionOrderId}' already exists (append-only ledger: order ids are never reused)`,
      );
    }
    if (input.reason.length === 0) {
      throw new ProductionPromotionError("retirement reason must not be empty");
    }
    if (input.subject.subjectId.length === 0) {
      throw new ProductionPromotionError("subject references must be complete");
    }
    if (input.subjectVersion < 1) {
      throw new ProductionPromotionError("subjectVersion must be >= 1");
    }
    const stage = this.currentProductionStage(input.subject.subjectId);
    if (stage !== "PRODUCTION" && stage !== "ROLLED_BACK") {
      throw new ProductionPromotionError(
        `subject '${input.subject.subjectId}' is ${stage}: retirement is a going-forward record for subjects that reached production`,
      );
    }
    const order: ProductionRetirementOrder = Object.freeze({
      productionOrderId: input.productionOrderId,
      orderKind: "RETIRE",
      subject: input.subject,
      subjectVersion: input.subjectVersion,
      reason: input.reason,
      orderedAt: input.orderedAt,
      orderDigest: contentDigest({
        productionOrderId: input.productionOrderId,
        subject: input.subject,
        subjectVersion: input.subjectVersion,
        reason: input.reason,
        orderedAt: input.orderedAt,
      }),
    });
    this.artifacts.push(order);
    this.artifactsById.set(order.productionOrderId, order);
    this.stages.set(input.subject.subjectId, "RETIRED");
    return order;
  }
}
