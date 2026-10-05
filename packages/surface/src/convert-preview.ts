/**
 * @payswap/surface — the Convert outcome's disclosure fold over the REAL
 * route-compiler output (P4-W4-002 §3.1 "Convert").
 *
 * The route compiler (@payswap/route-compiler, W4-001) owns route
 * compilation: MoneyMovementIntent in, RouteCompilationResult out — plans
 * with legs, honest ineligibility reasons, honest exclusions, provider
 * native baselines never ranked away. This module NEVER recompiles and
 * NEVER redefines those contracts: it FOLDS a compilation result into the
 * two-level disclosure view the universal interface renders —
 *
 * - SIMPLE view (§3.5 progressive disclosure): the outcome line — how many
 *   plans, how many executable now, what the honest headline is;
 * - ADVANCED view (explicit drill-down): every plan, leg by leg, with its
 *   ineligibility reasons and the excluded shapes verbatim.
 *
 * The input type is STRUCTURAL (a generic constraint): the compiler's real
 * RouteCompilationResult satisfies it by construction, and every real call
 * site typechecks against the compiler's own field names — if the compiler
 * renames a disclosed field, surface consumers fail to compile rather than
 * silently rendering stale shapes. The fold itself is pure data derivation.
 */

import { surfaceProvenance, type SurfaceContractProvenance } from "./version.js";

/** What the fold reads from any route compilation result (structural). */
export interface RouteCompilationDisclosureSource {
  readonly status: string;
  readonly plans?: ReadonlyArray<RoutePlanDisclosureSource>;
  readonly exclusions?: ReadonlyArray<{
    readonly shapeId: string;
    readonly reasons: readonly string[];
  }>;
}

export interface RoutePlanDisclosureSource {
  readonly planId: string;
  readonly shapeId: string;
  readonly candidateStatus: string;
  readonly compositionClass: string;
  readonly isProviderNativeBaseline: boolean;
  readonly legs: ReadonlyArray<{ readonly legKind: string }>;
  readonly ineligibilityReasons?: ReadonlyArray<{
    readonly legId: string;
    readonly code: string;
    readonly detail: string;
  }>;
}

/** One plan's advanced-disclosure row. */
export interface ConvertPlanView {
  readonly planId: string;
  readonly shapeId: string;
  readonly candidateStatus: string;
  readonly compositionClass: string;
  readonly isProviderNativeBaseline: boolean;
  /** The leg chain in people-readable order (e.g. FIAT_PSP_COLLECT → …). */
  readonly legChain: readonly string[];
  readonly ineligibilityReasons: readonly string[];
  /** True when the plan is the incumbent provider's own native flow. */
  readonly baselineNote: string;
}

/** The full two-level Convert disclosure view. */
export interface ConvertPreviewView {
  /** The SIMPLE outcome line (progressive disclosure level 1). */
  readonly outcomeLine: string;
  /** Counts behind the headline. */
  readonly counts: {
    readonly totalPlans: number;
    readonly executable: number;
    readonly baselines: number;
    readonly ineligible: number;
    readonly excludedShapes: number;
  };
  /**
   * True when NOTHING executable was compiled — the honest headline then
   * leads with that fact (never a failure tone: ineligible ≠ failed).
   */
  readonly nothingExecutable: boolean;
  /** ADVANCED disclosure (level 2 — rendered only on explicit drill-down). */
  readonly plans: readonly ConvertPlanView[];
  readonly exclusions: readonly { readonly shapeId: string; readonly reasons: readonly string[] }[];
  readonly provenance: SurfaceContractProvenance;
}

const BASELINE_NOTE = {
  baseline:
    "This plan is the incumbent provider's own native flow — emitted as a candidate exactly like composed plans, never ranked away.",
  composed: "Composed route across PaySwap rails.",
} as const;

function planView(plan: RoutePlanDisclosureSource): ConvertPlanView {
  return {
    planId: plan.planId,
    shapeId: plan.shapeId,
    candidateStatus: plan.candidateStatus,
    compositionClass: plan.compositionClass,
    isProviderNativeBaseline: plan.isProviderNativeBaseline,
    legChain: plan.legs.map((leg) => leg.legKind),
    ineligibilityReasons: (plan.ineligibilityReasons ?? []).map(
      (reason) => `${reason.legId} [${reason.code}]: ${reason.detail}`,
    ),
    baselineNote: plan.isProviderNativeBaseline ? BASELINE_NOTE.baseline : BASELINE_NOTE.composed,
  };
}

/**
 * Fold a compilation result into the disclosure view. Pure: same input,
 * same view, no clock, no env, no hidden state.
 */
export function foldRouteCompilation<R extends RouteCompilationDisclosureSource>(
  result: R,
): ConvertPreviewView {
  const plans = (result.plans ?? []).map(planView);
  const exclusions = (result.exclusions ?? []).map((exclusion) => ({
    shapeId: exclusion.shapeId,
    reasons: exclusion.reasons,
  }));
  const executable = plans.filter((plan) => plan.candidateStatus === "EXECUTABLE_CANDIDATE").length;
  const baselines = plans.filter(
    (plan) => plan.candidateStatus === "PROVIDER_NATIVE_BASELINE" || plan.isProviderNativeBaseline,
  ).length;
  const ineligible = plans.filter((plan) => plan.candidateStatus === "INELIGIBLE_CANDIDATE").length;
  const nothingExecutable = executable === 0;
  const outcomeLine = nothingExecutable
    ? `No executable route right now — ${plans.length} candidate plan${plans.length === 1 ? "" : "s"} compiled and every one is honestly recorded as ineligible or baseline-only; nothing was silently dropped.`
    : `${executable} executable route plan${executable === 1 ? "" : "s"}${
        baselines > 0 ? `, ${baselines} provider-native baseline${baselines === 1 ? "" : "s"}` : ""
      }${
        ineligible > 0 ? `, ${ineligible} ineligible candidate${ineligible === 1 ? "" : "s"} (reasons on drill-down)` : ""
      } — full legs and custody on the advanced view.`;
  return {
    outcomeLine,
    counts: {
      totalPlans: plans.length,
      executable,
      baselines,
      ineligible,
      excludedShapes: exclusions.length,
    },
    nothingExecutable,
    plans,
    exclusions,
    provenance: surfaceProvenance("P4-W4-002"),
  };
}

/**
 * The typed journey request for a Convert preview (what the surface's
 * caller assembles BEFORE any host compiles): exact minor-unit amount,
 * explicit source and target, both directions of the fiat/crypto boundary
 * representable, no free-form money strings.
 */
export interface ConvertPreviewRequest {
  readonly sourceCurrency: string;
  readonly targetCurrency: string;
  readonly amountMinorUnits: bigint;
}

/** People-language summary of the request (the confirm-before-compile line). */
export function convertRequestSummary(request: ConvertPreviewRequest): string {
  return `Convert ${request.amountMinorUnits.toString()} (minor units) ${request.sourceCurrency.toUpperCase()} → ${request.targetCurrency.toUpperCase()}`;
}
