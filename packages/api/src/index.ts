/**
 * @payswap/api — developer API surface.
 *
 * Work Order: W3-002 (Stage 1) — multi-tenant identity/session flows, signed
 * approval artifacts, scoped execution grants, the core REST surface and
 * webhook delivery, built ON TOP of the merged Stage-0 contracts:
 * - @payswap/interfaces (W3-001): REST/webhook/approval boundary contracts;
 * - @payswap/trust (W2-001): principals, mandates, authorization, epochs;
 * - @payswap/protocol (W1-001): envelopes, idempotency, errors, clock.
 *
 * Package boundary rules (enforced by test/boundary.test.ts): imports inside
 * src/ are relative, node: builtins or @payswap/* workspace packages only.
 */

export const PACKAGE_NAME = '@payswap/api' as const;

export * from './identity.js';
export * from './approvals.js';
export * from './grants.js';
export * from './http.js';
export * from './webhooks.js';
