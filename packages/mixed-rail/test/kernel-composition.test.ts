import { describe, expect, it } from "vitest";
import {
  UNISWAP_V2_ROUTER_02_ADDRESS,
  UNISWAP_V2_VENUE_ID,
  createUniswapV2VenuePack,
} from "@payswap/onchain-venues/uniswap";
import type { UniswapPoolState } from "@payswap/onchain-venues/uniswap";
import {
  INTENTS_SETTLEMENT_ADDRESS,
  INTENTS_VENUE_ID,
  createIntentsVenuePack,
} from "@payswap/onchain-venues/intents";
import { canonicalAssetRef } from "@payswap/onchain-domain";
import { CANDIDATE_BODY_REF, CANDIDATE_PRINCIPAL, CHAIN, ETH_ASSET, NOW, NOW_ISO, OWNER, USC_ASSET, BENEFICIARY, TENANT_REF, baseBestExecutionPolicy, baseSecurityPolicy, baseSecurityState, fiatExecutableBlocks, fiatScenario, fiatWorld, uscAssetObservation } from "./fixtures.js";
import { engineFromVenuePacks, discoverOnchainLane, protocolInstanceForPack, executeOnchainLane } from "../src/index.js";
import {
  MIXED_RAIL_DOMAIN_PACK,
  buildMixedRailCandidate,
  simulateMixedRail,
} from "./mixed-rail-lab-harness.js";

/**
 * P4-W3-001 requirement 1, the strongest proof: the Lab composes the REAL
 * venue extension packs (the merged Wave 2 execution plane) through the
 * REAL engine — the uniswap v2 reference pack (deterministic pool math,
 * real INV-SC01 router declarations, venue simulation + kernel gates) and
 * the intents/solver pack. No fixture venues here: quotes come from the
 * packs' own pool mathematics, writes from the packs' own planWrite, gate
 * decisions from the kernel's own gates on the packs' own approvals.
 */

function labUscEthPool(): UniswapPoolState {
  return {
    pairId: "pair:mixed-rail:usc-eth",
    assetA: USC_ASSET,
    assetB: ETH_ASSET,
    reserveAMinorUnits: "1000000000", // 1,000 USC (6 digits)
    reserveBMinorUnits: "333333333", // ETH-side reserve
    freshness: { asOfMs: NOW, maxAgeMs: 10_000 },
    provenance: {
      providerName: "mixed-rail-kernel-composition",
      source: "INDEXED_POOL_STATE",
      capturedAtMs: NOW,
      evidenceRefs: ["evidence:kernel-composition:usc-eth"],
    },
    observer: { observerId: "observer:kernel-composition-indexer", observerKind: "INDEXER" },
  };
}

describe("P4-W3-001 kernel composition: REAL venue packs behind the REAL engine", () => {
  it("a real uniswap v2 pack proves a lane through this package's discovery", () => {
    const pack = createUniswapV2VenuePack({ pools: [labUscEthPool()] });
    const { engine } = engineFromVenuePacks([pack]);
    const instance = protocolInstanceForPack(pack, {
      instanceId: "instance:kernel-composition:uniswap",
      accountRef: OWNER,
      tenantRef: TENANT_REF,
    });
    const result = discoverOnchainLane({
      engine,
      executionId: "kernel-composition-001",
      swap: {
        requestId: "swap-request-kernel-composition-001",
        chain: CHAIN,
        inputAsset: USC_ASSET,
        outputAsset: ETH_ASSET,
        swapKind: "EXACT_INPUT",
        amount: { currency: "USC", minorUnits: "1000000" },
      },
      policy: baseBestExecutionPolicy(),
      security: {
        policy: baseSecurityPolicy({
          allowedSpenders: [UNISWAP_V2_ROUTER_02_ADDRESS],
        }),
        state: baseSecurityState(),
      },
      instances: [instance],
      assetObservations: [uscAssetObservation()],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:mixed-rail-kernel-composition",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(result.status).toBe("LANE_PROVED");
    if (result.status !== "LANE_PROVED") {
      return;
    }
    const { lane } = result;
    // The REAL pack's venue produced the quote (its own pool math).
    expect(lane.venueId).toBe(UNISWAP_V2_VENUE_ID);
    expect(lane.quote.provenance.providerName).toContain("uniswap");
    // The REAL pack's router is the approval spender in the kernel write.
    const approval = lane.write.approvals[0]!;
    expect(approval.spender).toBe(UNISWAP_V2_ROUTER_02_ADDRESS);
    // The kernel gates ALLOWED the pack's write (real gate decision).
    expect(lane.gateDecision.decision).toBe("ALLOW");
    // The pack's own simulation ran through the kernel recorder.
    expect(lane.simulation).toBeDefined();
    if (lane.simulation !== undefined) {
      expect(lane.simulation.simulator).toContain("uniswap");
    }
    // Provider-native baseline declared by the REAL pack (INV-C08).
    expect(lane.isVenueNativeBaseline).toBe(true);
    // The asset observation grounding is the canonical USC position.
    expect(lane.inputAssetObservation.assetId).toBe(canonicalAssetRef(CHAIN, "USC"));
  });

  it("a real intents pack participates and can win selection", () => {
    const intentsPack = createIntentsVenuePack({});
    const uniswapPools = { pools: [labUscEthPool()] };
    const uniswapPack = createUniswapV2VenuePack(uniswapPools);
    const { engine } = engineFromVenuePacks([intentsPack, uniswapPack]);
    const instances = [
      protocolInstanceForPack(intentsPack, {
        instanceId: "instance:kernel-composition:intents",
        accountRef: OWNER,
        tenantRef: TENANT_REF,
      }),
      protocolInstanceForPack(uniswapPack, {
        instanceId: "instance:kernel-composition:uniswap",
        accountRef: OWNER,
        tenantRef: TENANT_REF,
      }),
    ];
    const result = discoverOnchainLane({
      engine,
      executionId: "kernel-composition-002",
      swap: {
        requestId: "swap-request-kernel-composition-002",
        chain: CHAIN,
        inputAsset: USC_ASSET,
        outputAsset: ETH_ASSET,
        swapKind: "EXACT_INPUT",
        amount: { currency: "USC", minorUnits: "1000000" },
      },
      policy: baseBestExecutionPolicy(),
      security: {
        policy: baseSecurityPolicy({
          allowedSpenders: [UNISWAP_V2_ROUTER_02_ADDRESS, INTENTS_SETTLEMENT_ADDRESS],
        }),
        state: baseSecurityState(),
      },
      instances,
      assetObservations: [uscAssetObservation()],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:mixed-rail-kernel-composition",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(result.status).toBe("LANE_PROVED");
    if (result.status !== "LANE_PROVED") {
      return;
    }
    // Both REAL packs were asked; both quotes are recorded in the kernel
    // provenance chain (whatever the deterministic ranking selected).
    expect(result.provenance.venues.map((venue) => venue.venueId)).toContain(
      UNISWAP_V2_VENUE_ID,
    );
    expect(result.provenance.venues.map((venue) => venue.venueId)).toContain(
      INTENTS_VENUE_ID,
    );
    expect(["uniswap-v2", "solverbatch-intents"]).toContain(result.lane.venueId);
  });

  it("a mixed candidate composed with the REAL pack simulates end-to-end", () => {
    const pack = createUniswapV2VenuePack({ pools: [labUscEthPool()] });
    const { engine } = engineFromVenuePacks([pack]);
    const instance = protocolInstanceForPack(pack, {
      instanceId: "instance:kernel-composition:uniswap",
      accountRef: OWNER,
      tenantRef: TENANT_REF,
    });
    const laneResult = discoverOnchainLane({
      engine,
      executionId: "kernel-composition-003",
      swap: {
        requestId: "swap-request-kernel-composition-003",
        chain: CHAIN,
        inputAsset: USC_ASSET,
        outputAsset: ETH_ASSET,
        swapKind: "EXACT_INPUT",
        amount: { currency: "USC", minorUnits: "1000000" },
      },
      policy: baseBestExecutionPolicy(),
      security: {
        policy: baseSecurityPolicy({ allowedSpenders: [UNISWAP_V2_ROUTER_02_ADDRESS] }),
        state: baseSecurityState(),
      },
      instances: [instance],
      assetObservations: [uscAssetObservation()],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:mixed-rail-kernel-composition",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    if (laneResult.status !== "LANE_PROVED") {
      throw new Error("real-pack lane must be proved");
    }

    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:kernel-composition-1",
      title: "kernel composition mixed candidate",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [laneResult.lane],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    expect(candidate.compositionClass).toBe("MIXED");

    const simulation = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-kernel-composition-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    expect(simulation.executionTier).toBe("LAB_SIMULATION_NON_PRODUCTION");
    expect(simulation.metrics.onchainConfirmed).toBe(1);
    expect(simulation.metrics.venueNativeBaselineLanes).toBe(1);

    // The provenance chain references the REAL pack's quote freshness and
    // the kernel evidence refs (pool state evidence from the pack).
    const onchainRecord = simulation.provenance.lanes.find(
      (record) => record.laneKind === "ONCHAIN",
    );
    expect(onchainRecord?.venueId).toBe(UNISWAP_V2_VENUE_ID);
    expect(onchainRecord?.evidenceRefs).toContain(
      "evidence:pool-state:pair:mixed-rail:usc-eth",
    );

    // Determinism through the REAL pack (replay equality).
    const again = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-kernel-composition-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    expect(again.digest).toBe(simulation.digest);

    // Fault injection on the REAL pack's lane: UNKNOWN stays UNKNOWN.
    const unknown = simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-kernel-composition-1",
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFaults: {
        [laneResult.lane.laneId]: {
          kind: "OUTCOME_UNKNOWN",
          reason: "simulated reorg on the real pack's lane: the receipt vanished",
        },
      },
    });
    expect(unknown.metrics.onchainUnknown).toBe(1);
    expect(unknown.metrics.onchainConfirmed).toBe(0);
    const execution = unknown.onchainExecutions[0]!;
    if (execution.status !== "EXECUTED") {
      throw new Error("execution must be EXECUTED");
    }
    expect(execution.outcome).toBe("OUTCOME_UNKNOWN");

    // The walk also validates the REAL lane's execution observation.
    const walk = executeOnchainLane({
      lane: laneResult.lane,
      at: NOW,
      observedAtIso: NOW_ISO,
    });
    expect(walk.status).toBe("EXECUTED");
  });
});
