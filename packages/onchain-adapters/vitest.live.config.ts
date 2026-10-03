import { defineConfig } from "vitest/config";

/**
 * NETWORK-DEPENDENT, READ-ONLY suite (run explicitly, never in the default
 * gate): test/live/** contacts genuinely reachable PUBLIC endpoints only —
 * the Ethereum mainnet public JSON-RPC (read-only: chain heads, chain id,
 * balances-as-observations, fee parameters), the Solana mainnet-beta public
 * RPC (read-only: slots, latest blockhash, balances-as-observations) and the
 * Bitcoin mainnet public explorer APIs (read-only: tip height/hash, fee
 * estimates, address stats). NO broadcast, NO signing, NO financial effect —
 * keys never exist in this package (AGENTS.md rule 25); broadcast stages are
 * proven by the deterministic fixture suite, with reachability of the
 * broadcast rails themselves documented in evidence/real-network-provenance.md.
 * Retries tolerate transient public-endpoint flakiness. An unreachable rail
 * reports UNKNOWN reachability — never success, never failure (INV-C01/C02).
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    environment: "node",
    retry: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
