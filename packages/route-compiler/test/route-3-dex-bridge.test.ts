/**
 * Route 3 — chain A → DEX → bridge → chain B (Work Order P4-W4-001
 * representative route 3).
 *
 * Proves the cross-chain journey: the chain-A DEX hop is an engine-selected
 * lane over the REAL Uniswap pack; the bridge hop is a kernel-prepared
 * "onchain.bridge" write (prepare → gate → expected diff) whose arrival on
 * chain B is honestly recorded (arrival chain + UNKNOWN arrival amount —
 * never estimated without evidence); the environment classes of BOTH chains
 * are derived from the frozen kernel registry; and the native bridge
 * incumbent is emitted as a baseline candidate.
 */

import { describe, expect, it } from "vitest";
import {
  compileBase,
  route3Intent,
  ONCHAIN_FINALITY_MODES,
  NOW,
  NOW_ISO,
  CHAIN,
  CHAIN_B,
  SOLANA_RECIPIENT,
  unknownPlannedReason,
} from "./fixtures.js";
import { walkRoutePlan } from "../src/index.js";

describe("route 3: chainA→DEX→bridge→chainB", () => {
  it("compiles the mixed plan with the DEX and bridge hops", () => {
    const result = compileBase(route3Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-bridge");
    expect(plan).toBeDefined();
    expect(plan!.candidateStatus).toBe("EXECUTABLE_CANDIDATE");
    expect(plan!.legs.map((leg) => leg.legKind)).toEqual([
      "ONCHAIN_DEX_SWAP",
      "ONCHAIN_BRIDGE",
    ]);
    expect(plan!.compositionClass).toBe("ONCHAIN_ONLY");
  });

  it("emits the native bridge incumbent as a baseline (INV-C08)", () => {
    const result = compileBase(route3Intent());
    const baseline = result.plans.find((plan) => plan.shapeId === "provider-native-bridge");
    expect(baseline).toBeDefined();
    expect(baseline!.isProviderNativeBaseline).toBe(true);
    expect(baseline!.candidateStatus).toBe("PROVIDER_NATIVE_BASELINE");
    expect(baseline!.legs.map((leg) => leg.legKind)).toEqual(["ONCHAIN_BRIDGE"]);
    // The native bridge moves the ORIGIN asset directly (no pre-swap).
    expect(baseline!.legs[0]!.custody.amount.currency).toBe("ETH");
  });

  it("records BOTH chain environments from the frozen kernel registry", () => {
    const result = compileBase(route3Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-bridge")!;
    expect(plan.environmentClasses).toContain("PRODUCTION");
    expect(plan.environmentClasses).toHaveLength(2);
    const bridge = plan.legs[1] as Extract<
      typeof plan.legs[number],
      { legKind: "ONCHAIN_BRIDGE" }
    >;
    expect(bridge.arrivalChainKey).toBe(CHAIN_B);
    expect(bridge.write.chain).toBe(CHAIN);
  });

  it("the bridge hop runs through the kernel write pipeline with a gate ALLOW", () => {
    const result = compileBase(route3Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-bridge")!;
    const bridge = plan.legs[1] as Extract<
      typeof plan.legs[number],
      { legKind: "ONCHAIN_BRIDGE" }
    >;
    expect(bridge.gateDecision.decision).toBe("ALLOW");
    expect(bridge.write.action).toBe("onchain.bridge");
    expect(bridge.expectedDiff).toBeDefined();
    expect(bridge.authorizationLineage.legAuthorization.kind).toBe("ONCHAIN_GATE_DECISION");
  });

  it("the bridge arrival amount is honestly UNKNOWN (never estimated without evidence)", () => {
    const result = compileBase(route3Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-bridge")!;
    const bridge = plan.legs[1]! as Extract<
      typeof plan.legs[number],
      { legKind: "ONCHAIN_BRIDGE" }
    >;
    expect(bridge.plannedAmount.basis).toBe("UNKNOWN");
    expect(unknownPlannedReason(bridge.plannedAmount)).toContain("observed at chain-B finality");
    // The DEX hop's output (the bridge deposit) IS quote-grounded.
    expect(plan.legs[0]!.plannedAmount.basis).toBe("QUOTE_GROUNDED");
  });

  it("chains custody wallet(A) → wallet(A) → recipient wallet(B) via the bridge protocol", () => {
    const result = compileBase(route3Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-bridge")!;
    const custodies = plan.legs.map((leg) => leg.custody);
    expect(custodies[0]!.from.kind).toBe("ONCHAIN_WALLET");
    expect(custodies[0]!.to.kind).toBe("ONCHAIN_WALLET");
    expect(custodies[1]!.via?.kind).toBe("ONCHAIN_PROTOCOL");
    const arrival = custodies[1]!.to as { kind: "ONCHAIN_WALLET"; accountRef: string };
    expect(arrival.accountRef).toBe(SOLANA_RECIPIENT);
  });

  it("walks the happy path: both hops observed, arrival at the chain-B recipient", () => {
    const result = compileBase(route3Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-bridge")!;
    const walkResult = walkRoutePlan({
      plan,
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFinalityModels: ONCHAIN_FINALITY_MODES,
    });
    expect(walkResult.status).toBe("ROUTE_COMPLETED_ALL_LEGS_OBSERVED");
    expect(walkResult.custodyAtStop?.party.kind).toBe("ONCHAIN_WALLET");
    // The bridge write settles on chain A's canonical rail id.
    const bridgeExecution = walkResult.legExecutions[1]!;
    expect(bridgeExecution.onchain?.railOperation.railId).toBe("onchain.ethereum:mainnet");
    expect(bridgeExecution.onchain?.observation.finalityCandidate?.finalityModel).toBe(
      "PROBABILISTIC",
    );
  });

  it("excludes the bridge shapes honestly without a bridge contract address", () => {
    const result = compileBase(route3Intent(), {
      routingHints: {
        intermediateStablecoin: {
          chain: CHAIN,
          assetId: "0xaaaa111111111111111111111111111111111111",
          symbol: "USC",
        },
        bridgeDepositAsset: {
          chain: CHAIN,
          assetId: "0xaaaa111111111111111111111111111111111111",
          symbol: "USC",
        },
        offRampDeposit: {
          providerName: "psp-mock",
          chainKey: CHAIN,
          accountRef: "0x5555555555555555555555555555555555555555",
        },
        onrampDeliveryAddress: "0x7777777777777777777777777777777777777777",
        offRampPayoutCapabilityId: "psp.payouts",
      },
    });
    expect(
      result.exclusions.filter((e) => e.shapeId.includes("bridge")).map((e) => e.shapeId).sort(),
    ).toEqual(["mixed-dex-bridge", "provider-native-bridge"]);
  });

  it("same-chain intents compile the direct transfer instead", async () => {
    const { route3Intent, compileBase } = await import("./fixtures.js");
    const intent = route3Intent();
    const sameChain = {
      ...intent,
      intentId: "intent:route-3b:same-chain-direct",
      destination: {
        ...intent.destination,
        chainKey: CHAIN,
        assetId: `${CHAIN}/asset:USC`,
        accountRef: SOLANA_RECIPIENT,
      },
    };
    const result = compileBase(sameChain);
    const direct = result.plans.find((plan) => plan.shapeId === "onchain-direct-transfer");
    expect(direct).toBeDefined();
    expect(direct!.legs.map((leg) => leg.legKind)).toEqual(["ONCHAIN_TRANSFER"]);
    expect(direct!.candidateStatus).toBe("EXECUTABLE_CANDIDATE");
    // The cross-chain shapes are honestly excluded for a same-chain intent.
    expect(result.plans.map((plan) => plan.shapeId)).toEqual(["onchain-direct-transfer"]);
  });
});
