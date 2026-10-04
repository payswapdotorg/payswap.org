/**
 * @payswap/route-compiler — the compiled route plan (Work Order
 * P4-W4-001).
 *
 * A RoutePlan is ONE candidate way to move ONE canonical Money Movement
 * Intent: an ordered chain of legs, each carrying the full chain of custody
 * for authority, state, finality and evidence (leg-contracts.ts).
 *
 * Structural laws:
 *
 * - SINGLE SOURCE OF TRUTH: the plan REFERENCES the intent (intentRef +
 *   intentAuthorizationRef) and never re-declares its amount, origin,
 *   destination or authorization (no duplicate ledger — rule 23);
 *
 * - PROVIDER-NATIVE BASELINES (INV-C08): a plan whose route is the
 *   incumbent provider's own native flow carries
 *   isProviderNativeBaseline: true and executionMode PASS_THROUGH_NATIVE.
 *   Baselines are emitted as candidates exactly like composed plans and
 *   are NEVER structurally disadvantaged: the compiler does not rank plans
 *   (ranking is downstream policy), so a baseline cannot be ranked away;
 *
 * - CUSTODY CHAIN: every plan's legs custody-chain (assertCustodyContinuity
 *   is enforced at construction — hidden custody is unrepresentable);
 *
 * - DETERMINISM: planId, legId and planDigest are pure functions of the
 *   canonical input projection; the plan is deep-frozen;
 *
 * - HONEST CANDIDATE STATUS: a plan is an EXECUTABLE_CANDIDATE only when
 *   every leg's authorization verdict is ALLOW/accepted/allowed and every
 *   grounding is fresh; otherwise it is emitted as an INELIGIBLE_CANDIDATE
 *   with its reasons — never silently dropped.
 */

import { ValidationError } from "@payswap/protocol";
import { contentDigest } from "@payswap/onchain-security";
import type { ExecutionMode } from "@payswap/connectors";
import type { AdapterLifecycleStage, RailEnvironmentClass } from "@payswap/onchain-adapters";
import type { OnchainLaneProof } from "@payswap/mixed-rail";
import type {
  CapabilityObservation,
  ConnectedCapabilityInstance,
  PayoutDestination,
  PayoutGateReport,
} from "@payswap/connectors";
import type {
  ExpectedStateDiff,
  GateDecision,
  PreparedWrite,
} from "@payswap/onchain-security";
import type { MerchantSettlementResult } from "@payswap/payment";
import {
  assertCustodyContinuity,
  ROUTE_LEG_FAILURE_SEMANTICS,
  type AuthorizationLineage,
  type CustodyTransfer,
  type LegFailureSemantics,
  type LegFinalityContract,
  type LegStateGrounding,
  type PlannedLegAmount,
} from "./leg-contracts.js";
import type { FiatLegKind } from "./fiat-legs.js";
import type { OnchainLegKind } from "./onchain-legs.js";
import type { StripeNativeSettlementUnavailableMarker } from "./stripe-legs.js";

export class InvalidRoutePlanError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRoutePlanError";
  }
}

export const ROUTE_LEG_KINDS = [
  "FIAT_PSP_COLLECT",
  "PSP_STABLECOIN_ISSUANCE",
  "OFF_RAMP_PAYOUT",
  "BANK_SETTLEMENT",
  "ONCHAIN_DEX_SWAP",
  "ONCHAIN_TRANSFER",
  "ONCHAIN_BRIDGE",
  "STRIPE_CRYPTO_SETTLEMENT",
] as const;
export type RouteLegKind = FiatLegKind | OnchainLegKind | "STRIPE_CRYPTO_SETTLEMENT";

/** Fields every route leg carries (the chain of custody for authority/state/finality/evidence/custody/failure). */
export interface RouteLegBase {
  /** Deterministic: `${planId}:leg:${hopIndex}:${legKind}`. */
  readonly legId: string;
  readonly legKind: RouteLegKind;
  readonly hopIndex: number;
  /** The intent this leg executes — referenced, never re-declared. */
  readonly intentRef: string;
  readonly authorizationLineage: AuthorizationLineage;
  readonly stateGrounding: LegStateGrounding;
  readonly finality: LegFinalityContract;
  readonly custody: CustodyTransfer;
  readonly failureSemantics: LegFailureSemantics;
  readonly evidenceRefs: readonly string[];
}

// --- Fiat legs ----------------------------------------------------------------

export interface FiatPspCollectLeg extends RouteLegBase {
  readonly legKind: "FIAT_PSP_COLLECT";
  readonly instance: ConnectedCapabilityInstance;
  readonly observation: CapabilityObservation;
  readonly plannedAmount: PlannedLegAmount;
}

export interface PspStablecoinIssuanceLeg extends RouteLegBase {
  readonly legKind: "PSP_STABLECOIN_ISSUANCE";
  readonly instance: ConnectedCapabilityInstance;
  readonly observation: CapabilityObservation;
  readonly plannedAmount: PlannedLegAmount;
}

export interface OffRampPayoutLeg extends RouteLegBase {
  readonly legKind: "OFF_RAMP_PAYOUT";
  readonly instance: ConnectedCapabilityInstance;
  readonly observation: CapabilityObservation;
  readonly destination: PayoutDestination;
  /** The REAL payout gate report — the leg's authorization verdict. */
  readonly gate: PayoutGateReport;
  readonly plannedAmount: PlannedLegAmount;
}

export interface BankSettlementLeg extends RouteLegBase {
  readonly legKind: "BANK_SETTLEMENT";
  /** Derived via the canonical settlementResultFrom — never re-declared. */
  readonly settlementResult: MerchantSettlementResult;
  readonly plannedAmount: PlannedLegAmount;
}

// --- Onchain legs --------------------------------------------------------------

export interface OnchainDexSwapLeg extends RouteLegBase {
  readonly legKind: "ONCHAIN_DEX_SWAP";
  /** The REAL mixed-rail lane proof (engine-selected, gate-ALLOWed, observation-grounded). */
  readonly lane: OnchainLaneProof;
  readonly plannedAmount: PlannedLegAmount;
}

export interface OnchainTransferLeg extends RouteLegBase {
  readonly legKind: "ONCHAIN_TRANSFER";
  /** The kernel-prepared write (prepareWrite artifact, content-addressed). */
  readonly write: PreparedWrite;
  /** The deterministic gate verdict — ALLOW, or an honest BLOCK/UNKNOWN. */
  readonly gateDecision: GateDecision;
  readonly expectedDiff: ExpectedStateDiff;
  readonly plannedAmount: PlannedLegAmount;
}

export interface OnchainBridgeLeg extends RouteLegBase {
  readonly legKind: "ONCHAIN_BRIDGE";
  readonly write: PreparedWrite;
  readonly gateDecision: GateDecision;
  readonly expectedDiff: ExpectedStateDiff;
  /** The arrival chain (the bridge's destination side). */
  readonly arrivalChainKey: string;
  readonly plannedAmount: PlannedLegAmount;
}

// --- Stripe leg (Mode A: the native provider capability) -------------------------

export interface StripeCryptoSettlementLeg extends RouteLegBase {
  readonly legKind: "STRIPE_CRYPTO_SETTLEMENT";
  /** Mode A only: the native Stripe crypto settlement hop (Mode B is the external route plan shape, not a leg kind). */
  readonly mode: "NATIVE_STRIPE_CRYPTO_SETTLEMENT";
  /** Honest marker: the actual integration awaits the P4-W1-003 research authority. */
  readonly awaitingAuthority: "P4-W1-003";
  readonly plannedAmount: PlannedLegAmount;
}

export type RouteLeg =
  | FiatPspCollectLeg
  | PspStablecoinIssuanceLeg
  | OffRampPayoutLeg
  | BankSettlementLeg
  | OnchainDexSwapLeg
  | OnchainTransferLeg
  | OnchainBridgeLeg
  | StripeCryptoSettlementLeg;

// --- The plan -------------------------------------------------------------------

export const ROUTE_PLAN_CANDIDATE_STATUSES = [
  "EXECUTABLE_CANDIDATE",
  "PROVIDER_NATIVE_BASELINE",
  "INELIGIBLE_CANDIDATE",
] as const;
export type RoutePlanCandidateStatus = (typeof ROUTE_PLAN_CANDIDATE_STATUSES)[number];

export const ROUTE_COMPOSITION_CLASSES = ["FIAT_ONLY", "ONCHAIN_ONLY", "MIXED"] as const;
export type RouteCompositionClass = (typeof ROUTE_COMPOSITION_CLASSES)[number];

/** Why an emitted plan is not executable — recorded verbatim, never silent. */
export interface RoutePlanIneligibilityReason {
  readonly legId: string;
  readonly code: string;
  readonly detail: string;
}

export interface RoutePlan {
  /** Deterministic: `route-plan:${intentId}:${shapeId}`. */
  readonly planId: string;
  /** The canonical shape this plan instantiates (e.g. `mixed-dex-offramp`). */
  readonly shapeId: string;
  readonly intentRef: string;
  readonly compositionClass: RouteCompositionClass;
  readonly executionMode: ExecutionMode;
  /** INV-C08: this plan IS the incumbent provider's own native flow. */
  readonly isProviderNativeBaseline: boolean;
  readonly candidateStatus: RoutePlanCandidateStatus;
  /** Present only on INELIGIBLE_CANDIDATE plans (honest, per-leg reasons). */
  readonly ineligibilityReasons: readonly RoutePlanIneligibilityReason[];
  readonly legs: readonly RouteLeg[];
  /** The kernel adapter lifecycle stages this plan exercised (projection). */
  readonly lifecycleStages: readonly AdapterLifecycleStage[];
  /** The environment classes touched (from the frozen kernel registry). */
  readonly environmentClasses: readonly RailEnvironmentClass[];
  /** Mode B plans only: the honest native-settlement-unavailable marker. */
  readonly stripeNativeSettlementUnavailable?: StripeNativeSettlementUnavailableMarker;
  readonly evidenceRefs: readonly string[];
  /** contentDigest of the canonical plan projection (deterministic). */
  readonly planDigest: string;
}

function legIsExecutable(leg: RouteLeg): boolean {
  switch (leg.legKind) {
    case "ONCHAIN_DEX_SWAP":
      return leg.lane.gateDecision.decision === "ALLOW";
    case "ONCHAIN_TRANSFER":
    case "ONCHAIN_BRIDGE":
      return leg.gateDecision.decision === "ALLOW";
    case "OFF_RAMP_PAYOUT":
      return leg.gate.allowed;
    case "FIAT_PSP_COLLECT":
    case "PSP_STABLECOIN_ISSUANCE":
      return leg.stateGrounding.groundingFailures.length === 0;
    case "BANK_SETTLEMENT":
      return true;
    case "STRIPE_CRYPTO_SETTLEMENT":
      return leg.authorizationLineage.legAuthorization.kind ===
        "PROVIDER_VERIFIED_STRIPE_ELIGIBILITY";
  }
}

function legIneligibilityReasons(leg: RouteLeg): RoutePlanIneligibilityReason[] {
  const reasons: RoutePlanIneligibilityReason[] = [];
  switch (leg.legKind) {
    case "ONCHAIN_DEX_SWAP":
    case "ONCHAIN_TRANSFER":
    case "ONCHAIN_BRIDGE": {
      const decision =
        leg.legKind === "ONCHAIN_DEX_SWAP" ? leg.lane.gateDecision : leg.gateDecision;
      if (decision.decision === "BLOCK") {
        reasons.push({
          legId: leg.legId,
          code: "ONCHAIN_GATE_BLOCK",
          detail: decision.reasons.map((reason) => reason.message).join("; "),
        });
      } else if (decision.decision === "UNKNOWN") {
        reasons.push({
          legId: leg.legId,
          code: "ONCHAIN_GATE_UNKNOWN",
          detail: decision.dimensions.map((dimension) => dimension.message).join("; "),
        });
      }
      break;
    }
    case "OFF_RAMP_PAYOUT":
      if (!leg.gate.allowed) {
        reasons.push({
          legId: leg.legId,
          code: "PAYOUT_GATE_CLOSED",
          detail: leg.gate.checks
            .filter((check) => !check.pass)
            .map((check) => check.reason ?? check.gate)
            .join("; "),
        });
      }
      break;
    default:
      break;
  }
  for (const failure of leg.stateGrounding.groundingFailures) {
    reasons.push({ legId: leg.legId, code: "LEG_GROUNDING_FAILURE", detail: failure });
  }
  return reasons;
}

function legLifecycleStages(leg: RouteLeg): AdapterLifecycleStage[] {
  switch (leg.legKind) {
    case "ONCHAIN_DEX_SWAP":
      return [...leg.lane.lifecycleStages];
    case "ONCHAIN_TRANSFER":
    case "ONCHAIN_BRIDGE":
      return ["observe", "prepare"];
    default:
      return [];
  }
}

/**
 * Constructs a route plan: validates every leg contract, enforces the
 * custody-CHAIN law, derives the honest candidate status from the legs'
 * authorization verdicts and groundings, and content-addresses the plan.
 * Deterministic: same legs → same plan (ids and digest are pure functions
 * of the canonical projection).
 */
export function buildRoutePlan(input: {
  readonly shapeId: string;
  readonly intentRef: string;
  readonly compositionClass: RouteCompositionClass;
  readonly executionMode: ExecutionMode;
  readonly isProviderNativeBaseline: boolean;
  readonly legs: readonly RouteLeg[];
  readonly environmentClasses: readonly RailEnvironmentClass[];
  readonly stripeNativeSettlementUnavailable?: StripeNativeSettlementUnavailableMarker;
}): RoutePlan {
  if (input.legs.length === 0) {
    throw new InvalidRoutePlanError(
      "a route plan requires at least one leg — an empty plan is never fabricated",
    );
  }
  if (input.legs.length > 8) {
    throw new InvalidRoutePlanError(
      "a route plan allows at most 8 legs — an unbounded hop count is never authorized",
    );
  }
  const planId = `route-plan:${input.intentRef}:${input.shapeId}`;
  const legs = Object.freeze(
    input.legs.map((leg, index) => {
      if (leg.hopIndex !== index) {
        throw new InvalidRoutePlanError(
          `leg ${index} carries hopIndex ${leg.hopIndex} — hop indexes are contiguous from zero`,
        );
      }
      if (leg.intentRef !== input.intentRef) {
        throw new InvalidRoutePlanError(
          `leg '${leg.legId}' references intent '${leg.intentRef}', not '${input.intentRef}' — every leg references the ONE canonical intent`,
        );
      }
      if (leg.legId !== `${planId}:leg:${index}:${leg.legKind}`) {
        throw new InvalidRoutePlanError(
          `leg ${index} id '${leg.legId}' must be the deterministic '${planId}:leg:${index}:${leg.legKind}'`,
        );
      }
      if (leg.failureSemantics !== ROUTE_LEG_FAILURE_SEMANTICS) {
        throw new InvalidRoutePlanError(
          `leg '${leg.legId}' must carry the frozen ROUTE_LEG_FAILURE_SEMANTICS contract (INV-X01/X02/X03 are structural, not configurable)`,
        );
      }
      if (leg.finality.finalityNeverAssumed !== true) {
        throw new InvalidRoutePlanError(
          `leg '${leg.legId}' must carry finalityNeverAssumed: true (INV-F06)`,
        );
      }
      if (leg.evidenceRefs.length === 0) {
        throw new InvalidRoutePlanError(
          `leg '${leg.legId}' requires non-empty evidenceRefs (INV-E02)`,
        );
      }
      return leg;
    }),
  );
  assertCustodyContinuity(legs.map((leg) => leg.custody));

  const ineligibilityReasons = Object.freeze(
    legs.flatMap((leg) => legIneligibilityReasons(leg)),
  );
  const executable = legs.every((leg) => legIsExecutable(leg));
  const candidateStatus: RoutePlanCandidateStatus = !executable
    ? "INELIGIBLE_CANDIDATE"
    : input.isProviderNativeBaseline
      ? "PROVIDER_NATIVE_BASELINE"
      : "EXECUTABLE_CANDIDATE";

  const evidenceRefs = Object.freeze([
    ...new Set(legs.flatMap((leg) => leg.evidenceRefs)),
  ]);
  const lifecycleStages = Object.freeze([...new Set(legs.flatMap(legLifecycleStages))]);
  const environmentClasses = Object.freeze([...input.environmentClasses]);

  const planDigest = contentDigest({
    planId,
    shapeId: input.shapeId,
    intentRef: input.intentRef,
    compositionClass: input.compositionClass,
    executionMode: input.executionMode,
    isProviderNativeBaseline: input.isProviderNativeBaseline,
    candidateStatus,
    legs: legs.map((leg) => ({
      legId: leg.legId,
      legKind: leg.legKind,
      authorization: leg.authorizationLineage.legAuthorization.kind,
      custody: leg.custody,
      plannedAmount: leg.plannedAmount,
    })),
  });

  return deepFreeze({
    planId,
    shapeId: input.shapeId,
    intentRef: input.intentRef,
    compositionClass: input.compositionClass,
    executionMode: input.executionMode,
    isProviderNativeBaseline: input.isProviderNativeBaseline,
    candidateStatus,
    ineligibilityReasons,
    legs,
    lifecycleStages,
    environmentClasses,
    ...(input.stripeNativeSettlementUnavailable !== undefined
      ? { stripeNativeSettlementUnavailable: input.stripeNativeSettlementUnavailable }
      : {}),
    evidenceRefs,
    planDigest,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (Object.isFrozen(value)) {
      return value;
    }
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
