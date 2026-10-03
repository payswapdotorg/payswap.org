/**
 * Neon production/preview separation probe — P3-W1-003.
 *
 * Authority:
 * - spec/development-state/neon-separation.json (the separation
 *   REQUIREMENTS — this driver executes every one of them);
 * - spec/development-state/runtime-activation.json (Neon project 'payswap',
 *   branches main=production / preview=preview);
 * - spec/experience/DEPLOYMENT-TOPOLOGY.md section 2 (environments are
 *   explicit and checked) and section 3 (secrets are vault-backed, never
 *   committed — only *_REF names / env NAMES appear in artifacts).
 *
 * What this driver does:
 *   - WITHOUT the connection bindings: prints (and with --record writes) an
 *     honest credential-gated record and exits 0 — no fabricated readings.
 *   - WITH them (vault-resolved at run time, values never logged):
 *       1. parses both connection strings to host/user/database FACTS;
 *       2. asserts DISTINCT hosts (branch separation);
 *       3. connects PRODUCTION read-only (catalog probe: current_database,
 *          current_user, version) — production is NEVER written;
 *       4. marker-table round trip: create on PREVIEW -> observe on
 *          PREVIEW -> assert ABSENT on PRODUCTION -> drop on PREVIEW;
 *       5. cross-branch credential check: the PROD connection string
 *          pointed at the PREVIEW host MUST be rejected (role scoping);
 *          a successful cross-login is a separation VIOLATION;
 *       6. optionally lists branches via the Neon API when NEON_API_KEY is
 *          bound (honest: attempted only when present).
 *
 * Usage: bun scripts/deployment/neon-separation-probe.ts [--record]
 * (bun: native PostgreSQL client + fetch, zero added dependencies.)
 */

import fs from "node:fs";
import path from "node:path";

const RECORD_FLAG = process.argv.includes("--record");
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const VERIFICATION_PATH = path.join(
  ROOT,
  "spec",
  "development-state",
  "neon-separation-verification.json",
);

const PROD_URL = (process.env.PAYSWAP_DATABASE_URL_PROD ?? "").trim();
const PREVIEW_URL = (process.env.PAYSWAP_DATABASE_URL_PREVIEW ?? "").trim();
const NEON_API_KEY = (process.env.NEON_API_KEY ?? "").trim();
const NEON_PROJECT_ID = (process.env.NEON_PROJECT_ID ?? "").trim();

interface PgFacts {
  user: string;
  host: string;
  database: string;
}

/** Redact a connection string to its safe facts (the pgFacts pattern). */
function pgFacts(uri: string): PgFacts | null {
  const match = /postgres(?:ql)?:\/\/([^:]+):[^@]+@([^/?]+)\/(\w+)/.exec(uri);
  return match ? { user: match[1], host: match[2], database: match[3] } : null;
}

// Minimal typing over Bun's native SQL (same pattern as runtime-plane-probe;
// the instance itself is the parameterized template tag, and sql.unsafe()
// exists for statements that cannot be parameterized — table DDL. All
// unsafe() calls below use a CONSTANT validated table name: no interpolation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SQL = (globalThis as any).Bun.SQL as new (uri: string) => {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  unsafe: (query: string) => Promise<Record<string, unknown>[]>;
  end: () => Promise<void>;
};

interface CatalogProbe {
  ok: boolean;
  database?: string;
  user?: string;
  serverVersion?: string;
  latencyMs?: number;
  error?: string;
}

async function catalogProbe(uri: string): Promise<CatalogProbe> {
  const started = Date.now();
  try {
    const sql = new SQL(uri);
    const rows = await sql`select current_database() as d, current_user as u, version() as v`;
    await sql.end();
    const row = rows[0] as { d: string; u: string; v: string } | undefined;
    return {
      ok: true,
      database: row?.d,
      user: row?.u,
      serverVersion: String(row?.v ?? "").split(" ").slice(0, 2).join(" "),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// The honest credential-gated report
// ---------------------------------------------------------------------------
function gatedReport() {
  return {
    schema_version: "1.0",
    record_type: "neon-separation-verification",
    workOrder: "P3-W1-003",
    probed_at: new Date().toISOString(),
    binding: {
      connectionStrings: "(vault-resolved at run time — never recorded)",
      envNames: ["PAYSWAP_DATABASE_URL_PROD", "PAYSWAP_DATABASE_URL_PREVIEW"],
      neonApiEnvNames: ["NEON_API_KEY", "NEON_PROJECT_ID"],
    },
    status: "credential-gated",
    statusDetail:
      "the operator vault holding the live Neon connection strings was lost to a sandbox reset (2026-10-02); no live separation check was executed and NONE is fabricated here (UNKNOWN is not FAILED, AGENTS.md rule 4). The requirements this driver will execute are recorded in spec/development-state/neon-separation.json; the last live connectivity evidence is spec/development-state/runtime-plane-probe.json.",
    requirementsLoadedFrom: "spec/development-state/neon-separation.json",
    checksNotExecuted: [
      "distinct-host assertion (branch separation)",
      "PROD read-only catalog probe",
      "PREVIEW catalog probe + marker-table round trip (create -> observe -> assert absent on PROD -> drop)",
      "cross-branch credential rejection (role scoping)",
      "optional Neon API branch listing",
    ],
    verdict: "CREDENTIAL_GATED_NOT_EXECUTED",
  };
}

// ---------------------------------------------------------------------------
// Live separation verification
// ---------------------------------------------------------------------------
const MARKER_TABLE = "payswap_separation_probe";

function swapHost(uri: string, newHost: string): string {
  return uri.replace(/@([^/?]+)/, `@${newHost}`);
}

const errors: string[] = [];
const results: Record<string, unknown> = {};

if (PROD_URL.length === 0 || PREVIEW_URL.length === 0) {
  const record = gatedReport();
  if (RECORD_FLAG) {
    fs.writeFileSync(VERIFICATION_PATH, JSON.stringify(record, null, 2) + "\n");
  }
  console.log("=== PaySwap Neon separation probe ===");
  console.log("status:            credential-gated (PAYSWAP_DATABASE_URL_PROD/PREVIEW absent)");
  console.log("requirements:      spec/development-state/neon-separation.json (6 requirements)");
  console.log("live checks:       NOT EXECUTED (none fabricated — UNKNOWN is not FAILED)");
  if (RECORD_FLAG) {
    console.log("record written:    ", path.relative(ROOT, VERIFICATION_PATH));
  }
  process.exit(0);
}

const probedAt = new Date().toISOString();

// 1. Parse to facts (values never logged beyond these facts).
const prodFacts = pgFacts(PROD_URL);
const previewFacts = pgFacts(PREVIEW_URL);
if (prodFacts === null || previewFacts === null) {
  console.error("neon-separation-probe: a connection string did not parse as postgres:// (values are never printed)");
  process.exit(1);
}
results.bindingFacts = {
  production: prodFacts,
  preview: previewFacts,
  note: "facts only — connection-string values are vault-resolved and never recorded",
};

// 2. Branch separation: distinct hosts.
const distinctHosts = prodFacts.host !== previewFacts.host;
results.branchSeparation = {
  distinctHosts,
  productionHost: prodFacts.host,
  previewHost: previewFacts.host,
};
if (!distinctHosts) {
  errors.push("branch separation FAILED: production and preview resolve to the same host");
}

// 3. Catalog probes (production READ-ONLY).
const prodProbe = await catalogProbe(PROD_URL);
const previewProbe = await catalogProbe(PREVIEW_URL);
results.productionCatalog = prodProbe;
results.previewCatalog = previewProbe;
if (!prodProbe.ok) errors.push(`production catalog probe: ${prodProbe.error}`);
if (!previewProbe.ok) errors.push(`preview catalog probe: ${previewProbe.error}`);

// 4. Marker-table round trip (preview write, prod read-only absence proof).
// Table names cannot be query parameters; the constant MARKER_TABLE is
// validated against a strict identifier pattern before any unsafe() call.
if (!/^[a-z_][a-z0-9_]*$/.test(MARKER_TABLE)) {
  console.error("neon-separation-probe: internal marker table name failed identifier validation");
  process.exit(1);
}
let markerRoundTrip: Record<string, unknown> = { ok: false };
if (prodProbe.ok && previewProbe.ok) {
  let previewSql: InstanceType<typeof SQL> | null = null;
  try {
    previewSql = new SQL(PREVIEW_URL);
    await previewSql.unsafe(`create table if not exists ${MARKER_TABLE} (id int primary key, note text)`);
    await previewSql.unsafe(`insert into ${MARKER_TABLE} (id, note) values (1, 'separation probe') on conflict (id) do update set note = excluded.note`);
    const previewRows = await previewSql.unsafe(`select to_regclass('public.${MARKER_TABLE}') as t`);
    const previewSees = (previewRows[0] as { t: string | null } | undefined)?.t !== null;

    const prodSql = new SQL(PROD_URL);
    const prodRows = await prodSql.unsafe(`select to_regclass('public.${MARKER_TABLE}') as t`);
    await prodSql.end();
    const prodSees = (prodRows[0] as { t: string | null } | undefined)?.t !== null;

    markerRoundTrip = {
      ok: previewSees && !prodSees,
      previewSeesMarker: previewSees,
      productionSeesMarker: prodSees,
      productionMutated: false,
    };
    if (!previewSees) errors.push("marker table not observable on PREVIEW after creation");
    if (prodSees) errors.push("STATE SEPARATION VIOLATION: production observed the preview marker table");
  } catch (error) {
    errors.push(`marker round trip: ${String(error).slice(0, 200)}`);
  } finally {
    if (previewSql !== null) {
      try {
        await previewSql.unsafe(`drop table if exists ${MARKER_TABLE}`);
        markerRoundTrip = { ...markerRoundTrip, cleanedUp: true };
      } catch (error) {
        errors.push(`preview cleanup: ${String(error).slice(0, 160)}`);
        markerRoundTrip = { ...markerRoundTrip, cleanedUp: false };
      }
      try {
        await previewSql.end();
      } catch {
        /* best-effort */
      }
    }
  }
}
results.markerRoundTrip = markerRoundTrip;

// 5. Cross-branch credential rejection (role scoping): the PROD connection
//    string pointed at the PREVIEW host must be REJECTED BY AUTHENTICATION.
//    A transport failure is NOT proof of scoping — it is classified
//    unmeasurable (UNKNOWN is not FAILED, and it is certainly not a pass).
const AUTH_REJECTED_PATTERN = /authentication failed|password authentication|28P01|SASL|invalid password/i;
let crossBranch: { outcome: "rejected" | "authenticated" | "unmeasurable"; detail: string };
try {
  const swapped = swapHost(PROD_URL, previewFacts.host);
  const cross = await catalogProbe(swapped);
  if (cross.ok) {
    crossBranch = {
      outcome: "authenticated",
      detail:
        "SEPARATION VIOLATION: the production credential AUTHENTICATED against the preview host — roles are not branch-scoped",
    };
    errors.push("role scoping FAILED: cross-branch authentication succeeded");
  } else if (AUTH_REJECTED_PATTERN.test(cross.error ?? "")) {
    crossBranch = {
      outcome: "rejected",
      detail: `the production credential was REJECTED by authentication against the preview host (role scoping holds): ${(cross.error ?? "").slice(0, 80)}`,
    };
  } else {
    crossBranch = {
      outcome: "unmeasurable",
      detail: `transport-level failure (not an authentication verdict — role scoping stays UNKNOWN, never guessed): ${(cross.error ?? "").slice(0, 120)}`,
    };
  }
} catch (error) {
  crossBranch = {
    outcome: "unmeasurable",
    detail: `transport-level failure: ${String(error).slice(0, 120)}`,
  };
}
const crossBranchRejected = crossBranch.outcome === "rejected";
results.crossBranchCredential = crossBranch;

// 6. Optional Neon API branch listing.
if (NEON_API_KEY.length > 0 && NEON_PROJECT_ID.length > 0) {
  try {
    const response = await fetch(`https://api.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches`, {
      headers: { authorization: `Bearer ${NEON_API_KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const body = (await response.json()) as { branches?: { id: string; name: string; primary?: boolean }[] };
      results.neonApiBranches = (body.branches ?? []).map((branch) => ({
        id: branch.id.slice(0, 8),
        name: branch.name,
        primary: branch.primary === true,
      }));
    } else {
      results.neonApiBranches = { error: `HTTP ${response.status} (recorded verbatim)` };
    }
  } catch (error) {
    results.neonApiBranches = { error: String(error).slice(0, 160) };
  }
} else {
  results.neonApiBranches = { status: "not-attempted (NEON_API_KEY/NEON_PROJECT_ID not bound — optional check)" };
}

const verdictOk = errors.length === 0 && distinctHosts && markerRoundTrip.ok === true && crossBranchRejected;

const record = {
  schema_version: "1.0",
  record_type: "neon-separation-verification",
  workOrder: "P3-W1-003",
  probed_at: probedAt,
  binding: {
    connectionStrings: "(vault-resolved at run time — never recorded)",
    envNames: ["PAYSWAP_DATABASE_URL_PROD", "PAYSWAP_DATABASE_URL_PREVIEW"],
    neonApiEnvNames: ["NEON_API_KEY", "NEON_PROJECT_ID"],
  },
  status: "live",
  ...results,
  errors,
  verdict: verdictOk ? "SEPARATION_VERIFIED" : "SEPARATION_VIOLATION_OR_UNMEASURABLE",
  requirementsLoadedFrom: "spec/development-state/neon-separation.json",
};
if (RECORD_FLAG) {
  fs.writeFileSync(VERIFICATION_PATH, JSON.stringify(record, null, 2) + "\n");
}

console.log("=== PaySwap Neon separation probe (LIVE) ===");
console.log("branch separation: ", distinctHosts ? `ok (${prodFacts.host} != ${previewFacts.host})` : "FAILED (same host)");
console.log("production catalog:", prodProbe.ok ? `${prodProbe.database}@${prodProbe.user} ${prodProbe.serverVersion} (${prodProbe.latencyMs}ms)` : `FAIL ${prodProbe.error}`);
console.log("preview catalog:   ", previewProbe.ok ? `${previewProbe.database}@${previewProbe.user} ${previewProbe.serverVersion} (${previewProbe.latencyMs}ms)` : `FAIL ${previewProbe.error}`);
console.log("marker round trip: ", markerRoundTrip.ok === true ? "ok (preview sees marker, production does NOT; preview cleaned up)" : "FAILED (see errors)");
console.log(
  "cross-credential:  ",
  crossBranch.outcome === "rejected"
    ? "ok (prod credential REJECTED by auth on preview host — roles are branch-scoped)"
    : crossBranch.outcome === "authenticated"
      ? "VIOLATION (cross-branch auth succeeded)"
      : "UNMEASURABLE (transport failure — role scoping stays UNKNOWN, never guessed)",
);
for (const error of errors) {
  console.log("error:             ", error);
}
if (RECORD_FLAG) {
  console.log("record written:    ", path.relative(ROOT, VERIFICATION_PATH));
}
process.exit(verdictOk ? 0 : 1);
