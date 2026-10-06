/**
 * @payswap/certification — the P4-W4-003 production-certification journey
 * contract (docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §35).
 *
 * The nine required acceptance journeys A–I are driven END-TO-END through
 * the REAL composed kernels. This module defines the typed contract every
 * journey fulfils — the W1-007/W2-003 journey doctrine adapted to the
 * production certification surface:
 *
 * - NO SIMULATED SUCCESS: every definitive state is evidence-backed
 *   (non-empty evidence refs recorded with the stage that produced it);
 *   UNKNOWN renders as UNKNOWN, never as failure or success (the W4-001
 *   law, reused verbatim by the journeys that force ambiguous states);
 * - no re-implementations: a journey composes the merged kernels exactly
 *   as the product does; the ONLY doubles are narrow, declared ports at
 *   the external seams (the trusted-surface signer, the signer adapter,
 *   the trusted-surface submission boundary, the off-ramp/venue
 *   observation fixtures) — each declared in production/world.ts;
 * - assertions RECOMPUTE their verdict from the observed artifacts — a
 *   pass is never fabricated;
 * - every stage record and the whole journey are content-addressed
 *   (deterministic digests; two runs of the same journey are
 *   byte-identical — the determinism guard).
 *
 * Deterministic only: no ambient clock, no randomness — every instant is
 * caller-supplied by the world fixtures.
 */

import { contentDigest } from "../digest.js";

/** The §35 acceptance-journey ids (A–I), in the handoff's order. */
export const PRODUCTION_JOURNEY_IDS = [
  "journey:a-simple-wallet-payment",
  "journey:b-dex-optimization",
  "journey:c-crypto-to-fiat",
  "journey:d-merchant-crypto-payment",
  "journey:e-mixed-execution",
  "journey:f-security-attack",
  "journey:g-agent-opportunity",
  "journey:h-state-change-before-broadcast",
  "journey:i-reorg-unknown",
] as const;

export type ProductionJourneyId = (typeof PRODUCTION_JOURNEY_IDS)[number];

/**
 * One observed stage of a journey's trace. `refs` carries the typed states
 * and artifact identities observed at the stage (machine vocabulary, never
 * prose-only), `evidenceRefs` the evidence lineage (INV-E02: non-empty on
 * every definitive state).
 */
export interface JourneyStageRecord {
  readonly stage: string;
  readonly summary: string;
  readonly refs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly digest: string;
}

/** A recomputed acceptance assertion (never a fabricated pass). */
export interface JourneyAssertion {
  readonly assertionId: string;
  readonly passed: boolean;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

/** The full observable outcome of one acceptance journey. */
export interface ProductionJourneyOutcome {
  readonly journeyId: ProductionJourneyId;
  readonly title: string;
  readonly spec: string;
  readonly stages: readonly JourneyStageRecord[];
  readonly assertions: readonly JourneyAssertion[];
  readonly evidenceRefs: readonly string[];
  readonly passed: boolean;
  readonly journeyDigest: string;
}

/** A journey definition: deterministic `run()` over the composed kernels. */
export interface ProductionJourney {
  readonly journeyId: ProductionJourneyId;
  readonly letter: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";
  readonly title: string;
  readonly spec: string;
  readonly run: () => ProductionJourneyOutcome;
}

/** Deterministic digest of one stage record (the evidence-file twin re-digests). */
export function stageDigest(record: Omit<JourneyStageRecord, "digest">): string {
  return contentDigest({
    stage: record.stage,
    summary: record.summary,
    refs: record.refs,
    evidenceRefs: record.evidenceRefs,
  });
}

/** Build a stage record (digest computed here — never caller-supplied). */
export function stage(
  stageId: string,
  summary: string,
  refs: readonly string[],
  evidenceRefs: readonly string[],
): JourneyStageRecord {
  const base = { stage: stageId, summary, refs, evidenceRefs };
  return { ...base, digest: stageDigest(base) };
}

/**
 * An assertion built from recomputed checks. `passed` is the conjunction
 * of the checks — a journey never asserts a pass it did not observe.
 */
export function assertionFromChecks(
  assertionId: string,
  checks: readonly { readonly check: string; readonly passed: boolean }[],
  evidenceRefs: readonly string[],
): JourneyAssertion {
  const failed = checks.filter((entry) => !entry.passed);
  return {
    assertionId,
    passed: failed.length === 0,
    summary:
      failed.length === 0
        ? checks.map((entry) => entry.check).join("; ")
        : `FAILED CHECKS: ${failed.map((entry) => entry.check).join("; ")}`,
    evidenceRefs,
  };
}

/** Recompute a journey's pass verdict from its assertions (never stored trust). */
export function journeyPassed(outcome: ProductionJourneyOutcome): boolean {
  return outcome.assertions.length > 0 && outcome.assertions.every((entry) => entry.passed);
}

/** Assemble the journey outcome (digest + verdict recomputed here). */
export function assembleJourneyOutcome(input: {
  readonly journey: ProductionJourney;
  readonly stages: readonly JourneyStageRecord[];
  readonly assertions: readonly JourneyAssertion[];
}): ProductionJourneyOutcome {
  const evidenceRefs = [
    ...new Set(input.stages.flatMap((record) => record.evidenceRefs)),
  ];
  const outcome = {
    journeyId: input.journey.journeyId,
    title: input.journey.title,
    spec: input.journey.spec,
    stages: input.stages,
    assertions: input.assertions,
    evidenceRefs,
    passed: false,
    journeyDigest: "",
  };
  return Object.freeze({
    ...outcome,
    passed: journeyPassed(outcome),
    journeyDigest: contentDigest({
      journeyId: outcome.journeyId,
      stages: outcome.stages,
      assertions: outcome.assertions,
      evidenceRefs: outcome.evidenceRefs,
    }),
  });
}

/**
 * Structural prerequisite guard: fail closed when a composed kernel did
 * not produce the artifact a later stage structurally requires (the
 * journey cannot continue past a missing prerequisite — it never
 * fabricates the missing artifact to keep going).
 */
export function journeyRequires(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`production journey structural prerequisite failed: ${message}`);
  }
}

/**
 * Presence guard with narrowing: returns the value when present, fails
 * closed otherwise (the journey never fabricates a missing artifact).
 */
export function requirePresent<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) {
    throw new Error(`production journey structural prerequisite failed: ${message}`);
  }
  return value;
}
