/**
 * @payswap/adversarial — the adversarial suite report (W2-007).
 *
 * Runs every fault-family scenario, recomputes each verdict from its
 * execution evidence (injection checks → injected; invariant probes → held;
 * recovery steps → completed), verifies complete family and invariant
 * coverage, and produces the overall suite verdict with a deterministic
 * content digest over the whole report.
 */

import { contentDigest } from "@payswap/certification";
import { ADVERSARIAL_EPOCH, FAULT_FAMILIES, verdictOf } from "./harness.js";
import type {
  AdversarialScenario,
  FaultFamilyId,
  FaultVerdict,
  TimestampMs,
} from "./harness.js";

/** One family's coverage line in the suite report. */
export interface FamilyCoverage {
  readonly family: FaultFamilyId;
  /** The fault id that asserted this family, or null when unasserted. */
  readonly faultId: string | null;
  readonly asserted: boolean;
  readonly passed: boolean;
}

/** One invariant's coverage line: which fault verdicts probed it. */
export interface InvariantCoverage {
  readonly invariantId: string;
  readonly probedBy: readonly string[];
  readonly held: boolean;
}

export interface AdversarialSuiteReport {
  readonly suiteId: "payswap.adversarial-suite";
  readonly workOrder: "W2-007";
  readonly generatedAt: TimestampMs;
  /** One verdict per W2-007 fault family, in work-order order. */
  readonly verdicts: readonly FaultVerdict[];
  readonly familyCoverage: readonly FamilyCoverage[];
  readonly invariantCoverage: readonly InvariantCoverage[];
  readonly overallPassed: boolean;
  readonly faultCount: number;
  readonly invariantCount: number;
  readonly digest: string;
}

export function suitePassed(report: AdversarialSuiteReport): boolean {
  return report.overallPassed;
}

/**
 * Run the adversarial suite over the given scenarios and assemble the
 * report. Every verdict is RECOMPUTED from the execution evidence — a
 * scenario never grades its own homework.
 */
export async function runAdversarialSuite(
  scenarios: readonly AdversarialScenario[],
): Promise<AdversarialSuiteReport> {
  const verdicts: FaultVerdict[] = [];
  for (const scenario of scenarios) {
    const execution = await scenario.run();
    verdicts.push(verdictOf(execution));
  }

  const familyCoverage: FamilyCoverage[] = FAULT_FAMILIES.map((family) => {
    const verdict = verdicts.find((candidate) => candidate.family === family);
    return {
      family,
      faultId: verdict?.faultId ?? null,
      asserted: verdict !== undefined,
      passed: verdict?.passed === true,
    };
  });

  const invariantIndex = new Map<string, { readonly probedBy: string[]; held: boolean }>();
  for (const verdict of verdicts) {
    for (const invariantProbe of verdict.probes) {
      const existing = invariantIndex.get(invariantProbe.invariantId);
      if (existing === undefined) {
        invariantIndex.set(invariantProbe.invariantId, {
          probedBy: [verdict.faultId],
          held: invariantProbe.held,
        });
      } else {
        invariantIndex.set(invariantProbe.invariantId, {
          probedBy: [...existing.probedBy, verdict.faultId],
          held: existing.held && invariantProbe.held,
        });
      }
    }
  }
  const invariantCoverage: InvariantCoverage[] = [...invariantIndex.entries()]
    .map(([invariantId, coverage]) => ({
      invariantId,
      probedBy: coverage.probedBy,
      held: coverage.held,
    }))
    .sort((a, b) => a.invariantId.localeCompare(b.invariantId));

  const overallPassed =
    verdicts.length === scenarios.length &&
    verdicts.length === FAULT_FAMILIES.length &&
    verdicts.every((verdict) => verdict.passed) &&
    familyCoverage.every((coverage) => coverage.asserted && coverage.passed) &&
    invariantCoverage.every((coverage) => coverage.held);

  const report: Omit<AdversarialSuiteReport, "digest"> = {
    suiteId: "payswap.adversarial-suite",
    workOrder: "W2-007",
    generatedAt: ADVERSARIAL_EPOCH,
    verdicts,
    familyCoverage,
    invariantCoverage,
    overallPassed,
    faultCount: verdicts.length,
    invariantCount: invariantCoverage.length,
  };
  return { ...report, digest: contentDigest(report) };
}

/** Deterministic re-run check: two runs of the same suite produce identical digests. */
export function suiteDeterministic(
  first: AdversarialSuiteReport,
  second: AdversarialSuiteReport,
): boolean {
  return first.digest === second.digest;
}
