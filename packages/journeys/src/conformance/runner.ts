/**
 * @payswap/journeys — the cross-provider conformance RUNNER (P2-W2-003).
 *
 * Executes the certification matrix: every (provider × scenario) pair from
 * the declared profiles × the 13 work-order lifecycle scenarios. For every
 * APPLICABLE pair the provider's own mapping/SDK code runs over synthetic
 * fixtures (ScenarioArtifacts), the scenario's lifecycle checks AND the
 * four SHARED gates (authorization / evidence / reconciliation / security)
 * produce the verdict. NOT_APPLICABLE pairs are recorded with their honest
 * declared basis — never silently skipped.
 *
 * The report is deterministic (fixed CONFORMANCE_EPOCH, scripted
 * transports) so the certification is REPEATABLE evidence: the same runner
 * backs the battery test (test/conformance.test.ts) and any future
 * re-certification when a connector or capability changes.
 */

import type { ConformanceScenarioId, ScenarioVerdict } from "./model.js";
import { CONFORMANCE_SCENARIO_IDS } from "./model.js";
import type { ConformanceProfileSet, ProviderConformanceProfile } from "./profile.js";
import { runSharedGates } from "./gates.js";
import { CONFORMANCE_SCENARIOS, scenarioById } from "./scenarios.js";
import { stripeConformanceProfile } from "./profiles-stripe.js";
import { paystackConformanceProfile } from "./profiles-paystack.js";
import { flutterwaveConformanceProfile } from "./profiles-flutterwave.js";

// ---------------------------------------------------------------------------
// The profile registry (Wave 1 + Wave 2 connector set; honest-declared)
// ---------------------------------------------------------------------------

/**
 * The certified profile set: every production provider whose connector is
 * merged, with its applicability declared from its OWN capability ids and
 * status vocabulary. Extending the set = adding a profile; the runner and
 * the battery test pick it up with zero changes.
 */
export const conformanceProfileSet: ConformanceProfileSet = {
  profiles: [stripeConformanceProfile, paystackConformanceProfile, flutterwaveConformanceProfile],
};

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** One provider's roll-up in the certification report. */
export interface ConformanceProviderSummary {
  readonly providerName: string;
  readonly providerVersion: string;
  readonly honestyNote: string;
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly notApplicable: number;
  /** The honest NOT_APPLICABLE bases (scenario -> basis), never hidden. */
  readonly notApplicableBases: Readonly<Record<ConformanceScenarioId, string>>;
}

/** One scenario's roll-up across providers. */
export interface ConformanceScenarioSummary {
  readonly scenarioId: ConformanceScenarioId;
  readonly title: string;
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly notApplicable: number;
}

/** The full certification report (P2-W2-003 acceptance object). */
export interface ConformanceCertificationReport {
  readonly certificationId: "P2-W2-003-cross-provider-conformance";
  readonly scenarioIds: readonly ConformanceScenarioId[];
  readonly providers: readonly ConformanceProviderSummary[];
  readonly scenarios: readonly ConformanceScenarioSummary[];
  /** Every (provider × scenario) verdict, matrix order. */
  readonly verdicts: readonly ScenarioVerdict[];
  readonly totalPairs: number;
  readonly executedPairs: number;
  readonly notApplicablePairs: number;
  readonly passedPairs: number;
  readonly failedPairs: number;
  /** True iff every executed pair passed and every pair is accounted for. */
  readonly allPassed: boolean;
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

async function certifyPair(
  profile: ProviderConformanceProfile,
  scenarioId: ConformanceScenarioId,
): Promise<ScenarioVerdict> {
  const scenario = scenarioById(scenarioId);
  if (scenario === undefined) {
    return {
      scenarioId,
      providerName: profile.providerName,
      verdict: "FAIL",
      gateChecks: [],
      scenarioChecks: [{ ok: false, detail: `scenario '${scenarioId}' has no definition` }],
      evidenceRefs: [],
      notes: [],
    };
  }
  const declared = profile.applicability[scenarioId];
  if (declared === undefined || !declared.applicable) {
    const basis =
      declared === undefined
        ? "NO APPLICABILITY DECLARED — the profile must declare all 13 scenarios"
        : declared.basis;
    return {
      scenarioId,
      providerName: profile.providerName,
      verdict: "NOT_APPLICABLE",
      gateChecks: [],
      scenarioChecks: [],
      evidenceRefs: [],
      notes: [`NOT_APPLICABLE: ${basis}`],
    };
  }
  const artifacts = await scenario.run(profile);
  const scenarioChecks = scenario.check(artifacts);
  const gateChecks = await runSharedGates(profile, artifacts);
  const gatesPassed = gateChecks.every((g) => g.passed);
  const checksPassed = scenarioChecks.every((c) => c.ok);
  return {
    scenarioId,
    providerName: profile.providerName,
    verdict: gatesPassed && checksPassed ? "PASS" : "FAIL",
    gateChecks,
    scenarioChecks,
    evidenceRefs: [
      `conformance://${profile.providerName}/${scenarioId}`,
      `envelopes=${artifacts.envelopes.length}`,
      ...artifacts.notes.map((n) => `note: ${n}`),
    ],
    notes: artifacts.notes,
  };
}

/**
 * Run the full certification matrix over a profile set: every profile ×
 * every one of the 13 work-order scenarios, in matrix order, with shared
 * gates on every executed pair.
 */
export async function runCrossProviderConformance(
  set: ConformanceProfileSet = conformanceProfileSet,
): Promise<ConformanceCertificationReport> {
  const verdicts: ScenarioVerdict[] = [];
  for (const profile of set.profiles) {
    for (const scenarioId of CONFORMANCE_SCENARIO_IDS) {
      verdicts.push(await certifyPair(profile, scenarioId));
    }
  }

  const providers: ConformanceProviderSummary[] = set.profiles.map((profile) => {
    const mine = verdicts.filter((v) => v.providerName === profile.providerName);
    const notApplicableBases: Record<ConformanceScenarioId, string> = {} as Record<
      ConformanceScenarioId,
      string
    >;
    for (const v of mine) {
      if (v.verdict === "NOT_APPLICABLE") {
        notApplicableBases[v.scenarioId] = v.notes[0] ?? "NOT_APPLICABLE";
      }
    }
    return {
      providerName: profile.providerName,
      providerVersion: profile.providerVersion,
      honestyNote: profile.honestyNote,
      executed: mine.filter((v) => v.verdict !== "NOT_APPLICABLE").length,
      passed: mine.filter((v) => v.verdict === "PASS").length,
      failed: mine.filter((v) => v.verdict === "FAIL").length,
      notApplicable: mine.filter((v) => v.verdict === "NOT_APPLICABLE").length,
      notApplicableBases,
    };
  });

  const scenarios: ConformanceScenarioSummary[] = CONFORMANCE_SCENARIO_IDS.map((scenarioId) => {
    const mine = verdicts.filter((v) => v.scenarioId === scenarioId);
    return {
      scenarioId,
      title: scenarioById(scenarioId)?.title ?? scenarioId,
      executed: mine.filter((v) => v.verdict !== "NOT_APPLICABLE").length,
      passed: mine.filter((v) => v.verdict === "PASS").length,
      failed: mine.filter((v) => v.verdict === "FAIL").length,
      notApplicable: mine.filter((v) => v.verdict === "NOT_APPLICABLE").length,
    };
  });

  const executedPairs = verdicts.filter((v) => v.verdict !== "NOT_APPLICABLE").length;
  const notApplicablePairs = verdicts.filter((v) => v.verdict === "NOT_APPLICABLE").length;
  const passedPairs = verdicts.filter((v) => v.verdict === "PASS").length;
  const failedPairs = verdicts.filter((v) => v.verdict === "FAIL").length;
  const totalPairs = verdicts.length;

  return {
    certificationId: "P2-W2-003-cross-provider-conformance",
    scenarioIds: CONFORMANCE_SCENARIO_IDS,
    providers,
    scenarios,
    verdicts,
    totalPairs: verdicts.length,
    executedPairs,
    notApplicablePairs,
    passedPairs,
    failedPairs,
    allPassed:
      failedPairs === 0 &&
      executedPairs > 0 &&
      totalPairs === set.profiles.length * CONFORMANCE_SCENARIO_IDS.length,
    notes: [
      "contract-level certification: the providers' own mapping/SDK code over synthetic fixtures on scripted transports; no live provider contacted, no financial effect simulated",
      "the four shared gates (AUTHORIZATION INV-NC04 / EVIDENCE INV-C06 / RECONCILIATION INV-X03 / SECURITY) run on every executed pair",
      "NOT_APPLICABLE is a declared, honest basis from the provider's own capability vocabulary — never a silent skip",
      ...set.profiles.map((p) => `${p.providerName}: ${p.honestyNote}`),
    ],
  };
}

// ---------------------------------------------------------------------------
// The human-readable summary (console/battery output)
// ---------------------------------------------------------------------------

/** Format the certification as a compact, honest text table. */
export function formatConformanceSummary(report: ConformanceCertificationReport): string {
  const lines: string[] = [];
  lines.push(`P2-W2-003 cross-provider conformance certification`);
  lines.push(
    `  pairs: ${report.totalPairs} total = ${report.executedPairs} executed + ${report.notApplicablePairs} not-applicable`,
  );
  lines.push(`  verdicts: ${report.passedPairs} PASS / ${report.failedPairs} FAIL`);
  lines.push(`  allPassed: ${report.allPassed}`);
  lines.push(``);
  lines.push(`  provider roll-up:`);
  for (const p of report.providers) {
    lines.push(
      `    ${p.providerName} (${p.providerVersion}): ${p.passed}/${p.executed} executed PASS, ${p.notApplicable} N/A — ${p.honestyNote}`,
    );
    for (const [scenarioId, basis] of Object.entries(p.notApplicableBases)) {
      lines.push(`      N/A ${scenarioId}: ${basis}`);
    }
  }
  lines.push(``);
  lines.push(`  scenario roll-up:`);
  for (const s of report.scenarios) {
    lines.push(
      `    ${s.scenarioId}: ${s.passed}/${s.executed} executed PASS, ${s.notApplicable} N/A${s.failed > 0 ? `, ${s.failed} FAIL` : ""}`,
    );
  }
  if (report.failedPairs > 0) {
    lines.push(``);
    lines.push(`  FAILURES:`);
    for (const v of report.verdicts) {
      if (v.verdict !== "FAIL") continue;
      lines.push(`    ${v.providerName} / ${v.scenarioId}:`);
      for (const g of v.gateChecks) {
        if (!g.passed) lines.push(`      gate ${g.gate}: ${g.summary}`);
      }
      for (const c of v.scenarioChecks) {
        if (!c.ok) lines.push(`      check: ${c.detail}`);
      }
    }
  }
  return lines.join("\n");
}
