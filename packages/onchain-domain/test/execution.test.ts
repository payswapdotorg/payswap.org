import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  validateOnchainExecutionDirective,
  validateOnchainExecutionRequest,
  assertOnchainExecutionScope,
  isOnchainCatalogueShape,
  validateOnchainExecutionObservation,
  ONCHAIN_EXECUTION_OUTCOMES,
  ONCHAIN_FAILURE_CLASSES,
} from "../src/execution.js";
import {
  transferDirective,
  broadcastObservation,
  confirmedObservation,
  unknownObservation,
  failedObservation,
  signerHandle,
  connectedChainInstance,
  ethereumChainDefinition,
  ETHEREUM_CHAIN_KEY,
} from "./fixtures.js";
import { canonicalAssetRef } from "../src/asset.js";

/** A canonical protocol-authorized onchain execution request. */
function canonicalRequest() {
  return {
    executionMode: "COMPOSED_PAYSWAP" as const,
    capabilityInstanceId: connectedChainInstance().instanceId,
    providerRequest: transferDirective(),
    idempotencyKey: "idem:execution:001",
    protocolAuthorization: {
      commandId: "cmd:001",
      principal: { principalType: "user", principalId: "user:001" },
      authorizationEvidenceRef: "authz-evidence:001",
    },
  };
}

describe("onchain execution directives (deterministic operation coupling)", () => {
  it("validates a canonical transfer directive", () => {
    const directive = validateOnchainExecutionDirective(transferDirective());
    expect(directive.operation).toBe("onchain.transfer");
    expect(directive.signerHandle.handleId).toBe("signer.handle.001");
  });

  it("an approval requires the approved spender (deterministic coupling)", () => {
    const missingSpender = {
      ...transferDirective(),
      operation: "onchain.approval" as const,
    };
    expect(() => validateOnchainExecutionDirective(missingSpender)).toThrow(
      /requires a spenderRef/,
    );
  });

  it("a contract call requires the protocol reference", () => {
    const missingProtocol = {
      ...transferDirective(),
      operation: "onchain.contract_call" as const,
    };
    expect(() => validateOnchainExecutionDirective(missingProtocol)).toThrow(
      /requires a protocolRef/,
    );
  });

  it("a transfer requires destination, asset and exact amount", () => {
    const noDestination = { ...transferDirective(), destination: undefined };
    expect(() => validateOnchainExecutionDirective(noDestination)).toThrow(/requires a destination/);
    const noAmount = { ...transferDirective(), amount: undefined };
    expect(() => validateOnchainExecutionDirective(noAmount)).toThrow(/requires an exact amount/);
    const noAsset = { ...transferDirective(), assetId: undefined };
    expect(() => validateOnchainExecutionDirective(noAsset)).toThrow(/requires an assetId/);
  });

  it("floating-point amounts never validate (INV-F01)", () => {
    const floatAmount = {
      ...transferDirective(),
      amount: { assetId: canonicalAssetRef(ETHEREUM_CHAIN_KEY, "ETH"), minorUnits: "1.5" },
    };
    expect(() => validateOnchainExecutionDirective(floatAmount)).toThrow(/amount is invalid/);
  });

  it("the directive's amount must be denominated in the directive's asset", () => {
    const crossAsset = {
      ...transferDirective(),
      amount: { assetId: "ethereum:mainnet/asset:USDC", minorUnits: "100" },
    };
    expect(() => validateOnchainExecutionDirective(crossAsset)).toThrow(
      /denominated in the directive's asset/,
    );
  });

  it("expiry is mandatory (the authorization kernel evaluates it before authorization)", () => {
    const noExpiry = { ...transferDirective(), expiresAt: undefined };
    expect(() => validateOnchainExecutionDirective(noExpiry)).toThrow(/expiresAt is mandatory/);
  });

  it("an invalid signer handle fails the directive (opaque references only)", () => {
    const keyMaterialHandle = {
      ...transferDirective(),
      signerHandle: { ...signerHandle(), handleId: "4c0883a69102937d".repeat(4) },
    };
    expect(() => validateOnchainExecutionDirective(keyMaterialHandle)).toThrow(/signerHandle/);
  });

  it("an undeclared operation fails closed", () => {
    const unknown = { ...transferDirective(), operation: "onchain.teleport" as never };
    expect(() => validateOnchainExecutionDirective(unknown)).toThrow(
      /undeclared operations never validate/,
    );
  });
});

describe("onchain execution requests (INV-C07: the canonical execution contract)", () => {
  it("validates a canonical protocol-authorized request", () => {
    const request = validateOnchainExecutionRequest(canonicalRequest());
    expect(request.executionMode).toBe("COMPOSED_PAYSWAP");
    expect(request.protocolAuthorization.commandId).toBe("cmd:001");
    expect(request.providerRequest.operation).toBe("onchain.transfer");
  });

  it("a request WITHOUT the protocol authorization link never validates (catalogue data alone cannot execute)", () => {
    const { protocolAuthorization, ...withoutAuthorization } = canonicalRequest();
    expect(protocolAuthorization).toBeDefined();
    expect(() => validateOnchainExecutionRequest(withoutAuthorization)).toThrow(
      /violates the canonical execution contract/,
    );
    expect(() => validateOnchainExecutionRequest(withoutAuthorization)).toThrow(
      /protocolAuthorization is required/,
    );
  });

  it("a request without an explicit execution mode never validates", () => {
    const { executionMode, ...withoutMode } = canonicalRequest();
    expect(executionMode).toBeDefined();
    expect(() => validateOnchainExecutionRequest(withoutMode)).toThrow(/executionMode is REQUIRED/);
  });

  it("a request without an idempotency key never validates (INV-F05)", () => {
    const { idempotencyKey, ...withoutKey } = canonicalRequest();
    expect(idempotencyKey).toBeDefined();
    expect(() => validateOnchainExecutionRequest(withoutKey)).toThrow(/idempotencyKey is required/);
  });
});

describe("execution scope assertion (catalogue never authorizes)", () => {
  it("accepts a genuinely connected chain instance", () => {
    expect(() => assertOnchainExecutionScope(connectedChainInstance())).not.toThrow();
  });

  it("rejects a chain catalogue shape with the explicit catalogue error", () => {
    expect(isOnchainCatalogueShape(ethereumChainDefinition())).toBe(true);
    expect(() => assertOnchainExecutionScope(ethereumChainDefinition())).toThrow(
      /can never authorize onchain execution/,
    );
  });

  it("rejects a chain descriptor", () => {
    expect(() => assertOnchainExecutionScope(ethereumChainDefinition().chain)).toThrow(
      /can never authorize onchain execution/,
    );
  });
});

describe("execution observations (UNKNOWN-capable; candidates never finality)", () => {
  it("validates canonical observations for all four outcomes", () => {
    for (const observation of [
      broadcastObservation(),
      confirmedObservation(),
      unknownObservation(),
      failedObservation(),
    ]) {
      expect(() => validateOnchainExecutionObservation(observation)).not.toThrow();
    }
    expect(ONCHAIN_EXECUTION_OUTCOMES).toHaveLength(4);
  });

  it("a BROADCAST outcome may NOT carry a finality candidate (submitted is not finality)", () => {
    const premature = {
      ...broadcastObservation(),
      finalityCandidate: confirmedObservation().finalityCandidate,
    };
    expect(() => validateOnchainExecutionObservation(premature)).toThrow(
      /submitted transactions are not financial finality/,
    );
  });

  it("a finality candidate that CLAIMS finality is rejected (INV-F06)", () => {
    const claiming = {
      ...confirmedObservation(),
      finalityCandidate: {
        ...confirmedObservation().finalityCandidate!,
        candidateOnly: false,
      },
    };
    expect(() => validateOnchainExecutionObservation(claiming)).toThrow(/candidateOnly must be true/);
  });

  it("UNKNOWN requires an explicit reason (ambiguity is explicit)", () => {
    const silent = { ...unknownObservation(), unknownReason: undefined };
    expect(() => validateOnchainExecutionObservation(silent)).toThrow(
      /REQUIRES an explicit unknownReason/,
    );
  });

  it("UNKNOWN may NOT carry a failure descriptor: UNKNOWN is not FAILED (INV-X01)", () => {
    const coerced = {
      ...unknownObservation(),
      failure: failedObservation().failure,
    };
    expect(() => validateOnchainExecutionObservation(coerced)).toThrow(
      /must NOT carry a failure descriptor/,
    );
  });

  it("FAILED requires a failure descriptor (definitive failures are explained)", () => {
    const unexplained = { ...failedObservation(), failure: undefined };
    expect(() => validateOnchainExecutionObservation(unexplained)).toThrow(
      /REQUIRES a failure descriptor/,
    );
  });

  it("there is no transport failure class: transport ambiguity is UNKNOWN, never FAILED", () => {
    expect(ONCHAIN_FAILURE_CLASSES).not.toContain("TRANSPORT");
    const transportAsFailure = {
      ...failedObservation(),
      failure: {
        failureClass: "TRANSPORT" as never,
        description: "transport error",
        retryGuidance: "SAFE_TO_RETRY" as const,
      },
    };
    expect(() => validateOnchainExecutionObservation(transportAsFailure)).toThrow(
      /failure.failureClass/,
    );
  });

  it("evidence references are mandatory (INV-E02)", () => {
    const unevidenced = { ...broadcastObservation(), evidenceRefs: [] };
    expect(() => validateOnchainExecutionObservation(unevidenced)).toThrow(
      /evidenceRefs is MANDATORY/,
    );
  });

  it("a reorg observation stays a candidate with the anomaly explicit", () => {
    const reorged = {
      ...confirmedObservation(),
      finalityCandidate: {
        ...confirmedObservation().finalityCandidate!,
        reorgDetected: true,
      },
    };
    expect(() => validateOnchainExecutionObservation(reorged)).not.toThrow();
    expect(reorged.finalityCandidate?.reorgDetected).toBe(true);
    // Still only a candidate: finality is protocol-owned.
    expect(reorged.finalityCandidate?.candidateOnly).toBe(true);
  });
});
