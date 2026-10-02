/**
 * @payswap/connectors — the canonical connector capability vocabulary.
 *
 * This package owns the canonical connector capability vocabulary
 * (CapabilityDefinition → ProviderImplementation → ConnectedCapabilityInstance →
 * CapabilityObservation, ProviderStateEnvelope, execution modes, Connector
 * Capability Packs, ExternalFunds observations). W3-003 consumes; it must
 * not redefine.
 *
 * Work Order: W2-003 (Stage 2). Architecture: 1.5-frozen-2026-09-30,
 * FROZEN-ARCHITECTURE §2A, ADR-006, LOSSLESS-CONNECTOR-CAPABILITY-MODEL.md.
 *
 * Invariants structurally enforced by this package:
 * - INV-C05: ProviderCatalogueEntry is structurally distinct from and
 *   non-assignable to ConnectedCapabilityInstance; catalogue claims never
 *   authorize execution (assertConnectedInstance, registry registration).
 * - INV-C06: ProviderStateEnvelope preserves provider state losslessly
 *   (raw state + history + action required + failure metadata + privacy
 *   scope + provenance, with an additive family classification).
 * - INV-C07: ExecutionMode is explicit on every execution and no mode
 *   bypasses protocol authorization (validateExecutionRequest).
 * - INV-C08: provider-native optimization/recovery is a capability and an
 *   incumbent benchmark baseline (NativeOptimizationDeclaration).
 * - INV-C09: ExternalFundsPositionObservation is external-state evidence
 *   with mandatory freshness/provenance — never PaySwap custody.
 */

export const PACKAGE_NAME = "@payswap/connectors" as const;

export * from "./execution-modes.js";
export * from "./definitions.js";
export * from "./providers.js";
export * from "./instances.js";
export * from "./provider-state.js";
export * from "./observations.js";
export * from "./external-funds.js";
export * from "./packs.js";
export * from "./registry.js";
export * from "./activation.js";
