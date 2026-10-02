#!/usr/bin/env node
/**
 * Runner for scripts/deployment/provider-rollout.ts — bundles the
 * TypeScript driver (which imports the workspace TS-source packages) with
 * esbuild and executes the bundle. Deterministic: same repo state, same
 * record. Usage: node scripts/deployment/run-rollout.mjs
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const outfile = path.join(os.tmpdir(), `payswap-rollout-record-${process.pid}.mjs`);

try {
  await build({
    entryPoints: [path.join(import.meta.dirname, "provider-rollout.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  const result = spawnSync("node", [outfile], { stdio: "inherit" });
  process.exit(result.status ?? 1);
} finally {
  import("node:fs").then((fs) => fs.rmSync(outfile, { force: true }));
}
