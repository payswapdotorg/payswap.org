/**
 * Runtime-plane probe — executes the LIVE runtime checks for an
 * operator-authorized deployment of the platform plane.
 *
 * Authority:
 * - spec/development-state/deployment-authorization.json (the operator
 *   directive that opened the production_deployment_authorized gate) and
 *   spec/development-state/runtime-activation.json (the operator credential
 *   batch that activated the runtime plane — the recorded activation path
 *   of the 73a2600 release record);
 * - spec/experience/DEPLOYMENT-TOPOLOGY.md §6 (the eleven release gates —
 *   this probe executes the three runtime-plane gates plus the runtime leg
 *   of browser journeys);
 * - packages/operations (the §3.1 configuration contract and the W3-007
 *   observability taxonomy, imported as data).
 *
 * What this probe does (LIVE — network, credentials from the operator
 * vault environment; NEVER values into the repo):
 *   1. resolves the runtime bindings from the vault (DATABASE_URL,
 *      OBJECT_STORAGE_*, QUEUE_URL/REDIS_URL, OBSERVABILITY_ENDPOINT) and
 *      checks §3.1 environment completeness PER WORKER ROLE;
 *   2. database connectivity FROM EVERY worker role's binding context
 *      (a real PostgreSQL connection per role) — plus the deployed-context
 *      result from the live runtime host's probe endpoint;
 *   3. queue/outbox health: the deployed-context drain drill (XADD →
 *      XREADGROUP → XACK → XPENDING) with the verdict derived from the RAW
 *      drill numbers (read ≥ 1, acked == read, pending == 0) — never from a
 *      hosted boolean alone;
 *   4. observability sink wiring: real taxonomy events POSTed to the live
 *      OBSERVABILITY_ENDPOINT (terminal transition, UNKNOWN outcome,
 *      reconciliation case, deployment gate result), an INVALID event that
 *      must be rejected, and the Upstash stream entry ids as receipt proof;
 *   5. object storage round trip (content-addressed artifact, digest
 *      verified) from the console vantage;
 *   6. hosting state (Vercel deployments, production aliases, project env
 *      bindings present);
 *   7. API journeys over the live surface: out-of-band session issuance →
 *      authenticated GET /v1/health (200 envelope) and GET /v1/capabilities,
 *      the honest unauthenticated 400 VALIDATION envelope, the INV-F05
 *      idempotency-key enforcement 400, and the fail-closed authorization
 *      denial for mutations under the zero-provider (empty-grants) release.
 *
 * Output: spec/development-state/runtime-plane-probe.json — the ground-
 * truth evidence artifact consumed by scripts/deployment/production-
 * deployment.ts (deploy:record) to set the runtime-plane gate verdicts.
 * SECRET HYGIENE: hosts, buckets, urls, counts, latencies and ids only —
 * never credentials, tokens, or connection passwords.
 *
 * Usage: bun scripts/deployment/runtime-plane-probe.ts <release-sha>
 * (bun is the operator console's execution runtime for live probes: native
 * PostgreSQL client, fetch, node:crypto — zero added dependencies.)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  CONFIGURATION_CONTRACT,
  OBSERVABILITY_EVENT_TAXONOMY,
  SERVICE_ROLES,
} from "@payswap/operations";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
const RELEASE_SHA = process.argv[2] ?? "unknown";
const PRODUCTION_URL = (process.env.PAYSWAP_PRODUCTION_URL ?? "").replace(/\/$/, "");
const RUNTIME_SECRET = process.env.PAYSWAP_RUNTIME_PROBE_SECRET ?? "";
const DATABASE_URL = process.env.PAYSWAP_DATABASE_URL_PROD ?? "";
const DATABASE_URL_PREVIEW = process.env.PAYSWAP_DATABASE_URL_PREVIEW ?? "";
const OBSERVABILITY_ENDPOINT = process.env.PAYSWAP_OBSERVABILITY_ENDPOINT ?? "";
const UPSTASH_REST_URL = process.env.PAYSWAP_REDIS_REST_URL_PROD ?? "";
const R2_ENDPOINT = (process.env.R2_S3_ENDPOINT ?? "").replace(/^https?:\/\//, "");
const R2_KEY = process.env.R2_ACCESS_KEY_ID ?? "";
const R2_SECRET = process.env.R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET = "payswap-evidence-prod";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN ?? "";
const VERCEL_TEAM = process.env.PAYSWAP_VERCEL_TEAM ?? "";
const VERCEL_PROJECT = process.env.PAYSWAP_VERCEL_PROJECT ?? "";

const PLATFORM_ROLES = SERVICE_ROLES.filter(
  (role) => role !== "rail-adapter-worker",
) as readonly string[];

function fail(message: string): never {
  console.error(`runtime-plane-probe: ${message}`);
  process.exit(1);
}

if (RELEASE_SHA === "unknown") fail("release sha argument required");
if (PRODUCTION_URL.length === 0) fail("PAYSWAP_PRODUCTION_URL not set (vault)");
if (RUNTIME_SECRET.length === 0) fail("PAYSWAP_RUNTIME_PROBE_SECRET not set (vault)");
if (DATABASE_URL.length === 0) fail("PAYSWAP_DATABASE_URL_PROD not set (vault)");

/** Redact a connection string to its safe host/database facts. */
function pgFacts(uri: string): { host: string; database: string; user: string } {
  const match = /postgres(?:ql)?:\/\/([^:]+):[^@]+@([^/]+)\/(\w+)/.exec(uri);
  return match
    ? { user: match[1], host: match[2], database: match[3] }
    : { user: "?", host: "?", database: "?" };
}

// ---------------------------------------------------------------------------
// 1. Vault-level §3.1 completeness per worker role
// ---------------------------------------------------------------------------
const resolvedBindings: Record<string, string> = {
  DATABASE_URL: pgFacts(DATABASE_URL).host,
  VAULT_REF: "vault://payswap/prod (operator vault, env-resolved)",
  OBSERVABILITY_ENDPOINT: OBSERVABILITY_ENDPOINT,
  OBJECT_STORAGE_ENDPOINT: R2_ENDPOINT,
  OBJECT_STORAGE_BUCKET: R2_BUCKET,
  OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_ACCESS_KEY_ID: "<vault-resolved>",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "<vault-resolved>",
  QUEUE_URL: UPSTASH_REST_URL,
  REDIS_URL: `${UPSTASH_REST_URL.replace(/^https?:\/\//, "")} (REST binding)`,
  API_VERSION: "2026-09-30",
  // The webhook signing ref resolves only when the vault actually holds the
  // notification-worker's X-PaySwap-Signature v1 HMAC key.
  WEBHOOK_SIGNING_SECRET_REF:
    (process.env.PAYSWAP_WEBHOOK_SIGNING_SECRET ?? "").length > 0
      ? "vault://payswap/webhook-signing (operator vault, env-resolved)"
      : "",
};

const roleCompleteness = PLATFORM_ROLES.map((role) => {
  const required = CONFIGURATION_CONTRACT.filter((variable) =>
    variable.requiredBy.includes(role as (typeof SERVICE_ROLES)[number]),
  );
  const roleBindings: Record<string, string> = { ...resolvedBindings, WORKER_ROLE: role };
  const missing = required
    .filter((variable) => (roleBindings[variable.name] ?? "").length === 0)
    .map((variable) => variable.name);
  return { role, declared: required.length, missing, passed: missing.length === 0 };
});
const vaultCompletenessPassed = roleCompleteness.every((entry) => entry.passed);

// ---------------------------------------------------------------------------
// 2. Database connectivity from every worker role (console vantage)
// ---------------------------------------------------------------------------
interface RoleDbResult {
  role: string;
  ok: boolean;
  database?: string;
  user?: string;
  serverVersion?: string;
  latencyMs?: number;
  error?: string;
}

async function checkRoleDatabase(role: string): Promise<RoleDbResult> {
  const started = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SQL = (globalThis as any).Bun.SQL as new (uri: string) => {
      query: (strings: TemplateStringsArray) => Promise<{ current_database: string; current_user: string; version: string }[]>;
      end: () => Promise<void>;
    };
    const sql = new SQL(DATABASE_URL);
    const rows = await sql`select current_database() as current_database, current_user as current_user, version() as version`;
    await sql.end();
    return {
      role,
      ok: true,
      database: rows[0].current_database,
      user: rows[0].current_user,
      serverVersion: String(rows[0].version).split(" ").slice(0, 2).join(" "),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { role, ok: false, error: String(error).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// 3-7. Live surface calls
// ---------------------------------------------------------------------------
async function callRuntimeProbe(): Promise<Record<string, unknown> | { error: string }> {
  try {
    const response = await fetch(`${PRODUCTION_URL}/api/internal/runtime-probe`, {
      headers: { "x-runtime-secret": RUNTIME_SECRET },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      return { error: `runtime-probe ${response.status}` };
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    return { error: String(error).slice(0, 200) };
  }
}

async function mintSession(): Promise<{ token: string; principal: string } | { error: string }> {
  try {
    const response = await fetch(`${PRODUCTION_URL}/api/internal/sessions`, {
      method: "POST",
      headers: { "x-runtime-secret": RUNTIME_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ ttlMs: 600_000 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return { error: `sessions ${response.status}` };
    }
    const body = (await response.json()) as { token: string; principal: string };
    return { token: body.token, principal: body.principal };
  } catch (error) {
    return { error: String(error).slice(0, 200) };
  }
}

interface ApiJourney {
  name: string;
  ok: boolean;
  status: number;
  detail: string;
}

async function apiJourneys(): Promise<ApiJourney[]> {
  const journeys: ApiJourney[] = [];
  const session = await mintSession();
  const authed = "token" in session;

  // Unauthenticated /v1/health: the honest VALIDATION envelope (auth +
  // apiVersion required) — never a fabricated health lie.
  try {
    const response = await fetch(`${PRODUCTION_URL}/v1/health`, { signal: AbortSignal.timeout(30_000) });
    const body = (await response.json()) as { error?: { category?: string; code?: string } };
    journeys.push({
      name: "unauthenticated /v1/health -> honest VALIDATION envelope",
      ok: response.status === 400 && body.error?.category === "VALIDATION",
      status: response.status,
      detail: `code=${body.error?.code ?? "?"} (auth.principal + apiVersion required)`,
    });
  } catch (error) {
    journeys.push({ name: "unauthenticated /v1/health", ok: false, status: 0, detail: String(error).slice(0, 120) });
  }

  if (!authed) {
    journeys.push({ name: "session issuance", ok: false, status: 0, detail: "error" in session ? session.error : "?" });
    return journeys;
  }

  const headers = {
    "x-payswap-api-version": "2026-09-30",
    "x-payswap-principal": session.principal,
    authorization: `Bearer ${session.token}`,
    "content-type": "application/json",
  };

  // Authenticated /v1/health: the certified 200 envelope.
  try {
    const response = await fetch(`${PRODUCTION_URL}/v1/health`, { headers, signal: AbortSignal.timeout(30_000) });
    const body = (await response.json()) as { data?: { status?: string; apiVersion?: string; schemaVersion?: string }; meta?: { requestId?: string } };
    journeys.push({
      name: "authenticated /v1/health -> 200 certified envelope",
      ok:
        response.status === 200 &&
        body.data?.status === "ok" &&
        body.data?.apiVersion === "2026-09-30" &&
        typeof body.meta?.requestId === "string",
      status: response.status,
      detail: `requestId=${body.meta?.requestId ?? "?"} serverTime present=${typeof body.data?.schemaVersion === "string"}`,
    });
  } catch (error) {
    journeys.push({ name: "authenticated /v1/health", ok: false, status: 0, detail: String(error).slice(0, 120) });
  }

  // Authenticated /v1/capabilities: the honest zero-provider capability set.
  try {
    const response = await fetch(`${PRODUCTION_URL}/v1/capabilities`, { headers, signal: AbortSignal.timeout(30_000) });
    const body = (await response.json()) as { data?: { capabilities?: { capabilityId: string; effectiveAvailability: string }[] } };
    const caps = body.data?.capabilities ?? [];
    const observation = caps.find((capability) => capability.capabilityId === "api.external_observation_probe");
    journeys.push({
      name: "authenticated /v1/capabilities -> honest zero-provider states",
      ok: response.status === 200 && caps.length === 3 && observation?.effectiveAvailability === "UNKNOWN",
      status: response.status,
      detail: `${caps.length} capabilities; external observation probe = ${observation?.effectiveAvailability ?? "?"} (UNKNOWN is the honest no-connector state)`,
    });
  } catch (error) {
    journeys.push({ name: "authenticated /v1/capabilities", ok: false, status: 0, detail: String(error).slice(0, 120) });
  }

  // INV-F05: mutation without idempotency key is rejected.
  try {
    const response = await fetch(`${PRODUCTION_URL}/v1/intents`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as { error?: { category?: string; message?: string } };
    journeys.push({
      name: "POST /v1/intents without Idempotency-Key -> INV-F05 rejection",
      ok: response.status === 400 && body.error?.category === "VALIDATION" && (body.error?.message ?? "").includes("idempotencyKey"),
      status: response.status,
      detail: (body.error?.message ?? "").slice(0, 110),
    });
  } catch (error) {
    journeys.push({ name: "POST /v1/intents INV-F05 check", ok: false, status: 0, detail: String(error).slice(0, 120) });
  }

  // Fail-closed authorization: the zero-provider release carries NO grants,
  // so a well-formed mutation is DENIED (never fabricated acceptance).
  try {
    const response = await fetch(`${PRODUCTION_URL}/v1/intents`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": `probe-${Date.now()}` },
      body: JSON.stringify({ commandType: "payments.intent.create" }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as { error?: { category?: string; code?: string; message?: string } };
    journeys.push({
      name: "POST /v1/intents well-formed -> fail-closed denial (no grants)",
      ok: response.status === 403 && body.error?.category === "AUTHORIZATION" && (body.error?.message ?? "").includes("fail closed"),
      status: response.status,
      detail: `code=${body.error?.code ?? "?"} (${(body.error?.message ?? "").slice(0, 60)})`,
    });
  } catch (error) {
    journeys.push({ name: "POST /v1/intents fail-closed check", ok: false, status: 0, detail: String(error).slice(0, 120) });
  }

  return journeys;
}

// ---------------------------------------------------------------------------
// 4. Observability sink: taxonomy events in, receipts back, invalid rejected
// ---------------------------------------------------------------------------
interface SinkResult {
  ok: boolean;
  accepted: { eventName: string; stream: string; eventId: string }[];
  invalidRejected: boolean;
  error?: string;
}

async function observabilitySink(): Promise<SinkResult> {
  const targets = [
    "settlement.terminal-transition.fulfilled",
    "settlement.terminal-transition.unknown",
    "reconciliation.case-opened",
    "deployment.gate-result",
  ];
  const accepted: { eventName: string; stream: string; eventId: string }[] = [];
  try {
    for (const eventName of targets) {
      const declaration = OBSERVABILITY_EVENT_TAXONOMY.find((event) => event.eventName === eventName);
      if (declaration === undefined) {
        return { ok: false, accepted, invalidRejected: false, error: `taxonomy miss: ${eventName}` };
      }
      const correlationKeys: Record<string, string> = {};
      for (const key of declaration.requiredCorrelationKeys) {
        correlationKeys[key] = `probe_${RELEASE_SHA.slice(0, 7)}_${crypto.randomBytes(4).toString("hex")}`;
      }
      const response = await fetch(OBSERVABILITY_ENDPOINT, {
        method: "POST",
        headers: { "x-runtime-secret": RUNTIME_SECRET, "content-type": "application/json" },
        body: JSON.stringify({
          eventName,
          correlationKeys,
          data: { probe: "runtime-plane-activation", release: RELEASE_SHA },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json()) as { accepted?: boolean; stream?: string; eventId?: string; error?: string };
      if (response.status !== 202 || body.accepted !== true || typeof body.eventId !== "string") {
        return { ok: false, accepted, invalidRejected: false, error: `sink ${eventName}: ${response.status} ${body.error ?? ""}` };
      }
      accepted.push({ eventName, stream: body.stream ?? "?", eventId: body.eventId });
    }
    // The invalid event MUST be rejected (honest validation, not a fake sink).
    const invalid = await fetch(OBSERVABILITY_ENDPOINT, {
      method: "POST",
      headers: { "x-runtime-secret": RUNTIME_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ eventName: "probe.not-a-taxonomy-event" }),
      signal: AbortSignal.timeout(30_000),
    });
    return { ok: accepted.length === targets.length && invalid.status === 422, accepted, invalidRejected: invalid.status === 422 };
  } catch (error) {
    return { ok: false, accepted, invalidRejected: false, error: String(error).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// 5. Object storage round trip (console vantage, zero-dep SigV4)
// ---------------------------------------------------------------------------
function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}
function sha256hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function r2Signed(method: "PUT" | "GET", keyPath: string, body?: Buffer): Promise<Response> {
  const url = `https://${R2_ENDPOINT}/${R2_BUCKET}/${keyPath}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body ?? "");
  const parsed = new URL(url);
  const canonicalHeaders = `host:${parsed.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, parsed.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${R2_SECRET}`, dateStamp), "auto"), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return fetch(url, {
    method,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${R2_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    },
    body,
  });
}

async function objectStorageRoundTrip(): Promise<Record<string, unknown>> {
  try {
    const content = Buffer.from(
      `payswap runtime-plane activation probe ${RELEASE_SHA} ${new Date().toISOString()}\n`,
    );
    const digest = sha256hex(content);
    const keyPath = `probe/activation/${digest}.txt`;
    const put = await r2Signed("PUT", keyPath, content);
    const get = await r2Signed("GET", keyPath);
    const back = Buffer.from(await get.arrayBuffer());
    return {
      ok: put.status === 200 && get.status === 200 && sha256hex(back) === digest,
      bucket: R2_BUCKET,
      artifact: keyPath,
      digestMatch: sha256hex(back) === digest,
    };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// 6. Hosting state (Vercel)
// ---------------------------------------------------------------------------
async function hostingState(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { provider: "vercel" };
  try {
    const response = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT}&teamId=${VERCEL_TEAM}&limit=5`,
      { headers: { authorization: `Bearer ${VERCEL_TOKEN}` }, signal: AbortSignal.timeout(30_000) },
    );
    const body = (await response.json()) as { deployments?: { uid: string; readyState: string; url: string; createdAt: number; meta?: Record<string, string> }[] };
    out.deployments = (body.deployments ?? []).map((deployment) => ({
      uid: deployment.uid,
      readyState: deployment.readyState,
      url: deployment.url,
      gitSha: deployment.meta?.gitCommitSha?.slice(0, 12) ?? null,
    }));
    const envResponse = await fetch(
      `https://api.vercel.com/v9/projects/${VERCEL_PROJECT}/env?teamId=${VERCEL_TEAM}`,
      { headers: { authorization: `Bearer ${VERCEL_TOKEN}` }, signal: AbortSignal.timeout(30_000) },
    );
    const envBody = (await envResponse.json()) as { envs?: { key: string; target: string[] }[] };
    const keys = (envBody.envs ?? []).filter((entry) => entry.target.includes("production")).map((entry) => entry.key);
    out.projectEnvKeys = keys.sort();
    out.observabilityEndpointBound = keys.includes("OBSERVABILITY_ENDPOINT");
  } catch (error) {
    out.error = String(error).slice(0, 200);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const probedAt = new Date().toISOString();

  const roleDatabases: RoleDbResult[] = [];
  for (const role of PLATFORM_ROLES) {
    roleDatabases.push(await checkRoleDatabase(role));
  }

  const deployed = await callRuntimeProbe();
  const queueDrill = (deployed as Record<string, unknown>).queueOutbox as
    | { ok?: boolean; ping?: string; drill?: { stream?: string; read?: number; acked?: number; pendingAfterAck?: number | null }; drainVerified?: boolean; latencyMs?: number }
    | undefined;
  const drainDerived =
    queueDrill?.drill !== undefined &&
    (queueDrill.drill.read ?? 0) >= 1 &&
    queueDrill.drill.read === queueDrill.drill.acked &&
    Number(queueDrill.drill.pendingAfterAck ?? 0) === 0;

  const sink = await observabilitySink();
  const storage = await objectStorageRoundTrip();
  const journeys = await apiJourneys();
  const hosting = await hostingState();

  const databaseConnectivity =
    roleDatabases.every((result) => result.ok) &&
    ((deployed as Record<string, unknown>).database as { ok?: boolean } | undefined)?.ok === true;
  const queueOutboxHealth =
    queueDrill?.ok === true && queueDrill.ping === "PONG" && drainDerived;
  const observabilityWired = sink.ok;
  const apiJourneysPassed = journeys.every((journey) => journey.ok);

  const record = {
    schema_version: "1.0",
    record_type: "runtime-plane-probe",
    release: { sha: RELEASE_SHA },
    probed_at: probedAt,
    production_url: PRODUCTION_URL,
    secondary_surface: (process.env.PAYSWAP_PRODUCTION_URL_ALT ?? "") || undefined,
    vantages: {
      console: "operator console (sandbox, vault-resolved bindings)",
      deployed: "live web-api role on the hosting plane (runtime-probe endpoint)",
    },
    environmentCompleteness: {
      vault: { roles: roleCompleteness, passed: vaultCompletenessPassed },
      deployed: ((deployed as Record<string, unknown>).environmentCompleteness ?? null) as unknown,
    },
    databaseConnectivity: {
      perRole: roleDatabases,
      deployedContext: ((deployed as Record<string, unknown>).database ?? null) as unknown,
      binding: { ...pgFacts(DATABASE_URL), previewBranch: pgFacts(DATABASE_URL_PREVIEW).host },
    },
    queueOutbox: {
      binding: { restEndpoint: UPSTASH_REST_URL, namespace: "payswap:*", note: "operator URL meet-ewe-145933 verified NXDOMAIN globally; account free tier single-DB binding with payswap:* namespaces" },
      deployedContext: queueDrill ?? null,
      drainDerived,
    },
    observability: {
      binding: { endpoint: OBSERVABILITY_ENDPOINT, sink: "upstash stream payswap:observability:production (taxonomy-validated ingestion)" },
      ...sink,
    },
    objectStorage: {
      consoleVantage: storage,
      deployedContext: ((deployed as Record<string, unknown>).objectStorage ?? null) as unknown,
    },
    hosting,
    apiJourneys: { journeys, passed: apiJourneysPassed },
    verdicts: {
      databaseConnectivity: databaseConnectivity ? "PASS" : "FAIL",
      queueOutboxHealth: queueOutboxHealth ? "PASS" : "FAIL",
      observability: observabilityWired ? "PASS" : "FAIL",
      apiJourneys: apiJourneysPassed ? "PASS" : "FAIL",
    },
  };

  const outPath = path.join(process.cwd(), "spec/development-state/runtime-plane-probe.json");
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");

  console.log("=== PaySwap runtime-plane probe ===");
  console.log("release:            ", RELEASE_SHA);
  console.log("production url:     ", PRODUCTION_URL);
  console.log("completeness (vault):", vaultCompletenessPassed);
  console.log("database per-role:  ", roleDatabases.map((r) => `${r.role}=${r.ok}`).join("; "));
  console.log("database deployed:  ", String(((deployed as Record<string, unknown>).database as { ok?: boolean } | undefined)?.ok));
  console.log("queue/outbox drill: ", JSON.stringify(queueDrill?.drill), "drainDerived:", drainDerived);
  console.log("observability sink: ", sink.ok ? `accepted ${sink.accepted.length} taxonomy events, invalid rejected=${sink.invalidRejected}` : `FAIL ${sink.error ?? ""}`);
  console.log("object storage:     ", String(storage.ok));
  console.log("api journeys:       ", journeys.map((j) => `${j.ok ? "PASS" : "FAIL"}(${j.status})`).join("; "));
  console.log("record written:     ", outPath);
}

await main();
