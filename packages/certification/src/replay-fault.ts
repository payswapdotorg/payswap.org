/**
 * Replay/fault test contracts (W2-006; FROZEN-ARCHITECTURE §19; LAB.md
 * "Simulation and replay"; INV-L02, INV-X01..X03, INV-S02, INV-P03).
 *
 * This module owns the FAULT-INJECTION DECLARATIONS and the deterministic
 * re-run contracts consumed by the adversarial/replay/fault/abuse suite
 * (the next Stage-6 work order). The replay machinery itself is owned by
 * the Lab package and consumed here STRUCTURALLY: the view interfaces below
 * are structural subsets of the Lab's replay result shapes, so REAL replay
 * results produced by the Lab's own `runReplay` flow through these
 * contracts unchanged (proven by the package tests, which drive the real
 * replay machinery). No replay vocabulary is redefined.
 *
 * The canonical fault→expected-behavior mapping (work order):
 * - PROVIDER_OUTAGE   → UNKNOWN (never FAILED; INV-X01/X02);
 * - WEBHOOK_LOSS      → reconciliation recovery (INV-X03);
 * - SECURITY_EPOCH_BUMP → re-authorization (INV-S02/A02).
 *
 * Deterministic only: every verdict is a pure function of the declaration
 * and the submitted replay observations.
 */

import { contentDigest } from "./digest.js";

// ---------------------------------------------------------------------------
// Structural views of the Lab replay machinery
// ---------------------------------------------------------------------------

/** Structural view of one replayed demand outcome record. */
export interface StructuralReplayOutcomeRecord {
  readonly outcome: string;
}

/** Structural view of a replay run (produced by the Lab replay machinery). */
export interface StructuralReplayRun {
  readonly digest: string;
  readonly outcomes: readonly StructuralReplayOutcomeRecord[];
}

/** Structural view of a replay result (the Lab's result is assignable). */
export interface StructuralReplayResult {
  readonly replayId: string;
  readonly factsId: string;
  readonly factsDigest: string;
  readonly digest: string;
  readonly run: StructuralReplayRun;
}

// ---------------------------------------------------------------------------
// Fault-injection declarations
// ---------------------------------------------------------------------------

export const FAULT_KINDS = [
  "PROVIDER_OUTAGE",
  "WEBHOOK_LOSS",
  "SECURITY_EPOCH_BUMP",
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export function isFaultKind(value: unknown): value is FaultKind {
  return (
    typeof value === "string" &&
    (FAULT_KINDS as readonly unknown[]).includes(value)
  );
}

/** The required outcome class for each fault kind (the contract mapping). */
export type RequiredFaultOutcome =
  | "UNKNOWN_REQUIRES_RECONCILIATION"
  | "RECONCILIATION_RECOVERY"
  | "RE_AUTHORIZATION_REQUIRED";

/** The invariants that must hold through each fault kind. */
export interface ExpectedFaultBehavior {
  readonly faultKind: FaultKind;
  readonly requiredOutcome: RequiredFaultOutcome;
  readonly requiredInvariants: readonly string[];
  readonly description: string;
}

/**
 * The canonical fault→expected-behavior mapping. A fault test case must
 * exhibit the required outcome under the fault; the declaration below is
 * the frozen contract the adversarial suite verifies against.
 */
export function expectedBehaviorForFault(faultKind: FaultKind): ExpectedFaultBehavior {
  switch (faultKind) {
    case "PROVIDER_OUTAGE":
      return {
        faultKind,
        requiredOutcome: "UNKNOWN_REQUIRES_RECONCILIATION",
        requiredInvariants: ["INV-X01", "INV-X02", "INV-X03"],
        description:
          "a provider outage during an in-flight external write surfaces as UNKNOWN requiring reconciliation — never as FAILED and never blindly retried",
      };
    case "WEBHOOK_LOSS":
      return {
        faultKind,
        requiredOutcome: "RECONCILIATION_RECOVERY",
        requiredInvariants: ["INV-X03", "INV-O04", "INV-E05"],
        description:
          "a lost webhook leaves the external effect ambiguous until reconciliation — the authoritative resolver — recovers it with evidence",
      };
    case "SECURITY_EPOCH_BUMP":
      return {
        faultKind,
        requiredOutcome: "RE_AUTHORIZATION_REQUIRED",
        requiredInvariants: ["INV-S02", "INV-A02"],
        description:
          "advancing the network security epoch invalidates every epoch-scoped authorization issued below it; sensitive actions must be re-authorized",
      };
  }
}

/** Raised for invalid fault declarations or observations. */
export class ReplayFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayFaultError";
  }
}

/** One fault-injection declaration: what is injected, where and when. */
export interface FaultInjectionDeclaration {
  readonly faultId: string;
  readonly faultKind: FaultKind;
  /** The component/provider identity the fault targets. */
  readonly target: { readonly kind: string; readonly id: string };
  /** When the fault activates, in replay steps. */
  readonly atStep: number;
  readonly notes?: string;
}

export function declareFault(input: {
  readonly faultId: string;
  readonly faultKind: FaultKind;
  readonly targetKind: string;
  readonly targetId: string;
  readonly atStep: number;
  readonly notes?: string;
}): FaultInjectionDeclaration {
  if (input.faultId.length === 0) {
    throw new ReplayFaultError("faultId must not be empty");
  }
  if (!isFaultKind(input.faultKind)) {
    throw new ReplayFaultError(
      `unknown fault kind '${String(input.faultKind)}'`,
    );
  }
  if (input.targetKind.length === 0 || input.targetId.length === 0) {
    throw new ReplayFaultError("fault target requires kind and id");
  }
  if (!Number.isInteger(input.atStep) || input.atStep < 0) {
    throw new ReplayFaultError("atStep must be a non-negative integer step");
  }
  return Object.freeze({
    faultId: input.faultId,
    faultKind: input.faultKind,
    target: Object.freeze({ kind: input.targetKind, id: input.targetId }),
    atStep: input.atStep,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
}

// ---------------------------------------------------------------------------
// Reconciliation and re-authorization observations (fault-adjacent facts)
// ---------------------------------------------------------------------------

/**
 * What the reconciliation machinery observed after the fault: how many
 * ambiguous external effects existed and how many were recovered WITH
 * evidence (INV-X03 — reconciliation is authoritative for ambiguity).
 */
export interface ReconciliationObservation {
  readonly ambiguousEffects: number;
  readonly recoveredWithEvidence: number;
}

/** What the epoch machinery observed after an epoch bump (INV-S02). */
export interface EpochBumpObservation {
  readonly issuedAtEpoch: bigint;
  readonly currentEpoch: bigint;
  /** Sensitive actions correctly rejected with the stale epoch and re-authorized. */
  readonly reAuthorizedActions: number;
}

// ---------------------------------------------------------------------------
// The fault contract verifier
// ---------------------------------------------------------------------------

/** The verdict of one replay/fault test case. */
export interface ReplayFaultVerdict {
  readonly faultId: string;
  readonly faultKind: FaultKind;
  readonly expected: ExpectedFaultBehavior;
  readonly passed: boolean;
  readonly violations: readonly string[];
  readonly verdictDigest: string;
}

function countOutcome(
  replay: StructuralReplayResult,
  outcome: string,
): number {
  return replay.run.outcomes.filter((record) => record.outcome === outcome)
    .length;
}

/**
 * Verifies that a replay result satisfies the fault contract for the
 * declared fault kind:
 *
 * - PROVIDER_OUTAGE (→ UNKNOWN, INV-X01): the replay must exhibit at least
 *   one UNKNOWN_REQUIRES_RECONCILIATION outcome for the in-flight effects
 *   of the outage;
 * - WEBHOOK_LOSS (→ reconciliation recovery, INV-X03): at least one UNKNOWN
 *   outcome must exist AND the reconciliation observation must show every
 *   ambiguity recovered with evidence;
 * - SECURITY_EPOCH_BUMP (→ re-authorization, INV-S02/A02): the epoch
 *   observation must show the current epoch strictly above the issuance
 *   epoch and at least one re-authorized sensitive action.
 */
export function verifyFaultContract(input: {
  readonly fault: FaultInjectionDeclaration;
  readonly replay: StructuralReplayResult;
  readonly reconciliation?: ReconciliationObservation;
  readonly epochBump?: EpochBumpObservation;
}): ReplayFaultVerdict {
  const fault = input.fault;
  if (!isFaultKind(fault.faultKind)) {
    throw new ReplayFaultError(
      `unknown fault kind '${String(fault.faultKind)}'`,
    );
  }
  if (input.replay.digest.length === 0 || input.replay.run.digest.length === 0) {
    throw new ReplayFaultError("the replay result must be digested");
  }
  const expected = expectedBehaviorForFault(fault.faultKind);
  const violations: string[] = [];

  switch (fault.faultKind) {
    case "PROVIDER_OUTAGE": {
      const unknown = countOutcome(input.replay, "UNKNOWN_REQUIRES_RECONCILIATION");
      if (unknown < 1) {
        violations.push(
          `INV-X01: the outage produced no UNKNOWN_REQUIRES_RECONCILIATION outcome (${unknown}); an in-flight external write under outage must surface as UNKNOWN, never as FAILED`,
        );
      }
      break;
    }
    case "WEBHOOK_LOSS": {
      const unknown = countOutcome(input.replay, "UNKNOWN_REQUIRES_RECONCILIATION");
      if (unknown < 1) {
        violations.push(
          "INV-X03: a lost webhook must leave at least one ambiguous (UNKNOWN) effect for reconciliation to recover",
        );
      }
      const reconciliation = input.reconciliation;
      if (reconciliation === undefined) {
        violations.push(
          "INV-X03: the webhook-loss contract requires the reconciliation observation",
        );
      } else {
        if (reconciliation.recoveredWithEvidence < reconciliation.ambiguousEffects) {
          violations.push(
            `INV-X03: reconciliation recovered ${reconciliation.recoveredWithEvidence} of ${reconciliation.ambiguousEffects} ambiguous effects with evidence`,
          );
        }
        if (reconciliation.ambiguousEffects < 1) {
          violations.push(
            "INV-X03: the reconciliation observation must account for at least one ambiguous effect",
          );
        }
      }
      break;
    }
    case "SECURITY_EPOCH_BUMP": {
      const epochBump = input.epochBump;
      if (epochBump === undefined) {
        violations.push(
          "INV-S02: the epoch-bump contract requires the epoch observation",
        );
      } else {
        if (epochBump.currentEpoch <= epochBump.issuedAtEpoch) {
          violations.push(
            "INV-S02: the epoch observation must show the network epoch advanced above the authorization issuance epoch",
          );
        }
        if (epochBump.reAuthorizedActions < 1) {
          violations.push(
            "INV-S02/A02: no sensitive action was re-authorized after the epoch bump — stale epoch-scoped authorizations must be rejected and re-authorized",
          );
        }
      }
      break;
    }
  }

  const passed = violations.length === 0;
  const verdictDigest = contentDigest({
    fault,
    replayDigest: input.replay.digest,
    expected,
    passed,
  });
  return Object.freeze({
    faultId: fault.faultId,
    faultKind: fault.faultKind,
    expected: Object.freeze(expected),
    passed,
    violations: Object.freeze(violations),
    verdictDigest,
  });
}

// ---------------------------------------------------------------------------
// Deterministic re-runs (INV-P03 discipline)
// ---------------------------------------------------------------------------

/** The result of a deterministic re-run check over two replay results. */
export type DeterministicReRunCheck =
  | { readonly deterministic: true; readonly digest: string }
  | { readonly deterministic: false; readonly reason: string };

/**
 * Verifies deterministic re-runs: the same recorded facts re-run under the
 * same program and seed must produce the SAME replay digest — byte-for-byte
 * evidence of reproducibility. Different digests for the same facts are a
 * reproducibility violation, and mismatched fact sets are rejected outright.
 */
export function verifyDeterministicReRun(
  first: StructuralReplayResult,
  second: StructuralReplayResult,
): DeterministicReRunCheck {
  if (first.factsDigest !== second.factsDigest) {
    return {
      deterministic: false,
      reason: `the two runs replay different fact sets (${first.factsDigest} vs ${second.factsDigest}); a deterministic re-run must replay the same recorded facts`,
    };
  }
  if (first.digest !== second.digest) {
    return {
      deterministic: false,
      reason: `same facts produced different replay digests (${first.digest} vs ${second.digest}); replay must be deterministic in (facts, program, seed)`,
    };
  }
  return { deterministic: true, digest: first.digest };
}

// ---------------------------------------------------------------------------
// The replay/fault suite contract
// ---------------------------------------------------------------------------

/** One replay/fault test case: a fault declaration plus its observations. */
export interface ReplayFaultTestCase {
  readonly caseId: string;
  readonly fault: FaultInjectionDeclaration;
  readonly replay: StructuralReplayResult;
  readonly reconciliation?: ReconciliationObservation;
  readonly epochBump?: EpochBumpObservation;
}

/** The aggregate result of a replay/fault suite run. */
export interface ReplayFaultSuiteResult {
  readonly suiteId: string;
  readonly cases: readonly ReplayFaultVerdict[];
  readonly passed: boolean;
  readonly suiteDigest: string;
}

/**
 * Runs a full replay/fault suite: every case is verified against the
 * canonical fault contract, and the suite passes only when every case
 * passes. Deterministic: verdicts depend only on the submitted cases.
 */
export function runReplayFaultSuite(input: {
  readonly suiteId: string;
  readonly cases: readonly ReplayFaultTestCase[];
}): ReplayFaultSuiteResult {
  if (input.suiteId.length === 0) {
    throw new ReplayFaultError("suiteId must not be empty");
  }
  if (input.cases.length === 0) {
    throw new ReplayFaultError(
      "a replay/fault suite requires at least one case",
    );
  }
  const verdicts = input.cases.map((testCase) =>
    verifyFaultContract({
      fault: testCase.fault,
      replay: testCase.replay,
      ...(testCase.reconciliation !== undefined
        ? { reconciliation: testCase.reconciliation }
        : {}),
      ...(testCase.epochBump !== undefined
        ? { epochBump: testCase.epochBump }
        : {}),
    }),
  );
  const passed = verdicts.every((verdict) => verdict.passed);
  const suiteDigest = contentDigest({
    suiteId: input.suiteId,
    verdicts,
    passed,
  });
  return Object.freeze({
    suiteId: input.suiteId,
    cases: Object.freeze(verdicts),
    passed,
    suiteDigest,
  });
}
