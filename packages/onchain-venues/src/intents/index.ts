/**
 * @payswap/onchain-venues/intents — an INTENT/SOLVER-ORIENTED venue
 * extension pack (P4-W2-002): batch-auction settlement with open solver
 * competition (a CoW-Protocol-STYLE model — synthetic deployment, no claim
 * about any specific real venue).
 *
 * Distinct capability flavor: the canonical IntentExecutionCapability
 * (FULFILLER_SETTLED settlement, OPEN solver competition) — not a DEX
 * capability. The venue's quotes are BATCH AUCTION quotes:
 * - the disclosed worst case is the intent LIMIT — the guaranteed minimum
 *   a settlement must meet or the intent expires unexecuted (escrowed
 *   funds return to the owner; atomic, no partial fills);
 * - solver competition can deliver SURPLUS above the limit: the expected
 *   output discloses the modelled surplus estimate (an estimate, never a
 *   promise);
 * - time-to-settlement carries the batch cadence plus inclusion;
 * - the quote→executed transition for this venue REQUIRES a settlement
 *   observation (buildIntentSettlementObservation maps a settlement event
 *   into the canonical onchain-domain execution observation — a quote is
 *   never an outcome).
 */

import type {
  IntentExecutionCapabilityDeclaration,
  ProtocolDefinition,
} from "@payswap/onchain-domain";
import { protocolCapabilityId } from "@payswap/onchain-domain";
import type { OnchainExecutionObservation } from "@payswap/onchain-domain";
import type {
  AssetIdentity,
  OnchainWriteRequest,
  PreparedWrite,
  SimulationObservation,
} from "@payswap/onchain-security";
import type {
  ExecutionVenue,
  HealthObservation,
  SwapRequest,
  VenueQuote,
  VenueQuoteOutcome,
  VenueWritePlanningInput,
} from "@payswap/best-execution";
import type { VenueExtensionPack } from "../index.js";
import { venueActionCapabilityDefinition } from "../capability-base.js";

// ---------------------------------------------------------------------------
// The modelled venue identity (synthetic)
// ---------------------------------------------------------------------------

export const INTENTS_PROTOCOL_KEY = "solverbatch-intents" as const;
export const INTENTS_CHAIN_KEY = "ethereum:mainnet" as const;
export const INTENTS_VENUE_ID = "solverbatch-intents" as const;
/** Synthetic batch-settlement contract (model deployment). */
export const INTENTS_SETTLEMENT_ADDRESS =
  "0xBa7cH00000000000000000000000000000000F00D" as const;

// ---------------------------------------------------------------------------
// The venue options
// ---------------------------------------------------------------------------

export interface IntentsVenueOptions {
  /**
   * The intent limit in basis points relative to the modelled reference
   * output (default 5): the auction's guaranteed minimum. The reference
   * output model is a fixed synthetic ratio for the fixture pack.
   */
  readonly limitBasisPoints?: number;
  /** The modelled solver-surplus estimate, in basis points (default 5). */
  readonly surplusBasisPoints?: number;
  /** The synthetic reference output-per-input ratio (default 1:1). */
  readonly referenceOutputPerInput?: { readonly numerator: string; readonly denominator: string };
  /**
   * The output assets this intent venue's auction domain serves (an
   * intent network serves LISTED tokens; default: the input asset's
   * stablecoin pair fixture — any asset when omitted).
   */
  readonly supportedOutputAssets?: readonly import("@payswap/onchain-security").AssetIdentity[];
  readonly batchCadenceMs?: number;
  readonly gasCost?: {
    readonly gasUnits: string;
    readonly pricePerUnitNativeMinor: { readonly numerator: string; readonly denominator: string };
    readonly feeAsset: AssetIdentity;
  };
  readonly quoteMaxAgeMs?: number;
  readonly health?: (at: number) => HealthObservation;
  readonly riskClass?: "LOW" | "MODERATE" | "ELEVATED" | "HIGH";
}

function servesAsset(
  served: import("@payswap/onchain-security").AssetIdentity,
  requested: import("@payswap/onchain-security").AssetIdentity,
): boolean {
  return (
    served.chain === requested.chain &&
    served.assetId === requested.assetId &&
    served.symbol === requested.symbol
  );
}

function defaultHealth(at: number): HealthObservation {
  return {
    status: "HEALTHY",
    observedAtMs: at,
    maxAgeMs: 30_000,
    provenance: {
      providerName: "payswap-venue-operators",
      source: "OPERATOR",
      capturedAtMs: at,
      evidenceRefs: ["evidence:health:solverbatch-intents"],
    },
  };
}

/** Builds the intent/solver venue extension pack. */
export function createIntentsVenuePack(
  options: IntentsVenueOptions,
): VenueExtensionPack {
  const limitBps = options.limitBasisPoints ?? 5;
  const surplusBps = options.surplusBasisPoints ?? 5;
  const referenceRatio = options.referenceOutputPerInput ?? { numerator: "1", denominator: "1" };
  const batchCadenceMs = options.batchCadenceMs ?? 30_000;

  const venue: ExecutionVenue = {
    descriptor: {
      venueId: INTENTS_VENUE_ID,
      displayName: "Solverbatch intents (intent/solver venue extension)",
      chains: [INTENTS_CHAIN_KEY],
      swapKinds: ["EXACT_INPUT"],
      quoteSemantics: "EXECUTABLE",
      slippageProtection: "DECLARED_LIMIT",
      supportsSimulation: true,
      nativeOptimization: {
        optimizationKind: "OPEN_SOLVER_COMPETITION",
        benchmarkBaseline: true,
        description:
          "The venue's own open solver competition over batch auctions (the incumbent baseline — INV-C08/rule 20)",
      },
    },
    protocol: {
      protocolKey: INTENTS_PROTOCOL_KEY,
      chainKey: INTENTS_CHAIN_KEY,
    },
    quote(request: SwapRequest, at: number): VenueQuoteOutcome {
      if (request.chain !== INTENTS_CHAIN_KEY) {
        return {
          kind: "UNAVAILABLE",
          reason: `the venue serves ${INTENTS_CHAIN_KEY} only`,
        };
      }
      if (request.swapKind !== "EXACT_INPUT") {
        return {
          kind: "UNAVAILABLE",
          reason: "intent settlement models EXACT_INPUT intents",
        };
      }
      if (
        options.supportedOutputAssets !== undefined &&
        !options.supportedOutputAssets.some((asset) => servesAsset(asset, request.outputAsset))
      ) {
        return {
          kind: "UNAVAILABLE",
          reason: "the auction domain does not list the requested output asset",
        };
      }
      const inputAmount = BigInt(request.amount.minorUnits);
      const referenceOutput =
        (inputAmount * BigInt(referenceRatio.numerator)) / BigInt(referenceRatio.denominator);
      // The auction LIMIT: the guaranteed minimum (worst case).
      const limitOutput = (referenceOutput * BigInt(10_000 - limitBps)) / 10_000n;
      // The modelled solver surplus estimate (an estimate, never a promise).
      const expectedOutput = (referenceOutput * BigInt(10_000 + surplusBps)) / 10_000n;
      const quoteId = `intent-quote-${request.requestId}-${at}`;

      const quote: VenueQuote = {
        quoteId,
        venueId: INTENTS_VENUE_ID,
        requestId: request.requestId,
        chain: INTENTS_CHAIN_KEY,
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
            minorUnits: limitOutput.toString(),
          },
          limitBasisPoints: limitBps,
          expectedOutput: {
            currency: request.outputAsset.symbol,
            minorUnits: expectedOutput.toString(),
          },
        },
        failureRisk: {
          riskClass: options.riskClass ?? "LOW",
          retryPolicy: "SAFE_TO_RETRY",
          description:
            "batch-auction intents are atomic and escrow-returning: an expired unfilled intent returns funds and is safe to re-submit",
        },
        timeToSettlement: {
          estimatedMs: batchCadenceMs + 45_000,
          finalityModel: "PROBABILISTIC",
          description: `batch cadence ${batchCadenceMs}ms plus onchain inclusion and confirmation depth`,
        },
        routeShape: [
          {
            venue: INTENTS_VENUE_ID,
            chain: INTENTS_CHAIN_KEY,
            protocolId: INTENTS_PROTOCOL_KEY,
            description: `batch-auction intent (open solver competition, limit ${limitBps}bps below reference)`,
          },
        ],
        optimizationOrigin: "PROVIDER_NATIVE",
        freshness: {
          asOfMs: at,
          maxAgeMs: options.quoteMaxAgeMs ?? 10_000,
        },
        provenance: {
          providerName: "solverbatch-intents-extension-pack",
          source: "SOLVER",
          capturedAtMs: at,
          evidenceRefs: [`evidence:intent-auction:${quoteId}`],
        },
        observer: {
          observerId: "observer:solverbatch-solver-api",
          observerKind: "VENUE_API",
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
        writeId: `write:intent:${quote.quoteId}`,
        action: "onchain.intent",
        chain: quote.chain,
        approvals: [
          {
            asset: quote.inputAsset,
            owner: input.owner,
            spender: INTENTS_SETTLEMENT_ADDRESS,
            amount: {
              currency: quote.inputAsset.symbol,
              minorUnits: quote.inputAmount.minorUnits,
            },
            unlimited: false,
          },
        ],
        contractCall: {
          target: INTENTS_SETTLEMENT_ADDRESS,
          calldata: `0xintent-place:${quote.quoteId}`,
          calldataDigest: `sha256:intent-calldata:${quote.quoteId}`,
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
          protocolId: INTENTS_PROTOCOL_KEY,
          version: "1.0.0",
          contract: intentsSettlementDeclaration(),
        },
        expiry: input.expiryMs,
        requestedBy: input.requestedBy,
      };
    },
    simulate(write: PreparedWrite, at: number): SimulationObservation {
      return {
        simulationId: `sim:intent:${write.writeId}`,
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
        gasEstimate: "120000",
        simulator: "solverbatch-intents-extension-pack-simulator",
      };
    },
  };

  return {
    packId: `venue-pack/${INTENTS_VENUE_ID}@1.0.0`,
    version: "1.0.0",
    venue,
    protocol: intentsProtocolDefinition(),
    implementation: {
      implementationId: `impl:${INTENTS_PROTOCOL_KEY}:extension-pack`,
      capabilityId: protocolCapabilityId(INTENTS_PROTOCOL_KEY, INTENTS_CHAIN_KEY),
      providerName: "payswap-onchain-venues",
      providerVersion: "1.0.0",
      version: "1.0.0",
      adapterRef: "adapter:venue-extension-pack:solverbatch-intents",
      implementationNotes:
        "Intent/solver venue extension pack (batch-auction settlement with open solver competition).",
      corridors: [],
      knownDeviations: [],
      nativeOptimization: {
        representableAsCapability: true,
        capabilityId: protocolCapabilityId(INTENTS_PROTOCOL_KEY, INTENTS_CHAIN_KEY),
      },
      protocolKey: INTENTS_PROTOCOL_KEY,
      chainKey: INTENTS_CHAIN_KEY,
    },
  };
}

// ---------------------------------------------------------------------------
// The settlement observation (the ONLY quote→executed evidence for this venue)
// ---------------------------------------------------------------------------

/**
 * Maps an observed settlement event into the canonical onchain-domain
 * execution observation. This is the ONLY evidence that moves an intent
 * from QUOTED to an executed state — a quote is never an outcome.
 */
export function buildIntentSettlementObservation(input: {
  readonly executionRef: string;
  readonly observationId: string;
  readonly observedAtIso: string;
  readonly settlementTxRef: string;
  readonly settledOutputMinorUnits: string;
  readonly outputCurrency: string;
  readonly confirmationDepth: number;
  readonly reorgDetected: boolean;
}): OnchainExecutionObservation {
  const observation: OnchainExecutionObservation = {
    observationId: input.observationId,
    executionRef: input.executionRef,
    observedAt: input.observedAtIso,
    chainKey: INTENTS_CHAIN_KEY,
    outcome: "CONFIRMED",
    externalOperationRef: input.settlementTxRef,
    finalityCandidate: {
      candidateOnly: true,
      requiresProtocolFinality: true,
      confirmationDepth: input.confirmationDepth,
      finalityModel: "PROBABILISTIC",
      reorgDetected: input.reorgDetected,
    },
    evidenceRefs: [
      `evidence:settlement:${input.settlementTxRef}`,
      `evidence:settled-output:${input.settledOutputMinorUnits}-${input.outputCurrency}`,
    ],
    provenance: {
      providerName: "solverbatch-intents-extension-pack",
      source: "PROVIDER_API",
      capturedAt: input.observedAtIso,
    },
  };
  return observation;
}

// ---------------------------------------------------------------------------
// The canonical protocol declaration (SYNTHETIC model deployment)
// ---------------------------------------------------------------------------

/** The INV-SC01 declaration of the synthetic batch-settlement contract. */
export function intentsSettlementDeclaration() {
  return {
    kind: "smart_contract_extension" as const,
    chainRef: INTENTS_CHAIN_KEY,
    contractAddress: INTENTS_SETTLEMENT_ADDRESS,
    sourceHash: "sha256:solverbatch-settlement-declared-source",
    bytecodeHash: "sha256:solverbatch-settlement-deployed-bytecode",
    upgradeAuthority: {
      kind: "MULTISIG" as const,
      description: "council multisig with a 48h timelock",
      delayOrTimelock: "48h timelock",
    },
    adminAuthority: {
      kind: "MULTISIG" as const,
      description: "council multisig (solver-allowlist configuration only)",
    },
    pausePowers: [
      {
        actor: "council-multisig",
        scope: "new batch settlement (settled batches are final)",
      },
    ],
    oracleDependencies: [],
    custody: {
      custodial: false,
      withdrawalAuthority:
        "intent owners withdraw unexecuted (expired) intents directly from the escrow vault",
      keyManagement: "no operator keys can move escrowed intent funds",
    },
    searchableByLabAfterCertification: true,
  };
}

/** The canonical intents protocol definition (protocol + IntentExecutionCapability flavor). */
export interface IntentsProtocolDefinition extends ProtocolDefinition {
  readonly onchain: IntentExecutionCapabilityDeclaration;
}

export function intentsProtocolDefinition(): IntentsProtocolDefinition {
  return {
    ...venueActionCapabilityDefinition(
      protocolCapabilityId(INTENTS_PROTOCOL_KEY, INTENTS_CHAIN_KEY),
      "Solverbatch intents: an intent/solver-oriented onchain execution venue extension pack",
    ),
    kind: "ACTION",
    onchain: {
      capabilityKind: "intent",
      supportedDomains: [INTENTS_CHAIN_KEY],
      settlementModel: "FULFILLER_SETTLED",
      solverCompetition: "OPEN",
    },
    protocol: {
      protocolKey: INTENTS_PROTOCOL_KEY,
      displayName: "Solverbatch Intents (modelled)",
      protocolClass: "INTENT_NETWORK",
      chainKey: INTENTS_CHAIN_KEY,
      smartContracts: [intentsSettlementDeclaration()],
    },
  };
}
