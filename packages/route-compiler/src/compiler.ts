/**
 * @payswap/route-compiler — the deterministic route compiler (Work Order
 * P4-W4-001).
 *
 * compileMoneyMovementRoute compiles ONE canonical Money Movement Intent
 * into candidate route plans spanning fiat and onchain rails. It is a PURE
 * FUNCTION OF ITS INPUTS:
 *
 * - every input collection is canonically ordered (venue packs by venueId,
 *   instances/observations/activations/destinations/evidence by id) so the
 *   compiled plan set is invariant under input permutation;
 * - every instant is caller-supplied (`at`); there is no ambient clock and
 *   no randomness anywhere;
 * - shape enumeration is a fixed deterministic function of the intent's
 *   origin/destination kinds.
 *
 * Representative journeys (the work order's four routes):
 * - ONCHAIN_WALLET → BANK_ACCOUNT: `provider-native-offramp` (the
 *   incumbent's own wallet→fiat→bank flow — INV-C08 baseline) and
 *   `mixed-dex-offramp` (crypto→DEX→stablecoin→off-ramp→bank);
 * - EXTERNAL_PROVIDER_ACCOUNT → ONCHAIN_RECIPIENT: `provider-native-onramp`
 *   (the incumbent's fiat→stablecoin→chain flow) and `mixed-psp-onramp`
 *   (fiat→PSP→stablecoin→chain→recipient);
 * - ONCHAIN_WALLET → ONCHAIN_RECIPIENT (cross-chain):
 *   `provider-native-bridge` (chainA→bridge→chainB natively) and
 *   `mixed-dex-bridge` (chainA→DEX→bridge→chainB); same-chain:
 *   `onchain-direct-transfer`;
 * - ONCHAIN_WALLET → STRIPE_MERCHANT_BALANCE:
 *   `stripe-native-crypto-settlement` (Mode A — requires provider-verified
 *   eligibility evidence; contracts modeled, awaiting P4-W1-003) and
 *   `stripe-external-payswap-route` (Mode B — the explicit external
 *   conversion/off-ramp route carrying the honest "Stripe balance
 *   settlement unavailable for this route" notice).
 *
 * Honesty laws:
 * - every enumerated shape is EITHER a plan OR an exclusion record with
 *   reasons — nothing is silently dropped;
 * - provider-native baselines are emitted exactly like composed plans (the
 *   compiler does not rank plans at all — ranking is downstream policy, so
 *   a baseline can never be structurally disadvantaged);
 * - opportunity observations (W3-002 kernel) inform routing context ONLY:
 *   each is resolved with resolveOpportunity + evaluateDiscoveryPolicy and
 *   recorded in the compilation provenance; discovery is STRUCTURALLY never
 *   authorization (discoveryPermitsExecution() === false is recorded on
 *   every compilation);
 * - FX is NEVER invented: cross-currency leg amounts are conversion-grounded
 *   on caller-supplied exact-rational rules, or honestly excluded.
 */

import { ValidationError, currencyCode } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/trust";
import { valueThroughRate, type ExactRational } from "@payswap/best-execution";
import type { BestExecutionPolicy, SwapRequest } from "@payswap/best-execution";
import type {
  AssetIdentity,
  OnchainSecurityPolicy,
  OnchainSecurityState,
} from "@payswap/onchain-security";
import { contentDigest } from "@payswap/onchain-security";
import { classifyChainEnvironment } from "@payswap/onchain-adapters";
import type { RailEnvironmentClass } from "@payswap/onchain-adapters";
import { canonicalAssetRef } from "@payswap/onchain-domain";
import type {
  AssetObservation,
  ConnectedProtocolInstance,
} from "@payswap/onchain-domain";
import type { VenueExtensionPack } from "@payswap/onchain-venues";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectedCapabilityInstance,
  ConnectedInstanceActivation,
  PayoutDestination,
} from "@payswap/connectors";
import {
  defineSettlementDestination,
  settlementResultFrom,
} from "@payswap/payment";
import type { MerchantSettlementDestination, MerchantSettlementResult } from "@payswap/payment";
import {
  evaluateDiscoveryPolicy,
  resolveOpportunity,
  discoveryPermitsExecution,
  type DiscoveryPolicyEvaluation,
  type FinancialOpportunity,
} from "@payswap/onchain-opportunities";
import type { OnchainLaneProof } from "@payswap/mixed-rail";
import { validateMoneyMovementIntent, type MoneyMovementIntent } from "./intent.js";
import {
  ROUTE_LEG_FAILURE_SEMANTICS,
  type CustodyTransfer,
  type LegFinalityContract,
  type LegStateGrounding,
  type PlannedLegAmount,
} from "./leg-contracts.js";
import {
  capabilityObservationId,
  evaluateOffRampPayoutGate,
  groundFiatLeg,
  isProviderNativeBaselineCapability,
  offRampPayoutRequestInit,
  settlementDestinationForIntent,
  type FiatObservationFreshnessPolicy,
} from "./fiat-legs.js";
import {
  discoverSwapLane,
  onchainObservationIsFresh,
  prepareOnchainTransferOrBridgeLeg,
  type KernelPreparedLegArtifacts,
} from "./onchain-legs.js";
import {
  stripeEligibilityEvidenceIsFresh,
  stripeNativeSettlementUnavailable,
  validateStripeCryptoSettlementEligibility,
  STRIPE_CRYPTO_SETTLEMENT_AUTHORITY,
  type StripeCryptoSettlementEligibilityEvidence,
  type StripeNativeSettlementUnavailableMarker,
} from "./stripe-legs.js";
import { buildRoutePlan, type RouteLeg, type RoutePlan } from "./route-plan.js";

/** Raised when compilation input is malformed (fail closed, never guessed). */
export class RouteCompilerError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "RouteCompilerError";
  }
}

// ---------------------------------------------------------------------------
// Compiler input
// ---------------------------------------------------------------------------

/** An exact conversion grounding between two currencies (minor-unit → minor-unit exact rational). */
export interface FiatConversionRule {
  readonly ruleId: string;
  readonly fromCurrency: string;
  readonly toCurrency: string;
  /** Exact rational: toCurrency minor units produced per fromCurrency minor unit. */
  readonly rate: ExactRational;
  /** The grounding source that declares this rate (peg declaration, policy — never the compiler). */
  readonly declaredBy: string;
}

/** Explicit compilation inputs that are routing hints, NOT intent data. */
export interface RoutingHints {
  /**
   * The execution-plane asset identity of the intent's ORIGIN (the venue
   * pools, security allowlists and policy conversions are keyed by the
   * token-addressed AssetIdentity; the intent itself speaks the canonical
   * observation asset ref — the mapping is an explicit input, never guessed).
   */
  readonly originExecutionAsset?: AssetIdentity;
  /**
   * The execution-plane asset identity of the intent's ONCHAIN destination
   * (same law as originExecutionAsset).
   */
  readonly destinationExecutionAsset?: AssetIdentity;
  /** The intermediate stablecoin for crypto→DEX→stablecoin routes. */
  readonly intermediateStablecoin?: AssetIdentity;
  /** The deposit asset the bridge expects on the origin chain (mixed chainA→DEX→bridge routes). */
  readonly bridgeDepositAsset?: AssetIdentity;
  /** The bridge contract address on the origin chain (bridge routes). */
  readonly bridgeContractAddress?: string;
  /** The off-ramp provider's onchain receiving address per chain. */
  readonly offRampDeposit?: {
    readonly providerName: string;
    readonly chainKey: string;
    readonly accountRef: string;
  };
  /** The onramp issuer's delivery address on the destination chain (mixed fiat→PSP→stablecoin routes). */
  readonly onrampDeliveryAddress?: string;
  /** The connector capability id that executes off-ramp payouts (explicit, never inferred). */
  readonly offRampPayoutCapabilityId?: string;
}

export interface RouteCompilerInput {
  readonly intent: MoneyMovementIntent;
  /** Deterministic compile instant (ms, caller-supplied). */
  readonly at: number;
  // The onchain execution plane (REAL venue extension packs behind the neutral port)
  readonly venuePacks: readonly VenueExtensionPack[];
  readonly bestExecutionPolicy: BestExecutionPolicy;
  readonly onchainSecurity: {
    readonly policy: OnchainSecurityPolicy;
    readonly state: OnchainSecurityState;
  };
  readonly onchainInstances: readonly ConnectedProtocolInstance[];
  readonly assetObservations: readonly AssetObservation[];
  // The fiat plane (connector capability law: instance + observation)
  readonly fiatDefinitions: readonly CapabilityDefinition[];
  readonly fiatInstances: readonly ConnectedCapabilityInstance[];
  readonly fiatObservations: readonly CapabilityObservation[];
  readonly fiatObservationMaxAgeSeconds: number;
  /** Activation records carrying transfer-out grants (the off-ramp payout gate). */
  readonly fiatActivations: readonly ConnectedInstanceActivation[];
  /** External settlement destinations (the Mode B merchant bank arrival). */
  readonly settlementDestinations: readonly MerchantSettlementDestination[];
  // Conversion grounding (no FX fabrication)
  readonly conversionRules: readonly FiatConversionRule[];
  // Stripe Mode A eligibility evidence (provider-verified-effects law)
  readonly stripeEligibilityEvidence: readonly StripeCryptoSettlementEligibilityEvidence[];
  // Discovery-tier context (W3-002 kernel — informs routing, never authorizes)
  readonly opportunityObservations: readonly FinancialOpportunity[];
  readonly routingHints?: RoutingHints;
}

// ---------------------------------------------------------------------------
// Compilation output
// ---------------------------------------------------------------------------

/** An honestly excluded shape: enumerated, never compiled, reasons recorded. */
export interface ExcludedRouteShape {
  readonly shapeId: string;
  readonly reasons: readonly string[];
}

/** The W3-002 kernel composition record: each opportunity resolved + policy-evaluated at the compile instant. */
export interface OpportunityGroundingRecord {
  readonly opportunityId: string;
  readonly family: string;
  readonly resolvedStatus: "CURRENT" | "STALE";
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly flags: readonly string[];
  readonly evaluatedAt: number;
}

export interface RouteCompilationResult {
  readonly status: "ROUTES_COMPILED" | "NO_COMPILABLE_ROUTE";
  readonly intentRef: string;
  readonly compiledAt: number;
  readonly plans: readonly RoutePlan[];
  readonly exclusions: readonly ExcludedRouteShape[];
  readonly opportunityGrounding: readonly OpportunityGroundingRecord[];
  /** Structural: the discovery tier never authorizes execution (W3-002 law, composed verbatim). */
  readonly discoveryPermitsExecution: false;
  /** contentDigest over the canonical compilation projection (deterministic). */
  readonly compilationDigest: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function intentAssetIdentity(
  intent: MoneyMovementIntent,
  hints: RoutingHints | undefined,
): AssetIdentity {
  if (intent.origin.kind !== "ONCHAIN_WALLET") {
    throw new RouteCompilerError("onchain shapes require an ONCHAIN_WALLET origin");
  }
  if (hints?.originExecutionAsset !== undefined) {
    if (
      hints.originExecutionAsset.chain !== intent.origin.chainKey ||
      hints.originExecutionAsset.symbol !== intent.origin.symbol
    ) {
      throw new RouteCompilerError(
        "the originExecutionAsset routing hint must match the intent origin's chain and symbol — execution identities never drift from the canonical intent",
      );
    }
    return hints.originExecutionAsset;
  }
  return {
    chain: intent.origin.chainKey,
    assetId: intent.origin.assetId,
    symbol: intent.origin.symbol,
  };
}

function destinationAssetIdentity(
  intent: MoneyMovementIntent,
  hints: RoutingHints | undefined,
): AssetIdentity {
  if (intent.destination.kind !== "ONCHAIN_RECIPIENT") {
    throw new RouteCompilerError("onchain arrival shapes require an ONCHAIN_RECIPIENT destination");
  }
  if (hints?.destinationExecutionAsset !== undefined) {
    if (
      hints.destinationExecutionAsset.chain !== intent.destination.chainKey ||
      hints.destinationExecutionAsset.symbol !== intent.destination.symbol
    ) {
      throw new RouteCompilerError(
        "the destinationExecutionAsset routing hint must match the intent destination's chain and symbol — execution identities never drift from the canonical intent",
      );
    }
    return hints.destinationExecutionAsset;
  }
  return {
    chain: intent.destination.chainKey,
    assetId: intent.destination.assetId,
    symbol: intent.destination.symbol,
  };
}

function convertAmount(
  amount: AmountSpec,
  rules: readonly FiatConversionRule[],
  toCurrency: string,
): PlannedLegAmount {
  const sorted = [...rules].sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
  const rule = sorted.find(
    (candidate) =>
      candidate.fromCurrency === amount.currency && candidate.toCurrency === toCurrency,
  );
  if (rule === undefined) {
    return {
      basis: "UNKNOWN",
      reason: `no exact conversion grounding from '${amount.currency}' to '${toCurrency}' — the compiler never invents an FX rate`,
    };
  }
  const minorUnits = valueThroughRate(amount.minorUnits, rule.rate);
  if (minorUnits === "0") {
    return {
      basis: "UNKNOWN",
      reason: `conversion rule '${rule.ruleId}' grounds to zero minor units — an unusable grounding is surfaced, never rounded up`,
    };
  }
  return {
    basis: "CONVERSION_GROUNDED",
    amount: { currency: toCurrency, minorUnits },
    ruleId: rule.ruleId,
  };
}

function intentDeclaredAmount(intent: MoneyMovementIntent): PlannedLegAmount {
  return { basis: "INTENT_DECLARED", amount: intent.originAmount };
}

function onchainLegGrounding(
  assetObservations: readonly AssetObservation[],
  chainKey: string,
  asset: { readonly chain: string; readonly assetId: string; readonly symbol: string },
  accountRef: string,
  at: number,
): LegStateGrounding {
  // The canonical grounding law (exactly as the mixed-rail lane discovery
  // matches): observations are keyed by the canonical asset ref derived
  // from (chainKey, symbol) — the execution-plane token address is a
  // different identity system, never the observation key.
  const expectedAssetRef = canonicalAssetRef(chainKey, asset.symbol);
  const sorted = [...assetObservations].sort((a, b) =>
    a.observationId < b.observationId ? -1 : 1,
  );
  const observation = sorted.find(
    (candidate) =>
      candidate.chainKey === chainKey &&
      candidate.assetId === expectedAssetRef &&
      candidate.location.accountRef === accountRef,
  );
  if (observation === undefined) {
    return {
      observations: [],
      groundingFailures: [
        `no canonical asset observation grounds the '${accountRef}' position for asset '${expectedAssetRef}' on chain '${chainKey}' — the hop is not grounded (INV-C05 discipline: a catalogue alone never grounds execution)`,
      ],
    };
  }
  const fresh = onchainObservationIsFresh(observation, at);
  return {
    observations: [
      {
        observationKind: "AssetObservation",
        observationId: observation.observationId,
        fresh,
        freshnessRule: "kernel:isObservationFresh",
      },
    ],
    groundingFailures: fresh
      ? []
      : [
          `asset observation '${observation.observationId}' is stale at the compile instant — the position is re-observed, never routed on stale state (kernel freshness law)`,
        ],
  };
}

function fiatLegGrounding(
  instance: ConnectedCapabilityInstance | undefined,
  observations: readonly CapabilityObservation[],
  at: number,
  freshnessPolicy: FiatObservationFreshnessPolicy,
): { readonly grounding: LegStateGrounding; readonly observation?: CapabilityObservation } {
  if (instance === undefined) {
    return {
      grounding: {
        observations: [],
        groundingFailures: [
          "no connected fiat instance grounds this hop — provider capabilities are observed, never assumed",
        ],
      },
    };
  }
  const sorted = [...observations].sort((a, b) =>
    a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.instanceId < b.instanceId ? -1 : 1,
  );
  const observation = sorted.find(
    (candidate) => candidate.instanceId === instance.instanceId,
  );
  if (observation === undefined) {
    return {
      grounding: {
        observations: [],
        groundingFailures: [
          `no canonical capability observation grounds instance '${instance.instanceId}' — an unobserved instance never grounds a hop (INV-C05)`,
        ],
      },
    };
  }
  const result = groundFiatLeg({ instance, observation, at, freshnessPolicy });
  if (result.status === "STALE") {
    return {
      grounding: {
        observations: [
          {
            observationKind: "CapabilityObservation",
            observationId: capabilityObservationId(observation),
            fresh: false,
            freshnessRule: `fiat-observation-max-age:${freshnessPolicy.maxAgeSeconds}s`,
          },
        ],
        groundingFailures: [result.reason],
      },
      observation,
    };
  }
  return {
    grounding: {
      observations: [
        {
          observationKind: "CapabilityObservation",
          observationId: capabilityObservationId(observation),
          fresh: true,
          freshnessRule: `fiat-observation-max-age:${freshnessPolicy.maxAgeSeconds}s`,
        },
      ],
      groundingFailures: [],
    },
    observation: result.grounding.observation,
  };
}

/**
 * The grounding of a PROSPECTIVE hop (a hop whose input position does not
 * exist yet — it is created by an upstream engine-selected swap): grounded
 * in the engine-validated quote and the funded input-asset observation of
 * the upstream lane, never in a fabricated future position.
 */
function prospectiveHopGrounding(lane: OnchainLaneProof): LegStateGrounding {
  return {
    observations: [
      {
        observationKind: "AssetObservation",
        observationId: lane.inputAssetObservation.observationId,
        fresh: true,
        freshnessRule: "kernel:isObservationFresh",
      },
      {
        observationKind: "VenueQuote",
        observationId: lane.quote.quoteId,
        fresh: true,
        freshnessRule: "kernel:isQuoteStale",
      },
    ],
    groundingFailures: [],
  };
}

function onchainFinality(
  model: "PROBABILISTIC" | "DETERMINISTIC" | "INSTANT" | "HYBRID",
): LegFinalityContract {
  return {
    finalityNeverAssumed: true,
    candidates: [{ candidateOnly: true, model }],
  };
}

function providerOwnedFinality(providerName: string): LegFinalityContract {
  return {
    finalityNeverAssumed: true,
    candidates: [{ candidateOnly: true, model: "PROVIDER_OWNED", providerName }],
  };
}

function emptyOnchainFinality(): LegFinalityContract {
  return { finalityNeverAssumed: true, candidates: [] };
}

function routeHashFor(planId: string, hopIndex: number, legKind: string): string {
  return contentDigest({ planId, hopIndex, legKind });
}

function settlementInstructionBinding(intentId: string, shapeId: string) {
  const instructionId = `settlement-instruction:${intentId}:${shapeId}`;
  return { instructionId, instructionDigest: contentDigest({ instructionId }) };
}

// ---------------------------------------------------------------------------
// Leg builders (each composes the REAL kernel surface)
// ---------------------------------------------------------------------------

interface LegBuildContext {
  readonly input: RouteCompilerInput;
  readonly intent: MoneyMovementIntent;
  readonly shapeId: string;
  readonly planId: string;
}

function makeSwapLeg(
  ctx: LegBuildContext,
  hopIndex: number,
  lane: OnchainLaneProof,
  custody: CustodyTransfer,
): RouteLeg {
  return {
    legId: `${ctx.planId}:leg:${hopIndex}:ONCHAIN_DEX_SWAP`,
    legKind: "ONCHAIN_DEX_SWAP",
    hopIndex,
    intentRef: ctx.intent.intentId,
    authorizationLineage: {
      intentRef: ctx.intent.intentId,
      intentAuthorizationRef: ctx.intent.intentAuthorizationRef,
      legAuthorization: {
        kind: "ONCHAIN_GATE_DECISION",
        gateDecision: lane.gateDecision,
        writeDigest: lane.write.writeDigest,
        routeRef: lane.routeRef,
        routeHash: lane.routeHash,
      },
    },
    stateGrounding: {
      observations: [
        {
          observationKind: "AssetObservation",
          observationId: lane.inputAssetObservation.observationId,
          fresh: true,
          freshnessRule: "kernel:isObservationFresh",
        },
        {
          observationKind: "VenueQuote",
          observationId: lane.quote.quoteId,
          fresh: true,
          freshnessRule: "kernel:isQuoteStale",
        },
        {
          observationKind: "HealthObservation",
          observationId: `health:${lane.venueId}`,
          fresh: true,
          freshnessRule: "kernel:isHealthObservationStale",
        },
      ],
      groundingFailures: [],
    },
    finality: onchainFinality(lane.quote.timeToSettlement.finalityModel),
    custody,
    failureSemantics: ROUTE_LEG_FAILURE_SEMANTICS,
    evidenceRefs: lane.evidenceRefs,
    lane,
    plannedAmount: {
      basis: "QUOTE_GROUNDED",
      amount: lane.quote.slippage.worstCaseOutput,
      quoteId: lane.quote.quoteId,
    },
  };
}

function makeKernelWriteLeg(
  ctx: LegBuildContext,
  hopIndex: number,
  legKind: "ONCHAIN_TRANSFER" | "ONCHAIN_BRIDGE",
  artifacts: KernelPreparedLegArtifacts,
  custody: CustodyTransfer,
  grounding: LegStateGrounding,
  plannedAmount: PlannedLegAmount,
  arrivalChainKey: string,
): RouteLeg {
  const base = {
    legId: `${ctx.planId}:leg:${hopIndex}:${legKind}`,
    legKind,
    hopIndex,
    intentRef: ctx.intent.intentId,
    authorizationLineage: {
      intentRef: ctx.intent.intentId,
      intentAuthorizationRef: ctx.intent.intentAuthorizationRef,
      legAuthorization: {
        kind: "ONCHAIN_GATE_DECISION" as const,
        gateDecision: artifacts.gateDecision,
        writeDigest: artifacts.write.writeDigest,
        routeRef: artifacts.write.route.routeId,
        routeHash: artifacts.write.route.routeHash,
      },
    },
    stateGrounding: grounding,
    finality: emptyOnchainFinality(),
    custody,
    failureSemantics: ROUTE_LEG_FAILURE_SEMANTICS,
    evidenceRefs: [
      `write:${artifacts.write.writeDigest}`,
      ...artifacts.gateDecision.evidenceRefs,
      ...custody.evidenceRefs,
    ],
    write: artifacts.write,
    gateDecision: artifacts.gateDecision,
    expectedDiff: artifacts.expectedDiff,
    plannedAmount,
  };
  return (
    legKind === "ONCHAIN_BRIDGE"
      ? { ...base, arrivalChainKey }
      : base
  ) as RouteLeg;
}

function makeFiatCollectLeg(
  ctx: LegBuildContext,
  hopIndex: number,
  custody: CustodyTransfer,
  grounding: LegStateGrounding,
  instance: ConnectedCapabilityInstance,
  observation: CapabilityObservation,
): RouteLeg {
  return {
    legId: `${ctx.planId}:leg:${hopIndex}:FIAT_PSP_COLLECT`,
    legKind: "FIAT_PSP_COLLECT",
    hopIndex,
    intentRef: ctx.intent.intentId,
    authorizationLineage: {
      intentRef: ctx.intent.intentId,
      intentAuthorizationRef: ctx.intent.intentAuthorizationRef,
      legAuthorization: {
        kind: "INTENT_AUTHORIZATION_ONLY",
        reason:
          "the payer's charge authorization IS the intent's authorization artifact; the PSP instance's authorization state is grounded in the fresh capability observation",
      },
    },
    stateGrounding: grounding,
    finality: providerOwnedFinality(instance.providerName),
    custody,
    failureSemantics: ROUTE_LEG_FAILURE_SEMANTICS,
    evidenceRefs: [
      `${capabilityObservationId(observation)}`,
      ...custody.evidenceRefs,
    ],
    instance,
    observation,
    plannedAmount: intentDeclaredAmount(ctx.intent),
  };
}

function makeIssuanceLeg(
  ctx: LegBuildContext,
  hopIndex: number,
  custody: CustodyTransfer,
  grounding: LegStateGrounding,
  instance: ConnectedCapabilityInstance,
  observation: CapabilityObservation,
  plannedAmount: PlannedLegAmount,
): RouteLeg {
  return {
    legId: `${ctx.planId}:leg:${hopIndex}:PSP_STABLECOIN_ISSUANCE`,
    legKind: "PSP_STABLECOIN_ISSUANCE",
    hopIndex,
    intentRef: ctx.intent.intentId,
    authorizationLineage: {
      intentRef: ctx.intent.intentId,
      intentAuthorizationRef: ctx.intent.intentAuthorizationRef,
      legAuthorization: {
        kind: "INTENT_AUTHORIZATION_ONLY",
        reason:
          "the on-ramp issuance executes under the intent authorization; the issuer's eligibility is grounded in the fresh capability observation",
      },
    },
    stateGrounding: grounding,
    finality: providerOwnedFinality(instance.providerName),
    custody,
    failureSemantics: ROUTE_LEG_FAILURE_SEMANTICS,
    evidenceRefs: [
      `${capabilityObservationId(observation)}`,
      ...custody.evidenceRefs,
    ],
    instance,
    observation,
    plannedAmount,
  };
}

function makeOffRampPayoutLeg(
  ctx: LegBuildContext,
  hopIndex: number,
  custody: CustodyTransfer,
  grounding: LegStateGrounding,
  instance: ConnectedCapabilityInstance,
  observation: CapabilityObservation,
  destination: PayoutDestination,
  gate: ReturnType<typeof evaluateOffRampPayoutGate>,
  plannedAmount: PlannedLegAmount,
): RouteLeg {
  return {
    legId: `${ctx.planId}:leg:${hopIndex}:OFF_RAMP_PAYOUT`,
    legKind: "OFF_RAMP_PAYOUT",
    hopIndex,
    intentRef: ctx.intent.intentId,
    authorizationLineage: {
      intentRef: ctx.intent.intentId,
      intentAuthorizationRef: ctx.intent.intentAuthorizationRef,
      legAuthorization: {
        kind: "PAYOUT_TRANSFER_OUT_GRANT",
        gate,
        transferOutAuthorizationId: `transfer-out:${ctx.intent.intentId}`,
      },
    },
    stateGrounding: grounding,
    finality: providerOwnedFinality(instance.providerName),
    custody,
    failureSemantics: ROUTE_LEG_FAILURE_SEMANTICS,
    evidenceRefs: [
      `${capabilityObservationId(observation)}`,
      `payout-gate:${instance.instanceId}`,
      ...custody.evidenceRefs,
    ],
    instance,
    observation,
    destination,
    gate,
    plannedAmount,
  };
}

function makeBankSettlementLeg(
  ctx: LegBuildContext,
  hopIndex: number,
  custody: CustodyTransfer,
  plannedAmount: PlannedLegAmount,
  settlementResult: MerchantSettlementResult,
): RouteLeg {
  return {
    legId: `${ctx.planId}:leg:${hopIndex}:BANK_SETTLEMENT`,
    legKind: "BANK_SETTLEMENT",
    hopIndex,
    intentRef: ctx.intent.intentId,
    authorizationLineage: {
      intentRef: ctx.intent.intentId,
      intentAuthorizationRef: ctx.intent.intentAuthorizationRef,
      legAuthorization: {
        kind: "INTENT_AUTHORIZATION_ONLY",
        reason:
          "the bank arrival is the evidenced consequence of the already-authorized payout hop; settlement finality belongs to the provider's settlement state machine (observed, never minted)",
      },
    },
    stateGrounding: { observations: [], groundingFailures: [] },
    finality: providerOwnedFinality("bank-settlement-observation"),
    custody,
    failureSemantics: ROUTE_LEG_FAILURE_SEMANTICS,
    evidenceRefs: [
      `settlement-destination:${settlementResult.destinationId}`,
      ...custody.evidenceRefs,
    ],
    settlementResult,
    plannedAmount,
  };
}

function makeStripeLeg(
  ctx: LegBuildContext,
  hopIndex: number,
  custody: CustodyTransfer,
  grounding: LegStateGrounding,
  evidenceId: string,
  plannedAmount: PlannedLegAmount,
): RouteLeg {
  return {
    legId: `${ctx.planId}:leg:${hopIndex}:STRIPE_CRYPTO_SETTLEMENT`,
    legKind: "STRIPE_CRYPTO_SETTLEMENT",
    hopIndex,
    intentRef: ctx.intent.intentId,
    authorizationLineage: {
      intentRef: ctx.intent.intentId,
      intentAuthorizationRef: ctx.intent.intentAuthorizationRef,
      legAuthorization: {
        kind: "PROVIDER_VERIFIED_STRIPE_ELIGIBILITY",
        evidenceId,
        awaitingAuthority: STRIPE_CRYPTO_SETTLEMENT_AUTHORITY,
      },
    },
    stateGrounding: grounding,
    finality: providerOwnedFinality("stripe"),
    custody,
    failureSemantics: ROUTE_LEG_FAILURE_SEMANTICS,
    evidenceRefs: [`stripe-eligibility:${evidenceId}`, ...custody.evidenceRefs],
    mode: "NATIVE_STRIPE_CRYPTO_SETTLEMENT",
    awaitingAuthority: STRIPE_CRYPTO_SETTLEMENT_AUTHORITY,
    plannedAmount,
  };
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

function opportunityGroundingRecords(
  opportunities: readonly FinancialOpportunity[],
  at: number,
): OpportunityGroundingRecord[] {
  return [...opportunities]
    .sort((a, b) => (a.opportunityId < b.opportunityId ? -1 : 1))
    .map((opportunity) => {
      const resolved = resolveOpportunity(opportunity, at);
      const policy: DiscoveryPolicyEvaluation = resolved.policy;
      return {
        opportunityId: opportunity.opportunityId,
        family: opportunity.family,
        resolvedStatus: resolved.status,
        eligible: policy.eligible,
        reasons: [...policy.reasons],
        flags: [...policy.flags],
        evaluatedAt: policy.evaluatedAt,
      };
    });
}

type BuildShapeFn = (
  shapeId: string,
  compositionClass: "FIAT_ONLY" | "ONCHAIN_ONLY" | "MIXED",
  executionMode: "PASS_THROUGH_NATIVE" | "COMPOSED_PAYSWAP" | "OPTIMIZED_MULTI_PROVIDER",
  isBaseline: boolean,
  legs: RouteLeg[],
  environmentClasses: readonly RailEnvironmentClass[],
  stripeMarker?: StripeNativeSettlementUnavailableMarker,
) => void;

/**
 * Compiles one canonical Money Movement Intent into candidate route plans.
 * Deterministic pure function: same input → deep-equal result with the same
 * compilationDigest. Enumerated shapes are plans or honest exclusions —
 * never silently dropped; provider-native baselines are emitted as
 * candidates, never structurally disadvantaged.
 */
export function compileMoneyMovementRoute(
  input: RouteCompilerInput,
): RouteCompilationResult {
  const intent = validateMoneyMovementIntent(input.intent);
  if (!Number.isInteger(input.at) || input.at < 0) {
    throw new RouteCompilerError(
      "compileMoneyMovementRoute: at must be a non-negative integer millisecond instant (no ambient clock)",
    );
  }
  if (input.at >= intent.expiresAt) {
    throw new RouteCompilerError(
      `the intent '${intent.intentId}' expired at ${intent.expiresAt}; the compile instant is ${input.at} — an expired authorization window compiles nothing`,
    );
  }

  const plans: RoutePlan[] = [];
  const exclusions: { shapeId: string; reasons: string[] }[] = [];
  const ctx: LegBuildContext = {
    input,
    intent,
    shapeId: "",
    planId: "",
  };

  const buildShape: BuildShapeFn = (
    shapeId,
    compositionClass,
    executionMode,
    isBaseline,
    legs,
    environmentClasses,
    stripeMarker,
  ) => {
    plans.push(
      buildRoutePlan({
        shapeId,
        intentRef: intent.intentId,
        compositionClass,
        executionMode,
        isProviderNativeBaseline: isBaseline,
        legs,
        environmentClasses,
        ...(stripeMarker !== undefined
          ? { stripeNativeSettlementUnavailable: stripeMarker }
          : {}),
      }),
    );
  };

  const originKind = intent.origin.kind;
  const destinationKind = intent.destination.kind;

  if (originKind === "ONCHAIN_WALLET" && destinationKind === "BANK_ACCOUNT") {
    compileOffRampShapes(ctx, buildShape, exclusions);
  } else if (
    originKind === "EXTERNAL_PROVIDER_ACCOUNT" &&
    destinationKind === "ONCHAIN_RECIPIENT"
  ) {
    compileOnRampShapes(ctx, buildShape, exclusions);
  } else if (originKind === "ONCHAIN_WALLET" && destinationKind === "ONCHAIN_RECIPIENT") {
    compileCrossChainShapes(ctx, buildShape, exclusions);
  } else if (
    originKind === "ONCHAIN_WALLET" &&
    destinationKind === "STRIPE_MERCHANT_BALANCE"
  ) {
    compileStripeShapes(ctx, buildShape, exclusions);
  } else {
    exclusions.push({
      shapeId: "unsupported-origin-destination-pair",
      reasons: [
        `no representative route shape is compiled for origin '${originKind}' → destination '${destinationKind}' — the honest empty state, never a fabricated route`,
      ],
    });
  }

  const opportunityGrounding = opportunityGroundingRecords(
    input.opportunityObservations,
    input.at,
  );

  const canonicalPlans = Object.freeze(
    [...plans].sort((a, b) => (a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0)),
  );
  const canonicalExclusions = Object.freeze(
    [...exclusions].sort((a, b) =>
      a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0,
    ),
  );

  const compilationDigest = contentDigest({
    intentRef: intent.intentId,
    compiledAt: input.at,
    plans: canonicalPlans.map((plan) => plan.planDigest),
    exclusions: canonicalExclusions,
    opportunityGrounding,
    discoveryPermitsExecution: discoveryPermitsExecution(),
  });

  return deepFreeze({
    status: canonicalPlans.length === 0 ? "NO_COMPILABLE_ROUTE" : "ROUTES_COMPILED",
    intentRef: intent.intentId,
    compiledAt: input.at,
    plans: canonicalPlans,
    exclusions: canonicalExclusions,
    opportunityGrounding: Object.freeze(opportunityGrounding),
    discoveryPermitsExecution: discoveryPermitsExecution(),
    compilationDigest,
  });
}

// ---------------------------------------------------------------------------
// Shape family: crypto → DEX → stablecoin → off-ramp → bank (+ the incumbent)
// ---------------------------------------------------------------------------

function compileOffRampShapes(
  ctx: LegBuildContext,
  buildShape: BuildShapeFn,
  exclusions: { shapeId: string; reasons: string[] }[],
): void {
  const { intent, input } = ctx;
  if (intent.origin.kind !== "ONCHAIN_WALLET" || intent.destination.kind !== "BANK_ACCOUNT") {
    throw new RouteCompilerError("internal: off-ramp shapes require wallet→bank intents");
  }
  const originAsset = intentAssetIdentity(intent, input.routingHints);
  const stablecoin = input.routingHints?.intermediateStablecoin;
  const offRampHint = input.routingHints?.offRampDeposit;
  const providerName = offRampHint?.providerName ?? "psp-mock";

  const chainEnv = classifyChainEnvironment(intent.origin.chainKey);
  const originWallet = {
    kind: "ONCHAIN_WALLET" as const,
    accountRef: intent.origin.accountRef,
    chainKey: intent.origin.chainKey,
  };
  const providerParty = {
    kind: "EXTERNAL_PROVIDER" as const,
    providerName,
    ...(offRampHint?.accountRef !== undefined ? { accountRef: offRampHint.accountRef } : {}),
  };
  const bankParty = {
    kind: "EXTERNAL_BANK_INSTRUMENT" as const,
    externalRef: intent.destination.externalRef,
  };

  // --- mixed: crypto → DEX → stablecoin → off-ramp deposit → payout → bank ---
  if (stablecoin === undefined) {
    exclusions.push({
      shapeId: "mixed-dex-offramp",
      reasons: [
        "no intermediate stablecoin routing hint grounds the DEX→off-ramp conversion hop — the compiler never invents an intermediate asset",
      ],
    });
  } else {
    const swap: SwapRequest = {
      requestId: `route-swap:${intent.intentId}:mixed-dex-offramp`,
      chain: originAsset.chain,
      inputAsset: originAsset,
      outputAsset: stablecoin,
      swapKind: "EXACT_INPUT",
      amount: intent.originAmount,
    };
    const discovery = discoverSwapLane({
      venuePacks: input.venuePacks,
      swap,
      policy: input.bestExecutionPolicy,
      security: input.onchainSecurity,
      instances: input.onchainInstances,
      assetObservations: input.assetObservations,
      owner: intent.origin.accountRef,
      beneficiary: intent.origin.accountRef,
      requestedBy: intent.principalRef,
      routeExpiryMs: intent.expiresAt,
      at: input.at,
    });
    if (discovery.outcome.status !== "LANE_PROVED") {
      exclusions.push({
        shapeId: "mixed-dex-offramp",
        reasons: [
          `the DEX hop was not proved through the real best-execution engine (${discovery.outcome.status}): ${discovery.outcome.detail}`,
        ],
      });
    } else if (offRampHint === undefined) {
      exclusions.push({
        shapeId: "mixed-dex-offramp",
        reasons: [
          "no off-ramp provider deposit address grounds the stablecoin→provider hop — custody destinations are explicit, never guessed",
        ],
      });
    } else {
      const lane = discovery.outcome.lane;
      const planId = `route-plan:${intent.intentId}:mixed-dex-offramp`;
      const stableAmount: PlannedLegAmount = {
        basis: "QUOTE_GROUNDED",
        amount: lane.quote.slippage.worstCaseOutput,
        quoteId: lane.quote.quoteId,
      };
      const legs: RouteLeg[] = [];

      // leg 0 — the DEX swap (custody: wallet → wallet, value morphs through the venue)
      legs.push(
        makeSwapLeg(
          { ...ctx, shapeId: "mixed-dex-offramp", planId },
          0,
          lane,
          {
            from: originWallet,
            to: originWallet,
            via: {
              kind: "ONCHAIN_PROTOCOL",
              protocolKey: lane.protocolBinding.protocolKey,
              chainKey: lane.protocolBinding.chainKey,
            },
            assetRef: originAsset.assetId,
            amount: intent.originAmount,
            evidenceRefs: lane.evidenceRefs,
          },
        ),
      );

      // leg 1 — the off-ramp deposit transfer (custody: wallet → provider)
      const depositArtifacts = prepareOnchainTransferOrBridgeLeg({
        operation: "onchain.transfer",
        writeId: `${planId}:write:1`,
        asset: stablecoin,
        amount: stableAmount.amount,
        from: intent.origin.accountRef,
        to: offRampHint.accountRef,
        routeId: `${planId}:route`,
        routeHash: routeHashFor(planId, 1, "ONCHAIN_TRANSFER"),
        expiry: intent.expiresAt,
        requestedBy: intent.principalRef,
        settlementInstruction: settlementInstructionBinding(intent.intentId, "mixed-dex-offramp"),
        security: input.onchainSecurity,
        at: input.at,
      });
      const depositGrounding = prospectiveHopGrounding(lane);
      legs.push(
        makeKernelWriteLeg(
          { ...ctx, shapeId: "mixed-dex-offramp", planId },
          1,
          "ONCHAIN_TRANSFER",
          depositArtifacts,
          {
            from: originWallet,
            to: providerParty,
            assetRef: stablecoin.assetId,
            amount: stableAmount.amount,
            evidenceRefs: [
              `write:${depositArtifacts.write.writeDigest}`,
              `quote:${lane.quote.quoteId}`,
            ],
          },
          depositGrounding,
          stableAmount,
          stablecoin.chain,
        ),
      );

      appendOffRampPayoutAndBankLegs(
        { ...ctx, shapeId: "mixed-dex-offramp", planId },
        legs,
        providerName,
        providerParty,
        bankParty,
        stableAmount,
        exclusions,
        buildShape,
        "mixed-dex-offramp",
        chainEnv,
      );
    }
  }

  // --- provider-native incumbent: wallet → provider → fiat payout → bank ---
  compileNativeOffRampShape(
    ctx,
    buildShape,
    exclusions,
    originWallet,
    providerParty,
    bankParty,
    originAsset,
    providerName,
    chainEnv,
  );
}

function compileNativeOffRampShape(
  ctx: LegBuildContext,
  buildShape: BuildShapeFn,
  exclusions: { shapeId: string; reasons: string[] }[],
  originWallet: { kind: "ONCHAIN_WALLET"; accountRef: string; chainKey: string },
  providerParty: { kind: "EXTERNAL_PROVIDER"; providerName: string; accountRef?: string },
  bankParty: { kind: "EXTERNAL_BANK_INSTRUMENT"; externalRef: string },
  originAsset: AssetIdentity,
  providerName: string,
  chainEnv: RailEnvironmentClass,
): void {
  const { intent, input } = ctx;
  const offRampHint = input.routingHints?.offRampDeposit;
  const shapeId = "provider-native-offramp";

  const baselineInstance = pickBaselineFiatInstance(ctx, providerName);
  if (baselineInstance === undefined) {
    exclusions.push({
      shapeId,
      reasons: [
        `no provider-native baseline capability (nativeOptimization.benchmarkBaseline, INV-C08) is evidenced for provider '${providerName}' — the incumbent baseline is emitted only on real evidence, never fabricated`,
      ],
    });
    return;
  }
  if (offRampHint === undefined) {
    exclusions.push({
      shapeId,
      reasons: [
        "no off-ramp provider deposit address grounds the wallet→provider hop — custody destinations are explicit, never guessed",
      ],
    });
    return;
  }

  const planId = `route-plan:${intent.intentId}:${shapeId}`;
  const legs: RouteLeg[] = [];

  // leg 0 — the native deposit transfer (custody: wallet → provider)
  const depositArtifacts = prepareOnchainTransferOrBridgeLeg({
    operation: "onchain.transfer",
    writeId: `${planId}:write:0`,
    asset: originAsset,
    amount: intent.originAmount,
    from: intent.origin.accountRef,
    to: offRampHint.accountRef,
    routeId: `${planId}:route`,
    routeHash: routeHashFor(planId, 0, "ONCHAIN_TRANSFER"),
    expiry: intent.expiresAt,
    requestedBy: intent.principalRef,
    settlementInstruction: settlementInstructionBinding(intent.intentId, shapeId),
    security: input.onchainSecurity,
    at: input.at,
  });
  const depositGrounding = onchainLegGrounding(
    input.assetObservations,
    originAsset.chain,
    originAsset,
    intent.origin.accountRef,
    input.at,
  );
  legs.push(
    makeKernelWriteLeg(
      { ...ctx, shapeId, planId },
      0,
      "ONCHAIN_TRANSFER",
      depositArtifacts,
      {
        from: originWallet,
        to: providerParty,
        assetRef: originAsset.assetId,
        amount: intent.originAmount,
        evidenceRefs: [`write:${depositArtifacts.write.writeDigest}`],
      },
      depositGrounding,
      intentDeclaredAmount(intent),
      originAsset.chain,
    ),
  );

  appendOffRampPayoutAndBankLegs(
    { ...ctx, shapeId, planId },
    legs,
    providerName,
    providerParty,
    bankParty,
    intentDeclaredAmount(intent),
    exclusions,
    buildShape,
    shapeId,
    chainEnv,
  );
}

/** Shared tail: the off-ramp payout (real payout gate) + the bank settlement arrival. */
function appendOffRampPayoutAndBankLegs(
  ctx: LegBuildContext,
  legs: RouteLeg[],
  providerName: string,
  providerParty: { kind: "EXTERNAL_PROVIDER"; providerName: string; accountRef?: string },
  bankParty: { kind: "EXTERNAL_BANK_INSTRUMENT"; externalRef: string },
  sourceAmount: PlannedLegAmount,
  exclusions: { shapeId: string; reasons: string[] }[],
  buildShape: (
    shapeId: string,
    compositionClass: "FIAT_ONLY" | "ONCHAIN_ONLY" | "MIXED",
    executionMode: "PASS_THROUGH_NATIVE" | "COMPOSED_PAYSWAP" | "OPTIMIZED_MULTI_PROVIDER",
    isBaseline: boolean,
    legs: RouteLeg[],
    environmentClasses: readonly RailEnvironmentClass[],
    stripeMarker?: StripeNativeSettlementUnavailableMarker,
  ) => void,
  shapeId: string,
  chainEnv: RailEnvironmentClass,
  stripeMarker?: StripeNativeSettlementUnavailableMarker,
): void {
  const { intent, input } = ctx;
  const arrivalCurrency =
    intent.destination.kind === "BANK_ACCOUNT"
      ? intent.destination.currency
      : intent.arrivalCurrency;

  const fiatAmount =
    sourceAmount.basis === "UNKNOWN"
      ? sourceAmount
      : convertAmount(sourceAmount.amount, input.conversionRules, arrivalCurrency);
  if (fiatAmount.basis === "UNKNOWN") {
    exclusions.push({
      shapeId,
      reasons: [
        `the off-ramp payout hop has no exact fiat grounding (${fiatAmount.reason}) — a payout amount is never guessed`,
      ],
    });
    return;
  }

  const payoutInstance = pickPayoutInstance(ctx, providerName);
  const payoutObservation = pickFiatObservation(ctx, payoutInstance);
  const payoutGrounding = fiatLegGrounding(
    payoutInstance,
    input.fiatObservations,
    input.at,
    { maxAgeSeconds: input.fiatObservationMaxAgeSeconds },
  );
  const activation = [...input.fiatActivations]
    .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1))
    .find((record) => record.instanceId === payoutInstance?.instanceId);

  if (payoutInstance === undefined || payoutObservation === undefined || activation === undefined) {
    exclusions.push({
      shapeId,
      reasons: [
        `the off-ramp payout hop is not fully grounded (instance: ${payoutInstance !== undefined}, observation: ${payoutObservation !== undefined}, activation: ${activation !== undefined}) — a payout hop without its transfer-out gate evidence is never compiled (the payout capability id is an explicit routing hint, never inferred)`,
      ],
    });
    return;
  }

  // legs[hops-1] — the off-ramp payout hop (custody: provider → provider, value morphs to fiat)
  const destination: PayoutDestination = {
    kind: "PROVIDER_BANK_INSTRUMENT",
    providerDestinationRef: bankParty.externalRef,
  };
  const gateInput = offRampPayoutRequestInit({
    connectorCapabilityId: payoutInstance.capabilityId,
    transferOutAuthorizationId: `transfer-out:${intent.intentId}`,
    destination,
    amount: fiatAmount.amount,
    protocolKey: `route:${intent.intentId}`,
    authorizationEvidenceRef: intent.intentAuthorizationRef,
    requestedAt: new Date(input.at).toISOString(),
  });
  const gate = evaluateOffRampPayoutGate(activation, gateInput);

  const payoutHopIndex = legs.length;
  legs.push(
    makeOffRampPayoutLeg(
      ctx,
      payoutHopIndex,
      {
        from: providerParty,
        to: providerParty,
        via: providerParty,
        assetRef: fiatAmount.amount.currency,
        amount: fiatAmount.amount,
        evidenceRefs: [
          `${capabilityObservationId(payoutObservation)}`,
          `payout-gate:${payoutInstance.instanceId}`,
        ],
      },
      payoutGrounding.grounding,
      payoutInstance,
      payoutObservation,
      destination,
      gate,
      fiatAmount,
    ),
  );

  // legs[hops] — the bank settlement arrival (custody: provider → external bank instrument)
  const bankDestination =
    settlementDestinationForIntent(input.settlementDestinations, bankParty.externalRef) ??
    defineSettlementDestination({
      id: `dest:${intent.intentId}:bank`,
      kind: "BANK_ACCOUNT",
      currency: currencyCode(arrivalCurrency),
      externalRef: bankParty.externalRef,
      provenance: {
        source: "route-compiler",
        reference: intent.intentId,
        recordedAt: BigInt(intent.declaredAt),
      },
    });
  legs.push(
    makeBankSettlementLeg(
      ctx,
      legs.length,
      {
        from: providerParty,
        to: bankParty,
        assetRef: fiatAmount.amount.currency,
        amount: fiatAmount.amount,
        evidenceRefs: [`settlement-destination:${bankDestination.id}`],
      },
      fiatAmount,
      settlementResultFrom(bankDestination),
    ),
  );

  buildShape(
    shapeId,
    "MIXED",
    shapeId === "provider-native-offramp" ? "PASS_THROUGH_NATIVE" : "OPTIMIZED_MULTI_PROVIDER",
    shapeId === "provider-native-offramp",
    legs,
    [chainEnv],
    stripeMarker,
  );
}

// ---------------------------------------------------------------------------
// Shape family: fiat → PSP → stablecoin → chain → recipient (+ the incumbent)
// ---------------------------------------------------------------------------

function compileOnRampShapes(
  ctx: LegBuildContext,
  buildShape: BuildShapeFn,
  exclusions: { shapeId: string; reasons: string[] }[],
): void {
  const { intent, input } = ctx;
  if (
    intent.origin.kind !== "EXTERNAL_PROVIDER_ACCOUNT" ||
    intent.destination.kind !== "ONCHAIN_RECIPIENT"
  ) {
    throw new RouteCompilerError("internal: on-ramp shapes require provider→onchain intents");
  }
  const destinationAsset = destinationAssetIdentity(intent, input.routingHints);
  const chainEnv = classifyChainEnvironment(intent.destination.chainKey);
  const providerParty = {
    kind: "EXTERNAL_PROVIDER" as const,
    providerName: intent.origin.providerName,
    accountRef: intent.origin.accountRef,
  };
  const providerPoolParty = {
    kind: "EXTERNAL_PROVIDER" as const,
    providerName: intent.origin.providerName,
  };
  const recipientWallet = {
    kind: "ONCHAIN_WALLET" as const,
    accountRef: intent.destination.accountRef,
    chainKey: intent.destination.chainKey,
  };

  const collectInstance = pickFiatInstance(ctx, intent.origin.providerName);
  const collectObservation = pickFiatObservation(ctx, collectInstance);
  const collectGrounding = fiatLegGrounding(
    collectInstance,
    input.fiatObservations,
    input.at,
    { maxAgeSeconds: input.fiatObservationMaxAgeSeconds },
  );
  if (collectInstance === undefined || collectObservation === undefined) {
    exclusions.push({
      shapeId: "mixed-psp-onramp",
      reasons: [
        `no connected instance + fresh capability observation grounds the PSP collect hop at provider '${intent.origin.providerName}' — provider capabilities are observed, never assumed`,
      ],
    });
    exclusions.push({
      shapeId: "provider-native-onramp",
      reasons: [
        `no connected instance + fresh capability observation grounds the PSP collect hop at provider '${intent.origin.providerName}'`,
      ],
    });
    return;
  }

  const stableAmount = convertAmount(
    intent.originAmount,
    input.conversionRules,
    destinationAsset.symbol,
  );
  if (stableAmount.basis === "UNKNOWN") {
    exclusions.push({
      shapeId: "mixed-psp-onramp",
      reasons: [
        `the stablecoin issuance hop has no exact grounding (${stableAmount.reason}) — a mint amount is never guessed`,
      ],
    });
    exclusions.push({
      shapeId: "provider-native-onramp",
      reasons: [
        `the stablecoin issuance hop has no exact grounding (${stableAmount.reason})`,
      ],
    });
    return;
  }

  // --- mixed: fiat → PSP collect → stablecoin issuance → onchain delivery ---
  {
    const shapeId = "mixed-psp-onramp";
    const planId = `route-plan:${intent.intentId}:${shapeId}`;
    const legs: RouteLeg[] = [];

    // leg 0 — the PSP collect hop (custody: provider-held instrument → provider collected pool)
    legs.push(
      makeFiatCollectLeg(
        { ...ctx, shapeId, planId },
        0,
        {
          from: providerParty,
          to: providerPoolParty,
          via: providerPoolParty,
          assetRef: intent.origin.currency,
          amount: intent.originAmount,
          evidenceRefs: [`${capabilityObservationId(collectObservation)}`],
        },
        collectGrounding.grounding,
        collectInstance,
        collectObservation,
      ),
    );

    // leg 1 — the stablecoin issuance hop (custody: provider → onchain issuer protocol)
    const issuerProtocolKey = `stablecoin-issuer:${destinationAsset.symbol.toLowerCase()}`;
    const issuerParty = {
      kind: "ONCHAIN_PROTOCOL" as const,
      protocolKey: issuerProtocolKey,
      chainKey: destinationAsset.chain,
    };
    legs.push(
      makeIssuanceLeg(
        { ...ctx, shapeId, planId },
        1,
        {
          from: providerPoolParty,
          to: issuerParty,
          via: issuerParty,
          assetRef: destinationAsset.assetId,
          amount: stableAmount.amount,
          evidenceRefs: [
            `${capabilityObservationId(collectObservation)}`,
            `issuer:${issuerProtocolKey}`,
          ],
        },
        collectGrounding.grounding,
        collectInstance,
        collectObservation,
        stableAmount,
      ),
    );

    // leg 2 — the onchain delivery transfer (custody: issuer protocol → recipient wallet)
    const deliveryAddress = input.routingHints?.onrampDeliveryAddress;
    if (deliveryAddress === undefined) {
      exclusions.push({
        shapeId,
        reasons: [
          "no onramp issuer delivery address grounds the issuance→recipient onchain hop — custody sources are explicit, never guessed",
        ],
      });
    } else {
      const deliveryArtifacts = prepareOnchainTransferOrBridgeLeg({
        operation: "onchain.transfer",
        writeId: `${planId}:write:2`,
        asset: destinationAsset,
        amount: stableAmount.amount,
        from: deliveryAddress,
        to: intent.destination.accountRef,
        routeId: `${planId}:route`,
        routeHash: routeHashFor(planId, 2, "ONCHAIN_TRANSFER"),
        expiry: intent.expiresAt,
        requestedBy: intent.principalRef,
        settlementInstruction: settlementInstructionBinding(intent.intentId, shapeId),
        security: input.onchainSecurity,
        at: input.at,
      });
      const deliveryGrounding = onchainLegGrounding(
        input.assetObservations,
        destinationAsset.chain,
        destinationAsset,
        deliveryAddress,
        input.at,
      );
      legs.push(
        makeKernelWriteLeg(
          { ...ctx, shapeId, planId },
          2,
          "ONCHAIN_TRANSFER",
          deliveryArtifacts,
          {
            from: issuerParty,
            to: recipientWallet,
            assetRef: destinationAsset.assetId,
            amount: stableAmount.amount,
            evidenceRefs: [
              `write:${deliveryArtifacts.write.writeDigest}`,
              `issuer:${issuerProtocolKey}`,
            ],
          },
          deliveryGrounding,
          stableAmount,
          destinationAsset.chain,
        ),
      );
      buildShape(shapeId, "MIXED", "OPTIMIZED_MULTI_PROVIDER", false, legs, [chainEnv]);
    }
  }

  // --- provider-native incumbent: fiat → PSP collect → native stablecoin delivery ---
  {
    const shapeId = "provider-native-onramp";
    const baselineInstance = pickBaselineFiatInstance(ctx, intent.origin.providerName);
    if (baselineInstance === undefined) {
      exclusions.push({
        shapeId,
        reasons: [
          `no provider-native baseline capability (nativeOptimization.benchmarkBaseline, INV-C08) is evidenced for provider '${intent.origin.providerName}' — the incumbent baseline is emitted only on real evidence`,
        ],
      });
      return;
    }
    const planId = `route-plan:${intent.intentId}:${shapeId}`;
    const legs: RouteLeg[] = [];
    legs.push(
      makeFiatCollectLeg(
        { ...ctx, shapeId, planId },
        0,
        {
          from: providerParty,
          to: providerPoolParty,
          via: providerPoolParty,
          assetRef: intent.origin.currency,
          amount: intent.originAmount,
          evidenceRefs: [`${capabilityObservationId(collectObservation)}`],
        },
        collectGrounding.grounding,
        collectInstance,
        collectObservation,
      ),
    );
    legs.push(
      makeIssuanceLeg(
        { ...ctx, shapeId, planId },
        1,
        {
          from: providerPoolParty,
          to: recipientWallet,
          via: {
            kind: "ONCHAIN_PROTOCOL",
            protocolKey: `stablecoin-issuer:${destinationAsset.symbol.toLowerCase()}`,
            chainKey: destinationAsset.chain,
          },
          assetRef: destinationAsset.assetId,
          amount: stableAmount.amount,
          evidenceRefs: [
            `${capabilityObservationId(collectObservation)}`,
            `native-flow:${intent.origin.providerName}`,
          ],
        },
        collectGrounding.grounding,
        collectInstance,
        collectObservation,
        stableAmount,
      ),
    );
    buildShape(shapeId, "MIXED", "PASS_THROUGH_NATIVE", true, legs, [chainEnv]);
  }
}

// ---------------------------------------------------------------------------
// Shape family: chainA → DEX → bridge → chainB (+ the native bridge incumbent)
// ---------------------------------------------------------------------------

function compileCrossChainShapes(
  ctx: LegBuildContext,
  buildShape: BuildShapeFn,
  exclusions: { shapeId: string; reasons: string[] }[],
): void {
  const { intent, input } = ctx;
  if (intent.origin.kind !== "ONCHAIN_WALLET" || intent.destination.kind !== "ONCHAIN_RECIPIENT") {
    throw new RouteCompilerError("internal: cross-chain shapes require wallet→onchain intents");
  }
  const originAsset = intentAssetIdentity(intent, input.routingHints);
  const originEnv = classifyChainEnvironment(intent.origin.chainKey);
  const destinationEnv = classifyChainEnvironment(intent.destination.chainKey);
  const originWallet = {
    kind: "ONCHAIN_WALLET" as const,
    accountRef: intent.origin.accountRef,
    chainKey: intent.origin.chainKey,
  };
  const recipientWallet = {
    kind: "ONCHAIN_WALLET" as const,
    accountRef: intent.destination.accountRef,
    chainKey: intent.destination.chainKey,
  };

  if (intent.origin.chainKey === intent.destination.chainKey) {
    // Same-chain: the direct onchain transfer.
    const shapeId = "onchain-direct-transfer";
    const planId = `route-plan:${intent.intentId}:${shapeId}`;
    const artifacts = prepareOnchainTransferOrBridgeLeg({
      operation: "onchain.transfer",
      writeId: `${planId}:write:0`,
      asset: originAsset,
      amount: intent.originAmount,
      from: intent.origin.accountRef,
      to: intent.destination.accountRef,
      routeId: `${planId}:route`,
      routeHash: routeHashFor(planId, 0, "ONCHAIN_TRANSFER"),
      expiry: intent.expiresAt,
      requestedBy: intent.principalRef,
      settlementInstruction: settlementInstructionBinding(intent.intentId, shapeId),
      security: input.onchainSecurity,
      at: input.at,
    });
    const grounding = onchainLegGrounding(
      input.assetObservations,
      originAsset.chain,
      originAsset,
      intent.origin.accountRef,
      input.at,
    );
    buildShape(
      shapeId,
      "ONCHAIN_ONLY",
      "COMPOSED_PAYSWAP",
      false,
      [
        makeKernelWriteLeg(
          { ...ctx, shapeId, planId },
          0,
          "ONCHAIN_TRANSFER",
          artifacts,
          {
            from: originWallet,
            to: recipientWallet,
            assetRef: originAsset.assetId,
            amount: intent.originAmount,
            evidenceRefs: [`write:${artifacts.write.writeDigest}`],
          },
          grounding,
          intentDeclaredAmount(intent),
          originAsset.chain,
        ),
      ],
      [originEnv],
    );
    return;
  }

  const bridgeContractAddress = input.routingHints?.bridgeContractAddress;

  // Cross-chain: the native bridge incumbent (chainA → bridge → chainB in one hop).
  {
    const shapeId = "provider-native-bridge";
    if (bridgeContractAddress === undefined) {
      exclusions.push({
        shapeId,
        reasons: [
          "no bridge contract address grounds the native bridge hop — the bridge protocol's onchain identity is explicit, never guessed",
        ],
      });
    } else {
      const planId = `route-plan:${intent.intentId}:${shapeId}`;
      const bridgeProtocolKey = "native-bridge";
      const nativeBridgeArtifacts = prepareOnchainTransferOrBridgeLeg({
        operation: "onchain.bridge",
        writeId: `${planId}:write:0`,
        asset: originAsset,
        amount: intent.originAmount,
        from: intent.origin.accountRef,
        to: bridgeContractAddress,
        routeId: `${planId}:route`,
        routeHash: routeHashFor(planId, 0, "ONCHAIN_BRIDGE"),
        expiry: intent.expiresAt,
        requestedBy: intent.principalRef,
        settlementInstruction: settlementInstructionBinding(intent.intentId, shapeId),
        security: input.onchainSecurity,
        at: input.at,
      });
      const grounding = onchainLegGrounding(
        input.assetObservations,
        originAsset.chain,
        originAsset,
        intent.origin.accountRef,
        input.at,
      );
      buildShape(
        shapeId,
        "ONCHAIN_ONLY",
        "PASS_THROUGH_NATIVE",
        true,
        [
          makeKernelWriteLeg(
            { ...ctx, shapeId, planId },
            0,
            "ONCHAIN_BRIDGE",
            nativeBridgeArtifacts,
            {
              from: originWallet,
              to: recipientWallet,
              via: {
                kind: "ONCHAIN_PROTOCOL",
                protocolKey: bridgeProtocolKey,
                chainKey: intent.origin.chainKey,
              },
              assetRef: originAsset.assetId,
              amount: intent.originAmount,
              evidenceRefs: [`write:${nativeBridgeArtifacts.write.writeDigest}`],
            },
            grounding,
            intentDeclaredAmount(intent),
            intent.destination.chainKey,
          ),
        ],
        [originEnv, destinationEnv],
      );
    }
  }

  // Cross-chain mixed: chainA → DEX → bridge deposit asset → bridge → chainB recipient.
  {
    const shapeId = "mixed-dex-bridge";
    const planId = `route-plan:${intent.intentId}:${shapeId}`;
    const bridgeDepositAsset = input.routingHints?.bridgeDepositAsset;
    if (bridgeDepositAsset === undefined) {
      exclusions.push({
        shapeId,
        reasons: [
          "no bridge deposit asset routing hint grounds the chain-A DEX hop — the compiler never invents an intermediate asset",
        ],
      });
      return;
    }
    if (bridgeContractAddress === undefined) {
      exclusions.push({
        shapeId,
        reasons: [
          "no bridge contract address grounds the bridge hop — the bridge protocol's onchain identity is explicit, never guessed",
        ],
      });
      return;
    }
    const swap: SwapRequest = {
      requestId: `route-swap:${intent.intentId}:mixed-dex-bridge`,
      chain: originAsset.chain,
      inputAsset: originAsset,
      outputAsset: bridgeDepositAsset,
      swapKind: "EXACT_INPUT",
      amount: intent.originAmount,
    };
    const discovery = discoverSwapLane({
      venuePacks: input.venuePacks,
      swap,
      policy: input.bestExecutionPolicy,
      security: input.onchainSecurity,
      instances: input.onchainInstances,
      assetObservations: input.assetObservations,
      owner: intent.origin.accountRef,
      beneficiary: intent.origin.accountRef,
      requestedBy: intent.principalRef,
      routeExpiryMs: intent.expiresAt,
      at: input.at,
    });
    if (discovery.outcome.status !== "LANE_PROVED") {
      exclusions.push({
        shapeId,
        reasons: [
          `the chain-A DEX hop was not proved through the real best-execution engine (${discovery.outcome.status}): ${discovery.outcome.detail}`,
        ],
      });
      return;
    }
    const lane = discovery.outcome.lane;
    const depositAmount: PlannedLegAmount = {
      basis: "QUOTE_GROUNDED",
      amount: lane.quote.slippage.worstCaseOutput,
      quoteId: lane.quote.quoteId,
    };
    const legs: RouteLeg[] = [];
    legs.push(
      makeSwapLeg(
        { ...ctx, shapeId, planId },
        0,
        lane,
        {
          from: originWallet,
          to: originWallet,
          via: {
            kind: "ONCHAIN_PROTOCOL",
            protocolKey: lane.protocolBinding.protocolKey,
            chainKey: lane.protocolBinding.chainKey,
          },
          assetRef: originAsset.assetId,
          amount: intent.originAmount,
          evidenceRefs: lane.evidenceRefs,
        },
      ),
    );
    const bridgeArtifacts = prepareOnchainTransferOrBridgeLeg({
      operation: "onchain.bridge",
      writeId: `${planId}:write:1`,
      asset: bridgeDepositAsset,
      amount: depositAmount.amount,
      from: intent.origin.accountRef,
      to: bridgeContractAddress,
      routeId: `${planId}:route`,
      routeHash: routeHashFor(planId, 1, "ONCHAIN_BRIDGE"),
      expiry: intent.expiresAt,
      requestedBy: intent.principalRef,
      settlementInstruction: settlementInstructionBinding(intent.intentId, shapeId),
      security: input.onchainSecurity,
      at: input.at,
    });
    const bridgeGrounding = prospectiveHopGrounding(lane);
    legs.push(
      makeKernelWriteLeg(
        { ...ctx, shapeId, planId },
        1,
        "ONCHAIN_BRIDGE",
        bridgeArtifacts,
        {
          from: originWallet,
          to: recipientWallet,
          via: {
            kind: "ONCHAIN_PROTOCOL",
            protocolKey: "native-bridge",
            chainKey: intent.origin.chainKey,
          },
          assetRef: bridgeDepositAsset.assetId,
          amount: depositAmount.amount,
          evidenceRefs: [
            `write:${bridgeArtifacts.write.writeDigest}`,
            `quote:${lane.quote.quoteId}`,
          ],
        },
        bridgeGrounding,
        {
          basis: "UNKNOWN",
          reason:
            "the bridge arrival amount on the destination chain is observed at chain-B finality — never estimated without evidence",
        },
        intent.destination.chainKey,
      ),
    );
    buildShape(shapeId, "ONCHAIN_ONLY", "OPTIMIZED_MULTI_PROVIDER", false, legs, [
      originEnv,
      destinationEnv,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Shape family: eligible crypto → Stripe settlement (Mode A + Mode B)
// ---------------------------------------------------------------------------

function compileStripeShapes(
  ctx: LegBuildContext,
  buildShape: BuildShapeFn,
  exclusions: { shapeId: string; reasons: string[] }[],
): void {
  const { intent, input } = ctx;
  if (
    intent.origin.kind !== "ONCHAIN_WALLET" ||
    intent.destination.kind !== "STRIPE_MERCHANT_BALANCE"
  ) {
    throw new RouteCompilerError("internal: stripe shapes require wallet→stripe-balance intents");
  }
  const stripeDestination = intent.destination;
  const originAsset = intentAssetIdentity(intent, input.routingHints);
  const chainEnv = classifyChainEnvironment(intent.origin.chainKey);
  const originWallet = {
    kind: "ONCHAIN_WALLET" as const,
    accountRef: intent.origin.accountRef,
    chainKey: intent.origin.chainKey,
  };
  const stripeBalance = {
    kind: "STRIPE_MERCHANT_BALANCE" as const,
    stripeAccountRef: stripeDestination.stripeAccountRef,
  };
  const stripeParty = { kind: "EXTERNAL_PROVIDER" as const, providerName: "stripe" };
  const fiatAmount = convertAmount(
    intent.originAmount,
    input.conversionRules,
    intent.destination.currency,
  );

  // --- Mode A: native Stripe crypto settlement (provider-verified eligibility required) ---
  {
    const shapeId = "stripe-native-crypto-settlement";
    const evidence = [...input.stripeEligibilityEvidence]
      .sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1))
      .map((candidate) => validateStripeCryptoSettlementEligibility(candidate))
      .find(
        (candidate) =>
          candidate.stripeAccountRef === stripeDestination.stripeAccountRef &&
          candidate.currency === stripeDestination.currency &&
          stripeEligibilityEvidenceIsFresh(candidate, input.at),
      );
    if (evidence === undefined) {
      exclusions.push({
        shapeId,
        reasons: [
          `no fresh provider-verified Stripe crypto settlement eligibility evidence grounds account '${stripeDestination.stripeAccountRef}' for currency '${stripeDestination.currency}' — native settlement (Mode A) is never compiled without it (the provider-verified-effects law); the actual integration awaits ${STRIPE_CRYPTO_SETTLEMENT_AUTHORITY}`,
        ],
      });
    } else {
      const planId = `route-plan:${intent.intentId}:${shapeId}`;
      buildShape(
        shapeId,
        "MIXED",
        "PASS_THROUGH_NATIVE",
        true,
        [
          makeStripeLeg(
            { ...ctx, shapeId, planId },
            0,
            {
              from: originWallet,
              to: stripeBalance,
              via: stripeParty,
              assetRef: originAsset.assetId,
              amount: intent.originAmount,
              evidenceRefs: [`stripe-eligibility:${evidence.evidenceId}`],
            },
            {
              observations: [
                {
                  observationKind: "StripeCryptoSettlementEligibilityEvidence",
                  observationId: evidence.evidenceId,
                  fresh: true,
                  freshnessRule: "stripe-eligibility-max-age",
                },
              ],
              groundingFailures: [],
            },
            evidence.evidenceId,
            fiatAmount,
          ),
        ],
        [chainEnv],
      );
    }
  }

  // --- Mode B: the explicit external PaySwap route with the honest unavailability notice ---
  {
    const shapeId = "stripe-external-payswap-route";
    const marker = stripeNativeSettlementUnavailable(
      `native Stripe crypto settlement is not grounded for account '${stripeDestination.stripeAccountRef}' on this compilation — this external route settles to the merchant's supported fiat destination instead, never a synthetic Stripe balance effect`,
    );
    const stablecoin = input.routingHints?.intermediateStablecoin;
    const offRampHint = input.routingHints?.offRampDeposit;
    const providerName = offRampHint?.providerName ?? "psp-mock";
    const providerParty = {
      kind: "EXTERNAL_PROVIDER" as const,
      providerName,
      ...(offRampHint?.accountRef !== undefined ? { accountRef: offRampHint.accountRef } : {}),
    };
    const merchantBank = [...input.settlementDestinations]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .find((destination) => destination.kind === "BANK_ACCOUNT");
    if (stablecoin === undefined || offRampHint === undefined || merchantBank === undefined) {
      exclusions.push({
        shapeId,
        reasons: [
          `the external route is not fully grounded (intermediate stablecoin: ${stablecoin !== undefined}, off-ramp deposit: ${offRampHint !== undefined}, merchant bank destination: ${merchantBank !== undefined}) — Mode B never fabricates its hops`,
        ],
      });
      return;
    }
    const bankParty = {
      kind: "EXTERNAL_BANK_INSTRUMENT" as const,
      externalRef: merchantBank.externalRef,
    };
    const swap: SwapRequest = {
      requestId: `route-swap:${intent.intentId}:stripe-external-payswap-route`,
      chain: originAsset.chain,
      inputAsset: originAsset,
      outputAsset: stablecoin,
      swapKind: "EXACT_INPUT",
      amount: intent.originAmount,
    };
    const discovery = discoverSwapLane({
      venuePacks: input.venuePacks,
      swap,
      policy: input.bestExecutionPolicy,
      security: input.onchainSecurity,
      instances: input.onchainInstances,
      assetObservations: input.assetObservations,
      owner: intent.origin.accountRef,
      beneficiary: intent.origin.accountRef,
      requestedBy: intent.principalRef,
      routeExpiryMs: intent.expiresAt,
      at: input.at,
    });
    if (discovery.outcome.status !== "LANE_PROVED") {
      exclusions.push({
        shapeId,
        reasons: [
          `the DEX hop was not proved through the real best-execution engine (${discovery.outcome.status}): ${discovery.outcome.detail}`,
        ],
      });
      return;
    }
    const lane = discovery.outcome.lane;
    const planId = `route-plan:${intent.intentId}:${shapeId}`;
    const stableAmount: PlannedLegAmount = {
      basis: "QUOTE_GROUNDED",
      amount: lane.quote.slippage.worstCaseOutput,
      quoteId: lane.quote.quoteId,
    };
    const legs: RouteLeg[] = [];
    // Mode B leg 0 — the DEX swap (the external route begins exactly like the off-ramp journey).
    legs.push(
      makeSwapLeg(
        { ...ctx, shapeId, planId },
        0,
        lane,
        {
          from: originWallet,
          to: originWallet,
          via: {
            kind: "ONCHAIN_PROTOCOL",
            protocolKey: lane.protocolBinding.protocolKey,
            chainKey: lane.protocolBinding.chainKey,
          },
          assetRef: originAsset.assetId,
          amount: intent.originAmount,
          evidenceRefs: lane.evidenceRefs,
        },
      ),
    );
    // Mode B leg 1 — the off-ramp deposit transfer.
    const depositArtifacts = prepareOnchainTransferOrBridgeLeg({
      operation: "onchain.transfer",
      writeId: `${planId}:write:1`,
      asset: stablecoin,
      amount: stableAmount.amount,
      from: intent.origin.accountRef,
      to: offRampHint.accountRef,
      routeId: `${planId}:route`,
      routeHash: routeHashFor(planId, 1, "ONCHAIN_TRANSFER"),
      expiry: intent.expiresAt,
      requestedBy: intent.principalRef,
      settlementInstruction: settlementInstructionBinding(intent.intentId, shapeId),
      security: input.onchainSecurity,
      at: input.at,
    });
    const depositGrounding = prospectiveHopGrounding(lane);
    legs.push(
      makeKernelWriteLeg(
        { ...ctx, shapeId, planId },
        1,
        "ONCHAIN_TRANSFER",
        depositArtifacts,
        {
          from: originWallet,
          to: providerParty,
          assetRef: stablecoin.assetId,
          amount: stableAmount.amount,
          evidenceRefs: [
            `write:${depositArtifacts.write.writeDigest}`,
            `quote:${lane.quote.quoteId}`,
          ],
        },
        depositGrounding,
        stableAmount,
        stablecoin.chain,
      ),
    );
    appendOffRampPayoutAndBankLegs(
      { ...ctx, shapeId, planId },
      legs,
      providerName,
      providerParty,
      bankParty,
      stableAmount,
      exclusions,
      buildShape,
      shapeId,
      chainEnv,
      marker,
    );
  }
}

// ---------------------------------------------------------------------------
// Fiat instance/observation pickers (deterministic)
// ---------------------------------------------------------------------------

/**
 * The payout-execution instance: the provider instance bound to the
 * caller-declared payout capability id — the capability that is actually
 * authorized to execute transfer-out (never inferred from the provider
 * name alone).
 */
function pickPayoutInstance(
  ctx: LegBuildContext,
  providerName: string,
): ConnectedCapabilityInstance | undefined {
  const capabilityId = ctx.input.routingHints?.offRampPayoutCapabilityId;
  if (capabilityId === undefined) {
    return undefined;
  }
  return [...ctx.input.fiatInstances]
    .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1))
    .find(
      (instance) =>
        instance.providerName === providerName && instance.capabilityId === capabilityId,
    );
}

function pickFiatInstance(
  ctx: LegBuildContext,
  providerName: string,
): ConnectedCapabilityInstance | undefined {
  return [...ctx.input.fiatInstances]
    .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1))
    .find((instance) => instance.providerName === providerName);
}

function pickBaselineFiatInstance(
  ctx: LegBuildContext,
  providerName: string,
): ConnectedCapabilityInstance | undefined {
  const baselineCapabilityIds = new Set(
    [...ctx.input.fiatDefinitions]
      .filter((definition) => isProviderNativeBaselineCapability(definition))
      .map((definition) => definition.capabilityId),
  );
  return [...ctx.input.fiatInstances]
    .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1))
    .find(
      (instance) =>
        instance.providerName === providerName &&
        baselineCapabilityIds.has(instance.capabilityId),
    );
}

function pickFiatObservation(
  ctx: LegBuildContext,
  instance: ConnectedCapabilityInstance | undefined,
): CapabilityObservation | undefined {
  if (instance === undefined) {
    return undefined;
  }
  return [...ctx.input.fiatObservations]
    .sort((a, b) =>
      a.observedAt < b.observedAt
        ? -1
        : a.observedAt > b.observedAt
          ? 1
          : a.instanceId < b.instanceId
            ? -1
            : 1,
    )
    .find((observation) => observation.instanceId === instance.instanceId);
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
