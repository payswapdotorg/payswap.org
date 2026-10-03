/**
 * @payswap/onchain-domain — the provider-neutral onchain domain and
 * capability kernel (Work Order P4-W1-001).
 *
 * This package owns the ONCHAIN DOMAIN VOCABULARY inside the existing
 * Capability/Connector model (never a second model):
 * - chain family vocabulary + OPTIONAL family-scoped extensions (the only
 *   place family-specific shapes live);
 * - ChainDefinition / ChainImplementation / ConnectedChainInstance;
 * - AssetDefinition / AssetObservation (observations, never custody);
 * - ProtocolDefinition / ProtocolImplementation / ConnectedProtocolInstance
 *   (composing the canonical INV-SC01 SmartContractExtension);
 * - WalletCapability / SignerCapability / SmartAccountCapability
 *   declarations and the opaque SignerHandle;
 * - OnchainExecutionCapability / GenericContractInteractionCapability /
 *   DexCapability / BridgeCapability / IntentExecutionCapability;
 * - the deterministic onchain operation semantics and the execution
 *   request/observation vocabulary (UNKNOWN-capable, finality candidates
 *   only);
 * - the canonical settlement mapping (observations → rail operations →
 *   settlement machinery; no parallel crypto ledger).
 *
 * Invariants structurally enforced by this package:
 * - catalogue-never-authorizes (INV-C05 discipline): ChainDefinition /
 *   ProtocolDefinition / asset catalogues carry no authorization scope;
 *   execution requires a ConnectedCapabilityInstance-shaped scope.
 * - observations-not-custody (INV-C09, rule 21): AssetObservation carries
 *   mandatory freshness, provenance and observer identity and is
 *   structurally never a balance.
 * - no-secret-fields (rule 25): agent-facing contracts carry opaque
 *   references only; SignerHandle rejects key-material-shaped ids.
 * - family-neutral core (rule 17): neutral contracts never mention family-specific
 *   shapes; family extensions are optional and never required.
 * - exact money (INV-F01): asset amounts are integer minor units.
 * - UNKNOWN is not FAILED (INV-X01): OUTCOME_UNKNOWN is a first-class,
 *   explained, reconciliation-requiring outcome.
 * - submitted is not finality (rule 29) and finality is protocol-owned
 *   (INV-F06): observers produce finality CANDIDATES only.
 */

export const PACKAGE_NAME = "@payswap/onchain-domain" as const;

export * from "./family.js";
export * from "./family-extensions.js";
export * from "./chain.js";
export * from "./asset.js";
export * from "./operations.js";
export * from "./wallet.js";
export * from "./onchain-protocol.js";
export * from "./onchain-capabilities.js";
export * from "./execution.js";
export * from "./settlement-mapping.js";
