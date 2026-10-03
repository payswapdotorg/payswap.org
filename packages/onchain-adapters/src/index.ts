/**
 * @payswap/onchain-adapters — Multi-Chain Adapter SDK core (P4-W2-001).
 *
 * This barrel is the VENDOR-NEUTRAL SDK core: the frozen adapter lifecycle
 * contract, the structural environment/rail discriminator, the transport
 * ports, the explicit family semantics vocabulary, the shared lifecycle
 * machinery and the production settlement gate. The family implementations
 * (EVM, Solana, UTXO) are SUBPATH exports (`@payswap/onchain-adapters/evm`,
 * `/solana`, `/utxo`) so the core barrel never imports a family module —
 * the dependency direction is strictly family → core (adversarially
 * verified in test/no-vendor.test.ts).
 *
 * Hard constraints structurally enforced by this package:
 * - NO single RPC/indexer/simulation vendor is a core dependency: vendors
 *   live behind the transport ports; PRODUCTION transports require endpoint
 *   provider diversity (≥2 distinct providers).
 * - Fee, finality and reorg semantics are EXPLICIT per family and fail
 *   closed when inexpressible (SemanticNotExpressibleError).
 * - UNKNOWN for ambiguous/unfinalized state, never converted to
 *   success/failure (INV-X01); unreachable rails surface availability
 *   UNKNOWN (INV-C01/C02).
 * - Testnet/simulation can NEVER be production financial execution: the
 *   environment discriminator is STRUCTURAL (chain-identity registry +
 *   branded types + runtime re-derivation), not a runtime flag alone.
 * - Adapters map into canonical SettlementInstruction/Attempt/RailOperation
 *   via the EXISTING onchain-domain settlement vocabulary — no parallel
 *   ledger, no duplicate connector vocabulary.
 * - The catalogue never authorizes (INV-C05); external balances are
 *   observations (INV-C09/rule 21); no secrets in agent-facing contracts
 *   (rule 25 — every adapter output is secret-scanned).
 */

export const PACKAGE_NAME = "@payswap/onchain-adapters" as const;

// Lifecycle contract (the frozen family-adapter interface)
export * from "./contract.js";
// Structural environment/rail discriminator
export * from "./environment.js";
// Vendor-neutral transport ports + endpoint diversity law
export * from "./transport.js";
// Explicit family fee/finality/reorg semantics
export * from "./semantics.js";
// Shared lifecycle machinery (base adapter, kernel feed, staleness guards)
export * from "./lifecycle.js";
// Production settlement gate (canonical mapping, environment-guarded)
export * from "./settlement-gate.js";
// Error taxonomy
export * from "./errors.js";
