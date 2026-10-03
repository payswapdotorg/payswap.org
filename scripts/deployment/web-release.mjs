#!/usr/bin/env node
/**
 * Web release-record driver for @payswap/web (Work Order P3-W1-001).
 *
 * Convention: follows scripts/deployment/run.mjs (the production-deployment
 * record runner) — a driver that assembles a release record DETERMINISTICALLY
 * (same repo state + same arguments => byte-identical record; "deployment is
 * reproducible") and writes it under spec/development-state/.
 *
 * What this driver does:
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
 * Determinism: the record contains no wall-clock timestamps — the record
 * DATE is an explicit input (defaulting to today UTC), everything else is a
 * pure function of the repo state and the CLI arguments. Two runs with the
 * same inputs produce byte-identical files.
 *
 * Usage:
 *   node scripts/deployment/web-release.mjs [record-date] [production-url] [preview-url]
 *     record-date      YYYY-MM-DD (default: today, UTC)
 *     production-url   optional; recorded verbatim once the TL has deployed
 *     preview-url      optional; recorded verbatim once the TL has deployed
 *
 *   node scripts/deployment/web-release.mjs --reverify [record-date]
 *     P3-W1-003 release-reproducibility mode: builds @payswap/web TWICE from
 *     the same sources, asserts the two BUILD_IDs are identical (byte-identical
 *     build ids) and that both equal the independently recomputed source
 *     digest; compares the result against the existing release records; and
 *     writes spec/development-state/web-release-reverification-<date>.json.
 *     The historical release record is NEVER touched by this mode.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

// --- inputs -----------------------------------------------------------------

const REVERIFY = process.argv.includes("--reverify");
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const recordDate = positional[0] ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
  fail(`record-date must be YYYY-MM-DD, got ${JSON.stringify(positional[0] ?? "")}`);
}
const productionUrl = positional[1]?.trim() || null;
const previewUrl = positional[2]?.trim() || null;

// --- release identity -------------------------------------------------------

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

const commitSha = gitCommitSha();

// --- the build --------------------------------------------------------------

function buildIdPath() {
  return path.join(WEB_ROOT, ".next", "BUILD_ID");
}

/** Run the production build and return its BUILD_ID (fail-loud). */
function runWebBuild(label) {
  console.log(`web-release: running the @payswap/web production build (${label}) ...`);
  const build = spawnSync(
    "npm",
    ["run", "build", "--workspace", "@payswap/web"],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (build.status !== 0) {
    fail(`the @payswap/web build failed (${label}) — no release record was written`);
  }
  const idPath = buildIdPath();
  if (!fs.existsSync(idPath)) {
    fail("the build did not produce .next/BUILD_ID — cannot verify build identity");
  }
  return fs.readFileSync(idPath, "utf8").trim();
}

const buildId = runWebBuild("release");

// --- independent digest recomputation (mirrors next.config.ts) -------------

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

// --- canonical serialization + fnv1a64 digest (house pattern) ----------------

function serialize(value) {
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

function contentDigest(value) {
  const input = serialize(value);
  const prime = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

// --- P3-W1-003: --reverify mode (release reproducibility) -------------------

if (REVERIFY) {
  // A re-run from the same sources must reproduce BYTE-IDENTICAL build ids.
  const buildIdRun2 = runWebBuild("reverification");
  const byteIdenticalBuildIds = buildId === buildIdRun2;
  const matchesSourceDigest = sourceDigest === buildId && sourceDigest === buildIdRun2;

  // Honest comparison against the existing release records: a record for the
  // CURRENT commit must match; the absence of a record for this commit is
  // recorded honestly (the TL writes release records at the review gate).
  const existingRecords = [];
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (!/^web-release-.*\.json$/.test(file) || file.includes("reverification")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), "utf8"));
      if (parsed?.release?.commit && parsed?.release?.buildId) {
        existingRecords.push({
          file,
          commit: parsed.release.commit,
          buildId: parsed.release.buildId,
          sameCommitAsHead: parsed.release.commit === commitSha,
          buildIdMatchesThisRun: parsed.release.buildId === buildId,
        });
      }
    } catch {
      /* skip unparseable */
    }
  }
  const currentCommitRecord = existingRecords.find((entry) => entry.sameCommitAsHead) ?? null;

  const reverification = {
    schema_version: "1.0",
    record_type: "web-release-reverification",
    workOrder: "P3-W1-003",
    package: "@payswap/web",
    date: recordDate,
    commit: commitSha,
    reproduction: {
      run1BuildId: buildId,
      run2BuildId: buildIdRun2,
      byteIdenticalBuildIds,
      buildIdScheme:
        "sha256 over the sorted packages/web build inputs (src/ + public/ + package.json + postcss.config.mjs + next.config.ts), truncated to 16 hex — same sources always produce the same build id",
      bothRunsMatchIndependentlyRecomputedSourceDigest: matchesSourceDigest,
      sourceDigest: sourceDigest,
    },
    existingRecordComparison: {
      records: existingRecords,
      recordForCurrentCommit: currentCommitRecord,
      finding: currentCommitRecord
        ? currentCommitRecord.buildIdMatchesThisRun
          ? `the existing release record for this commit (${currentCommitRecord.file}) carries the SAME build id — the release is reproducible across independent runs`
          : `the existing release record for this commit (${currentCommitRecord.file}) carries a DIFFERENT build id — the sources changed since that record was written; re-record the release`
        : "no release record exists for the current commit yet (the TL records releases at the review gate) — this reverification stands on the two independent builds above",
    },
    commands: [
      "node scripts/deployment/web-release.mjs --reverify " + recordDate,
    ],
  };
  reverification.digest = contentDigest(reverification);
  const reverificationPath = path.join(OUT_DIR, `web-release-reverification-${recordDate}.json`);
  fs.writeFileSync(reverificationPath, JSON.stringify(reverification, null, 2) + "\n");

  console.log("=== PaySwap web release REVERIFICATION ===");
  console.log("record written:  ", path.relative(ROOT, reverificationPath));
  console.log("commit:          ", commitSha);
  console.log("build id run 1:  ", buildId);
  console.log("build id run 2:  ", buildIdRun2);
  console.log("byte-identical:  ", byteIdenticalBuildIds ? "YES — same sources reproduce the same build id" : "NO — REPRODUCIBILITY VIOLATION");
  console.log("source digest:   ", sourceDigest, matchesSourceDigest ? "(matches both runs)" : "(MISMATCH)");
  console.log(
    "record for HEAD: ",
    currentCommitRecord
      ? currentCommitRecord.buildIdMatchesThisRun
        ? `${currentCommitRecord.file} (same build id)`
        : `${currentCommitRecord.file} (DIFFERENT build id — sources changed since)`
      : "(none yet — TL records releases at the review gate)",
  );
  process.exit(byteIdenticalBuildIds && matchesSourceDigest ? 0 : 1);
}

// --- the record --------------------------------------------------------------

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
    buildIdVerifiedAgainstSources: buildIdMatchesSource,
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
    law: "the web surface is a CONSUMER of the authoritative PaySwap API — it holds no financial state of its own",
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

// --- write + report -----------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, `web-release-${recordDate}.json`);

// P3-W1-003 immutability guard: a release record file that already exists
// may only be overwritten when it belongs to the SAME commit (the TL's
// documented re-run flow — e.g. recording the live deployment URLs at the
// review gate). Overwriting a DIFFERENT commit's record would silently
// rewrite release history — refused loudly instead.
if (fs.existsSync(outPath)) {
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {
    fail(`refusing to overwrite unparseable record ${path.relative(ROOT, outPath)}`);
  }
  if (existing?.release?.commit && existing.release.commit !== commitSha) {
    fail(
      `refusing to overwrite ${path.relative(ROOT, outPath)}: it records commit ${existing.release.commit.slice(0, 12)} ` +
        `but the current commit is ${commitSha.slice(0, 12)} (release history is immutable — choose a new record date for a new commit)`,
    );
  }
}
fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");

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
