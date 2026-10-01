/**
 * Lab shadow/canary promotion (W2-004; FROZEN-ARCHITECTURE §19; LAB.md
 * "Promotion"; INV-L02/L03; AGENTS.md rules 8/14).
 *
 * Lifecycle: DRAFT → BENCHMARKED → VALIDATED → SHADOW → CANARY →
 * PRODUCTION → RETIRED (LAB.md). The Lab-side stages (DRAFT…VALIDATED) are
 * owned by the candidate registry (candidates.ts); this ledger owns
 * SHADOW/CANARY/PRODUCTION/RETIRED orders.
 *
 * INV-L02 — ordering a promotion to SHADOW or beyond requires a complete
 * evidence bundle: REPLAY + COUNTERFACTUAL + ROBUSTNESS evidence (and, per
 * stage, the shadow/canary reports). A missing piece raises
 * PromotionEvidenceError; there is no override path.
 *
 * INV-L03 — promotion is VERSIONED (every order references an immutable
 * published candidate version) and REVERSIBLE (orderRollback appends a
 * rollback order and moves the active stage back; the append-only history
 * is never rewritten).
 *
 * INV-G03/A05 — a promotion ORDER is a proposal artifact. This ledger is a
 * Lab-side control structure: applying an order to production traffic is a
 * protocol-authority operation that lives OUTSIDE the Lab (W3-003 adapter
 * surface); nothing here mutates financial state.
 *
 * INV-C08 — `comparePromotionCandidates` ranks EXPLICIT side-by-side
 * candidates across the three execution modes by evidence only: hard
 * constraints first, then optimization score. Provider-native incumbents
 * are never assumed inferior (nor superior).
 */

import { canonicalize, fnv1a64 } from "./simulation.js";
import type { ExecutionMode } from "@payswap/connectors";
import type { RunEvaluationResult } from "./evaluator.js";

// ---------------------------------------------------------------------------
// Stages and evidence
// ---------------------------------------------------------------------------

export const PROMOTION_STAGES = [
  "DRAFT",
  "BENCHMARKED",
  "VALIDATED",
  "SHADOW",
  "CANARY",
  "PRODUCTION",
  "RETIRED",
] as const;
export type PromotionStage = (typeof PROMOTION_STAGES)[number];

export function isPromotionStage(value: unknown): value is PromotionStage {
  return (
    typeof value === "string" &&
    (PROMOTION_STAGES as readonly unknown[]).includes(value)
  );
}

export type PromotionEvidenceKind =
  | "BASELINE_SUITE_EVALUATION"
  | "REPLAY"
  | "COUNTERFACTUAL"
  | "ROBUSTNESS"
  | "SHADOW_REPORT"
  | "CANARY_REPORT";

export interface PromotionEvidenceRef {
  readonly evidenceId: string;
  readonly kind: PromotionEvidenceKind;
  readonly artifactRef: string;
  readonly contentDigest: string;
}

/** The evidence kinds REQUIRED for a target stage (INV-L02). */
export function requiredEvidenceForTarget(
  targetStage: PromotionStage,
): readonly PromotionEvidenceKind[] {
  switch (targetStage) {
    case "BENCHMARKED":
      return ["BASELINE_SUITE_EVALUATION"];
    case "VALIDATED":
      return ["REPLAY", "COUNTERFACTUAL", "ROBUSTNESS"];
    case "SHADOW":
      return ["REPLAY", "COUNTERFACTUAL", "ROBUSTNESS"];
    case "CANARY":
      return ["REPLAY", "COUNTERFACTUAL", "ROBUSTNESS", "SHADOW_REPORT"];
    case "PRODUCTION":
      return [
        "REPLAY",
        "COUNTERFACTUAL",
        "ROBUSTNESS",
        "SHADOW_REPORT",
        "CANARY_REPORT",
      ];
    case "DRAFT":
    case "RETIRED":
      return [];
  }
}

// ---------------------------------------------------------------------------
// Orders (versioned, reversible, append-only)
// ---------------------------------------------------------------------------

export type PromotionOrderKind = "ADVANCE" | "ROLLBACK" | "RETIRE";

export interface PromotionOrder {
  readonly orderId: string;
  readonly orderKind: PromotionOrderKind;
  readonly candidateId: string;
  readonly candidateVersion: number;
  readonly fromStage: PromotionStage;
  readonly toStage: PromotionStage;
  readonly evidence: readonly PromotionEvidenceRef[];
  readonly orderedAt: string;
  readonly orderDigest: string;
}

/** Raised for any illegal promotion attempt. */
export class PromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionError";
  }
}

export class PromotionSkipError extends PromotionError {
  constructor(fromStage: PromotionStage, toStage: PromotionStage) {
    super(
      `illegal stage transition ${fromStage} → ${toStage}: promotions advance one stage at a time (INV-L03)`,
    );
    this.name = "PromotionSkipError";
  }
}

export class PromotionEvidenceError extends PromotionError {
  readonly missing: readonly PromotionEvidenceKind[];

  constructor(targetStage: PromotionStage, missing: readonly PromotionEvidenceKind[]) {
    super(
      `promotion to ${targetStage} requires evidence ${requiredEvidenceForTarget(targetStage).join(", ")}; missing: ${missing.join(", ")} (INV-L02)`,
    );
    this.name = "PromotionEvidenceError";
    this.missing = missing;
  }
}

/**
 * The Lab promotion ledger: append-only order history per candidate.
 * Deterministic: order ids derive from a per-candidate sequence and the
 * order content; decisions depend only on the ledger state + inputs.
 */
export class PromotionLedger {
  /** candidateId → active stage (defaults to DRAFT on first observation). */
  private readonly stages = new Map<string, PromotionStage>();
  /** candidateId → append-only order history. */
  private readonly history = new Map<string, PromotionOrder[]>();
  private readonly sequences = new Map<string, number>();

  currentStage(candidateId: string): PromotionStage {
    return this.stages.get(candidateId) ?? "DRAFT";
  }

  historyFor(candidateId: string): readonly PromotionOrder[] {
    return [...(this.history.get(candidateId) ?? [])];
  }

  private record(
    order: Omit<PromotionOrder, "orderId" | "orderDigest">,
  ): PromotionOrder {
    const sequence = (this.sequences.get(order.candidateId) ?? 0) + 1;
    this.sequences.set(order.candidateId, sequence);
    const orderDigest = fnv1a64(
      canonicalize({ sequence, order }),
    );
    const full: PromotionOrder = Object.freeze({
      ...order,
      orderId: `promotion:${order.candidateId}:${sequence}`,
      orderDigest,
    });
    const existing = this.history.get(order.candidateId) ?? [];
    this.history.set(order.candidateId, [...existing, full]);
    this.stages.set(order.candidateId, order.toStage);
    return full;
  }

  /**
   * Orders an advancement to the NEXT stage. Enforces:
   * - adjacency (no skipping; INV-L03);
   * - the INV-L02 evidence bundle for the target stage;
   * - a positive candidateVersion referencing an immutable published
   *   snapshot (the order is versioned).
   */
  orderPromotion(input: {
    candidateId: string;
    candidateVersion: number;
    targetStage: PromotionStage;
    evidence: readonly PromotionEvidenceRef[];
    orderedAt: string;
  }): PromotionOrder {
    if (input.candidateVersion < 1) {
      throw new PromotionError("candidateVersion must reference a published version (>= 1)");
    }
    if (!isPromotionStage(input.targetStage)) {
      throw new PromotionError(`unknown target stage '${String(input.targetStage)}'`);
    }
    const fromStage = this.currentStage(input.candidateId);
    const fromIndex = PROMOTION_STAGES.indexOf(fromStage);
    const toIndex = PROMOTION_STAGES.indexOf(input.targetStage);
    if (toIndex !== fromIndex + 1) {
      throw new PromotionSkipError(fromStage, input.targetStage);
    }

    const required = requiredEvidenceForTarget(input.targetStage);
    const present = new Set(input.evidence.map((ref) => ref.kind));
    const missing = required.filter((kind) => !present.has(kind));
    if (missing.length > 0) {
      throw new PromotionEvidenceError(input.targetStage, missing);
    }

    return this.record({
      orderKind: "ADVANCE",
      candidateId: input.candidateId,
      candidateVersion: input.candidateVersion,
      fromStage,
      toStage: input.targetStage,
      evidence: [...input.evidence],
      orderedAt: input.orderedAt,
    });
  }

  /**
   * Orders a rollback to an EARLIER stage (INV-L03: reversible). The
   * rollback is APPENDED to the history; prior orders remain untouched.
   */
  orderRollback(input: {
    candidateId: string;
    candidateVersion: number;
    toStage: PromotionStage;
    reason: string;
    orderedAt: string;
  }): PromotionOrder {
    const fromStage = this.currentStage(input.candidateId);
    const fromIndex = PROMOTION_STAGES.indexOf(fromStage);
    const toIndex = PROMOTION_STAGES.indexOf(input.toStage);
    if (fromStage === "RETIRED") {
      throw new PromotionError("a retired candidate cannot roll back");
    }
    if (toIndex >= fromIndex || toIndex < 0) {
      throw new PromotionError(
        `rollback target ${input.toStage} must be an earlier stage than ${fromStage}`,
      );
    }
    return this.record({
      orderKind: "ROLLBACK",
      candidateId: input.candidateId,
      candidateVersion: input.candidateVersion,
      fromStage,
      toStage: input.toStage,
      evidence: [],
      orderedAt: input.orderedAt,
    });
  }

  /** Retires a candidate from any active stage (terminal, still reversible to nothing). */
  retire(input: {
    candidateId: string;
    candidateVersion: number;
    reason: string;
    orderedAt: string;
  }): PromotionOrder {
    const fromStage = this.currentStage(input.candidateId);
    if (fromStage === "RETIRED") {
      throw new PromotionError("candidate is already retired");
    }
    return this.record({
      orderKind: "RETIRE",
      candidateId: input.candidateId,
      candidateVersion: input.candidateVersion,
      fromStage,
      toStage: "RETIRED",
      evidence: [],
      orderedAt: input.orderedAt,
    });
  }
}

// ---------------------------------------------------------------------------
// Side-by-side candidate comparison (INV-C07/C08)
// ---------------------------------------------------------------------------

export interface PromotionCandidateEvaluation {
  readonly candidateId: string;
  readonly executionMode: ExecutionMode;
  readonly isIncumbentBaseline: boolean;
  readonly evaluation: RunEvaluationResult;
}

export interface RankedPromotionCandidate {
  readonly candidateId: string;
  readonly executionMode: ExecutionMode;
  readonly isIncumbentBaseline: boolean;
  readonly rank: number;
  readonly passedHardConstraints: boolean;
  readonly totalOptimizationScoreMinor: bigint;
}

/**
 * Ranks explicit side-by-side candidates. HARD CONSTRAINTS FIRST, then the
 * optimization score (lower is better), then deterministic tie-break on
 * candidateId. There is NO mode-based prior: PASS_THROUGH_NATIVE,
 * COMPOSED_PAYSWAP and OPTIMIZED_MULTI_PROVIDER compete purely on evidence
 * (INV-C07/C08 — the incumbent native candidate can win or lose).
 */
export function comparePromotionCandidates(
  evaluations: readonly PromotionCandidateEvaluation[],
): readonly RankedPromotionCandidate[] {
  const sorted = [...evaluations].sort((left, right) => {
    const leftPass = left.evaluation.passedHardConstraints ? 1 : 0;
    const rightPass = right.evaluation.passedHardConstraints ? 1 : 0;
    if (leftPass !== rightPass) {
      return rightPass - leftPass; // passing candidates first
    }
    const leftScore = left.evaluation.totalOptimizationScoreMinor;
    const rightScore = right.evaluation.totalOptimizationScoreMinor;
    if (leftScore !== rightScore) {
      return leftScore < rightScore ? -1 : 1; // lower cost first
    }
    return left.candidateId < right.candidateId
      ? -1
      : left.candidateId > right.candidateId
        ? 1
        : 0;
  });
  return Object.freeze(
    sorted.map((entry, index) => ({
      candidateId: entry.candidateId,
      executionMode: entry.executionMode,
      isIncumbentBaseline: entry.isIncumbentBaseline,
      rank: index + 1,
      passedHardConstraints: entry.evaluation.passedHardConstraints,
      totalOptimizationScoreMinor: entry.evaluation.totalOptimizationScoreMinor,
    })),
  );
}
