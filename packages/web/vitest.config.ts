import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      // Components render through next/link in the real app; tests assert
      // server-rendered markup, where next/link internals are not needed —
      // a plain <a> stub keeps the node-environment suite dependency-free.
      "next/link": path.resolve(
        import.meta.dirname,
        "src/test/stubs/link.tsx",
      ),
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
