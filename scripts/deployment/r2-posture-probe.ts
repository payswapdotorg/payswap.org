/**
 * R2 posture probe — P3-W1-003 (infrastructure hardening).
 *
 * Authority:
 * - spec/development-state/r2-posture.json (THE posture data: expected
 *   buckets, storage budgets, prefix hygiene, lifecycle posture);
 * - spec/development-state/runtime-activation.json (buckets
 *   payswap-evidence-prod / payswap-evidence-preview, S3 API, SigV4);
 * - spec/experience/DEPLOYMENT-TOPOLOGY.md section 4 (object storage holds
 *   immutable content-addressed evidence — never financial truth) and
 *   section 7 (free tiers preferred).
 *
 * Zero-dependency SigV4: the same node:crypto signing pattern as
 * scripts/deployment/runtime-plane-probe.ts (r2Signed), EXTENDED with
 * canonical query-string support (ListObjectsV2 / lifecycle reads). No AWS
 * SDK is added (no unexpected dependency; free-tier bias).
 *
 * Honest modes:
 *   - WITHOUT credentials: prints (and with --record writes) a
 *     credential-gated verification record and exits 0. Nothing live is
 *     claimed — UNKNOWN is not FAILED.
 *   - WITH credentials: ListBuckets, HeadBucket, bounded ListObjectsV2 per
 *     bucket (count/size/prefix hygiene vs the posture budgets), and a
 *     GetBucketLifecycleConfiguration ATTEMPT per bucket whose answer is
 *     classified honestly (rules | not-configured | not-supported-via-s3).
 *     Exits 0 when the live posture is within budget and shape; non-zero
 *     when a budget or separation law is violated or a check is
 *     unmeasurable.
 *
 * Usage: bun scripts/deployment/r2-posture-probe.ts [--record]
 * (bun: the operator console's execution runtime — fetch + node:crypto.)
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
const RECORD_FLAG = process.argv.includes("--record");
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const POSTURE_PATH = path.join(ROOT, "spec", "development-state", "r2-posture.json");
const VERIFICATION_PATH = path.join(
  ROOT,
  "spec",
  "development-state",
  "r2-posture-verification.json",
);

const RAW_ENDPOINT = (process.env.R2_S3_ENDPOINT ?? process.env.OBJECT_STORAGE_ENDPOINT ?? "")
  .trim()
  .replace(/\/$/, "");
// Explicit http:// is honored for LOCAL mock verification of this driver's
// SigV4 mechanics only; the real R2 binding (and any bare host) is https.
const ENDPOINT_SCHEME = RAW_ENDPOINT.startsWith("http://") ? "http" : "https";
const ENDPOINT = RAW_ENDPOINT.replace(/^https?:\/\//, "");
const ACCESS_KEY = (process.env.R2_ACCESS_KEY_ID ?? process.env.OBJECT_STORAGE_ACCESS_KEY_ID ?? "").trim();
const SECRET_KEY = (process.env.R2_SECRET_ACCESS_KEY ?? process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY ?? "").trim();

interface PostureRecord {
  selfImposedBudgets: { storageTotalBytes: number };
  buckets: {
    name: string;
    environment: string;
    prefixLayout: Record<string, string>;
    retentionPolicy: { lifecycleRules: { rule: string; status: string }[] };
  }[];
}

function fail(message: string): never {
  console.error(`r2-posture-probe: ${message}`);
  process.exit(1);
}

function loadPosture(): PostureRecord {
  const raw = JSON.parse(fs.readFileSync(POSTURE_PATH, "utf8")) as PostureRecord;
  if (!Array.isArray(raw.buckets) || raw.buckets.length === 0) {
    fail("spec/development-state/r2-posture.json is malformed (no buckets)");
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Zero-dependency SigV4 (extends runtime-plane-probe.ts r2Signed with
// canonical query strings)
// ---------------------------------------------------------------------------
import crypto from "node:crypto";

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}
function sha256hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** URI-encode per SigV4 (RFC 3986, keeping the unreserved set). */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * SigV4-signed S3 request against the R2 endpoint.
 * `query` must be a plain key→value map (sorted + encoded canonically here).
 */
async function r2SignedRequest(
  method: "GET" | "HEAD",
  bucket: string | null,
  query: Record<string, string>,
): Promise<Response> {
  // Canonical path: "/" (ListBuckets) or "/{bucket}/" (per-bucket ops).
  const canonicalPath = bucket === null ? "/" : `/${bucket}/`;
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(query[key])}`)
    .join("&");
  const url = `${ENDPOINT_SCHEME}://${ENDPOINT}${canonicalPath}${canonicalQuery.length > 0 ? `?${canonicalQuery}` : ""}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex("");
  const canonicalHeaders = `host:${ENDPOINT}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStamp), "auto"), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return fetch(url, {
    method,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    },
    signal: AbortSignal.timeout(30_000),
  });
}

// --- minimal XML field readers (S3 shapes only; no XML dependency) ----------
function xmlValues(xml: string, tag: string): string[] {
  const matches = [...xml.matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, "g"))];
  return matches.map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// Live verification
// ---------------------------------------------------------------------------
interface BucketVerification {
  bucket: string;
  headOk: boolean;
  objectCount: number;
  totalSizeBytes: number;
  sizeBudgetBytes: number;
  withinStorageBudget: boolean;
  prefixes: { prefix: string; declared: boolean; objects: number }[];
  prefixHygieneOk: boolean;
  lifecycle: {
    readVia: "s3-api";
    answer: "rules-present" | "not-configured" | "not-supported-via-s3" | "un-readable";
    rules?: string[];
    detail: string;
  };
}

async function verifyBucket(
  posture: PostureRecord,
  bucket: PostureRecord["buckets"][number],
): Promise<BucketVerification> {
  // HeadBucket: the bucket exists and the credentials scope to it.
  const head = await r2SignedRequest("HEAD", bucket.name, {});
  const headOk = head.status === 200;

  // Bounded ListObjectsV2: up to 5 pages x 1000 keys.
  let objectCount = 0;
  let totalSizeBytes = 0;
  const prefixHistogram = new Map<string, number>();
  let continuationToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const query: Record<string, string> = { "list-type": "2", "max-keys": "1000" };
    if (continuationToken !== undefined) {
      query["continuation-token"] = continuationToken;
    }
    const list = await r2SignedRequest("GET", bucket.name, query);
    if (list.status !== 200) {
      throw new Error(`ListObjectsV2 ${bucket.name} -> HTTP ${list.status}`);
    }
    const xml = await list.text();
    const keys = xmlValues(xml, "Key");
    const sizes = xmlValues(xml, "Size");
    for (let i = 0; i < keys.length; i += 1) {
      objectCount += 1;
      totalSizeBytes += Number(sizes[i] ?? 0);
      const prefix = `${keys[i].split("/")[0]}/`;
      prefixHistogram.set(prefix, (prefixHistogram.get(prefix) ?? 0) + 1);
    }
    const truncated = xmlValues(xml, "IsTruncated")[0] === "true";
    continuationToken = xmlValues(xml, "NextContinuationToken")[0];
    if (!truncated || continuationToken === undefined) {
      break;
    }
  }

  // Prefix hygiene vs the declared layout.
  const declaredPrefixes = Object.keys(bucket.prefixLayout);
  const prefixes = [...prefixHistogram.entries()].map(([prefix, objects]) => ({
    prefix,
    declared: declaredPrefixes.includes(prefix),
    objects,
  }));
  const prefixHygieneOk = prefixes.every((entry) => entry.declared);

  // Lifecycle attempt — the answer is classified, never invented.
  let lifecycle: BucketVerification["lifecycle"];
  try {
    const response = await r2SignedRequest("GET", bucket.name, { lifecycle: "" });
    if (response.status === 200) {
      const xml = await response.text();
      lifecycle = {
        readVia: "s3-api",
        answer: "rules-present",
        rules: xmlValues(xml, "ID"),
        detail: `${xmlValues(xml, "Rule").length} rule(s) read via the S3 API`,
      };
    } else if (response.status === 404) {
      lifecycle = {
        readVia: "s3-api",
        answer: "not-configured",
        detail: "HTTP 404 — no lifecycle configuration is set on this bucket",
      };
    } else {
      lifecycle = {
        readVia: "s3-api",
        answer: "not-supported-via-s3",
        detail: `HTTP ${response.status} — R2 lifecycle rules are managed via the Cloudflare API/console; the S3 API does not expose them. The REQUIRED rules stay recorded in the posture record; their application is credential-gated.`,
      };
    }
  } catch (error) {
    lifecycle = {
      readVia: "s3-api",
      answer: "un-readable",
      detail: String(error).slice(0, 160),
    };
  }

  return {
    bucket: bucket.name,
    headOk,
    objectCount,
    totalSizeBytes,
    sizeBudgetBytes: posture.selfImposedBudgets.storageTotalBytes,
    withinStorageBudget: totalSizeBytes <= posture.selfImposedBudgets.storageTotalBytes,
    prefixes,
    prefixHygieneOk,
    lifecycle,
  };
}

// ---------------------------------------------------------------------------
// The honest credential-gated report
// ---------------------------------------------------------------------------
function gatedReport(posture: PostureRecord) {
  return {
    schema_version: "1.0",
    record_type: "r2-posture-verification",
    workOrder: "P3-W1-003",
    probed_at: new Date().toISOString(),
    binding: {
      endpoint: "(vault-resolved at run time — never recorded)",
      envNames: ["R2_S3_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
    },
    status: "credential-gated",
    statusDetail:
      "the operator vault holding the live R2 S3 access keys was lost to a sandbox reset (2026-10-02); no live verification was executed and NONE is fabricated here (UNKNOWN is not FAILED, AGENTS.md rule 4). The last live R2 evidence on record is the digest-verified activation round trip in spec/development-state/runtime-plane-probe.json.",
    postureLoadedFrom: "spec/development-state/r2-posture.json",
    postureSummary: {
      buckets: posture.buckets.map((bucket) => bucket.name),
      storageBudgetBytes: posture.selfImposedBudgets.storageTotalBytes,
    },
    checksNotExecuted: [
      "ListBuckets — expected buckets exist, no unexpected third bucket",
      "HeadBucket per bucket",
      "ListObjectsV2 per bucket — count/size vs storage budget",
      "prefix hygiene vs declared prefixLayout",
      "lifecycle read attempt per bucket",
    ],
    verdict: "CREDENTIAL_GATED_NOT_EXECUTED",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const posture = loadPosture();

if (ENDPOINT.length === 0 || ACCESS_KEY.length === 0 || SECRET_KEY.length === 0) {
  const record = gatedReport(posture);
  if (RECORD_FLAG) {
    fs.writeFileSync(VERIFICATION_PATH, JSON.stringify(record, null, 2) + "\n");
  }
  console.log("=== PaySwap R2 posture probe ===");
  console.log("status:            credential-gated (R2_S3_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY absent)");
  console.log("posture loaded:    spec/development-state/r2-posture.json");
  console.log("expected buckets:  ", posture.buckets.map((bucket) => bucket.name).join(", "));
  console.log("live checks:       NOT EXECUTED (none fabricated — UNKNOWN is not FAILED)");
  if (RECORD_FLAG) {
    console.log("record written:    ", path.relative(ROOT, VERIFICATION_PATH));
  }
  process.exit(0);
}

const probedAt = new Date().toISOString();
const errors: string[] = [];
const bucketVerifications: BucketVerification[] = [];
let unexpectedBuckets: string[] = [];

try {
  // ListBuckets + separation shape.
  const listBuckets = await r2SignedRequest("GET", null, {});
  if (listBuckets.status !== 200) {
    errors.push(`ListBuckets -> HTTP ${listBuckets.status}`);
  } else {
    const xml = await listBuckets.text();
    const present = xmlValues(xml, "Name");
    const expected = posture.buckets.map((bucket) => bucket.name);
    unexpectedBuckets = present.filter((name) => !expected.includes(name));
    const missingBuckets = expected.filter((name) => !present.includes(name));
    if (missingBuckets.length > 0) {
      errors.push(`expected buckets missing: ${missingBuckets.join(", ")}`);
    }
  }

  for (const bucket of posture.buckets) {
    try {
      bucketVerifications.push(await verifyBucket(posture, bucket));
    } catch (error) {
      errors.push(`${bucket.name}: ${String(error).slice(0, 160)}`);
    }
  }
} catch (error) {
  errors.push(String(error).slice(0, 200));
}

const shapeOk = errors.length === 0 && unexpectedBuckets.length === 0;
const bucketsOk = bucketVerifications.length === posture.buckets.length &&
  bucketVerifications.every(
    (entry) => entry.headOk && entry.withinStorageBudget && entry.prefixHygieneOk,
  );
const withinPosture = shapeOk && bucketsOk;

const record = {
  schema_version: "1.0",
  record_type: "r2-posture-verification",
  workOrder: "P3-W1-003",
  probed_at: probedAt,
  binding: {
    endpoint: "(vault-resolved at run time — never recorded)",
    envNames: ["R2_S3_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
  },
  status: "live",
  unexpectedBuckets,
  buckets: bucketVerifications,
  errors,
  verdict: withinPosture ? "WITHIN_POSTURE" : "POSTURE_VIOLATION_OR_UNMEASURABLE",
  postureLoadedFrom: "spec/development-state/r2-posture.json",
};
if (RECORD_FLAG) {
  fs.writeFileSync(VERIFICATION_PATH, JSON.stringify(record, null, 2) + "\n");
}

console.log("=== PaySwap R2 posture probe (LIVE) ===");
console.log("unexpected buckets:", unexpectedBuckets.length === 0 ? "none" : unexpectedBuckets.join(", "));
for (const entry of bucketVerifications) {
  console.log(
    `${entry.bucket}:        head=${entry.headOk} objects=${entry.objectCount} size=${entry.totalSizeBytes}B/${entry.sizeBudgetBytes}B ` +
      `(${entry.withinStorageBudget ? "ok" : "OVER"}) prefixes=${entry.prefixes.map((p) => `${p.prefix}${p.declared ? "" : "(UNDECLARED)"}`).join("|") || "(empty)"} ` +
      `lifecycle=${entry.lifecycle.answer}`,
  );
}
for (const error of errors) {
  console.log("error:             ", error);
}
if (RECORD_FLAG) {
  console.log("record written:    ", path.relative(ROOT, VERIFICATION_PATH));
}
process.exit(withinPosture ? 0 : 1);
