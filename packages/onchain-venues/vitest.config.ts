import { defineConfig } from "vitest/config";

/**
 * Deterministic suite: every venue pack is exercised against SYNTHETIC,
 * fixture-driven venue state (published-quote-fixture style observation
 * evidence — no credentials, no live endpoints). The venue packs model the
 * real venue SHAPES; network integration arrives with the adapter wave.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
