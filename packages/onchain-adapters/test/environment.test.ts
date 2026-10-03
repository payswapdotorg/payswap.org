import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  CHAIN_ENVIRONMENT_REGISTRY,
  classifyChainEnvironment,
  productionEnvironment,
  railEnvironment,
  assertEnvironmentClass,
} from "../src/environment.js";
import { TestnetNeverProductionError } from "../src/errors.js";
import { adapterSettlementEnvelope } from "../src/settlement-gate.js";
import { EvmChainAdapter, nativeEtherBinding, ETHEREUM_MAINNET_PUBLIC_ENDPOINTS, ETHEREUM_SEPOLIA_PUBLIC_ENDPOINTS } from "../src/evm/index.js";
import { SOLANA_MAINNET_PUBLIC_ENDPOINTS } from "../src/solana/index.js";
import { BITCOIN_MAINNET_PUBLIC_ENDPOINTS } from "../src/utxo/index.js";
import { HttpJsonRpcTransport } from "../src/transport.js";
import { assertEndpointProviderDiversity } from "../src/transport.js";
import { fakeEndpoint, CHAIN, ETHEREUM_ASSET_ID, NOW_ISO } from "./helpers.js";
import { evmAdapter } from "./adapter-fixture.js";

/**
 * The environment/rail discriminator is STRUCTURAL (P4-W2-001 hard
 * constraint): chain identity classifies the environment — a runtime flag
 * alone can never claim production for a testnet chain.
 */
describe("structural environment discrimination", () => {
  it("chain identity classifies the environment (frozen registry)", () => {
    expect(classifyChainEnvironment("ethereum:mainnet")).toBe("PRODUCTION");
    expect(classifyChainEnvironment("ethereum:sepolia")).toBe("TESTNET");
    expect(classifyChainEnvironment("solana:mainnet-beta")).toBe("PRODUCTION");
    expect(classifyChainEnvironment("solana:devnet")).toBe("TESTNET");
    expect(classifyChainEnvironment("bitcoin:mainnet")).toBe("PRODUCTION");
    expect(classifyChainEnvironment("bitcoin:regtest")).toBe("REGTEST");
  });

  it("an unknown chainKey classifies FAIL CLOSED (never guessed)", () => {
    expect(() => classifyChainEnvironment("ethereum:unknownnet")).toThrow(ValidationError);
    expect(() => classifyChainEnvironment("notachain")).toThrow(ValidationError);
  });

  it("the environment token DERIVES from the chain identity", () => {
    const production = productionEnvironment("ethereum:mainnet");
    expect(production.environmentClass).toBe("PRODUCTION");
    expect(production.chainKey).toBe("ethereum:mainnet");
    expect(() => productionEnvironment("ethereum:sepolia")).toThrow(TestnetNeverProductionError);
    expect(() => productionEnvironment("bitcoin:regtest")).toThrow(TestnetNeverProductionError);
  });

  it("runtime re-derivation rejects forged environment classes (defense in depth)", () => {
    expect(() => assertEnvironmentClass("ethereum:sepolia", "PRODUCTION")).toThrow(ValidationError);
    expect(() => assertEnvironmentClass("ethereum:mainnet", "TESTNET")).toThrow(ValidationError);
    expect(() => assertEnvironmentClass("ethereum:mainnet", "PRODUCTION")).not.toThrow();
  });

  it("a testnet adapter CANNOT produce a production settlement envelope", () => {
    const sepoliaTransport = new HttpJsonRpcTransport({
      transportId: "transport:sepolia:test",
      endpoints: ETHEREUM_SEPOLIA_PUBLIC_ENDPOINTS,
    });
    const sepoliaAdapter = new EvmChainAdapter({
      adapterId: "adapter:evm:sepolia",
      chainKey: "ethereum:sepolia",
      evmChainId: "11155111",
      transport: sepoliaTransport,
      assetBindings: [nativeEtherBinding("ethereum:sepolia")],
      confirmationDepthTarget: 12,
    });
    expect(sepoliaAdapter.environment.environmentClass).toBe("TESTNET");
    expect(() =>
      adapterSettlementEnvelope({
        adapterId: sepoliaAdapter.adapterId,
        chainKey: sepoliaAdapter.chainKey,
        environmentClass: sepoliaAdapter.environment.environmentClass,
      }),
    ).toThrow(TestnetNeverProductionError);
    // A forged class string cannot pass either (chainKey re-derivation).
    expect(() =>
      adapterSettlementEnvelope({
        adapterId: sepoliaAdapter.adapterId,
        chainKey: sepoliaAdapter.chainKey,
        environmentClass: "PRODUCTION",
      }),
    ).toThrow(TestnetNeverProductionError);
  });

  it("testnet observations never reach production settlement machinery (type + runtime)", () => {
    // Type-level: railEnvironment<"TESTNET"> is not assignable to
    // AdapterSettlementEnvelope<"PRODUCTION">'s environment parameter.
    const testnetEnvironment = railEnvironment<"TESTNET">("ethereum:sepolia");
    const productionToken = productionEnvironment("ethereum:mainnet");
    expect(testnetEnvironment.environmentClass).not.toBe(productionToken.environmentClass);
    // Runtime: the envelope gate is the only bridge, and it re-derives.
    expect(() =>
      adapterSettlementEnvelope({
        adapterId: "a",
        chainKey: "ethereum:sepolia",
        environmentClass: "TESTNET",
      }),
    ).toThrow(/can never feed production settlement machinery/);
  });

  it("the registry is frozen and covers every chain the adapters serve", () => {
    expect(Object.keys(CHAIN_ENVIRONMENT_REGISTRY)).toContain("ethereum:mainnet");
    expect(Object.keys(CHAIN_ENVIRONMENT_REGISTRY)).toContain("solana:mainnet-beta");
    expect(Object.keys(CHAIN_ENVIRONMENT_REGISTRY)).toContain("bitcoin:mainnet");
    expect(Object.isFrozen(CHAIN_ENVIRONMENT_REGISTRY)).toBe(true);
  });

  it("public endpoint profiles carry chain-scoped environment declarations", () => {
    for (const endpoint of ETHEREUM_MAINNET_PUBLIC_ENDPOINTS) {
      expect(classifyChainEnvironment(endpoint.chainKey)).toBe("PRODUCTION");
    }
    for (const endpoint of ETHEREUM_SEPOLIA_PUBLIC_ENDPOINTS) {
      expect(classifyChainEnvironment(endpoint.chainKey)).toBe("TESTNET");
    }
  });
});

describe("endpoint provider diversity (no single vendor law)", () => {
  it("a PRODUCTION transport requires endpoints from ≥2 DISTINCT providers", () => {
    const multi = [
      fakeEndpoint({ endpointId: "e1", providerName: "ProviderA", chainKey: CHAIN }),
      fakeEndpoint({ endpointId: "e2", providerName: "ProviderB", chainKey: CHAIN }),
    ];
    expect(() => assertEndpointProviderDiversity(multi, "PRODUCTION")).not.toThrow();
    const single = [
      fakeEndpoint({ endpointId: "e1", providerName: "ProviderA", chainKey: CHAIN }),
      fakeEndpoint({ endpointId: "e2", providerName: "ProviderA", chainKey: CHAIN }),
    ];
    expect(() => assertEndpointProviderDiversity(single, "PRODUCTION")).toThrow(
      /at least two DISTINCT providers/,
    );
  });

  it("the PUBLIC production profiles of every family satisfy provider diversity", () => {
    expect(() => assertEndpointProviderDiversity(ETHEREUM_MAINNET_PUBLIC_ENDPOINTS, "PRODUCTION")).not.toThrow();
    expect(() => assertEndpointProviderDiversity(SOLANA_MAINNET_PUBLIC_ENDPOINTS, "PRODUCTION")).not.toThrow();
    expect(() => assertEndpointProviderDiversity(BITCOIN_MAINNET_PUBLIC_ENDPOINTS, "PRODUCTION")).not.toThrow();
  });

  it("every adapter-produced record carries its environment class", async () => {
    const adapter = evmAdapter();
    const probe = await adapter.observeChainHead({ at: NOW_ISO });
    if (probe.kind !== "HEAD_OBSERVED") throw new Error("unreachable");
    expect(probe.head.environmentClass).toBe("PRODUCTION");
    expect(probe.head.provenance.environmentClass).toBe("PRODUCTION");
    void ETHEREUM_ASSET_ID;
  });
});
