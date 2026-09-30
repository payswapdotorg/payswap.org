/**
 * Shared version constants for the @payswap/interfaces contract surface.
 *
 * Stage 0 (W3-001) pins both the external API version and the payload schema
 * version to the architecture lock date. They are deliberately distinct
 * concepts that happen to share a value today:
 * - the API version identifies the transport/protocol contract a client pins
 *   via the X-PaySwap-API-Version request header (see http.ts);
 * - the schema version identifies the payload schema of an individual
 *   response/webhook (see ResponseMeta.schemaVersion and
 *   WebhookEventEnvelope.schemaVersion).
 */

export const CURRENT_API_VERSION = '2026-09-30';

export const CONTRACT_SCHEMA_VERSION = '2026-09-30';
