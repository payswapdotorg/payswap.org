import { defineConfig } from "vitest/config";

/**
 * DETERMINISTIC suite (default gate): test/** EXCLUDING test/live/**.
 * This suite MUST pass fully offline — every network interaction is injected
 * as a scripted transport fixture, never a live endpoint. The
 * network-dependent read-only suite lives in vitest.live.config.ts and is
 * run explicitly (`npm run test:live`), with retries for public-endpoint
 * tolerance. No test in this suite performs or simulates a financial effect.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**", "node_modules/**"],
    environment: "node",
  },
});
