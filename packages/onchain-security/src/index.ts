/**
 * @payswap/onchain-security — Wallet/Signer Authorization + Blockchain
 * Security Kernel (Work Order P4-W1-002).
 *
 * The trusted-surface boundary between intent preparation and
 * user-controlled signing (AGENTS.md rules 9, 10, 25-29; UMI architecture
 * 1.6-frozen "Wallet/signing"):
 *
 * - types.ts:         provider-neutral identity contracts (chain / asset /
 *                     protocol identity; the structural W1-001 alignment
 *                     surface — no EVM assumptions in core contracts);
 * - digest.ts:        package-local deterministic content addressing;
 * - secrets.ts:       the secret-boundary kernel (runtime + type-level
 *                     proof that raw credentials cannot transit the
 *                     agent-facing surface);
 * - write-intent.ts:  prepare — validated consequential-write requests;
 * - simulation.ts:    simulation OBSERVATIONS (never authority);
 * - diff.ts:          user-readable expected-state diffs;
 * - gates.ts:         deterministic BLOCK/ALLOW/UNKNOWN security gates over
 *                     chain, asset, amount, destination, spender/approval,
 *                     expiry, route and protocol/contract identity +
 *                     composed immune-system state; adversarial agents may
 *                     FLAG but can NEVER override a BLOCK (rule 27);
 * - authorization.ts: onchain authorization requests + signed artifacts
 *                     extending the @payswap/trust model (rule 10), minted
 *                     ONLY by a trusted approval surface;
 * - recheck.ts:       immediate pre-broadcast recheck with stale-state
 *                     invalidation (drift voids the authorization; it is
 *                     re-requested, never auto-repaired);
 * - pipeline.ts:      the deterministic state machine
 *                     prepare → simulate (when supported) → gates → diff →
 *                     authorization → recheck → broadcast handoff;
 * - signers.ts:       SignerAdapter port + signing requests + broadcast
 *                     handoff (the kernel never broadcasts);
 * - adapters/eip712.ts, adapters/erc1271.ts: EVM signing semantics (EIP-712
 *                     typed data, ERC-1271 contract signatures) isolated
 *                     BEHIND adapters — never in core contracts;
 * - delegation.ts:    scoped signing delegation (session keys / smart
 *                     accounts): attenuated ⊂ parent, revocable, expiring.
 *
 * Boundary law: this package's src/** imports ONLY @payswap/protocol,
 * @payswap/trust and @payswap/capabilities. It composes with the
 * @payswap/security immune system through pure data inputs
 * (OnchainSecurityState) — the wiring happens at the TL's integration
 * station, and the composition is proven in test/ with the REAL security
 * machinery (the security package's own boundary test forbids src-level
 * imports until the TL merges a consumer).
 */

export const PACKAGE_NAME = "@payswap/onchain-security" as const;

export * from "./types.js";
export * from "./digest.js";
export * from "./secrets.js";
