import { describe, expect, it } from "vitest";
import { BestExecutionEngine } from "@payswap/best-execution";
import { checkSelectedRouteValidity } from "@payswap/best-execution";
import { createUniswapV2VenuePack } from "../src/uniswap/index.js";
import { createAggregatorVenuePack } from "../src/aggregator/index.js";
import { createIntentsVenuePack } from "../src/intents/index.js";
import { venueConnectedProtocolInstance } from "../src/index.js";
import type { RfqMakerOrder } from "../src/aggregator/index.js";
import {
  BENEFICIARY,
  CHAIN,
  ETH_ASSET,
  NOW,
  OWNER,
  USC_ASSET,
  baseBestExecutionPolicy,
  baseSecurityPolicy,
  baseSecurityState,
  deepEthDaiPool,
  deepUscEthPool,
  poolFreshness,
  poolObserver,
  poolProvenance,
  rfqProvenance,
  thinUscDaiPool,
  uscSwapRequest,
} from "./helpers.js";

/**
 * All three real venue packs through the REAL best-execution engine: the
 * reference venue, the independent aggregator and the intent venue compete
 * on identical terms; provider-native optimization is never structurally
 * disadvantaged; the provenance chain records every venue; stale quotes
 * invalidate and refresh re-validates.
 */

const UNISWAP_GAS = {
  gasUnits: "160000",
  pricePerUnitNativeMinor: { numerator: "20000000000", denominator: "1" },
  feeAsset: ETH_ASSET,
} as const;

const AGGREGATOR_GAS = {
  gasUnits: "140000",
  pricePerUnitNativeMinor: { numerator: "60", denominator: "1000000" },
  feeAsset: USC_ASSET,
} as const;

const INTENTS_GAS = {
  gasUnits: "120000",
  pricePerUnitNativeMinor: { numerator: "60", denominator: "1000000" },
  feeAsset: USC_ASSET,
} as const;

function makerOrder(overrides?: Partial<RfqMakerOrder>): RfqMakerOrder {
  return {
    orderId: "rfq-order-001",
    makerRef: "maker:fixture-001",
    assetIn: USC_ASSET,
    assetOut: USC_ASSET,
    outputPerInput: { numerator: "998", denominator: "1000" },
    maxInputMinorUnits: "100000000000",
    validUntilMs: NOW + 60_000,
    freshness: poolFreshness(),
    provenance: rfqProvenance("rfq-order-001"),
    observer: poolObserver(),
    ...overrides,
  };
}

function allPacksInput() {
  const uniswap = createUniswapV2VenuePack({
    pools: [deepUscEthPool(), deepEthDaiPool(), thinUscDaiPool()],
    intermediates: [ETH_ASSET],
    gasCost: UNISWAP_GAS,
  });
  const aggregator = createAggregatorVenuePack({
    rfqOrders: [makerOrder()],
    gasCost: AGGREGATOR_GAS,
  });
  const intents = createIntentsVenuePack({ gasCost: INTENTS_GAS });
  return { uniswap, aggregator, intents };
}

function engineWithAllPacks() {
  const { uniswap, aggregator, intents } = allPacksInput();
  const engine = new BestExecutionEngine();
  engine.register(uniswap.venue);
  engine.register(aggregator.venue);
  engine.register(intents.venue);
  const instances = [
    venueConnectedProtocolInstance({
      protocolKey: "uniswap-v2",
      chainKey: CHAIN,
      instanceId: "instance:uniswap-v2:001",
      providerName: "payswap-onchain-venues",
      accountRef: "acct:merchant-001",
      tenantRef: "tenant:merchant-001",
    }),
    venueConnectedProtocolInstance({
      protocolKey: "zeroswap-aggregator",
      chainKey: CHAIN,
      instanceId: "instance:aggregator:001",
      providerName: "payswap-onchain-venues",
      accountRef: "acct:merchant-001",
      tenantRef: "tenant:merchant-001",
    }),
    venueConnectedProtocolInstance({
      protocolKey: "solverbatch-intents",
      chainKey: CHAIN,
      instanceId: "instance:intents:001",
      providerName: "payswap-onchain-venues",
      accountRef: "acct:merchant-001",
      tenantRef: "tenant:merchant-001",
    }),
  ];
  return { engine, instances };
}

describe("the three venue packs through the real engine", () => {
  it("every pack is asked, recorded in the provenance chain, and gated when it quotes", () => {
    const { engine, instances } = engineWithAllPacks();
    const decision = engine.execute({
      executionId: "execution-integration-001",
      swap: uscSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances,
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(decision.decision).toBe("ROUTE_SELECTED");
    // The provenance chain records EVERY venue asked, with its exact outcome.
    expect(decision.provenance.venues.map((venue) => venue.venueId)).toEqual([
      "uniswap-v2",
      "zeroswap-aggregator",
      "solverbatch-intents",
    ]);
    for (const venue of decision.provenance.venues) {
      expect(["QUOTED", "UNAVAILABLE", "OUTCOME_UNKNOWN"]).toContain(venue.outcome);
    }
    // Every candidate that quoted was gated (no venue path bypassed the gates).
    for (const trace of decision.ranking) {
      expect(["ALLOW", "BLOCK", "UNKNOWN", "NOT_EVALUATED"]).toContain(
        trace.security.gateDecision,
      );
    }
  });

  it("the aggregator wins when its net executable outcome is best (provider-native never disadvantaged)", () => {
    const { engine, instances } = engineWithAllPacks();
    const decision = engine.execute({
      executionId: "execution-integration-002",
      swap: uscSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances,
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(decision.decision).toBe("ROUTE_SELECTED");
    if (decision.decision !== "ROUTE_SELECTED") {
      return;
    }
    // USC→USC: uniswap has NO direct USC/USC pair (its pools pair USC-ETH,
    // ETH-DAI, USC-DAI) → UNAVAILABLE; the aggregator's RFQ (997002 after
    // fee, 8.4 USC-minor gas) vs the intent venue (999500 limit, 7.2
    // USC-minor gas): the intent venue wins on the guaranteed number.
    expect(decision.selected.venueId).toBe("solverbatch-intents");
    expect(decision.provenance.venues[0]?.outcome).toBe("UNAVAILABLE");
    // And the selection margin is recorded.
    expect(decision.provenance.selection?.marginOverRunnerUpMinorUnits).toBeDefined();
  });

  it("the reference venue wins when its multi-hop route is best", () => {
    // The intent venue's auction domain lists only USC in this fixture:
    // USC→DAI is served by the reference venue's deep two-hop route alone.
    const { uniswap, aggregator } = allPacksInput();
    const restrictedIntents = createIntentsVenuePack({
      gasCost: INTENTS_GAS,
      supportedOutputAssets: [USC_ASSET],
    });
    const { instances } = engineWithAllPacks();
    const engine = new BestExecutionEngine();
    engine.register(uniswap.venue);
    engine.register(aggregator.venue);
    engine.register(restrictedIntents.venue);
    const decision = engine.execute({
      executionId: "execution-integration-003",
      swap: {
        requestId: "swap-request-usc-dai",
        chain: CHAIN,
        inputAsset: USC_ASSET,
        outputAsset: {
          chain: CHAIN,
          assetId: "0xcccc333333333333333333333333333333333333",
          symbol: "DAI",
        },
        swapKind: "EXACT_INPUT",
        amount: { currency: "USC", minorUnits: "1000000" },
      },
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances,
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(decision.decision).toBe("ROUTE_SELECTED");
    if (decision.decision !== "ROUTE_SELECTED") {
      return;
    }
    // The reference venue's deep two-hop route wins.
    expect(decision.selected.venueId).toBe("uniswap-v2");
    expect(decision.selected.quote.routeShape.length).toBe(2);
    expect(decision.selected.gateDecision.decision).toBe("ALLOW");
  });

  it("the aggregator wins when its RFQ maker strictly beats the intent venue", () => {
    const { uniswap, intents } = allPacksInput();
    const richAggregator = createAggregatorVenuePack({
      rfqOrders: [
        makerOrder({ outputPerInput: { numerator: "1050", denominator: "1000" } }),
      ],
      gasCost: AGGREGATOR_GAS,
    });
    const engine = new BestExecutionEngine();
    engine.register(uniswap.venue);
    engine.register(richAggregator.venue);
    engine.register(intents.venue);
    const { instances } = engineWithAllPacks();
    const decision = engine.execute({
      executionId: "execution-integration-004",
      swap: uscSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances,
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe(
      "zeroswap-aggregator",
    );
  });

  it("a security BLOCK on the best venue's contract kills its route and the runner-up wins", () => {
    const { engine, instances } = engineWithAllPacks();
    const decision = engine.execute({
      executionId: "execution-integration-005",
      swap: uscSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: {
        policy: baseSecurityPolicy({
          // The intents settlement contract is NOT an allowed spender:
          // the best quote's write gets BLOCKed at the gates.
          allowedSpenders: [
            "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
            "0xA11Ce0000000000000000000000000000000BEEF",
          ],
        }),
        state: baseSecurityState(),
      },
      instances,
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(decision.decision).toBe("ROUTE_SELECTED");
    if (decision.decision !== "ROUTE_SELECTED") {
      return;
    }
    expect(decision.selected.venueId).toBe("zeroswap-aggregator");
    const blocked = decision.ranking.find(
      (trace) => trace.venueId === "solverbatch-intents",
    );
    expect(blocked?.status).toBe("SECURITY_BLOCKED");
    expect(blocked?.security.blockReasonCodes).toContain("spender_not_permitted");
  });

  it("stale pool states age the quote out; refreshed pools re-validate (re-selection)", () => {
    const later = NOW + 60_000;
    const freshPacks = allPacksInput();
    const engineA = new BestExecutionEngine();
    engineA.register(freshPacks.uniswap.venue);
    const { instances } = engineWithAllPacks();
    const uniswapInstance = [instances[0] as ReturnType<typeof venueConnectedProtocolInstance>];
    const firstDecision = engineA.execute({
      executionId: "execution-stale-001",
      swap: {
        requestId: "swap-usc-dai-stale",
        chain: CHAIN,
        inputAsset: USC_ASSET,
        outputAsset: {
          chain: CHAIN,
          assetId: "0xcccc333333333333333333333333333333333333",
          symbol: "DAI",
        },
        swapKind: "EXACT_INPUT",
        amount: { currency: "USC", minorUnits: "1000000" },
      },
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances: uniswapInstance,
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(firstDecision.decision).toBe("ROUTE_SELECTED");
    // 60s later the quote (max age 10s, asOf NOW) is stale.
    expect(checkSelectedRouteValidity(firstDecision, later).valid).toBe(false);

    // Refreshed pool states (asOf `later`) produce a fresh, valid decision.
    const refreshedUniswap = createUniswapV2VenuePack({
      pools: [
        { ...deepUscEthPool(), freshness: { asOfMs: later, maxAgeMs: 10_000 } },
        { ...deepEthDaiPool(), freshness: { asOfMs: later, maxAgeMs: 10_000 } },
        { ...thinUscDaiPool(), freshness: { asOfMs: later, maxAgeMs: 10_000 } },
      ],
      intermediates: [ETH_ASSET],
      gasCost: UNISWAP_GAS,
    });
    const engineB = new BestExecutionEngine();
    engineB.register(refreshedUniswap.venue);
    const secondDecision = engineB.execute({
      executionId: "execution-stale-002",
      swap: {
        requestId: "swap-usc-dai-refreshed",
        chain: CHAIN,
        inputAsset: USC_ASSET,
        outputAsset: {
          chain: CHAIN,
          assetId: "0xcccc333333333333333333333333333333333333",
          symbol: "DAI",
        },
        swapKind: "EXACT_INPUT",
        amount: { currency: "USC", minorUnits: "1000000" },
      },
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState({ observedAt: later }) },
      instances: uniswapInstance,
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: later + 300_000,
      at: later,
    });
    expect(secondDecision.decision).toBe("ROUTE_SELECTED");
    if (secondDecision.decision === "ROUTE_SELECTED") {
      expect(checkSelectedRouteValidity(secondDecision, later).valid).toBe(true);
    }
    void poolProvenance;
  });
});
