#!/usr/bin/env node
/**
 * Runner for scripts/deployment/production-deployment.ts — bundles the
 * TypeScript driver (which imports the workspace TS-source packages) with
 * esbuild and executes the bundle. Deterministic: same inputs, same record.
 *
 * Usage: node scripts/deployment/run.mjs <release-sha> <battery> <authorized-at>
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const outfile = path.join(os.tmpdir(), `payswap-deploy-record-${process.pid}.mjs`);

try {
  await build({
    entryPoints: [path.join(import.meta.dirname, "production-deployment.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  const res = spawnSync(process.execPath, [outfile, ...args], {
    stdio: "inherit",
  });
  process.exit(res.status ?? 1);
} finally {
  try {
    fs.unlinkSync(outfile);
  } catch {
    /* temp cleanup best-effort */
  }
}
