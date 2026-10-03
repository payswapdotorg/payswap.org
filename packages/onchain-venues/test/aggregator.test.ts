import { describe, expect, it } from "vitest";
import { validateVenueQuote } from "@payswap/best-execution";
import {
  AGGREGATOR_PROTOCOL_KEY,
  AGGREGATOR_SETTLEMENT_ADDRESS,
  AGGREGATOR_VENUE_ID,
  createAggregatorVenuePack,
} from "../src/aggregator/index.js";
import { createUniswapV2VenuePack, uniswapV2HopOutput } from "../src/uniswap/index.js";
import {
  CHAIN,
  NOW,
  USC_ASSET,
  deepUscEthPool,
  poolFreshness,
  poolObserver,
  poolProvenance,
  rfqProvenance,
  uscSwapRequest,
} from "./helpers.js";
import type { RfqMakerOrder, AggregatorAmmSource } from "../src/aggregator/index.js";

/**
 * The independent 0x-style aggregator venue: its OWN extension pack —
 * multi-source composition (RFQ + AMM), an explicit integrator fee on top,
 * provider-native smart routing as the incumbent baseline. Deliberately
 * NOT a fork of the reference venue (structurally distinct shapes).
 */

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

function ammSource(overrides?: Partial<AggregatorAmmSource>): AggregatorAmmSource {
  return {
    sourceId: "amm-source-001",
    assetIn: USC_ASSET,
    assetOut: USC_ASSET,
    reserveInMinorUnits: "1000000000000",
    reserveOutMinorUnits: "1000000000000",
    feeBasisPoints: 30,
    freshness: poolFreshness(),
    provenance: poolProvenance("agg-amm-001"),
    observer: poolObserver(),
    ...overrides,
  };
}

const pack = createAggregatorVenuePack({
  rfqOrders: [makerOrder()],
  ammSources: [ammSource()],
  integratorFeeBasisPoints: 10,
  gasCost: {
    gasUnits: "140000",
    pricePerUnitNativeMinor: { numerator: "20000000000", denominator: "1" },
    feeAsset: USC_ASSET,
  },
});

describe("the aggregator is an independent pack (not a reference-venue fork)", () => {
  it("its quotes compose MULTIPLE liquidity sources with distinct provenance kinds", () => {
    const rfqWin = pack.venue.quote(uscSwapRequest(), NOW);
    if (rfqWin.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(rfqWin.quote.provenance.source).toBe("RFQ");
    expect(rfqWin.quote.routeShape[0]?.description).toContain("RFQ maker");

    const ammOnlyPack = createAggregatorVenuePack({
      ammSources: [ammSource()],
    });
    const ammWin = ammOnlyPack.venue.quote(uscSwapRequest(), NOW);
    if (ammWin.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(ammWin.quote.provenance.source).toBe("INDEXED_POOL_STATE");
    expect(ammWin.quote.routeShape[0]?.description).toContain("AMM source");
  });

  it("it charges an EXPLICIT integrator fee on top (the reference venue charges none)", () => {
    const outcome = pack.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(outcome.quote.fees.length).toBe(1);
    expect(outcome.quote.fees[0]?.feeKind).toBe("INTEGRATOR_FEE");
    // 10bps of 1 USC (1,000,000 minor units) = 1,000 minor units (exact floor).
    expect(outcome.quote.fees[0]?.amount.minorUnits).toBe("1000");
  });

  it("its protocol identity, contracts and capability are its own", () => {
    expect(pack.venue.protocol.protocolKey).toBe(AGGREGATOR_PROTOCOL_KEY);
    expect(pack.protocol.protocol.smartContracts[0]?.contractAddress).toBe(
      AGGREGATOR_SETTLEMENT_ADDRESS,
    );
    expect(pack.venue.descriptor.venueId).toBe(AGGREGATOR_VENUE_ID);
  });
});

describe("smart source routing (the provider-native incumbent baseline)", () => {
  it("picks the better source deterministically (RFQ beats the 1:1 AMM here)", () => {
    // RFQ: (1 USC − 10bps fee) × 0.998 = 999000 × 998/1000 = 997002.
    // AMM: post-fee 999000 through 1:1 reserves with 30bps ≈ 996002.
    // RFQ wins.
    const outcome = pack.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    const rfqOutput = (999000n * 998n) / 1000n; // 997002
    const ammPostFee = (999000n * 9970n) / 10000n; // 996003... (30bps)
    const ammOutput = (ammPostFee * 1000000000000n) / (1000000000000n + ammPostFee);
    const expectedBest = rfqOutput > ammOutput ? rfqOutput : ammOutput;
    expect(outcome.quote.slippage.expectedOutput?.minorUnits).toBe(expectedBest.toString());
    expect(expectedBest).toBe(997002n);
  });

  it("picks the AMM source when it is strictly better", () => {
    const betterAmmPack = createAggregatorVenuePack({
      rfqOrders: [makerOrder()],
      ammSources: [
        ammSource({
          sourceId: "amm-deep",
          reserveInMinorUnits: "1000000000000000",
          reserveOutMinorUnits: "1000000000000000",
          feeBasisPoints: 5,
        }),
      ],
    });
    const outcome = betterAmmPack.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(outcome.quote.routeShape[0]?.description).toContain("amm-deep");
  });

  it("expired RFQ orders are skipped deterministically (firm quotes expire)", () => {
    const expiredPack = createAggregatorVenuePack({
      rfqOrders: [
        makerOrder({
          orderId: "rfq-expired",
          validUntilMs: NOW - 1,
          outputPerInput: { numerator: "2", denominator: "1" },
        }),
      ],
      ammSources: [ammSource()],
    });
    const outcome = expiredPack.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(outcome.quote.routeShape[0]?.description).not.toContain("rfq-expired");
  });

  it("oversized requests beyond every source's capacity are UNAVAILABLE", () => {
    const smallPack = createAggregatorVenuePack({
      rfqOrders: [makerOrder({ maxInputMinorUnits: "1000" })],
      ammSources: [],
    });
    const outcome = smallPack.venue.quote(uscSwapRequest(), NOW);
    expect(outcome.kind).toBe("UNAVAILABLE");
  });

  it("the pack declares its smart routing as the incumbent baseline", () => {
    expect(pack.venue.descriptor.nativeOptimization?.benchmarkBaseline).toBe(true);
    expect(pack.venue.descriptor.nativeOptimization?.optimizationKind).toBe(
      "SMART_SOURCE_ROUTING",
    );
  });
});

describe("the quote law and fee math (no double counting)", () => {
  it("the sourced output is computed on the POST-FEE routed input (exact)", () => {
    const outcome = pack.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    // 1 USC input, 10bps integrator fee → 999000 routed; RFQ 0.998 → 997002.
    expect(outcome.quote.slippage.expectedOutput?.minorUnits).toBe("997002");
    expect(() => validateVenueQuote(outcome.quote)).not.toThrow();
    expect(outcome.quote.optimizationOrigin).toBe("PROVIDER_NATIVE");
  });

  it("worst case applies the declared slippage limit exactly", () => {
    const outcome = pack.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(outcome.quote.slippage.limitBasisPoints).toBe(50);
    expect(outcome.quote.slippage.worstCaseOutput.minorUnits).toBe(
      ((997002n * 9950n) / 10000n).toString(),
    );
  });

  it("its AMM-source math matches the canonical constant-product invariant (shared math, own pack)", () => {
    // The aggregator's AMM source uses the same invariant as the reference
    // venue's pools — the MATH is the market's, the PACK is its own shape.
    const reference = uniswapV2HopOutput(999000n, 1000000000000n, 1000000000000n);
    const ammOnly = createAggregatorVenuePack({
      ammSources: [ammSource({ feeBasisPoints: 30 })],
    });
    const outcome = ammOnly.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    // AMM with 30bps fee = v2-style fee: outputs must match exactly.
    expect(outcome.quote.slippage.expectedOutput?.minorUnits).toBe(reference.toString());
    void deepUscEthPool;
  });
});
