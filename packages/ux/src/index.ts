/**
 * @payswap/ux — the product UX CONTRACT layer (W3-006, Stage 6).
 *
 * This package is the deterministic view-state machine layer future UIs
 * implement: the universal Command Center view-model (search, universal
 * inbox, Work-Graph context, economic controls), payment command-center
 * journeys that consume the SAME @payswap/api surface as programmatic
 * clients, approval completion through the trusted surface, incumbent
 * provenance views, honest UNKNOWN/error states and messaging adapters bound
 * to the same authorization gates.
 *
 * It contains NO DOM, NO network and NO rendering — every visual state is a
 * PURE derivation from authority state (one-to-one: a view state can never
 * change without a corresponding authority change), every terminal-state
 * mapping is CONSUMED from @payswap/interfaces (`mapTerminalStateToUi`,
 * never re-defined), and every mutation leaves as a validated
 * `RequestEnvelope` through the injected @payswap/api handler.
 *
 * Invariant ownership exercised across the modules (spec/architecture/
 * INVARIANTS.md):
 * - INV-A03 approvals complete through a trusted surface as signed artifacts
 *   (trusted-approvals.ts; journeys fold approvals the same way);
 * - INV-A05 suggestions/intents cannot override protocol, policy,
 *   compliance or security constraints (messaging-adapters.ts intents);
 * - INV-C06 provider state is preserved losslessly in views
 *   (honest-states.ts ProviderStateDrawer; command-center.ts verbatim
 *   customer actions);
 * - INV-E04 UI/browser artifacts are never stronger than their
 *   authenticated provenance (incumbent-views.ts strength order);
 * - INV-X01 UNKNOWN is never rendered as failure (honest-states.ts,
 *   command-center.ts execution views);
 * - INV-F05 every journey mutation carries an idempotency key
 *   (journeys.ts validated RequestEnvelopes).
 *
 * Dependencies (declared in package.json, W3-006 work order):
 * @payswap/api, @payswap/payment, @payswap/execution, @payswap/interfaces.
 */

export const PACKAGE_NAME = '@payswap/ux' as const;

export * from './command-center.js';
export * from './journeys.js';
export * from './trusted-approvals.js';
export * from './incumbent-views.js';
export * from './honest-states.js';
export * from './messaging-adapters.js';
export * from './product-ia.js';
export * from './product-journeys.js';
