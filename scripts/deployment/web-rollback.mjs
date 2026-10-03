#!/usr/bin/env node
/**
 * Web rollback driver — P3-W1-003.
 *
 * Authority: spec/development-state/web-rollback-runbook.md (the runbook
 * this script automates) + spec/development-state/web-release-*.json (the
 * release records anchoring build-id re-verification).
 *
 * Modes (both exit 0 when nothing is wrong; the guard FAILS loudly on
 * misuse — it can never touch a project other than payswap-web):
 *
 *   1. DRY-RUN / CREDENTIAL-GATED (default when VERCEL_TOKEN is absent):
 *      prints the exact rollback plan — candidate deployments (when the
 *      token IS present) or the plan skeleton with the exact CLI commands
 *      — and exits 0. NOTHING is executed; no live state is fabricated.
 *
 *   2. LIVE (VERCEL_TOKEN present):
 *      a. lists the payswap-web deployments (Vercel API, app=payswap-web);
 *      b. resolves the target: --to <url|uid>, defaulting to the newest
 *         READY production deployment that is NOT the current alias;
 *      c. POSTs the rollback (v13) for that deployment;
 *      d. re-verifies: polls GET /api/health on the production alias until
 *         it answers, checks liveness/readiness and the reported build.id
 *         against the release records (build-id re-verification);
 *      e. with --record, writes spec/development-state/web-rollback-record.json.
 *
 * Usage: node scripts/deployment/web-rollback.mjs [--to <url|uid>] [--record] [--execute]
 *        (--execute is REQUIRED for the live rollback POST — a plan without
 *         it is always safe to run)
 *
 * Secret hygiene: the token is read from the environment and never printed
 * or recorded; records carry deployment ids/urls/build ids only.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PROJECT = "payswap-web"; // hard law: this script only ever touches payswap-web
const PRODUCTION_ALIAS = "https://payswap-web.vercel.app";
const RECORD_PATH = path.join(ROOT, "spec", "development-state", "web-rollback-record.json");
const DEV_STATE = path.join(ROOT, "spec", "development-state");

const args = process.argv.slice(2);
const TO_INDEX = args.indexOf("--to");
const TARGET_ARG = TO_INDEX >= 0 ? args[TO_INDEX + 1] : undefined;
const RECORD_FLAG = args.includes("--record");
const EXECUTE_FLAG = args.includes("--execute");

const VERCEL_TOKEN = (process.env.VERCEL_TOKEN ?? "").trim();
const VERCEL_TEAM = (process.env.VERCEL_TEAM ?? process.env.PAYSWAP_VERCEL_TEAM ?? "").trim();
// Overridable API base for LOCAL driver-mechanics verification (mock);
// the default is the real Vercel API.
const VERCEL_API_BASE = (process.env.VERCEL_API_BASE ?? "https://api.vercel.com").trim().replace(/\/$/, "");

function fail(message) {
  console.error(`web-rollback: ${message}`);
  process.exit(1);
}

if (args.some((arg) => arg.startsWith("--project") || arg.startsWith("--alias"))) {
  fail(`this driver is hard-scoped to the ${PROJECT} project; project/alias overrides are refused`);
}

// ---------------------------------------------------------------------------
// Release records: commit -> buildId (the re-verification chain)
// ---------------------------------------------------------------------------
function loadReleaseRecords() {
  const records = [];
  if (!fs.existsSync(DEV_STATE)) return records;
  for (const file of fs.readdirSync(DEV_STATE)) {
    if (!/^web-release-.*\.json$/.test(file) || file.includes("reverification")) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(DEV_STATE, file), "utf8"));
      if (record?.release?.commit && record?.release?.buildId) {
        records.push({
          file,
          commit: record.release.commit,
          buildId: record.release.buildId,
          date: record.release.date,
        });
      }
    } catch {
      /* unparseable record files are skipped, not fatal */
    }
  }
  return records;
}

const releaseRecords = loadReleaseRecords();

// ---------------------------------------------------------------------------
// Vercel API helpers
// ---------------------------------------------------------------------------
function vercelUrl(pathname) {
  const url = new URL(`${VERCEL_API_BASE}${pathname}`);
  if (VERCEL_TEAM.length > 0) {
    url.searchParams.set("teamId", VERCEL_TEAM);
  }
  return url.toString();
}

async function listDeployments() {
  const query = `?app=${PROJECT}&limit=10&state=READY`;
  const response = await fetch(vercelUrl(`/v6/deployments${query}`), {
    headers: { authorization: `Bearer ${VERCEL_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`list deployments -> HTTP ${response.status}`);
  }
  const body = await response.json();
  return (body.deployments ?? []).map((deployment) => ({
    uid: deployment.uid,
    url: deployment.url,
    readyState: deployment.readyState,
    createdAt: deployment.createdAt,
    target: deployment.target ?? null,
    commit: deployment.meta?.gitCommitSha ?? null,
  }));
}

async function probeHealth() {
  const started = Date.now();
  try {
    const response = await fetch(`${PRODUCTION_ALIAS}/api/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    return {
      httpStatus: response.status,
      status: body.status ?? null,
      liveness: body.liveness ?? null,
      ready: body.readiness?.ready ?? null,
      buildId: body.build?.id ?? null,
      buildCommit: body.build?.commit ?? null,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { error: String(error).slice(0, 160), latencyMs: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------
// DRY-RUN / CREDENTIAL-GATED plan
// ---------------------------------------------------------------------------
function printPlan(candidates) {
  console.log("=== PaySwap web rollback plan (payswap-web ONLY — the payswap API project is never touched) ===");
  console.log("production alias: ", PRODUCTION_ALIAS);
  console.log();
  console.log("PROCEDURE A — Vercel rollback (instant mitigation):");
  if (candidates !== null) {
    console.log("  candidate deployments (READY, newest first):");
    for (const candidate of candidates) {
      const record = releaseRecords.find((entry) => entry.commit === candidate.commit);
      console.log(
        `    ${candidate.url}  commit=${candidate.commit?.slice(0, 12) ?? "?"}` +
          `${record ? `  buildId=${record.buildId} (release record: ${record.file})` : "  (no release record — NOT a reviewed release)"}`,
      );
    }
  } else {
    console.log("  (candidate list requires VERCEL_TOKEN — credential-gated, not fetched; nothing fabricated)");
  }
  console.log("  1. pick the target: the newest READY deployment matching a recorded release");
  console.log("  2. roll back:        cd packages/web && vercel rollback <target-url> --yes --token \"$VERCEL_TOKEN\"");
  console.log("     (or re-run this driver with --to <target-url> --execute and VERCEL_TOKEN bound)");
  console.log("  3. verify:           curl -s " + PRODUCTION_ALIAS + "/api/health");
  console.log("     expect liveness=alive and build.id equal to the target's recorded release buildId");
  console.log();
  console.log("PROCEDURE B — git revert (source-of-truth repair):");
  console.log("  1. git checkout -b revert/web-<date>-<sha> main && git revert <bad-commit>");
  console.log("  2. verify: node scripts/verify-repository.mjs && npm run typecheck && npm test && (cd packages/web && npm run build)");
  console.log("  3. merge per governance; the TL re-runs scripts/deployment/web-release.mjs and redeploys");
  console.log();
  console.log("Full runbook: spec/development-state/web-rollback-runbook.md");
}

if (VERCEL_TOKEN.length === 0) {
  printPlan(null);
  console.log();
  console.log("status:             credential-gated (VERCEL_TOKEN absent) — plan only, nothing executed, exit 0");
  if (RECORD_FLAG) {
    const record = {
      schema_version: "1.0",
      record_type: "web-rollback-record",
      workOrder: "P3-W1-003",
      at: new Date().toISOString(),
      mode: "credential-gated-plan",
      project: PROJECT,
      productionAlias: PRODUCTION_ALIAS,
      executed: false,
      status: "CREDENTIAL_GATED_NOT_EXECUTED (operator vault lost to sandbox reset 2026-10-02; the rollback API leg is un-rehearsed — see runbook section 6)",
      releaseRecordsLoaded: releaseRecords.length,
    };
    fs.writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2) + "\n");
    console.log("record written:     ", path.relative(ROOT, RECORD_PATH));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// LIVE mode
// ---------------------------------------------------------------------------
let candidates;
try {
  candidates = await listDeployments();
} catch (error) {
  fail(`could not list ${PROJECT} deployments: ${String(error).slice(0, 160)}`);
}

printPlan(candidates);

const annotated = candidates.map((candidate) => ({
  ...candidate,
  record: releaseRecords.find((entry) => entry.commit === candidate.commit) ?? null,
}));

let target;
if (TARGET_ARG !== undefined) {
  target = annotated.find(
    (candidate) => candidate.uid === TARGET_ARG || candidate.url === TARGET_ARG || `https://${candidate.url}` === TARGET_ARG,
  );
  if (target === undefined) {
    fail(`--to target ${TARGET_ARG} is not among the READY ${PROJECT} deployments`);
  }
} else {
  target = annotated.find((candidate) => candidate.record !== null);
}
if (target === undefined) {
  fail("no READY deployment matches a recorded release — refusing to roll back to an unreviewed build");
}

console.log();
console.log("target:            ", `${target.url} (commit ${target.commit?.slice(0, 12) ?? "?"}, buildId ${target.record?.buildId ?? "?"})`);

if (!EXECUTE_FLAG) {
  console.log("mode:              LIVE plan (add --execute to perform the rollback POST)");
  process.exit(0);
}

// The rollback POST (v13).
try {
  const response = await fetch(vercelUrl(`/v13/deployments/${target.uid}/rollback`), {
    method: "POST",
    headers: { authorization: `Bearer ${VERCEL_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    fail(`rollback POST -> HTTP ${response.status}: ${bodyText.slice(0, 200)}`);
  }
  console.log("rollback:          ", `POST /v13/deployments/${target.uid}/rollback -> HTTP ${response.status}`);
} catch (error) {
  fail(`rollback POST failed: ${String(error).slice(0, 200)}`);
}

// Re-verification: poll the alias health until it answers; check build id.
let health = null;
for (let attempt = 1; attempt <= 6; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  health = await probeHealth();
  if (health.error === undefined) break;
}
const buildIdMatches =
  health !== null && health.error === undefined && health.buildId !== null && health.buildId === target.record?.buildId;

console.log("verify health:     ", health?.error !== undefined ? `PROBE FAILED: ${health.error}` : JSON.stringify(health));
console.log("build id match:    ", buildIdMatches ? `ok (${health?.buildId} == recorded ${target.record?.buildId})` : `MISMATCH/UNKNOWN (probe: ${health?.buildId ?? "?"}, recorded: ${target.record?.buildId ?? "?"})`);

if (RECORD_FLAG) {
  const record = {
    schema_version: "1.0",
    record_type: "web-rollback-record",
    workOrder: "P3-W1-003",
    at: new Date().toISOString(),
    mode: "live",
    project: PROJECT,
    productionAlias: PRODUCTION_ALIAS,
    executed: true,
    target: { uid: target.uid, url: target.url, commit: target.commit, buildId: target.record?.buildId ?? null },
    health,
    buildIdMatches,
  };
  fs.writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2) + "\n");
  console.log("record written:    ", path.relative(ROOT, RECORD_PATH));
}

process.exit(buildIdMatches ? 0 : 1);
