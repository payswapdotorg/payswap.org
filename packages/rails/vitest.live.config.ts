import { defineConfig } from "vitest/config";

/**
 * NETWORK-DEPENDENT suite (run explicitly, never in the default gate):
 * test/live/** contacts genuinely reachable public endpoints only —
 * the Ethereum mainnet public JSON-RPC (read-only), the ECB daily
 * reference-rates feed, and credential-gated PSP endpoints probed
 * WITHOUT credentials (reachability documentation only — INV-C01/C02,
 * INV-NC04). Retries tolerate transient public-endpoint flakiness.
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
