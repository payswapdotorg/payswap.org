/**
 * @payswap/onchain-venues/aggregator — an INDEPENDENT 0x-style DEX/aggregator
 * venue extension pack (P4-W2-002).
 *
 * Modelled as its OWN extension pack — deliberately NOT a fork of the
 * reference venue: its quote shape composes multiple liquidity sources
 * (firm RFQ maker orders AND indexed AMM sources), charges an explicit
 * integrator fee ON TOP of the sourced liquidity (deducted from the routed
 * input — never double-counted inside the sourced output), and declares
 * its own PROVIDER-NATIVE smart routing as the incumbent baseline
 * (INV-C08 / rule 20): the pack's default quote IS its own optimized
 * source composition.
 *
 * - the protocol definition composes the canonical INV-SC01 declaration of
 *   a settlement-proxy-style contract (SYNTHETIC model deployment — this
 *   pack is a modelled venue, not a claim about any specific real
 *   deployment) and the canonical DexCapability flavor;
 * - RFQ maker orders are firm, expiring quote observations with maker
 *   provenance (RFQ source kind); AMM sources carry indexed-pool-state
 *   provenance;
 * - the quote's fee list carries the explicit INTEGRATOR_FEE; the sourced
 *   output is computed on the post-fee routed input;
 * - quotes carry the full observation law; planWrite produces the
 *   kernel-ready write through the settlement proxy.
 */

import type { DexCapabilityDeclaration, ProtocolDefinition } from "@payswap/onchain-domain";
import { protocolCapabilityId } from "@payswap/onchain-domain";
import type {
  AssetIdentity,
  OnchainWriteRequest,
  PreparedWrite,
  SimulationObservation,
} from "@payswap/onchain-security";
import type {
  ExecutionVenue,
  HealthObservation,
  QuoteFreshness,
  QuoteObserver,
  QuoteProvenance,
  SwapRequest,
  VenueQuote,
  VenueQuoteOutcome,
  VenueWritePlanningInput,
} from "@payswap/best-execution";
import type { VenueExtensionPack } from "../index.js";
import { venueActionCapabilityDefinition } from "../capability-base.js";

// ---------------------------------------------------------------------------
// The modelled venue identity (synthetic — a 0x-STYLE shape, no real claim)
// ---------------------------------------------------------------------------

export const AGGREGATOR_PROTOCOL_KEY = "zeroswap-aggregator" as const;
export const AGGREGATOR_CHAIN_KEY = "ethereum:mainnet" as const;
export const AGGREGATOR_VENUE_ID = "zeroswap-aggregator" as const;
/** Synthetic settlement-proxy contract (model deployment). */
export const AGGREGATOR_SETTLEMENT_ADDRESS =
  "0xA11Ce0000000000000000000000000000000BEEF" as const;

// ---------------------------------------------------------------------------
// Liquidity sources (fixture observations, offline)
// ---------------------------------------------------------------------------

/**
 * A firm RFQ maker order: an exact output-per-input ratio good for any size
 * up to maxInputMinorUnits, valid until validUntilMs. Maker identity and
 * the observation law are mandatory.
 */
export interface RfqMakerOrder {
  readonly orderId: string;
  readonly makerRef: string;
  /** The asset the maker RECEIVES (the trader's input). */
  readonly assetIn: AssetIdentity;
  /** The asset the maker DELIVERS (the trader's output). */
  readonly assetOut: AssetIdentity;
  /** Exact output minor units per ONE input minor unit. */
  readonly outputPerInput: { readonly numerator: string; readonly denominator: string };
  /** Maximum input size this order serves. */
  readonly maxInputMinorUnits: string;
  readonly validUntilMs: number;
  readonly freshness: QuoteFreshness;
  readonly provenance: QuoteProvenance;
  readonly observer: QuoteObserver;
}

/** An indexed AMM liquidity source the aggregator composes. */
export interface AggregatorAmmSource {
  readonly sourceId: string;
  readonly assetIn: AssetIdentity;
  readonly assetOut: AssetIdentity;
  readonly reserveInMinorUnits: string;
  readonly reserveOutMinorUnits: string;
  /** Source swap fee in basis points (embedded in the source output math). */
  readonly feeBasisPoints: number;
  readonly freshness: QuoteFreshness;
  readonly provenance: QuoteProvenance;
  readonly observer: QuoteObserver;
}

export interface AggregatorVenueOptions {
  readonly rfqOrders?: readonly RfqMakerOrder[];
  readonly ammSources?: readonly AggregatorAmmSource[];
  /** The explicit integrator fee, in basis points of the input (default 10). */
  readonly integratorFeeBasisPoints?: number;
  /** The caller-declared slippage limit, in basis points (default 50). */
  readonly slippageLimitBasisPoints?: number;
  readonly gasCost?: {
    readonly gasUnits: string;
    readonly pricePerUnitNativeMinor: { readonly numerator: string; readonly denominator: string };
    readonly feeAsset: AssetIdentity;
  };
  readonly quoteMaxAgeMs?: number;
  readonly health?: (at: number) => HealthObservation;
  readonly riskClass?: "LOW" | "MODERATE" | "ELEVATED" | "HIGH";
  readonly estimatedSettlementMs?: number;
}

function ammSourceOutput(
  amountInMinorUnits: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBasisPoints: number,
): bigint {
  if (amountInMinorUnits === 0n) {
    return 0n;
  }
  const feeMultiplierNumerator = BigInt(10_000 - feeBasisPoints);
  const amountInAfterFee = (amountInMinorUnits * feeMultiplierNumerator) / 10_000n;
  // Constant-product output on the post-fee input (source fee embedded):
  // Δy = reserveOut × Δx / (reserveIn + Δx).
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}

function sameAsset(a: AssetIdentity, b: AssetIdentity): boolean {
  return a.chain === b.chain && a.assetId === b.assetId && a.symbol === b.symbol;
}

interface SourcePlan {
  readonly kind: "RFQ" | "AMM";
  readonly sourceId: string;
  readonly outputMinorUnits: bigint;
  readonly oldestAsOfMs: number;
  readonly evidenceRefs: readonly string[];
  readonly provenance: QuoteProvenance;
  readonly observer: QuoteObserver;
  readonly description: string;
}

/** Builds the independent aggregator venue extension pack. */
export function createAggregatorVenuePack(
  options: AggregatorVenueOptions,
): VenueExtensionPack {
  const rfqOrders = options.rfqOrders ?? [];
  const ammSources = options.ammSources ?? [];
  const integratorFeeBps = options.integratorFeeBasisPoints ?? 10;
  const slippageBps = options.slippageLimitBasisPoints ?? 50;
  const quoteMaxAgeMs = options.quoteMaxAgeMs ?? 10_000;

  const venue: ExecutionVenue = {
    descriptor: {
      venueId: AGGREGATOR_VENUE_ID,
      displayName: "Zeroswap aggregator (independent 0x-style venue extension)",
      chains: [AGGREGATOR_CHAIN_KEY],
      swapKinds: ["EXACT_INPUT", "EXACT_OUTPUT"],
      quoteSemantics: "EXECUTABLE",
      slippageProtection: "DECLARED_LIMIT",
      supportsSimulation: true,
      nativeOptimization: {
        optimizationKind: "SMART_SOURCE_ROUTING",
        benchmarkBaseline: true,
        description:
          "The aggregator's own smart routing across RFQ makers and AMM sources (the incumbent baseline — INV-C08/rule 20)",
      },
    },
    protocol: {
      protocolKey: AGGREGATOR_PROTOCOL_KEY,
      chainKey: AGGREGATOR_CHAIN_KEY,
    },
    quote(request: SwapRequest, at: number): VenueQuoteOutcome {
      if (request.chain !== AGGREGATOR_CHAIN_KEY) {
        return {
          kind: "UNAVAILABLE",
          reason: `the venue serves ${AGGREGATOR_CHAIN_KEY} only`,
        };
      }
      if (request.swapKind !== "EXACT_INPUT") {
        return {
          kind: "UNAVAILABLE",
          reason: "this pack models EXACT_INPUT swaps",
        };
      }
      const inputAmount = BigInt(request.amount.minorUnits);

      // The explicit integrator fee is deducted from the routed input —
      // the sourced output is computed on the post-fee remainder (never
      // double-counted).
      const integratorFee = (inputAmount * BigInt(integratorFeeBps)) / 10_000n;
      const routedInput = inputAmount - integratorFee;

      // The venue's OWN smart routing: the best firm source for the routed
      // input (deterministic: higher output wins; ties break RFQ over AMM,
      // then lexicographic source id).
      const sources: SourcePlan[] = [];
      for (const order of rfqOrders) {
        if (
          !sameAsset(order.assetIn, request.inputAsset) ||
          !sameAsset(order.assetOut, request.outputAsset)
        ) {
          continue;
        }
        if (at >= order.validUntilMs || BigInt(order.maxInputMinorUnits) < routedInput) {
          continue;
        }
        const output =
          (routedInput * BigInt(order.outputPerInput.numerator)) /
          BigInt(order.outputPerInput.denominator);
        sources.push({
          kind: "RFQ",
          sourceId: order.orderId,
          outputMinorUnits: output,
          oldestAsOfMs: order.freshness.asOfMs,
          evidenceRefs: [`evidence:rfq-order:${order.orderId}`],
          provenance: order.provenance,
          observer: order.observer,
          description: `RFQ maker ${order.makerRef} (firm order ${order.orderId})`,
        });
      }
      for (const source of ammSources) {
        if (
          !sameAsset(source.assetIn, request.inputAsset) ||
          !sameAsset(source.assetOut, request.outputAsset)
        ) {
          continue;
        }
        const output = ammSourceOutput(
          routedInput,
          BigInt(source.reserveInMinorUnits),
          BigInt(source.reserveOutMinorUnits),
          source.feeBasisPoints,
        );
        sources.push({
          kind: "AMM",
          sourceId: source.sourceId,
          outputMinorUnits: output,
          oldestAsOfMs: source.freshness.asOfMs,
          evidenceRefs: [`evidence:amm-source:${source.sourceId}`],
          provenance: source.provenance,
          observer: source.observer,
          description: `AMM source ${source.sourceId} (${source.feeBasisPoints}bps source fee embedded in output)`,
        });
      }
      if (sources.length === 0) {
        return {
          kind: "UNAVAILABLE",
          reason: "no RFQ or AMM source serves the requested pair at this size",
        };
      }
      sources.sort((a, b) => {
        if (b.outputMinorUnits !== a.outputMinorUnits) {
          return b.outputMinorUnits > a.outputMinorUnits ? 1 : -1;
        }
        if (a.kind !== b.kind) {
          return a.kind === "RFQ" ? -1 : 1;
        }
        return a.sourceId < b.sourceId ? -1 : 1;
      });
      const best = sources[0] as SourcePlan;

      const expectedOutput = best.outputMinorUnits;
      const worstCase = (expectedOutput * BigInt(10_000 - slippageBps)) / 10_000n;
      const quoteId = `aggregator-quote-${request.requestId}-${at}`;

      const quote: VenueQuote = {
        quoteId,
        venueId: AGGREGATOR_VENUE_ID,
        requestId: request.requestId,
        chain: AGGREGATOR_CHAIN_KEY,
        swapKind: request.swapKind,
        inputAsset: request.inputAsset,
        outputAsset: request.outputAsset,
        inputAmount: request.amount,
        quoteSemantics: "EXECUTABLE",
        fees: [
          {
            feeKind: "INTEGRATOR_FEE",
            amount: {
              asset: request.inputAsset,
              minorUnits: integratorFee.toString(),
            },
            description: `integrator fee (${integratorFeeBps}bps of the input, deducted before routing)`,
          },
        ],
        ...(options.gasCost !== undefined ? { gasCost: options.gasCost } : {}),
        slippage: {
          protection: "DECLARED_LIMIT",
          worstCaseOutput: {
            currency: request.outputAsset.symbol,
            minorUnits: worstCase.toString(),
          },
          limitBasisPoints: slippageBps,
          expectedOutput: {
            currency: request.outputAsset.symbol,
            minorUnits: expectedOutput.toString(),
          },
        },
        failureRisk: {
          riskClass: options.riskClass ?? "LOW",
          retryPolicy: "SAFE_TO_RETRY",
          description:
            "settlement-proxy fills are atomic: a failed fill reverts and is safe to re-request",
        },
        timeToSettlement: {
          estimatedMs: options.estimatedSettlementMs ?? 90_000,
          finalityModel: "PROBABILISTIC",
          description: "single onchain settlement through the proxy plus confirmation depth",
        },
        routeShape: [
          {
            venue: AGGREGATOR_VENUE_ID,
            chain: AGGREGATOR_CHAIN_KEY,
            protocolId: AGGREGATOR_PROTOCOL_KEY,
            description: `smart-routed via ${best.description}`,
          },
        ],
        optimizationOrigin: "PROVIDER_NATIVE",
        freshness: {
          asOfMs: best.oldestAsOfMs,
          maxAgeMs: quoteMaxAgeMs,
        },
        provenance: {
          providerName: "zeroswap-aggregator-extension-pack",
          source: best.kind === "RFQ" ? "RFQ" : "INDEXED_POOL_STATE",
          capturedAtMs: at,
          evidenceRefs: [...best.evidenceRefs, `evidence:aggregator-routing:${quoteId}`],
        },
        observer: best.observer,
      };
      return { kind: "QUOTE", quote };
    },
    observeHealth(at: number): HealthObservation {
      return (
        options.health?.(at) ?? {
          status: "HEALTHY",
          observedAtMs: at,
          maxAgeMs: 30_000,
          provenance: {
            providerName: "payswap-venue-operators",
            source: "OPERATOR",
            capturedAtMs: at,
            evidenceRefs: ["evidence:health:zeroswap-aggregator"],
          },
        }
      );
    },
    planWrite(input: VenueWritePlanningInput): OnchainWriteRequest {
      const quote = input.quote;
      return {
        writeId: `write:aggregator:${quote.quoteId}`,
        action: "onchain.swap",
        chain: quote.chain,
        approvals: [
          {
            asset: quote.inputAsset,
            owner: input.owner,
            spender: AGGREGATOR_SETTLEMENT_ADDRESS,
            amount: {
              currency: quote.inputAsset.symbol,
              minorUnits: quote.inputAmount.minorUnits,
            },
            unlimited: false,
          },
        ],
        contractCall: {
          target: AGGREGATOR_SETTLEMENT_ADDRESS,
          calldata: `0xaggregator-transform-erc20:${quote.quoteId}`,
          calldataDigest: `sha256:aggregator-calldata:${quote.quoteId}`,
        },
        route: {
          routeId: input.routeRef,
          routeHash: input.routeHash,
          hops: quote.routeShape.map((hop) => ({
            venue: hop.venue,
            chain: hop.chain,
            ...(hop.protocolId !== undefined ? { protocolId: hop.protocolId } : {}),
          })),
        },
        protocol: {
          protocolId: AGGREGATOR_PROTOCOL_KEY,
          version: "1.0.0",
          contract: aggregatorSettlementDeclaration(),
        },
        expiry: input.expiryMs,
        requestedBy: input.requestedBy,
      };
    },
    simulate(write: PreparedWrite, at: number): SimulationObservation {
      return {
        simulationId: `sim:aggregator:${write.writeId}`,
        writeId: write.writeId,
        status: "SUCCEEDED",
        observedAt: at,
        blockRef: "block:fixture-1",
        balanceDeltas: [],
        approvals: write.approvals.map((approval) => ({
          owner: approval.owner,
          spender: approval.spender,
          asset: approval.asset,
          allowance: approval.amount,
          unlimited: approval.unlimited,
        })),
        gasEstimate: "140000",
        simulator: "aggregator-extension-pack-simulator",
      };
    },
  };

  return {
    packId: `venue-pack/${AGGREGATOR_VENUE_ID}@1.0.0`,
    version: "1.0.0",
    venue,
    protocol: aggregatorProtocolDefinition(),
    implementation: {
      implementationId: `impl:${AGGREGATOR_PROTOCOL_KEY}:extension-pack`,
      capabilityId: protocolCapabilityId(AGGREGATOR_PROTOCOL_KEY, AGGREGATOR_CHAIN_KEY),
      providerName: "payswap-onchain-venues",
      providerVersion: "1.0.0",
      version: "1.0.0",
      adapterRef: "adapter:venue-extension-pack:zeroswap-aggregator",
      implementationNotes:
        "Independent 0x-style aggregator venue extension pack (RFQ + AMM source composition with an explicit integrator fee).",
      corridors: [],
      knownDeviations: [],
      nativeOptimization: {
        representableAsCapability: true,
        capabilityId: protocolCapabilityId(AGGREGATOR_PROTOCOL_KEY, AGGREGATOR_CHAIN_KEY),
      },
      protocolKey: AGGREGATOR_PROTOCOL_KEY,
      chainKey: AGGREGATOR_CHAIN_KEY,
    },
  };
}

// ---------------------------------------------------------------------------
// The canonical protocol declaration (SYNTHETIC model deployment)
// ---------------------------------------------------------------------------

/** The INV-SC01 declaration of the synthetic settlement proxy. */
export function aggregatorSettlementDeclaration() {
  return {
    kind: "smart_contract_extension" as const,
    chainRef: AGGREGATOR_CHAIN_KEY,
    contractAddress: AGGREGATOR_SETTLEMENT_ADDRESS,
    sourceHash: "sha256:zeroswap-settlement-declared-source",
    bytecodeHash: "sha256:zeroswap-settlement-deployed-bytecode",
    upgradeAuthority: {
      kind: "MULTISIG" as const,
      description: "operator multisig with a 24h timelock",
      delayOrTimelock: "24h timelock",
    },
    adminAuthority: {
      kind: "MULTISIG" as const,
      description: "operator multisig (fee configuration only, never fund custody)",
    },
    pausePowers: [
      {
        actor: "operator-multisig",
        scope: "new batch settlement (settled batches are final)",
      },
    ],
    oracleDependencies: [],
    custody: {
      custodial: false,
      withdrawalAuthority: "traders withdraw unexecuted orders at any time",
      keyManagement: "no operator keys touch trader funds",
    },
    searchableByLabAfterCertification: true,
  };
}

/** The canonical aggregator protocol definition (protocol + DexCapability flavor). */
export interface AggregatorProtocolDefinition extends ProtocolDefinition {
  readonly onchain: DexCapabilityDeclaration;
}

export function aggregatorProtocolDefinition(): AggregatorProtocolDefinition {
  return {
    ...venueActionCapabilityDefinition(
      protocolCapabilityId(AGGREGATOR_PROTOCOL_KEY, AGGREGATOR_CHAIN_KEY),
      "Zeroswap aggregator: an independent 0x-style onchain execution venue extension pack",
    ),
    kind: "ACTION",
    onchain: {
      capabilityKind: "dex",
      supportedSwapKinds: ["EXACT_INPUT", "EXACT_OUTPUT"],
      supportedChains: [AGGREGATOR_CHAIN_KEY],
      quoteSemantics: "EXECUTABLE",
      slippageProtection: "DECLARED_LIMIT",
    },
    protocol: {
      protocolKey: AGGREGATOR_PROTOCOL_KEY,
      displayName: "Zeroswap Aggregator (modelled)",
      protocolClass: "DEX",
      chainKey: AGGREGATOR_CHAIN_KEY,
      smartContracts: [aggregatorSettlementDeclaration()],
    },
  };
}
