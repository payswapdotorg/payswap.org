import { describe, expect, it } from "vitest";
import { validateVenueQuote } from "@payswap/best-execution";
import { prepareWrite } from "@payswap/onchain-security";
import {
  UNISWAP_V2_FACTORY_ADDRESS,
  UNISWAP_V2_PROTOCOL_KEY,
  UNISWAP_V2_ROUTER_02_ADDRESS,
  UNISWAP_V2_VENUE_ID,
  createUniswapV2VenuePack,
  uniswapV2HopOutput,
  uniswapV2ProtocolDefinition,
} from "../src/uniswap/index.js";
import {
  BENEFICIARY,
  CHAIN,
  DAI_ASSET,
  ETH_ASSET,
  NOW,
  OWNER,
  USC_ASSET,
  deepEthDaiPool,
  deepUscEthPool,
  thinUscDaiPool,
  uscSwapRequest,
  uscToDaiSwapRequest,
} from "./helpers.js";

/**
 * The Uniswap reference venue extension: real v2 constant-product math,
 * router-native multi-hop path selection (the provider-native incumbent
 * baseline), the observation law on quotes, and kernel-ready write
 * planning.
 */

const pack = createUniswapV2VenuePack({
  pools: [deepUscEthPool(), deepEthDaiPool(), thinUscDaiPool()],
  intermediates: [ETH_ASSET],
  gasCost: {
    gasUnits: "160000",
    pricePerUnitNativeMinor: { numerator: "20000000000", denominator: "1" },
    feeAsset: ETH_ASSET,
  },
});

describe("the v2 constant-product math (exact, fee embedded)", () => {
  it("computes the exact v2 output (hand-verified value)", () => {
    // amountIn 1000, reserves 100000/100000:
    // floor((1000×997×100000)/(100000×1000 + 1000×997)) = floor(99700000000/100997000) = 987
    expect(uniswapV2HopOutput(1000n, 100000n, 100000n)).toBe(987n);
  });

  it("is monotone in the input and bounded by the no-fee invariant", () => {
    const small = uniswapV2HopOutput(1000n, 100000n, 100000n);
    const large = uniswapV2HopOutput(2000n, 100000n, 100000n);
    expect(large).toBeGreaterThan(small);
    const noFee = (1000n * 100000n) / (100000n + 1000n);
    expect(small).toBeLessThan(noFee);
  });

  it("rejects non-positive reserves (fail closed)", () => {
    expect(() => uniswapV2HopOutput(1000n, 0n, 100000n)).toThrow();
    expect(() => uniswapV2HopOutput(1000n, 100000n, 0n)).toThrow();
  });
});

describe("the reference venue quotes (the observation law)", () => {
  it("produces a fully valid executable quote with declared-limit slippage", () => {
    const outcome = pack.venue.quote(uscSwapRequest(ETH_ASSET), NOW);
    expect(outcome.kind).toBe("QUOTE");
    if (outcome.kind !== "QUOTE") {
      return;
    }
    expect(() => validateVenueQuote(outcome.quote)).not.toThrow();
    expect(outcome.quote.venueId).toBe(UNISWAP_V2_VENUE_ID);
    expect(outcome.quote.quoteSemantics).toBe("EXECUTABLE");
    expect(outcome.quote.optimizationOrigin).toBe("PROVIDER_NATIVE");
    expect(outcome.quote.slippage.limitBasisPoints).toBe(50);
    // Worst case = expected × (10000-50)/10000 (exact floor).
    const expected = BigInt(outcome.quote.slippage.expectedOutput?.minorUnits ?? "0");
    const worst = BigInt(outcome.quote.slippage.worstCaseOutput.minorUnits);
    expect(worst).toBe((expected * 9950n) / 10000n);
  });

  it("the v2 pool fee is embedded in the output and NEVER double-counted as a fee component", () => {
    const outcome = pack.venue.quote(uscSwapRequest(ETH_ASSET), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(outcome.quote.fees).toEqual([]);
    expect(outcome.quote.routeShape[0]?.description).toContain("0.30% pool fee embedded");
  });

  it("quote freshness inherits the OLDEST pool state's asOf (the observation law)", () => {
    const stalePoolTime = NOW - 60_000;
    const packWithStalePool = createUniswapV2VenuePack({
      pools: [
        { ...deepUscEthPool(), freshness: { asOfMs: stalePoolTime, maxAgeMs: 10_000 } },
      ],
    });
    const outcome = packWithStalePool.venue.quote(uscSwapRequest(ETH_ASSET), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(outcome.quote.freshness.asOfMs).toBe(stalePoolTime);
  });

  it("serves only its declared chain (deterministic unavailability)", () => {
    const outcome = pack.venue.quote(
      { ...uscSwapRequest(ETH_ASSET), chain: "solana:mainnet-beta" },
      NOW,
    );
    expect(outcome).toEqual({
      kind: "UNAVAILABLE",
      reason: expect.stringContaining("ethereum:mainnet"),
    });
  });
});

describe("router-native path selection (the provider-native incumbent baseline)", () => {
  it("selects the DIRECT pair when it is the best route", () => {
    const outcome = pack.venue.quote(uscSwapRequest(ETH_ASSET), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(outcome.quote.routeShape.length).toBe(1);
  });

  it("selects the TWO-HOP route through the intermediate when the direct pool is thin", () => {
    const outcome = pack.venue.quote(uscToDaiSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    // The thin direct USC/DAI pool loses to the deep USC→ETH→DAI route.
    expect(outcome.quote.routeShape.length).toBe(2);
    expect(outcome.quote.routeShape[0]?.description).toContain("USC→ETH");
    expect(outcome.quote.routeShape[1]?.description).toContain("ETH→DAI");

    // And the two-hop output strictly beats the direct thin-pool output
    // (verified with the same math).
    const direct = uniswapV2HopOutput(1000000n, 5000000n, 5000000n);
    const hop1 = uniswapV2HopOutput(
      1000000n,
      BigInt(deepUscEthPool().reserveAMinorUnits),
      BigInt(deepUscEthPool().reserveBMinorUnits),
    );
    const hop2 = uniswapV2HopOutput(
      hop1,
      BigInt(deepEthDaiPool().reserveAMinorUnits),
      BigInt(deepEthDaiPool().reserveBMinorUnits),
    );
    expect(hop2).toBeGreaterThan(direct);
    expect(outcome.quote.slippage.expectedOutput?.minorUnits).toBe(hop2.toString());
  });

  it("the pack declares its router-native optimization as the incumbent baseline", () => {
    expect(pack.venue.descriptor.nativeOptimization).toEqual({
      optimizationKind: "ROUTER_NATIVE_PATH_SELECTION",
      benchmarkBaseline: true,
      description: expect.any(String),
    });
  });
});

describe("kernel write planning + simulation", () => {
  it("plans a kernel-valid write: router approval + router contract call + protocol identity", () => {
    const outcome = pack.venue.quote(uscSwapRequest(ETH_ASSET), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    const writeRequest = pack.venue.planWrite({
      quote: outcome.quote,
      instance: {
        instanceId: "instance:uniswap-v2:001",
        capabilityId: `protocol.${CHAIN}:${UNISWAP_V2_PROTOCOL_KEY}`,
        implementationId: "impl:uniswap-v2:extension-pack",
        providerName: "payswap-onchain-venues",
        providerVersion: "1.0.0",
        accountRef: "acct:merchant-001",
        tenantRef: "tenant:merchant-001",
        authorization: {
          status: "ACTIVE",
          grantedAt: "2026-10-01T00:00:00Z",
          authorizationRef: "authz:001",
        },
        credentialScope: { credentialRef: "cred:001", credentialKind: "API_KEY" },
        geography: { countries: ["US"] },
        currencies: ["USC"],
        permissionState: {
          granted: ["onchain:write"],
          requested: ["onchain:write"],
          missing: [],
        },
        eligibility: { eligible: true, reasons: [] },
        configuration: {},
        protocolKey: UNISWAP_V2_PROTOCOL_KEY,
        chainKey: CHAIN,
      },
      owner: OWNER,
      beneficiary: BENEFICIARY,
      routeRef: "route/ref-1",
      routeHash: "fnv1a64:0000000000000001",
      expiryMs: NOW + 300_000,
      requestedBy: "agent:agent-key-1",
    });
    const prepared = prepareWrite(writeRequest, NOW);
    expect(prepared.writeId).toBe(`write:uniswap-v2:${outcome.quote.quoteId}`);
    expect(prepared.action).toBe("onchain.swap");
    expect(prepared.approvals[0]?.spender).toBe(UNISWAP_V2_ROUTER_02_ADDRESS);
    expect(prepared.contractCall?.target).toBe(UNISWAP_V2_ROUTER_02_ADDRESS);
    expect(prepared.protocol?.protocolId).toBe(UNISWAP_V2_PROTOCOL_KEY);
  });

  it("simulates consistently with the planned write (kernel recordSimulation accepts it)", () => {
    const outcome = pack.venue.quote(uscSwapRequest(ETH_ASSET), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    const writeRequest = pack.venue.planWrite({
      quote: outcome.quote,
      instance: {
        instanceId: "i",
        capabilityId: `protocol.${CHAIN}:${UNISWAP_V2_PROTOCOL_KEY}`,
        implementationId: "impl",
        providerName: "p",
        providerVersion: "1",
        accountRef: "a",
        tenantRef: "t",
        authorization: { status: "ACTIVE" },
        credentialScope: { credentialRef: "c", credentialKind: "API_KEY" },
        geography: { countries: ["US"] },
        currencies: ["USC"],
        permissionState: { granted: [], requested: [], missing: [] },
        eligibility: { eligible: true, reasons: [] },
        configuration: {},
        protocolKey: UNISWAP_V2_PROTOCOL_KEY,
        chainKey: CHAIN,
      },
      owner: OWNER,
      beneficiary: BENEFICIARY,
      routeRef: "route/ref-1",
      routeHash: "fnv1a64:0000000000000001",
      expiryMs: NOW + 300_000,
      requestedBy: "agent:agent-key-1",
    });
    const prepared = prepareWrite(writeRequest, NOW);
    const simulation = pack.venue.simulate?.(prepared, NOW);
    expect(simulation?.writeId).toBe(prepared.writeId);
    expect(simulation?.status).toBe("SUCCEEDED");
    expect(simulation?.approvals[0]?.spender).toBe(UNISWAP_V2_ROUTER_02_ADDRESS);
  });
});

describe("the canonical protocol declarations", () => {
  it("declares the published v2 contracts (public constants, full INV-SC01)", () => {
    const definition = uniswapV2ProtocolDefinition();
    const contracts = definition.protocol.smartContracts;
    expect(contracts.map((contract) => contract.contractAddress)).toEqual([
      UNISWAP_V2_ROUTER_02_ADDRESS,
      UNISWAP_V2_FACTORY_ADDRESS,
    ]);
    // Router02: immutable, non-custodial.
    const router = contracts[0];
    expect(router?.upgradeAuthority.kind).toBe("IMMUTABLE");
    expect(router?.custody.custodial).toBe(false);
    expect(router?.chainRef).toBe(CHAIN);
  });

  it("the pack's quotes carry USC and DAI conversions correctly via output asset identity", () => {
    // Sanity: the pack quote for USC→DAI denominates in DAI.
    const outcome = pack.venue.quote(uscToDaiSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(outcome.quote.outputAsset.assetId).toBe(DAI_ASSET.assetId);
    expect(outcome.quote.slippage.worstCaseOutput.currency).toBe("DAI");
    expect(outcome.quote.inputAmount.currency).toBe("USC");
  });
});
