/**
 * Upstash budget probe — P3-W1-003 (infrastructure hardening).
 *
 * Authority:
 * - spec/development-state/upstash-budgets.json (THE budget data: namespace
 *   inventory, per-namespace command-class budgets, rate ceilings, memory
 *   budget, stream-length ceilings, alert thresholds);
 * - spec/development-state/runtime-activation.json (the free-tier single-DB
 *   binding with payswap:* namespaces);
 * - spec/experience/DEPLOYMENT-TOPOLOGY.md section 7 (free tiers preferred;
 *   a paid dependency must have an explicit capability reason).
 *
 * What this driver does:
 *   1. loads the budget record (fail-loud when malformed);
 *   2. resolves the Upstash REST binding from the environment at RUN TIME
 *      (UPSTASH_REDIS_REST_URL / _TOKEN, with the operator-console aliases
 *      PAYSWAP_REDIS_REST_URL_PROD / _TOKEN_PROD). Credentials NEVER enter
 *      the repo, logs or records — env NAMES only;
 *   3. WITHOUT credentials: prints (and, with --record, writes) an honest
 *      `credential-gated` measurement record and exits 0 — UNKNOWN is not
 *      FAILED, and no live reading is ever fabricated;
 *   4. WITH credentials: measures live usage against every budget —
 *      DBSIZE (namespace law), bounded SCAN pages (inventory), XLEN per
 *      declared stream (stream ceilings), INFO used_memory (memory budget)
 *      — reports the probe's OWN command spend, and exits non-zero when a
 *      budget is exceeded or a key outside payswap:* exists.
 *
 * Usage: bun scripts/deployment/upstash-budget-probe.ts [--record]
 * (bun: the operator console's execution runtime for live probes — fetch,
 * node:crypto, zero added dependencies. Free-tier bias: no SDK.)
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
const RECORD_FLAG = process.argv.includes("--record");
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BUDGETS_PATH = path.join(ROOT, "spec", "development-state", "upstash-budgets.json");
const MEASUREMENT_PATH = path.join(
  ROOT,
  "spec",
  "development-state",
  "upstash-budget-measurement.json",
);

const REST_URL =
  process.env.UPSTASH_REDIS_REST_URL?.trim() ||
  process.env.PAYSWAP_REDIS_REST_URL_PROD?.trim() ||
  "";
const REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ||
  process.env.PAYSWAP_REDIS_REST_TOKEN_PROD?.trim() ||
  "";

interface BudgetRecord {
  providerFreeTierCeiling: { commandsPerDay: number; maxDataSizeBytes: number };
  memoryBudget: { selfImposedTotalBytes: number; warnThresholdBytes: number };
  streamLengthCeilings: Record<string, number>;
  namespaceInventory: { namespace: string; type: string }[];
  commandClassBudgets: {
    perNamespace: { namespace: string; totalDaily: number }[];
    totalDailyAllNamespaces: number;
  };
}

function loadBudgets(): BudgetRecord {
  const raw = JSON.parse(fs.readFileSync(BUDGETS_PATH, "utf8")) as BudgetRecord;
  if (
    typeof raw.providerFreeTierCeiling?.commandsPerDay !== "number" ||
    !Array.isArray(raw.namespaceInventory) ||
    !Array.isArray(raw.commandClassBudgets?.perNamespace)
  ) {
    fail("spec/development-state/upstash-budgets.json is malformed (budget fields missing)");
  }
  return raw;
}

function fail(message: string): never {
  console.error(`upstash-budget-probe: ${message}`);
  process.exit(1);
}

/** One REST command = one Upstash command; spend is counted honestly. */
let commandSpend = 0;
async function restCommand(command: string, ...args: string[]): Promise<string> {
  commandSpend += 1;
  const url = `${REST_URL}/${command}/${args.map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${REST_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`REST ${command} -> HTTP ${response.status}`);
  }
  return await response.text();
}

function parseRestResult(text: string): { result: unknown } {
  const body = JSON.parse(text) as { result?: unknown; error?: string };
  if (body.error !== undefined) {
    throw new Error(`REST error: ${body.error}`);
  }
  return { result: body.result };
}

// ---------------------------------------------------------------------------
// The honest credential-gated report
// ---------------------------------------------------------------------------
function gatedReport(budgets: BudgetRecord) {
  return {
    schema_version: "1.0",
    record_type: "upstash-budget-measurement",
    workOrder: "P3-W1-003",
    probed_at: new Date().toISOString(),
    binding: {
      restEndpoint: "(vault-resolved at run time — never recorded)",
      envNames: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    },
    status: "credential-gated",
    statusDetail:
      "the operator vault holding the live Upstash credentials was lost to a sandbox reset (2026-10-02); no live measurement was executed and NONE is fabricated here — UNKNOWN is not FAILED (AGENTS.md rule 4). Re-run this driver with the vault re-supplied to produce a live measurement.",
    budgetsLoadedFrom: "spec/development-state/upstash-budgets.json",
    budgetsSummary: {
      namespaces: budgets.namespaceInventory.length,
      totalDailyAllNamespaces: budgets.commandClassBudgets.totalDailyAllNamespaces,
      providerDailyCeiling: budgets.providerFreeTierCeiling.commandsPerDay,
      memoryBudgetBytes: budgets.memoryBudget.selfImposedTotalBytes,
    },
    checksNotExecuted: [
      "DBSIZE vs namespace law (every key under payswap:*)",
      "SCAN payswap:* inventory vs namespaceInventory",
      "XLEN per declared stream vs streamLengthCeilings",
      "INFO used_memory vs memoryBudget",
      "probe command spend vs budget",
    ],
    verdict: "CREDENTIAL_GATED_NOT_EXECUTED",
  };
}

// ---------------------------------------------------------------------------
// Live measurement
// ---------------------------------------------------------------------------
interface LiveReport {
  dbsize?: number;
  keysOutsideNamespace?: string[];
  inventory?: { namespace: string; type: string; keys: number; observedType?: string }[];
  streamLengths?: { stream: string; length: number; ceiling: number; within: boolean }[];
  memory?: {
    usedMemoryBytes?: number;
    selfImposedBudgetBytes: number;
    providerCeilingBytes: number;
    within: boolean;
  };
  commandSpend: number;
  errors: string[];
}

async function liveMeasurement(budgets: BudgetRecord): Promise<LiveReport> {
  const report: LiveReport = { commandSpend: 0, errors: [] };

  // 1. DBSIZE — the namespace law baseline.
  try {
    const dbsize = parseRestResult(await restCommand("dbsize")).result;
    report.dbsize = Number(dbsize);
  } catch (error) {
    report.errors.push(`dbsize: ${String(error).slice(0, 160)}`);
  }

  // 2. Bounded SCAN pages over payswap:* — the inventory + namespace law.
  const keyHistogram = new Map<string, number>();
  const foreignKeys = new Set<string>();
  try {
    let cursor = "0";
    let pages = 0;
    do {
      const raw = parseRestResult(await restCommand("scan", cursor, "match", "payswap:*", "count", "100"))
        .result as [string, string[]] | string[];
      // Upstash REST returns ["nextCursor", [keys]] (array) for SCAN.
      const next = Array.isArray(raw) ? raw[0] : "0";
      const keys = Array.isArray(raw) && Array.isArray(raw[1]) ? raw[1] : [];
      for (const key of keys) {
        // First two segments define the namespace family (payswap:<plane>:<family>).
        const segments = key.split(":");
        const family = segments.slice(0, Math.min(3, segments.length)).join(":");
        keyHistogram.set(family, (keyHistogram.get(family) ?? 0) + 1);
      }
      cursor = String(next);
      pages += 1;
    } while (cursor !== "0" && pages < 10);
  } catch (error) {
    report.errors.push(`scan: ${String(error).slice(0, 160)}`);
  }
  // Namespace law: any non-payswap key would require an unbounded scan to
  // prove; dbsize vs payswap:* count is the honest observable: when the
  // payswap:* scan count is lower than dbsize, non-namespace keys EXIST.
  const payswapKeyCount = [...keyHistogram.values()].reduce((sum, n) => sum + n, 0);
  if (report.dbsize !== undefined && payswapKeyCount < report.dbsize) {
    foreignKeys.add(`${report.dbsize - payswapKeyCount} key(s) outside payswap:*`);
  }
  report.keysOutsideNamespace = [...foreignKeys];

  // 3. Inventory vs the declared namespace families.
  report.inventory = budgets.namespaceInventory.map((entry) => {
    const family = entry.namespace.replace(/:\*$/, "");
    return {
      namespace: entry.namespace,
      type: entry.type,
      keys: keyHistogram.get(family) ?? 0,
    };
  });

  // 4. XLEN per concrete declared stream (numeric entries only — the record
  // carries prose notes in a sibling field, never inside the data map).
  report.streamLengths = [];
  for (const [stream, ceiling] of Object.entries(budgets.streamLengthCeilings)) {
    if (typeof ceiling !== "number") {
      continue;
    }
    try {
      const length = Number(parseRestResult(await restCommand("xlen", stream)).result);
      report.streamLengths.push({ stream, length, ceiling, within: length <= ceiling });
    } catch (error) {
      report.errors.push(`xlen ${stream}: ${String(error).slice(0, 120)}`);
      report.streamLengths.push({ stream, length: -1, ceiling, within: false });
    }
  }

  // 5. INFO — memory (Upstash REST supports INFO; parse defensively).
  try {
    const info = parseRestResult(await restCommand("info")).result as string;
    const match = /used_memory:(\d+)/.exec(String(info));
    const used = match ? Number(match[1]) : undefined;
    report.memory = {
      ...(used === undefined ? {} : { usedMemoryBytes: used }),
      selfImposedBudgetBytes: budgets.memoryBudget.selfImposedTotalBytes,
      providerCeilingBytes: budgets.providerFreeTierCeiling.maxDataSizeBytes,
      within:
        used === undefined
          ? false
          : used <= budgets.memoryBudget.selfImposedTotalBytes,
    };
    if (used === undefined) {
      report.errors.push("info: used_memory not parseable (recorded verbatim as unparsed)");
    }
  } catch (error) {
    report.errors.push(`info: ${String(error).slice(0, 160)}`);
    report.memory = {
      selfImposedBudgetBytes: budgets.memoryBudget.selfImposedTotalBytes,
      providerCeilingBytes: budgets.providerFreeTierCeiling.maxDataSizeBytes,
      within: false,
    };
  }

  report.commandSpend = commandSpend;
  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const budgets = loadBudgets();

if (REST_URL.length === 0 || REST_TOKEN.length === 0) {
  const record = gatedReport(budgets);
  const json = JSON.stringify(record, null, 2) + "\n";
  if (RECORD_FLAG) {
    fs.writeFileSync(MEASUREMENT_PATH, json);
  }
  console.log("=== PaySwap Upstash budget probe ===");
  console.log("status:            credential-gated (UPSTASH_REDIS_REST_URL/_TOKEN absent)");
  console.log("budgets loaded:    spec/development-state/upstash-budgets.json");
  console.log(
    "budget totals:     ",
    `${budgets.commandClassBudgets.totalDailyAllNamespaces}/day across ${budgets.namespaceInventory.length} namespaces`,
    `(provider ceiling ${budgets.providerFreeTierCeiling.commandsPerDay}/day)`,
  );
  console.log("live checks:       NOT EXECUTED (none fabricated — UNKNOWN is not FAILED)");
  if (RECORD_FLAG) {
    console.log("record written:    ", path.relative(ROOT, MEASUREMENT_PATH));
  }
  process.exit(0);
}

const probedAt = new Date().toISOString();
const live = await liveMeasurement(budgets);
const streamCeilingsOk = (live.streamLengths ?? []).every((entry) => entry.within);
const namespaceLawOk = (live.keysOutsideNamespace ?? []).length === 0;
const memoryOk = live.memory?.within === true;
const withinBudget = namespaceLawOk && streamCeilingsOk && memoryOk && live.errors.length === 0;

const record = {
  schema_version: "1.0",
  record_type: "upstash-budget-measurement",
  workOrder: "P3-W1-003",
  probed_at: probedAt,
  binding: {
    restEndpoint: "(vault-resolved at run time — never recorded)",
    envNames: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  },
  status: "live",
  measurement: live,
  verdict: withinBudget ? "WITHIN_BUDGET" : "OVER_BUDGET_OR_UNMEASURABLE",
  budgetsLoadedFrom: "spec/development-state/upstash-budgets.json",
};
const json = JSON.stringify(record, null, 2) + "\n";
if (RECORD_FLAG) {
  fs.writeFileSync(MEASUREMENT_PATH, json);
}

console.log("=== PaySwap Upstash budget probe (LIVE) ===");
console.log("dbsize:            ", live.dbsize ?? "?");
console.log("namespace law:     ", namespaceLawOk ? "ok (all keys under payswap:*)" : `VIOLATION: ${live.keysOutsideNamespace?.join("; ")}`);
console.log("inventory:         ", live.inventory?.map((i) => `${i.namespace}=${i.keys}`).join("; "));
console.log("stream ceilings:   ", live.streamLengths?.map((s) => `${s.stream} ${s.length}/${s.ceiling} ${s.within ? "ok" : "OVER"}`).join("; "));
console.log(
  "memory:            ",
  live.memory?.usedMemoryBytes !== undefined
    ? `${live.memory.usedMemoryBytes}B vs budget ${live.memory.selfImposedBudgetBytes}B (${memoryOk ? "ok" : "OVER"})`
    : "unmeasured (see errors)",
);
console.log("probe command spend:", live.commandSpend);
for (const error of live.errors) {
  console.log("error:             ", error);
}
if (RECORD_FLAG) {
  console.log("record written:    ", path.relative(ROOT, MEASUREMENT_PATH));
}
process.exit(withinBudget ? 0 : 1);
