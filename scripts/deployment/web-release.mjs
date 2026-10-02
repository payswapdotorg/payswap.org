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

const recordDate = process.argv[2] ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
  fail(`record-date must be YYYY-MM-DD, got ${JSON.stringify(process.argv[2] ?? "")}`);
}
const productionUrl = process.argv[3]?.trim() || null;
const previewUrl = process.argv[4]?.trim() || null;

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
