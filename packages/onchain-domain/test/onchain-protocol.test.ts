import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  canonicalProtocolRef,
  protocolCapabilityId,
  validateProtocolDefinition,
  validateProtocolDescriptor,
  validateProtocolImplementation,
  validateConnectedProtocolInstance,
  PROTOCOL_CLASSES,
} from "../src/onchain-protocol.js";
import { protocolDefinition, ETHEREUM_CHAIN_KEY, connectedChainInstance } from "./fixtures.js";
import { validateSmartContractExtension, assessSmartContractRisk } from "@payswap/capabilities";

describe("protocol definitions (compose the canonical INV-SC01 declaration — never duplicate)", () => {
  it("validates a canonical protocol definition", () => {
    const definition = validateProtocolDefinition(protocolDefinition());
    expect(definition.protocol.protocolKey).toBe("bridge-example");
    expect(definition.protocol.protocolClass).toBe("BRIDGE");
    expect(definition.kind).toBe("ACTION");
  });

  it("REUSES the canonical SmartContractExtension vocabulary: the declaration validates through @payswap/capabilities", () => {
    const definition = validateProtocolDefinition(protocolDefinition());
    const contract = definition.protocol.smartContracts[0]!;
    // The canonical capabilities validator accepts the reused declaration.
    expect(() => validateSmartContractExtension(contract)).not.toThrow();
    // And the canonical risk assessment machinery runs on it (INV-SC04).
    const risk = assessSmartContractRisk(contract);
    expect(risk.custodyRisk).toBe("CUSTODIAL");
    expect(risk.pauseRisk).toBe("PRESENT");
  });

  it("enforces the deterministic protocol identity", () => {
    const expected = protocolCapabilityId("bridge-example", ETHEREUM_CHAIN_KEY);
    expect(expected).toBe("protocol.ethereum:mainnet:bridge-example");
    expect(canonicalProtocolRef("bridge-example", ETHEREUM_CHAIN_KEY)).toBe(
      "ethereum:mainnet/protocol:bridge-example",
    );
    const tampered = { ...protocolDefinition(), capabilityId: "protocol.nowhere:x" };
    expect(() => validateProtocolDefinition(tampered)).toThrow(/deterministic/);
  });

  it("requires at least one smart-contract declaration (INV-SC01 never empty)", () => {
    const empty = {
      ...protocolDefinition(),
      protocol: { ...protocolDefinition().protocol, smartContracts: [] },
    };
    expect(() => validateProtocolDefinition(empty)).toThrow(/at least one smart contract/);
  });

  it("rejects a contract whose declared chain does not match the protocol's chain", () => {
    const offChain = {
      ...protocolDefinition(),
      protocol: {
        ...protocolDefinition().protocol,
        smartContracts: [
          {
            ...protocolDefinition().protocol.smartContracts[0]!,
            chainRef: "solana:mainnet-beta",
          },
        ],
      },
    };
    expect(() => validateProtocolDefinition(offChain)).toThrow(/does not match the protocol chain/);
  });

  it("rejects an incomplete smart-contract declaration (undeclared property — INV-NC03)", () => {
    const undeclared = {
      ...protocolDefinition(),
      protocol: {
        ...protocolDefinition().protocol,
        smartContracts: [
          { ...protocolDefinition().protocol.smartContracts[0]!, custody: undefined },
        ],
      },
    };
    expect(() => validateProtocolDefinition(undeclared)).toThrow(/custody must be declared/);
  });

  it("rejects an unknown protocol class and malformed protocol keys", () => {
    expect(() =>
      validateProtocolDescriptor({
        ...protocolDefinition().protocol,
        protocolClass: "MONEY_PRINTER",
      }),
    ).toThrow(/protocolClass/);
    expect(() =>
      validateProtocolDescriptor({ ...protocolDefinition().protocol, protocolKey: "Not Canonical!" }),
    ).toThrow(/protocolKey/);
  });

  it("protocol class vocabulary covers the onchain protocol families", () => {
    for (const cls of ["DEX", "BRIDGE", "INTENT_NETWORK", "LENDING", "ESCROW"] as const) {
      expect(PROTOCOL_CLASSES).toContain(cls);
    }
  });
});

describe("protocol implementations and connected instances", () => {
  it("validates a canonical protocol implementation", () => {
    const implementation = validateProtocolImplementation({
      implementationId: "impl:protocol:001",
      providerName: "protocol-connector",
      providerVersion: "1.0.0",
      capabilityId: protocolCapabilityId("bridge-example", ETHEREUM_CHAIN_KEY),
      version: "1.0.0",
      adapterRef: "adapter:protocol",
      corridors: [],
      knownDeviations: [],
      protocolKey: "bridge-example",
      chainKey: ETHEREUM_CHAIN_KEY,
    });
    expect(implementation.protocolKey).toBe("bridge-example");
  });

  it("validates a canonical connected protocol instance with the deterministic linkage", () => {
    const instance = validateConnectedProtocolInstance({
      ...connectedChainInstance(),
      capabilityId: protocolCapabilityId("bridge-example", ETHEREUM_CHAIN_KEY),
      protocolKey: "bridge-example",
      chainKey: ETHEREUM_CHAIN_KEY,
    });
    expect(instance.protocolKey).toBe("bridge-example");
  });

  it("rejects a connected protocol instance without the deterministic capability linkage", () => {
    expect(() =>
      validateConnectedProtocolInstance({
        ...connectedChainInstance(),
        protocolKey: "bridge-example",
        chainKey: ETHEREUM_CHAIN_KEY,
      }),
    ).toThrow(/deterministic protocol capability id/);
  });

  it("a protocol DEFINITION is not an instance: it carries no authorization scope", () => {
    const definition = protocolDefinition();
    const record = definition as unknown as Record<string, unknown>;
    expect(record.instanceId).toBeUndefined();
    expect(record.accountRef).toBeUndefined();
    expect(record.authorization).toEqual({
      protocolAuthorization: true,
      requiredScopes: ["onchain:write"],
      customerConsent: "EXPLICIT",
    });
    // The definition's authorization DECLARATION states that protocol
    // authorization is required — it is not an authorization scope itself.
  });
});
