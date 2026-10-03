#!/usr/bin/env node
/**
 * Web release-record driver for @payswap/web (Work Order P3-W1-001;
 * extended with a rollback-record mode by P3-W1-003).
 *
 * Convention: follows scripts/deployment/run.mjs (the production-deployment
 * record runner) — a driver that assembles release records DETERMINISTICALLY
 * (same repo state + same arguments => byte-identical record; "deployment is
 * reproducible") and writes them under spec/development-state/.
 *
 * Structure (P3-W1-003): the file is split into a PURE, side-effect-free
 * core (serialize / contentDigest / assembleReleaseRecord /
 * assembleRollbackRecord / formatRecord — all exported for the
 * fixture-based reproducibility test) and a thin CLI that performs the
 * side effects (git, npm build, file writes). Importing the module runs NO
 * build and touches no network; the CLI runs only when executed directly.
 *
 * Release mode (what this driver does):
 *   1. runs the @payswap/web production build (`npm run build --workspace
 *      @payswap/web`) — the build is expected to be green;
 *   2. reads the BUILD_ID Next.js generated (next.config.ts derives it as a
 *      content digest of the package's build inputs) and RECOMPUTES the same
 *      sha256 digest over the same inputs independently — the two must agree,
 *      otherwise the driver fails loudly (a build that does not match its
 *      sources cannot be released reproducibly);
 *   3. records the release identity: commit SHA, build hash, the Vercel
 *      project name (`payswap-web`, root directory `packages/web`),
 *      deployment URL PLACEHOLDER fields (the TL performs the actual
 *      `vercel` deployment at the review gate and can re-run this driver
 *      with the live URLs as arguments), and the API-runtime project
 *      separation (the existing `payswap` project — the authoritative API
 *      host — is NOT touched by a web release);
 *   4. writes spec/development-state/web-release-<date>.json (2-space JSON
 *      + trailing newline, like the other deployment records) and prints a
 *      summary. The record carries an fnv1a64 content digest (the house
 *      pattern from @payswap/certification) computed over the canonical
 *      serialization of the record without the digest field.
 *
 * Rollback mode (P3-W1-003): records a web rollback WITHOUT running any
 * build — a Vercel rollback re-points the production alias to a previous
 * immutable deployment; the build id of that deployment is unchanged by
 * definition. The record is assembled from the same style of explicit
 * inputs and is deterministic for the same reasons.
 *
 * Determinism: the records contain no wall-clock timestamps — the record
 * DATE is an explicit input (defaulting to today UTC in the CLI only),
 * everything else is a pure function of the repo state and the CLI
 * arguments. Two runs with the same inputs produce byte-identical files.
 *
 * Usage:
 *   node scripts/deployment/web-release.mjs [record-date] [production-url] [preview-url]
 *     record-date      YYYY-MM-DD (default: today, UTC)
 *     production-url   optional; recorded verbatim once the TL has deployed
 *     preview-url      optional; recorded verbatim once the TL has deployed
 *
 *   node scripts/deployment/web-release.mjs rollback <record-date> <from-deployment> <to-deployment> <reason> [to-build-id] [to-commit]
 *     record-date       YYYY-MM-DD
 *     from-deployment   the deployment being rolled back FROM (current production URL or deployment id)
 *     to-deployment     the deployment being rolled back TO (previous deployment URL or id)
 *     reason            verbatim reason for the rollback
 *     to-build-id       optional; the build id of the target deployment, when known from its release record
 *     to-commit         optional; the commit of the target deployment, when known from its release record
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const WEB_ROOT = path.join(ROOT, "packages", "web");
const OUT_DIR = path.join(ROOT, "spec", "development-state");

// --- fail-loud helpers ------------------------------------------------------

function fail(message) {
  console.error(`web-release: ${message}`);
  process.exit(1);
}

function readPackageName(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

if (readPackageName(WEB_ROOT) !== "@payswap/web") {
  fail(
    `expected ${WEB_ROOT} to be the @payswap/web package (found "${readPackageName(WEB_ROOT) ?? "no package.json"}")`,
  );
}

// ============================================================================
// PURE CORE — deterministic record construction (exported for tests).
// No clock, no randomness, no network, no filesystem writes. Everything is a
// function of the explicit inputs, so identical inputs => identical records.
// ============================================================================

/** Canonical serialization (sorted keys, bigint-safe) — house pattern. */
export function serialize(value) {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return `n:${value.toString()}`;
    case "bigint":
      return `b:${value.toString()}`;
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => serialize(item)).join(",")}]`;
      }
      const keys = Object.keys(value).sort();
      const parts = [];
      for (const key of keys) {
        parts.push(`${JSON.stringify(key)}:${serialize(value[key])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`web-release: unsupported value of type '${typeof value}'`);
  }
}

/** fnv1a64 digest of the canonical serialization (house pattern). */
export function contentDigest(value) {
  const input = serialize(value);
  const prime = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

const API_RUNTIME_SEPARATION_LAW =
  "the web surface is a CONSUMER of the authoritative PaySwap API — it holds no financial state of its own";

/**
 * Assemble the deterministic web-release record (digest included). Pure.
 * Key order is fixed by construction — it matches the record shape shipped
 * by P3-W1-001 byte-for-byte (regression-tested against
 * spec/development-state/web-release-2026-10-02.json).
 */
export function assembleReleaseRecord({
  recordDate,
  commitSha,
  buildId,
  buildIdVerifiedAgainstSources,
  productionUrl = null,
  previewUrl = null,
}) {
  const record = {
    schema_version: "1.0",
    record_type: "web-release",
    workOrder: "P3-W1-001",
    package: "@payswap/web",
    release: {
      date: recordDate,
      commit: commitSha,
      buildId,
      buildIdScheme:
        "sha256 over the sorted packages/web build inputs (src/ + public/ + package.json + postcss.config.mjs + next.config.ts), truncated to 16 hex — same sources always produce the same build id",
      buildIdVerifiedAgainstSources,
    },
    vercelProject: {
      name: "payswap-web",
      rootDirectory: "packages/web",
      framework: "nextjs",
      deploymentUrls: {
        production: productionUrl,
        preview: previewUrl,
      },
      deploymentUrlsNote:
        "placeholders by design — the TL performs the actual `vercel` deployment at the review gate (one command from packages/web with the payswap-web project linked); re-run this driver with the live URLs as arguments to record them",
    },
    apiRuntimeSeparation: {
      law: API_RUNTIME_SEPARATION_LAW,
      webProject: "payswap-web",
      apiRuntimeProject: "payswap",
      apiRuntimeProjectRole: "the existing Vercel project that hosts the authoritative API/runtime — NOT touched by a web release",
      apiBaseUrlEnvVar: "NEXT_PUBLIC_PAYSWAP_API_URL",
      apiBaseUrlValue: null,
      apiBaseUrlNote:
        "referenced by name only — the value is supplied per environment (production API host for production, preview API host for preview) at deployment time, never stored in git",
    },
    healthEndpoint: "/api/health",
    routes: [
      "/",
      "/capabilities",
      "/security",
      "/developers",
      "/app (authenticated entry boundary — honest gate; every /app/* deep link resolves and is hard-refresh safe)",
      "/api/health",
    ],
  };
  record.digest = contentDigest(record);
  return record;
}

/**
 * Assemble the deterministic web-rollback record (digest included). Pure.
 * A rollback re-points the production alias to a PREVIOUS immutable
 * deployment — no rebuild happens, so the record is built purely from the
 * explicit rollback inputs. `toBuildId`/`toCommit` may be null when the
 * target deployment predates the release-record convention (recorded
 * honestly, never guessed).
 */
export function assembleRollbackRecord({
  recordDate,
  fromDeployment,
  toDeployment,
  reason,
  toBuildId = null,
  toCommit = null,
}) {
  const record = {
    schema_version: "1.0",
    record_type: "web-rollback",
    workOrder: "P3-W1-003",
    package: "@payswap/web",
    rollback: {
      date: recordDate,
      fromDeployment,
      toDeployment,
      toBuildId,
      toCommit,
      reason,
      method:
        "vercel rollback — re-point the payswap-web production alias to a previous immutable deployment (no rebuild; the target deployment's build id is unchanged by definition)",
      verification:
        "after the rollback, GET /api/health on the production alias must report the target deployment's build id + commit and the honest readiness state for its environment; record observed values in the live-verification notes",
    },
    vercelProject: {
      name: "payswap-web",
      rootDirectory: "packages/web",
      framework: "nextjs",
    },
    apiRuntimeSeparation: {
      law: API_RUNTIME_SEPARATION_LAW,
      webProject: "payswap-web",
      apiRuntimeProject: "payswap",
      apiRuntimeProjectRole:
        "the existing Vercel project that hosts the authoritative API/runtime — NOT touched by a web release or a web rollback",
    },
    healthEndpoint: "/api/health",
  };
  record.digest = contentDigest(record);
  return record;
}

/** Canonical on-disk form: 2-space JSON + trailing newline (house style). */
export function formatRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** The deterministic record filename for a record type + explicit date. */
export function recordFileName(recordType, recordDate) {
  return recordType === "web-rollback"
    ? `web-rollback-${recordDate}.json`
    : `web-release-${recordDate}.json`;
}

// ============================================================================
// CLI — side-effectful driver (build, git, file writes). Runs only when this
// file is executed directly, never when imported (tests import the core).
// ============================================================================

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

function parseRecordDate(raw, what) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw ?? "")) {
    fail(`${what} must be YYYY-MM-DD, got ${JSON.stringify(raw ?? "")}`);
  }
  return raw;
}

function requireArg(value, what) {
  if (value === undefined || value.trim().length === 0) {
    fail(`missing required argument: ${what}`);
  }
  return value.trim();
}

function gitCommitSha() {
  const res = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0 || !res.stdout.trim()) {
    fail("could not resolve the current commit (git rev-parse HEAD)");
  }
  return res.stdout.trim();
}

function writeRecord(record) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, recordFileName(record.record_type, recordDateOf(record)));
  fs.writeFileSync(outPath, formatRecord(record));
  return outPath;
}

function recordDateOf(record) {
  return record.record_type === "web-rollback" ? record.rollback.date : record.release.date;
}

// --- rollback-record mode ----------------------------------------------------
// No build runs: a rollback re-points an alias; rebuilding would produce a
// NEW deployment, which is the opposite of a rollback.

function runRollbackMode() {
  const recordDate = parseRecordDate(process.argv[3], "rollback record-date");
  const fromDeployment = requireArg(process.argv[4], "from-deployment (the deployment being rolled back FROM)");
  const toDeployment = requireArg(process.argv[5], "to-deployment (the deployment being rolled back TO)");
  const reason = requireArg(process.argv[6], "reason");
  const toBuildId = process.argv[7]?.trim() || null;
  const toCommit = process.argv[8]?.trim() || null;

  // Cross-check (informational, deterministic): when a to-build-id is given,
  // look for the release record that shipped it so the TL can confirm the
  // pairing. A miss is recorded honestly — not a failure (the target may
  // predate the release-record convention).
  if (toBuildId !== null && fs.existsSync(OUT_DIR)) {
    const matches = fs
      .readdirSync(OUT_DIR)
      .filter((name) => /^web-release-\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(OUT_DIR, name), "utf8"));
        } catch {
          return null;
        }
      })
      .filter((rec) => rec?.release?.buildId === toBuildId)
      .map((rec) => `${rec.release.date} (commit ${rec.release.commit})`);
    if (matches.length === 0) {
      console.log(
        `web-release: note — no existing release record carries build id ${toBuildId}; recording it as given (the target deployment may predate release records)`,
      );
    } else {
      console.log(`web-release: build id ${toBuildId} pairs with release record(s): ${matches.join("; ")}`);
    }
  }

  const record = assembleRollbackRecord({
    recordDate,
    fromDeployment,
    toDeployment,
    reason,
    toBuildId,
    toCommit,
  });

  const outPath = writeRecord(record);

  console.log("=== PaySwap web rollback record ===");
  console.log("record written:  ", path.relative(ROOT, outPath));
  console.log("rollback date:   ", recordDate);
  console.log("from deployment: ", fromDeployment);
  console.log("to deployment:   ", toDeployment, toBuildId !== null ? `(build id ${toBuildId})` : "(build id not recorded)");
  console.log("reason:          ", reason);
  console.log(
    "api separation:   ",
    "web=payswap-web (consumer) — api runtime=payswap (authority, untouched by a web rollback)",
  );
  console.log("digest:          ", record.digest);
  console.log(
    "next:             ",
    "verify per spec/phase-3/infrastructure/rollback-runbook.md — GET /api/health must report the target deployment's build id + commit",
  );
}

// --- release-record mode (unchanged behavior) --------------------------------

function runReleaseMode() {
  const recordDate = parseRecordDate(
    process.argv[2] ?? new Date().toISOString().slice(0, 10),
    "record-date",
  );
  const productionUrl = process.argv[3]?.trim() || null;
  const previewUrl = process.argv[4]?.trim() || null;

  const commitSha = gitCommitSha();

  console.log("web-release: running the @payswap/web production build ...");
  const build = spawnSync(
    "npm",
    ["run", "build", "--workspace", "@payswap/web"],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (build.status !== 0) {
    fail("the @payswap/web build failed — no release record was written");
  }

  const buildIdPath = path.join(WEB_ROOT, ".next", "BUILD_ID");
  if (!fs.existsSync(buildIdPath)) {
    fail("the build did not produce .next/BUILD_ID — cannot verify build identity");
  }
  const buildId = fs.readFileSync(buildIdPath, "utf8").trim();

  // --- independent digest recomputation (mirrors next.config.ts) -----------

  const IGNORED_DIRECTORIES = new Set([
    ".git",
    ".next",
    "node_modules",
    "coverage",
    "out",
    ".vercel",
  ]);
  const HASHED_CONFIG_FILES = [
    "package.json",
    "postcss.config.mjs",
    "next.config.ts",
  ];

  function collectSourceFiles(root) {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) {
            continue;
          }
          walk(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          files.push(path.join(dir, entry.name));
        }
      }
    };
    for (const dir of ["src", "public"]) {
      const absolute = path.join(root, dir);
      if (fs.existsSync(absolute)) {
        walk(absolute);
      }
    }
    for (const file of HASHED_CONFIG_FILES) {
      const absolute = path.join(root, file);
      if (fs.existsSync(absolute)) {
        files.push(absolute);
      }
    }
    return files.sort();
  }

  function computeSourceDigest(root) {
    const hash = createHash("sha256");
    for (const file of collectSourceFiles(root)) {
      hash.update(path.relative(root, file));
      hash.update("\0");
      hash.update(fs.readFileSync(file));
      hash.update("\0");
    }
    return hash.digest("hex").slice(0, 16);
  }

  const sourceDigest = computeSourceDigest(WEB_ROOT);
  const buildIdMatchesSource = sourceDigest === buildId;
  if (!buildIdMatchesSource) {
    fail(
      `BUILD ID MISMATCH — the build produced ${buildId} but the sources hash to ${sourceDigest}. ` +
        "The built artifact does not correspond to the committed sources; refusing to record a release.",
    );
  }

  const record = assembleReleaseRecord({
    recordDate,
    commitSha,
    buildId,
    buildIdVerifiedAgainstSources: buildIdMatchesSource,
    productionUrl,
    previewUrl,
  });

  const outPath = writeRecord(record);

  console.log("=== PaySwap web release record ===");
  console.log("record written:  ", path.relative(ROOT, outPath));
  console.log("release date:    ", recordDate);
  console.log("commit:          ", commitSha);
  console.log("build id:        ", buildId, "(verified against the source digest)");
  console.log("vercel project:  ", "payswap-web (root directory packages/web)");
  console.log(
    "deployment urls:  ",
    `production=${productionUrl ?? "(placeholder)"} preview=${previewUrl ?? "(placeholder)"}`,
  );
  console.log(
    "api separation:   ",
    "web=payswap-web (consumer) — api runtime=payswap (authority, untouched)",
  );
  console.log("digest:          ", record.digest);
}

if (isMainModule()) {
  if (process.argv[2] === "rollback") {
    runRollbackMode();
  } else {
    runReleaseMode();
  }
}
