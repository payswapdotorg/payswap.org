import { describe, expect, it } from "vitest";
import * as onchainDomain from "../src/index.js";

/** Smoke: the canonical package export surface exists and is importable. */
describe("smoke (@payswap/onchain-domain)", () => {
  it("exports the canonical onchain domain vocabulary", () => {
    expect(onchainDomain.PACKAGE_NAME).toBe("@payswap/onchain-domain");
    // Chain vocabulary.
    expect(typeof onchainDomain.chainCapabilityId).toBe("function");
    expect(typeof onchainDomain.validateChainDefinition).toBe("function");
    expect(typeof onchainDomain.validateConnectedChainInstance).toBe("function");
    expect(typeof onchainDomain.assertConnectedChainInstance).toBe("function");
    // Asset vocabulary.
    expect(typeof onchainDomain.canonicalAssetRef).toBe("function");
    expect(typeof onchainDomain.validateAssetDefinition).toBe("function");
    expect(typeof onchainDomain.validateAssetObservation).toBe("function");
    // Operation semantics.
    expect(typeof onchainDomain.onchainOperationSemantics).toBe("function");
    // Wallet/signer vocabulary.
    expect(typeof onchainDomain.validateSignerHandle).toBe("function");
    // Protocol vocabulary.
    expect(typeof onchainDomain.validateProtocolDefinition).toBe("function");
    // Capability flavors.
    expect(typeof onchainDomain.validateOnchainCapabilityDefinition).toBe("function");
    // Execution vocabulary.
    expect(typeof onchainDomain.validateOnchainExecutionRequest).toBe("function");
    expect(typeof onchainDomain.validateOnchainExecutionObservation).toBe("function");
    expect(typeof onchainDomain.assertOnchainExecutionScope).toBe("function");
    // Settlement mapping.
    expect(typeof onchainDomain.onchainRailId).toBe("function");
    expect(typeof onchainDomain.mapObservationToRailOutcome).toBe("function");
    expect(typeof onchainDomain.mapToRailOperation).toBe("function");
  });
});
