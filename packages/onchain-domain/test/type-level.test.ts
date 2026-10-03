import { describe, expect, it } from "vitest";
import type { Money } from "@payswap/protocol";
import type { ConnectedCapabilityInstance, CapabilityDefinition, ConnectorExecutionRequest } from "@payswap/connectors";
import type { AssetObservation } from "../src/asset.js";
import type { ChainDefinition, ConnectedChainInstance } from "../src/chain.js";
import type { OnchainExecutionRequest } from "../src/execution.js";
import type { OnchainFinalityCandidate } from "../src/execution.js";
import type { SmartAccountCapabilityDeclaration } from "../src/wallet.js";
import type { ContractInteractionCapabilityDeclaration } from "../src/onchain-capabilities.js";
import type { ProtocolDefinition } from "../src/onchain-protocol.js";
import type { ExternalFundsPositionObservation } from "@payswap/connectors";
import type { Expect, Equal, NotAssignable } from "./type-utils.js";

type AssignableTo<X, Y> = X extends Y ? true : false;

/**
 * Compile-time assertion helpers: a failed Expect<...> is a tsc error, so the
 * guarantees below are enforced by the typecheck gate, not just at runtime.
 */
describe("type-level guarantees (P4-W1-001)", () => {
  it("INV-C09: an asset observation is never assignable to money (never custody)", () => {
    type ObservationIsNotMoney = Expect<Equal<AssignableTo<AssetObservation, Money>, false>>;
    type MoneyIsNotObservation = Expect<Equal<AssignableTo<Money, AssetObservation>, false>>;
    expect(true).toBe(true);
  });

  it("INV-C09: an asset observation is nominally distinct from the provider funds observation (chain-scoped vocabulary, no accidental interop)", () => {
    type NotProviderFunds = Expect<Equal<AssignableTo<AssetObservation, ExternalFundsPositionObservation>, false>>;
    type NotAssetObservation = Expect<Equal<AssignableTo<ExternalFundsPositionObservation, AssetObservation>, false>>;
    expect(true).toBe(true);
  });

  it("layer reuse: chain/protocol definitions extend CapabilityDefinition; instances extend ConnectedCapabilityInstance (never redefined)", () => {
    type ChainIsCapabilityDefinition = Expect<Equal<AssignableTo<ChainDefinition, CapabilityDefinition>, true>>;
    type ProtocolIsCapabilityDefinition = Expect<Equal<AssignableTo<ProtocolDefinition, CapabilityDefinition>, true>>;
    type ChainInstanceIsConnectorInstance = Expect<Equal<AssignableTo<ConnectedChainInstance, ConnectedCapabilityInstance>, true>>;
    expect(true).toBe(true);
  });

  it("catalogue never authorizes (type-level): a chain definition is NOT a connected instance", () => {
    type DefinitionIsNotInstance = Expect<Equal<AssignableTo<ChainDefinition, ConnectedCapabilityInstance>, false>>;
    type NotAssignableToInstance = NotAssignable<ChainDefinition, ConnectedCapabilityInstance>;
    expect(true).toBe(true);
  });

  it("execution request reuse: OnchainExecutionRequest extends the canonical connector execution request", () => {
    type IsConnectorExecutionRequest = Expect<
      Equal<AssignableTo<OnchainExecutionRequest, ConnectorExecutionRequest>, true>
    >;
    expect(true).toBe(true);
  });

  it("finality candidates are structurally candidates only (literal types — INV-F06)", () => {
    type CandidateOnlyLiteral = Expect<Equal<OnchainFinalityCandidate["candidateOnly"], true>>;
    type RequiresProtocolFinalityLiteral = Expect<
      Equal<OnchainFinalityCandidate["requiresProtocolFinality"], true>
    >;
    expect(true).toBe(true);
  });

  it("INV-SC03: the smart-account permission envelope literal cannot be weakened", () => {
    type EnvelopeLiteral = Expect<Equal<SmartAccountCapabilityDeclaration["permissionEnvelopeRequired"], true>>;
    expect(true).toBe(true);
  });

  it("rule 28: the controlled escape hatch literals cannot be weakened", () => {
    type EscapeHatchLiteral = Expect<Equal<ContractInteractionCapabilityDeclaration["controlledEscapeHatch"], true>>;
    type CertificationLiteral = Expect<Equal<ContractInteractionCapabilityDeclaration["certificationRequired"], true>>;
    type UnknownWritePolicies = Expect<
      Equal<
        ContractInteractionCapabilityDeclaration["unknownWritePolicy"],
        "BLOCK" | "REQUIRE_ESCALATION"
      >
    >;
    expect(true).toBe(true);
  });
});
