/**
 * @payswap/adapters — the Connector SDK/framework (W3-003).
 *
 * The ConnectorSDK framework base (search/read/create/update/action/
 * subscribe/reconcile/health/disconnect/credential-rotation), the
 * provider-neutral RailAdapter interface with ProviderStateEnvelope
 * preservation, the PSP connector interface (merchant keeps the incumbent
 * PSP; one connector exposes PaySwap), generalized external-system connector
 * interfaces, deterministic webhook/event ingestion with signature
 * verification and replay protection, and one reference adapter shape.
 *
 * This package consumes the canonical connector capability vocabulary owned
 * by @payswap/connectors (W2-003). It must not redefine capability
 * vocabulary or create parallel provider-state models.
 *
 * Stage 3 = canonical contracts + framework: NO provider network calls by
 * design (real rails are Stage 4+).
 */

export const PACKAGE_NAME = "@payswap/adapters" as const;

export * from "./sdk.js";
export * from "./rail-adapter.js";
export * from "./psp-connector.js";
export * from "./external-systems.js";
export * from "./webhooks.js";
export * from "./credential-broker.js";
