import { describe, expect, it } from "vitest";
import { validateOnchainCapabilityDefinition, validateConnectedProtocolInstance } from "@payswap/onchain-domain";
import { protocolCapabilityId } from "@payswap/onchain-domain";
import { BestExecutionEngine } from "@payswap/best-execution";
import { validateVenueExtensionPack, venuePackId } from "../src/index.js";
import { venueConnectedProtocolInstance } from "../src/index.js";
import { createUniswapV2VenuePack } from "../src/uniswap/index.js";
import { createAggregatorVenuePack } from "../src/aggregator/index.js";
import { createIntentsVenuePack } from "../src/intents/index.js";
import {
  CHAIN,
  ETH_ASSET,
  NOW,
  USC_ASSET,
  baseBestExecutionPolicy,
  baseSecurityPolicy,
  baseSecurityState,
  deepUscEthPool,
  uscSwapRequest,
} from "./helpers.js";

/**
 * The venue extension-pack contract: packs validate through the canonical
 * onchain-domain validators (protocol definition + capability flavor +
 * connected instance), pack identity is deterministic, and the INV-C05
 * catalogue-never-authorizes discipline holds.
 */

const uniswapPack = createUniswapV2VenuePack({ pools: [deepUscEthPool()] });
const aggregatorPack = createAggregatorVenuePack({});
const intentsPack = createIntentsVenuePack({});

describe("venue extension-pack validation (the canonical onchain-domain composition)", () => {
  it("every pack validates as a VenueExtensionPack", () => {
    expect(() => validateVenueExtensionPack(uniswapPack)).not.toThrow();
    expect(() => validateVenueExtensionPack(aggregatorPack)).not.toThrow();
    expect(() => validateVenueExtensionPack(intentsPack)).not.toThrow();
  });

  it("every pack's protocol definition validates through the canonical protocol validator", () => {
    for (const pack of [uniswapPack, aggregatorPack, intentsPack]) {
      expect(pack.protocol.protocol.protocolKey).toBe(pack.venue.protocol.protocolKey);
      expect(pack.protocol.protocol.chainKey).toBe(pack.venue.protocol.chainKey);
      expect(pack.protocol.capabilityId).toBe(
        protocolCapabilityId(pack.venue.protocol.protocolKey, pack.venue.protocol.chainKey),
      );
    }
  });

  it("the DEX packs' definitions ALSO validate as DexCapability flavors; the intent pack as IntentExecutionCapability", () => {
    const uniswapFlavor = validateOnchainCapabilityDefinition(uniswapPack.protocol);
    expect(uniswapFlavor.onchain.capabilityKind).toBe("dex");
    const aggregatorFlavor = validateOnchainCapabilityDefinition(aggregatorPack.protocol);
    expect(aggregatorFlavor.onchain.capabilityKind).toBe("dex");
    const intentsFlavor = validateOnchainCapabilityDefinition(intentsPack.protocol);
    expect(intentsFlavor.onchain.capabilityKind).toBe("intent");
    const intentDeclaration = intentsFlavor.onchain as {
      capabilityKind: "intent";
      settlementModel: string;
      solverCompetition: string;
    };
    expect(intentDeclaration.settlementModel).toBe("FULFILLER_SETTLED");
    expect(intentDeclaration.solverCompetition).toBe("OPEN");
  });

  it("the INV-SC01 declarations are complete (source/bytecode/authorities/custody on every contract)", () => {
    for (const pack of [uniswapPack, aggregatorPack, intentsPack]) {
      expect(pack.protocol.protocol.smartContracts.length).toBeGreaterThan(0);
      for (const contract of pack.protocol.protocol.smartContracts) {
        expect(contract.kind).toBe("smart_contract_extension");
        expect(contract.sourceHash).toMatch(/^sha256:/);
        expect(contract.bytecodeHash).toMatch(/^sha256:/);
        expect(contract.upgradeAuthority.kind).toBeTruthy();
        expect(contract.adminAuthority.kind).toBeTruthy();
        expect(typeof contract.custody.custodial).toBe("boolean");
        expect(contract.chainRef).toBe(pack.venue.protocol.chainKey);
      }
    }
  });

  it("pack ids are deterministic and couple to the venue identity", () => {
    expect(uniswapPack.packId).toBe(venuePackId("uniswap-v2", "1.0.0"));
    expect(() =>
      validateVenueExtensionPack({
        ...uniswapPack,
        packId: "venue-pack/some-other-venue@1.0.0",
      }),
    ).toThrow(/venueId/);
  });

  it("a pack whose venue port and protocol declarations disagree is rejected", () => {
    expect(() =>
      validateVenueExtensionPack({
        ...uniswapPack,
        protocol: {
          ...uniswapPack.protocol,
          capabilityId: protocolCapabilityId("a-different-protocol", CHAIN),
          protocol: {
            ...uniswapPack.protocol.protocol,
            protocolKey: "a-different-protocol",
          },
        },
      }),
    ).toThrow(/ONE venue/);
  });
});

describe("INV-C05: the catalogue never authorizes (execution scope law)", () => {
  it("a connected protocol instance validates and binds to the pack's protocol capability id", () => {
    const instance = venueConnectedProtocolInstance({
      protocolKey: "uniswap-v2",
      chainKey: CHAIN,
      instanceId: "instance:uniswap-v2:001",
      providerName: "payswap-onchain-venues",
      accountRef: "acct:merchant-001",
      tenantRef: "tenant:merchant-001",
    });
    expect(() => validateConnectedProtocolInstance(instance)).not.toThrow();
    expect(instance.capabilityId).toBe(
      protocolCapabilityId("uniswap-v2", CHAIN),
    );
  });

  it("the engine refuses to plan through a mismatched instance (no execution scope)", () => {
    const engine = new BestExecutionEngine();
    engine.register(uniswapPack.venue);
    // An instance bound to a DIFFERENT protocol: no execution scope.
    const foreignInstance = venueConnectedProtocolInstance({
      protocolKey: "some-other-protocol",
      chainKey: CHAIN,
      instanceId: "instance:foreign:001",
      providerName: "foreign",
      accountRef: "acct:merchant-001",
      tenantRef: "tenant:merchant-001",
    });
    const decision = engine.execute({
      executionId: "execution-venues-inv05",
      swap: uscSwapRequest(ETH_ASSET),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances: [foreignInstance],
      owner: "0x1111111111111111111111111111111111111111",
      beneficiary: "0x2222222222222222222222222222222222222222",
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(decision.decision).toBe("NO_EXECUTABLE_ROUTE");
    expect(
      decision.ranking[0]?.disqualifications?.map((reason) => reason.code),
    ).toContain("no_execution_scope");
  });

  it("an ineligible or non-ACTIVE instance is not an execution scope either", () => {
    const engine = new BestExecutionEngine();
    const quotingAggregator = createAggregatorVenuePack({
      ammSources: [
        {
          sourceId: "amm-1",
          assetIn: USC_ASSET,
          assetOut: USC_ASSET,
          reserveInMinorUnits: "1000000000000",
          reserveOutMinorUnits: "1000000000000",
          feeBasisPoints: 30,
          freshness: { asOfMs: NOW, maxAgeMs: 10_000 },
          provenance: {
            providerName: "fixture",
            source: "INDEXED_POOL_STATE",
            capturedAtMs: NOW,
            evidenceRefs: ["evidence:fixture-amm-1"],
          },
          observer: { observerId: "observer:fixture", observerKind: "INDEXER" },
        },
      ],
    });
    engine.register(quotingAggregator.venue);
    const revoked = venueConnectedProtocolInstance({
      protocolKey: "zeroswap-aggregator",
      chainKey: CHAIN,
      instanceId: "instance:agg:revoked",
      providerName: "payswap-onchain-venues",
      accountRef: "acct:merchant-001",
      tenantRef: "tenant:merchant-001",
      authorizationStatus: "REVOKED",
    });
    const ineligible = venueConnectedProtocolInstance({
      protocolKey: "zeroswap-aggregator",
      chainKey: CHAIN,
      instanceId: "instance:agg:ineligible",
      providerName: "payswap-onchain-venues",
      accountRef: "acct:merchant-001",
      tenantRef: "tenant:merchant-001",
      eligible: false,
    });
    const decision = engine.execute({
      executionId: "execution-venues-inv05b",
      swap: uscSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances: [revoked, ineligible],
      owner: "0x1111111111111111111111111111111111111111",
      beneficiary: "0x2222222222222222222222222222222222222222",
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(decision.decision).toBe("NO_EXECUTABLE_ROUTE");
    expect(
      decision.ranking[0]?.disqualifications?.map((reason) => reason.code),
    ).toContain("no_execution_scope");
  });
});
