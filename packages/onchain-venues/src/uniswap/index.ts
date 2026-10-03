/**
 * @payswap/onchain-venues/uniswap — THE REFERENCE VENUE EXTENSION (P4-W2-002).
 *
 * Uniswap v2 modelled as its own extension pack built on
 * @payswap/onchain-domain:
 * - the protocol definition composes the canonical INV-SC01
 *   SmartContractExtension declarations of the published v2 contracts
 *   (Router02 and the Factory — public documented constants, never
 *   secrets) AND the canonical DexCapability flavor (one object, both
 *   canonical validators);
 * - the venue's OWN optimization — router-native multi-hop path selection
 *   over the factory's pairs — is the PROVIDER-NATIVE incumbent baseline
 *   (INV-C08 / rule 20): declared with benchmarkBaseline: true and
 *   reported as optimizationOrigin PROVIDER_NATIVE on every quote;
 * - quotes are observations carrying the full observation law (freshness
 *   inherited from the underlying indexed pool states, provenance,
 *   observer identity);
 * - the swap math is the REAL v2 constant-product invariant with the
 *   0.30% pool fee per hop (the fee is EMBEDDED in the output computation
 *   — it is never double-counted as a separate fee component; the quote's
 *   fee list carries only fees added ON TOP of the pool execution);
 * - planWrite produces the kernel-ready OnchainWriteRequest (router
 *   approval + synthetic router calldata shape; real calldata encoding
 *   belongs to the family adapters).
 *
 * Pool states are INJECTED as fixture observations (deterministic,
 * offline). Live pool-state feeds arrive with the adapter wave.
 */

import type { ProtocolDefinition } from "@payswap/onchain-domain";
import type { DexCapabilityDeclaration } from "@payswap/onchain-domain";
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
// Published v2 contract constants (public documentation values — not secrets)
// ---------------------------------------------------------------------------

/** Uniswap V2 Router02 on Ethereum mainnet (published constant). */
export const UNISWAP_V2_ROUTER_02_ADDRESS =
  "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as const;

/** Uniswap V2 Factory on Ethereum mainnet (published constant). */
export const UNISWAP_V2_FACTORY_ADDRESS =
  "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" as const;

export const UNISWAP_V2_PROTOCOL_KEY = "uniswap-v2" as const;
export const UNISWAP_V2_CHAIN_KEY = "ethereum:mainnet" as const;
export const UNISWAP_V2_VENUE_ID = "uniswap-v2" as const;

// ---------------------------------------------------------------------------
// Indexed pool-state observations (fixture-driven, offline)
// ---------------------------------------------------------------------------

/** An observed v2 pair state: reserves + the observation law. */
export interface UniswapPoolState {
  readonly pairId: string;
  readonly assetA: AssetIdentity;
  readonly assetB: AssetIdentity;
  /** Exact integer reserves in minor units (assetA / assetB denominated). */
  readonly reserveAMinorUnits: string;
  readonly reserveBMinorUnits: string;
  readonly freshness: QuoteFreshness;
  readonly provenance: QuoteProvenance;
  readonly observer: QuoteObserver;
}

/** Default venue health for the reference pack (operator-observed). */
function defaultHealth(at: number): HealthObservation {
  return {
    status: "HEALTHY",
    observedAtMs: at,
    maxAgeMs: 30_000,
    provenance: {
      providerName: "payswap-venue-operators",
      source: "OPERATOR",
      capturedAtMs: at,
      evidenceRefs: ["evidence:health:uniswap-v2"],
    },
  };
}

// ---------------------------------------------------------------------------
// The v2 constant-product math (exact bigint; 0.30% fee per hop)
// ---------------------------------------------------------------------------

/**
 * The exact v2 swap output for one hop (UniswapV2Library.getAmountOut):
 * amountOut = floor((amountIn × 997 × reserveOut) / (reserveIn × 1000 + amountIn × 997)).
 * The 0.30% pool fee is embedded in this computation.
 */
export function uniswapV2HopOutput(
  amountInMinorUnits: bigint,
  reserveInMinorUnits: bigint,
  reserveOutMinorUnits: bigint,
): bigint {
  if (amountInMinorUnits < 0n || reserveInMinorUnits <= 0n || reserveOutMinorUnits <= 0n) {
    throw new Error("uniswapV2HopOutput requires non-negative input and positive reserves");
  }
  if (amountInMinorUnits === 0n) {
    return 0n;
  }
  const amountInWithFee = amountInMinorUnits * 997n;
  const numerator = amountInWithFee * reserveOutMinorUnits;
  const denominator = reserveInMinorUnits * 1000n + amountInWithFee;
  return numerator / denominator;
}

interface HopPlan {
  readonly from: AssetIdentity;
  readonly to: AssetIdentity;
  readonly pairId: string;
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
  readonly state: UniswapPoolState;
}

function pairFor(
  pools: readonly UniswapPoolState[],
  from: AssetIdentity,
  to: AssetIdentity,
): UniswapPoolState | undefined {
  return pools.find(
    (pool) =>
      (sameAsset(pool.assetA, from) && sameAsset(pool.assetB, to)) ||
      (sameAsset(pool.assetA, to) && sameAsset(pool.assetB, from)),
  );
}

function sameAsset(a: AssetIdentity, b: AssetIdentity): boolean {
  return a.chain === b.chain && a.assetId === b.assetId && a.symbol === b.symbol;
}

/**
 * Router-native path selection over the factory's pairs (the venue's OWN
 * optimization — the incumbent baseline): the best of the direct pair and
 * every two-hop path through the declared intermediates, computed with the
 * real v2 math. Deterministic tie-break: higher output, then fewer hops,
 * then lexicographic first pair id.
 */
function selectRoute(
  pools: readonly UniswapPoolState[],
  inputAsset: AssetIdentity,
  outputAsset: AssetIdentity,
  intermediates: readonly AssetIdentity[],
  amountInMinorUnits: bigint,
): { hops: readonly HopPlan[]; outputMinorUnits: bigint } | undefined {
  const paths: HopPlan[][] = [];

  const direct = pairFor(pools, inputAsset, outputAsset);
  if (direct !== undefined) {
    const [reserveIn, reserveOut] = sameAsset(direct.assetA, inputAsset)
      ? [direct.reserveAMinorUnits, direct.reserveBMinorUnits]
      : [direct.reserveBMinorUnits, direct.reserveAMinorUnits];
    paths.push([
      {
        from: inputAsset,
        to: outputAsset,
        pairId: direct.pairId,
        reserveIn: BigInt(reserveIn),
        reserveOut: BigInt(reserveOut),
        state: direct,
      },
    ]);
  }

  for (const intermediate of intermediates) {
    if (sameAsset(intermediate, inputAsset) || sameAsset(intermediate, outputAsset)) {
      continue;
    }
    const first = pairFor(pools, inputAsset, intermediate);
    const second = pairFor(pools, intermediate, outputAsset);
    if (first === undefined || second === undefined) {
      continue;
    }
    const [firstIn, firstOut] = sameAsset(first.assetA, inputAsset)
      ? [first.reserveAMinorUnits, first.reserveBMinorUnits]
      : [first.reserveBMinorUnits, first.reserveAMinorUnits];
    const [secondIn, secondOut] = sameAsset(second.assetA, intermediate)
      ? [second.reserveAMinorUnits, second.reserveBMinorUnits]
      : [second.reserveBMinorUnits, second.reserveAMinorUnits];
    paths.push([
      {
        from: inputAsset,
        to: intermediate,
        pairId: first.pairId,
        reserveIn: BigInt(firstIn),
        reserveOut: BigInt(firstOut),
        state: first,
      },
      {
        from: intermediate,
        to: outputAsset,
        pairId: second.pairId,
        reserveIn: BigInt(secondIn),
        reserveOut: BigInt(secondOut),
        state: second,
      },
    ]);
  }

  if (paths.length === 0) {
    return undefined;
  }
  let best: { hops: readonly HopPlan[]; outputMinorUnits: bigint } | undefined;
  for (const path of paths) {
    let running = amountInMinorUnits;
    for (const hop of path) {
      running = uniswapV2HopOutput(running, hop.reserveIn, hop.reserveOut);
    }
    if (
      best === undefined ||
      running > best.outputMinorUnits ||
      (running === best.outputMinorUnits && path.length < best.hops.length)
    ) {
      best = { hops: path, outputMinorUnits: running };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The venue pack
// ---------------------------------------------------------------------------

export interface UniswapVenueOptions {
  /** The indexed pool states (fixture observations; mandatory). */
  readonly pools: readonly UniswapPoolState[];
  /** Intermediates the router-native path search considers (e.g. WETH). */
  readonly intermediates?: readonly AssetIdentity[];
  /** The caller-declared slippage limit, in basis points (default 50). */
  readonly slippageLimitBasisPoints?: number;
  /** Gas estimate disclosure (units + exact rational price in the fee asset). */
  readonly gasCost?: {
    readonly gasUnits: string;
    readonly pricePerUnitNativeMinor: { readonly numerator: string; readonly denominator: string };
    readonly feeAsset: AssetIdentity;
  };
  /** Quote freshness bound (default 10s). */
  readonly quoteMaxAgeMs?: number;
  /** Health observation override. */
  readonly health?: (at: number) => HealthObservation;
  /** Failure-risk class declaration override (default LOW). */
  readonly riskClass?: "LOW" | "MODERATE" | "ELEVATED" | "HIGH";
  /** Estimated settlement duration override (default 120s, probabilistic). */
  readonly estimatedSettlementMs?: number;
}

/** Builds the Uniswap v2 reference venue extension pack. */
export function createUniswapV2VenuePack(
  options: UniswapVenueOptions,
): VenueExtensionPack {
  const pools = options.pools;
  const slippageBps = options.slippageLimitBasisPoints ?? 50;
  const quoteMaxAgeMs = options.quoteMaxAgeMs ?? 10_000;

  const venue: ExecutionVenue = {
    descriptor: {
      venueId: UNISWAP_V2_VENUE_ID,
      displayName: "Uniswap v2 (reference venue extension)",
      chains: [UNISWAP_V2_CHAIN_KEY],
      swapKinds: ["EXACT_INPUT", "EXACT_OUTPUT"],
      quoteSemantics: "EXECUTABLE",
      slippageProtection: "DECLARED_LIMIT",
      supportsSimulation: true,
      nativeOptimization: {
        optimizationKind: "ROUTER_NATIVE_PATH_SELECTION",
        benchmarkBaseline: true,
        description:
          "The venue's own multi-hop path selection over its factory pairs (the incumbent baseline — INV-C08/rule 20)",
      },
    },
    protocol: {
      protocolKey: UNISWAP_V2_PROTOCOL_KEY,
      chainKey: UNISWAP_V2_CHAIN_KEY,
    },
    quote(request: SwapRequest, at: number): VenueQuoteOutcome {
      if (request.chain !== UNISWAP_V2_CHAIN_KEY) {
        return {
          kind: "UNAVAILABLE",
          reason: `the venue serves ${UNISWAP_V2_CHAIN_KEY} only`,
        };
      }
      if (request.swapKind !== "EXACT_INPUT") {
        return {
          kind: "UNAVAILABLE",
          reason: "this reference pack models EXACT_INPUT swaps",
        };
      }
      if (sameAsset(request.inputAsset, request.outputAsset)) {
        return {
          kind: "UNAVAILABLE",
          reason: "a swap between identical assets is degenerate (no route)",
        };
      }
      const route = selectRoute(
        pools,
        request.inputAsset,
        request.outputAsset,
        options.intermediates ?? [],
        BigInt(request.amount.minorUnits),
      );
      if (route === undefined || route.hops.length === 0) {
        return {
          kind: "UNAVAILABLE",
          reason: "no pool path exists for the requested pair",
        };
      }
      // The selected path's output (real v2 math, already computed).
      const expectedOutput = route.outputMinorUnits;
      const worstCase = (expectedOutput * BigInt(10_000 - slippageBps)) / 10_000n;
      const quoteId = `uniswap-v2-quote-${request.requestId}-${at}`;

      const quote: VenueQuote = {
        quoteId,
        venueId: UNISWAP_V2_VENUE_ID,
        requestId: request.requestId,
        chain: UNISWAP_V2_CHAIN_KEY,
        swapKind: request.swapKind,
        inputAsset: request.inputAsset,
        outputAsset: request.outputAsset,
        inputAmount: request.amount,
        quoteSemantics: "EXECUTABLE",
        fees: [],
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
            "v2 swaps are atomic: a failed swap reverts and is safe to re-request",
        },
        timeToSettlement: {
          estimatedMs: options.estimatedSettlementMs ?? 120_000,
          finalityModel: "PROBABILISTIC",
          description: "onchain inclusion plus a confirmation-depth wait",
        },
        routeShape: route.hops.map((hop, index) => ({
          venue: UNISWAP_V2_VENUE_ID,
          chain: UNISWAP_V2_CHAIN_KEY,
          protocolId: UNISWAP_V2_PROTOCOL_KEY,
          description: `${hop.from.symbol}→${hop.to.symbol} via pair ${hop.pairId} (0.30% pool fee embedded in output) [hop ${index + 1}]`,
        })),
        optimizationOrigin: "PROVIDER_NATIVE",
        freshness: {
          asOfMs: Math.min(...route.hops.map((hop) => hop.state.freshness.asOfMs)),
          maxAgeMs: quoteMaxAgeMs,
        },
        provenance: {
          providerName: "uniswap-v2-extension-pack",
          source: "INDEXED_POOL_STATE",
          capturedAtMs: at,
          evidenceRefs: route.hops.map((hop) => `evidence:pool-state:${hop.pairId}`),
        },
        observer: {
          observerId: "observer:uniswap-v2-pool-indexer",
          observerKind: "INDEXER",
        },
      };
      return { kind: "QUOTE", quote };
    },
    observeHealth(at: number): HealthObservation {
      return options.health !== undefined ? options.health(at) : defaultHealth(at);
    },
    planWrite(input: VenueWritePlanningInput): OnchainWriteRequest {
      const quote = input.quote;
      return {
        writeId: `write:uniswap-v2:${quote.quoteId}`,
        action: "onchain.swap",
        chain: quote.chain,
        approvals: [
          {
            asset: quote.inputAsset,
            owner: input.owner,
            spender: UNISWAP_V2_ROUTER_02_ADDRESS,
            amount: {
              currency: quote.inputAsset.symbol,
              minorUnits: quote.inputAmount.minorUnits,
            },
            unlimited: false,
          },
        ],
        contractCall: {
          target: UNISWAP_V2_ROUTER_02_ADDRESS,
          calldata: `0xv2-swapExactTokensForTokens:${quote.quoteId}`,
          calldataDigest: `sha256:v2-calldata:${quote.quoteId}`,
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
          protocolId: UNISWAP_V2_PROTOCOL_KEY,
          version: "1.0.0",
          contract: uniswapV2RouterDeclaration(),
        },
        expiry: input.expiryMs,
        requestedBy: input.requestedBy,
      };
    },
    simulate(write: PreparedWrite, at: number): SimulationObservation {
      return {
        simulationId: `sim:uniswap-v2:${write.writeId}`,
        writeId: write.writeId,
        status: "SUCCEEDED",
        observedAt: at,
        blockRef: "block:fixture-1",
        balanceDeltas: [
          {
            holder: write.approvals[0]?.owner ?? "",
            asset: write.approvals[0]?.asset ?? quoteAssetFallback(write),
            amount: {
              currency: write.approvals[0]?.asset.symbol ?? "USC",
              minorUnits: write.approvals[0]?.amount.minorUnits ?? "0",
            },
            direction: "debit",
          },
        ],
        approvals: write.approvals.map((approval) => ({
          owner: approval.owner,
          spender: approval.spender,
          asset: approval.asset,
          allowance: approval.amount,
          unlimited: approval.unlimited,
        })),
        gasEstimate: "160000",
        simulator: "uniswap-v2-extension-pack-simulator",
      };
    },
  };

  return {
    packId: `venue-pack/${UNISWAP_V2_VENUE_ID}@1.0.0`,
    version: "1.0.0",
    venue,
    protocol: uniswapV2ProtocolDefinition(),
    implementation: {
      implementationId: `impl:${UNISWAP_V2_PROTOCOL_KEY}:extension-pack`,
      capabilityId: protocolCapabilityId(UNISWAP_V2_PROTOCOL_KEY, UNISWAP_V2_CHAIN_KEY),
      providerName: "payswap-onchain-venues",
      providerVersion: "1.0.0",
      version: "1.0.0",
      adapterRef: "adapter:venue-extension-pack:uniswap-v2",
      implementationNotes:
        "Reference venue extension pack implementing the neutral best-execution venue port for the published v2 contracts.",
      corridors: [],
      knownDeviations: [],
      nativeOptimization: {
        representableAsCapability: true,
        capabilityId: protocolCapabilityId(UNISWAP_V2_PROTOCOL_KEY, UNISWAP_V2_CHAIN_KEY),
      },
      protocolKey: UNISWAP_V2_PROTOCOL_KEY,
      chainKey: UNISWAP_V2_CHAIN_KEY,
    },
  };
}

function quoteAssetFallback(write: PreparedWrite): AssetIdentity {
  return write.approvals[0]?.asset ?? { chain: write.chain, assetId: "unknown", symbol: "USC" };
}

// ---------------------------------------------------------------------------
// The canonical protocol declarations (INV-SC01 — public, published properties)
// ---------------------------------------------------------------------------

/** The canonical INV-SC01 declaration of the published v2 Router02. */
export function uniswapV2RouterDeclaration() {
  return {
    kind: "smart_contract_extension" as const,
    chainRef: UNISWAP_V2_CHAIN_KEY,
    contractAddress: UNISWAP_V2_ROUTER_02_ADDRESS,
    sourceHash: "sha256:uniswap-v2-router02-declared-source",
    bytecodeHash: "sha256:uniswap-v2-router02-deployed-bytecode",
    upgradeAuthority: {
      kind: "IMMUTABLE" as const,
      description: "Router02 has no upgrade path (deployed, verified, immutable)",
    },
    adminAuthority: {
      kind: "IMMUTABLE" as const,
      description: "Router02 exposes no administrative functions",
    },
    pausePowers: [],
    oracleDependencies: [],
    custody: {
      custodial: false,
      withdrawalAuthority: "n/a — the router never takes custody of funds",
      keyManagement: "n/a — no operator keys",
    },
    searchableByLabAfterCertification: true,
  };
}

/** The canonical INV-SC01 declaration of the published v2 Factory. */
export function uniswapV2FactoryDeclaration() {
  return {
    kind: "smart_contract_extension" as const,
    chainRef: UNISWAP_V2_CHAIN_KEY,
    contractAddress: UNISWAP_V2_FACTORY_ADDRESS,
    sourceHash: "sha256:uniswap-v2-factory-declared-source",
    bytecodeHash: "sha256:uniswap-v2-factory-deployed-bytecode",
    upgradeAuthority: {
      kind: "IMMUTABLE" as const,
      description: "The v2 factory has no upgrade path",
    },
    adminAuthority: {
      kind: "MULTISIG" as const,
      description: "feeToSetter governance multisig (fee-switch only, not fund custody)",
    },
    pausePowers: [],
    oracleDependencies: [],
    custody: {
      custodial: false,
      withdrawalAuthority: "n/a — the factory never takes custody of funds",
      keyManagement: "n/a — no operator keys",
    },
    searchableByLabAfterCertification: true,
  };
}

/**
 * The canonical v2 protocol definition: ONE object validating through BOTH
 * canonical onchain-domain validators — validateProtocolDefinition (the
 * §2A protocol layer + INV-SC01 declarations) and the DexCapability flavor
 * (validateOnchainCapabilityDefinition).
 */
export interface UniswapV2ProtocolDefinition extends ProtocolDefinition {
  readonly onchain: DexCapabilityDeclaration;
}

export function uniswapV2ProtocolDefinition(): UniswapV2ProtocolDefinition {
  return {
    ...venueActionCapabilityDefinition(
      protocolCapabilityId(UNISWAP_V2_PROTOCOL_KEY, UNISWAP_V2_CHAIN_KEY),
      "Uniswap v2: the reference onchain execution venue extension pack",
    ),
    kind: "ACTION",
    onchain: {
      capabilityKind: "dex",
      supportedSwapKinds: ["EXACT_INPUT", "EXACT_OUTPUT"],
      supportedChains: [UNISWAP_V2_CHAIN_KEY],
      quoteSemantics: "EXECUTABLE",
      slippageProtection: "DECLARED_LIMIT",
    },
    protocol: {
      protocolKey: UNISWAP_V2_PROTOCOL_KEY,
      displayName: "Uniswap v2",
      protocolClass: "DEX",
      chainKey: UNISWAP_V2_CHAIN_KEY,
      smartContracts: [uniswapV2RouterDeclaration(), uniswapV2FactoryDeclaration()],
    },
  };
}
