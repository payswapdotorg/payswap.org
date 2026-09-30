/**
 * @payswap/interfaces — API, runtime and experience boundary contracts:
 * REST/HTTP, webhooks, trusted approval surfaces, MCP, A2A, AG-UI,
 * messaging, runtime adapter and the merchant PSP connector boundary.
 * Work Order: W3-001 (Stage 0 contract freeze).
 *
 * Package boundary rules (enforced by test/boundary.test.ts):
 * - zero runtime dependencies;
 * - imports inside src/ are relative or node: builtins only;
 * - node: builtins are used solely for conformance helpers (HMAC, hashing,
 *   test scaffolding).
 */

export const PACKAGE_NAME = '@payswap/interfaces' as const;

export * from './version.js';
export * from './protocol-state.js';
export * from './canonical-json.js';
export * from './http.js';
export * from './webhooks.js';
export * from './approval.js';
export * from './agent-protocols.js';
export * from './runtime-adapter.js';
export * from './psp-connector.js';
export * from './conformance/contract-test.js';
export * from './conformance/assertions.js';
export * from './conformance/http-contract.js';
export * from './conformance/webhook-contract.js';
export * from './conformance/approval-contract.js';
export * from './conformance/psp-connector-contract.js';
export * from './conformance/reference-fixtures.js';
