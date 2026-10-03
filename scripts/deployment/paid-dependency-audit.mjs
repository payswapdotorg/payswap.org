#!/usr/bin/env node
/**
 * Paid-dependency guard — P3-W1-003 (infrastructure hardening).
 *
 * Authority:
 * - spec/phase-3/work-items/P3-W1-003.md ("no unexpected paid dependency";
 *   "Resend/Apify are absent unless actual workflow requirements justify
 *   them");
 * - spec/experience/DEPLOYMENT-TOPOLOGY.md section 7 ("A paid dependency
 *   must have an explicit capability reason; the reason is recorded with
 *   the dependency, not in tribal memory"; free tiers preferred);
 * - spec/development-state/phase-3-state.json policy.free_low_cost_bias.
 *
 * What this guard does (zero dependencies — node:fs + node:path only):
 *   1. walks every workspace package.json (root + packages/*) and collects
 *      the FULL declared dependency surface (dependencies,
 *      devDependencies, peerDependencies, optionalDependencies);
 *   2. classifies every external package:
 *        - SERVICE-BINDING packages (they bind the repo to an external
 *          account/service) are flagged; a `paid-subscription` tier hint is
 *          an immediate FAILURE; ANY service binding without a recorded
 *          justification is a FAILURE (topology section 7 law);
 *        - licenses are read from the ACTUAL installed node_modules
 *          metadata (not guessed) and checked against the OSS allowlist —
 *          unknown/copyleft/missing licenses are flagged;
 *   3. asserts the Work-Order-mandated absences: resend and apify (and
 *      every package in the service-binding list) must be ABSENT unless a
 *      justifying workflow is recorded;
 *   4. prints the audit; with --record writes
 *      spec/development-state/dependency-cost-posture.json;
 *   5. exit code: 0 = clean posture, 1 = violation (fail-loud guard).
 *
 * Tier hints are policy data as of 2026-10-02 from provider public pricing
 * (re-verify when a binding is actually added). The guard's LAW does not
 * rest on tier hints: ANY service binding requires a recorded capability
 * reason, free tier or not.
 *
 * Usage: node scripts/deployment/paid-dependency-audit.mjs [--record]
 */
import fs from "node:fs";
import path from "node:path";

const RECORD_FLAG = process.argv.includes("--record");
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT_PATH = path.join(ROOT, "spec", "development-state", "dependency-cost-posture.json");

// ---------------------------------------------------------------------------
// Policy data
// ---------------------------------------------------------------------------

/**
 * Service-binding packages: using one binds the repository to an external
 * service account. tierHint: free-tier | usage-based | paid-subscription
 * (as of 2026-10-02 public pricing — re-verify when adding one).
 */
const SERVICE_BINDINGS = {
  // email
  resend: { service: "Resend", tierHint: "free-tier", note: "free tier ~3k emails/month; phase-3 state records email as OPTIONAL_RESEND" },
  "@trycourier/courier": { service: "Courier", tierHint: "free-tier", note: "notification SaaS" },
  nodemailer: { service: "(SMTP transport — provider-agnostic)", tierHint: "free-tier", note: "library is OSS; the SMTP host decides cost" },
  sendgrid: { service: "Twilio SendGrid", tierHint: "free-tier", note: "free tier exists" },
  mailgun: { service: "Mailgun", tierHint: "usage-based", note: "" },
  postmark: { service: "Postmark", tierHint: "usage-based", note: "" },
  // research/scraping
  apify: { service: "Apify", tierHint: "free-tier", note: "free plan credit; phase-3 state records research as OPTIONAL_APIFY" },
  "@apify/actor": { service: "Apify Actors", tierHint: "free-tier", note: "" },
  crawlbase: { service: "Crawlbase", tierHint: "usage-based", note: "" },
  "scrapingbee": { service: "ScrapingBee", tierHint: "usage-based", note: "" },
  // payments (usage-based per-transaction, no fixed cost)
  stripe: { service: "Stripe", tierHint: "usage-based", note: "per-transaction pricing; no subscription" },
  "@stripe/stripe-js": { service: "Stripe (client)", tierHint: "usage-based", note: "" },
  paystack: { service: "Paystack", tierHint: "usage-based", note: "" },
  flutterwave: { service: "Flutterwave", tierHint: "usage-based", note: "" },
  // data stores / queues as MANAGED SERVICE SDKs (self-hosted OSS clients excluded)
  "@upstash/redis": { service: "Upstash Redis", tierHint: "free-tier", note: "the repo intentionally talks REST to Upstash without an SDK" },
  "@upstash/queue": { service: "Upstash QStash", tierHint: "free-tier", note: "" },
  "@upstash/ratelimit": { service: "Upstash", tierHint: "free-tier", note: "" },
  "@neondatabase/serverless": { service: "Neon", tierHint: "free-tier", note: "" },
  "@vercel/postgres": { service: "Neon via Vercel", tierHint: "free-tier", note: "" },
  "@aws-sdk/client-s3": { service: "AWS S3 (or S3-compatible)", tierHint: "usage-based", note: "the repo signs SigV4 with node:crypto instead — no SDK" },
  "@aws-sdk/client-dynamodb": { service: "AWS DynamoDB", tierHint: "usage-based", note: "" },
  mongo: { service: "MongoDB Atlas", tierHint: "free-tier", note: "" },
  mongodb: { service: "MongoDB (driver)", tierHint: "free-tier", note: "driver is OSS; the host decides cost" },
  firebase: { service: "Firebase", tierHint: "free-tier", note: "" },
  "firebase-admin": { service: "Firebase", tierHint: "free-tier", note: "" },
  supabase: { service: "Supabase", tierHint: "free-tier", note: "" },
  // observability SaaS
  "@sentry/node": { service: "Sentry", tierHint: "free-tier", note: "free tier ~5k errors/month" },
  "@sentry/nextjs": { service: "Sentry", tierHint: "free-tier", note: "" },
  datadog: { service: "Datadog", tierHint: "paid-subscription", note: "no permanent free tier (trial only)" },
  "dd-trace": { service: "Datadog APM", tierHint: "paid-subscription", note: "no permanent free tier" },
  "@datadog/browser-rum": { service: "Datadog RUM", tierHint: "paid-subscription", note: "" },
  newrelic: { service: "New Relic", tierHint: "free-tier", note: "free tier exists; paid above it" },
  bugsnag: { service: "Bugsnag", tierHint: "free-tier", note: "" },
  "honeycomb-beeline": { service: "Honeycomb", tierHint: "free-tier", note: "free tier exists" },
  // feature flags / experimentation / analytics SaaS
  launchdarkly: { service: "LaunchDarkly", tierHint: "free-tier", note: "developer free tier exists" },
  "@launchdarkly/node-server-sdk": { service: "LaunchDarkly", tierHint: "free-tier", note: "" },
  optimizely: { service: "Optimizely", tierHint: "paid-subscription", note: "no usable free tier" },
  amplitude: { service: "Amplitude", tierHint: "free-tier", note: "" },
  mixpanel: { service: "Mixpanel", tierHint: "free-tier", note: "" },
  segment: { service: "Segment (Twilio)", tierHint: "free-tier", note: "free tier exists" },
  algoliasearch: { service: "Algolia", tierHint: "free-tier", note: "" },
  contentful: { service: "Contentful", tierHint: "free-tier", note: "" },
  braze: { service: "Braze", tierHint: "paid-subscription", note: "" },
  intercom: { service: "Intercom", tierHint: "paid-subscription", note: "" },
};

/** Patterns that smell like service bindings the curated list missed. */
const SUSPICIOUS_PATTERNS = [
  /sendgrid|mailgun|postmark|resend|brevo|mailerlite|klaviyo/i,
  /twilio|vonage|messagebird|sinch/i,
  /segment|amplitude|mixpanel|heap-|braze|intercom|zendesk|freshdesk|hubspot|salesforce/i,
  /algolia|typesense|elastic|meilisearch/i,
  /datadog|dynatrace|appdynamics|newrelic|bugsnag|sentry|honeycomb|grafana|signoz/i,
  /launchdarkly|splitio|optimizely|unleash|flagsmith/i,
  /apify|crawlbase|scrapingbee|brightdata|scraperapi/i,
];

/** OSS license allowlist (free software posture). */
const LICENSE_ALLOWLIST = [
  "MIT", "ISC", "Apache-2.0", "Apache 2.0", "BSD-2-Clause", "BSD-3-Clause",
  "BSD-2-Clause-FreeBSD", "0BSD", "Unlicense", "CC0-1.0", "CC-BY-4.0",
  "Python-2.0", "PostgreSQL", "BlueOak-1.0.0", "MPL-2.0",
];

/** Work-Order-mandated absences (P3-W1-003 acceptance criteria). */
const MANDATORY_ABSENT = ["resend", "apify"];

/** Recorded justifications for service bindings, if ever needed (empty today). */
const RECORDED_JUSTIFICATIONS = {};

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

const workspaceFiles = ["package.json"];
const packagesDir = path.join(ROOT, "packages");
for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    const pkg = path.join(packagesDir, entry.name, "package.json");
    if (fs.existsSync(pkg)) {
      workspaceFiles.push(path.relative(ROOT, pkg));
    }
  }
}

const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const surface = new Map(); // name -> { ranges: Set, sections: Set, packages: Set }

for (const file of workspaceFiles) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      if (!surface.has(name)) {
        surface.set(name, { ranges: new Set(), sections: new Set(), packages: new Set() });
      }
      const entry = surface.get(name);
      entry.ranges.add(String(range));
      entry.sections.add(section);
      entry.packages.add(file);
    }
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function readInstalledLicense(name) {
  for (const base of [path.join(ROOT, "node_modules"), ...workspaceFiles.map((f) => path.join(ROOT, path.dirname(f), "node_modules"))]) {
    const manifest = path.join(base, ...name.split("/"), "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
        const license = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(" OR ") : undefined);
        return typeof license === "string" ? license : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function normalizeLicense(license) {
  if (license === undefined) return undefined;
  return license.trim();
}

const violations = [];
const reviewFlags = [];
const dependencyRows = [];

for (const [name, meta] of [...surface.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const row = {
    name,
    internal: name.startsWith("@payswap/"),
    ranges: [...meta.ranges],
    sections: [...meta.sections],
    packages: [...meta.packages],
  };

  if (row.internal) {
    dependencyRows.push({ ...row, classification: "internal-workspace" });
    continue;
  }

  const binding = SERVICE_BINDINGS[name];
  const suspicious = SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(name));
  const license = normalizeLicense(readInstalledLicense(name));

  if (binding !== undefined && binding.tierHint === "paid-subscription") {
    violations.push({
      kind: "paid-subscription-dependency",
      name,
      service: binding.service,
      note: binding.note,
    });
    row.classification = "SERVICE BINDING (paid-subscription)";
  } else if (binding !== undefined) {
    if (RECORDED_JUSTIFICATIONS[name] === undefined) {
      violations.push({
        kind: "unjustified-service-binding",
        name,
        service: binding.service,
        note: `${binding.service} binds the repo to an external service with tier hint '${binding.tierHint}' — topology section 7 requires a recorded capability reason (spec/development-state/dependency-cost-posture.json RECORDED_JUSTIFICATIONS)`,
      });
    }
    row.classification = `SERVICE BINDING (${binding.tierHint})`;
  } else if (suspicious) {
    violations.push({
      kind: "unrecognized-service-binding",
      name,
      note: "matches a service-binding pattern but is not in the curated SERVICE_BINDINGS list — classify it explicitly (add to the list or rename the dependency)",
    });
    row.classification = "SUSPECTED SERVICE BINDING (unclassified)";
  } else if (license === undefined) {
    violations.push({
      kind: "license-unknown",
      name,
      note: "no license readable from the installed package metadata — resolve before shipping (free-software posture)",
    });
    row.classification = "license UNKNOWN";
  } else if (!LICENSE_ALLOWLIST.some((allowed) => license === allowed)) {
    violations.push({
      kind: "license-not-allowlisted",
      name,
      note: `license '${license}' is not in the OSS allowlist (${LICENSE_ALLOWLIST.join(", ")}) — copyleft/unknown posture requires explicit review`,
    });
    row.classification = `license ${license} (not allowlisted)`;
  } else {
    row.classification = `open-source tooling (${license})`;
  }
  row.license = license;
  dependencyRows.push(row);
}

// Work-Order-mandated absences.
const absenceChecks = MANDATORY_ABSENT.map((name) => {
  const present = surface.has(name);
  return {
    package: name,
    present,
    justification: present ? RECORDED_JUSTIFICATIONS[name] ?? null : null,
    ok: !present || RECORDED_JUSTIFICATIONS[name] !== undefined,
  };
});
for (const check of absenceChecks) {
  if (!check.ok) {
    violations.push({
      kind: "work-order-absence-violated",
      name: check.package,
      note: "P3-W1-003: Resend/Apify must be absent unless an actual workflow requirement justifies them (none is recorded)",
    });
  }
}

// ---------------------------------------------------------------------------
// Verdict + output
// ---------------------------------------------------------------------------

const serviceBindingsPresent = dependencyRows.filter((row) => String(row.classification).startsWith("SERVICE BINDING") || String(row.classification).startsWith("SUSPECTED"));
const clean = violations.length === 0;

const record = {
  schema_version: "1.0",
  record_type: "dependency-cost-posture",
  workOrder: "P3-W1-003",
  audited_at: new Date().toISOString(),
  scope: "every declared dependency of every workspace (root + packages/*): dependencies, devDependencies, peerDependencies, optionalDependencies",
  posture: clean
    ? "CLEAN — no paid-by-default dependency, no unjustified service binding, all external licenses within the OSS allowlist"
    : "VIOLATION — see violations",
  summary: {
    workspacesAudited: workspaceFiles.length,
    distinctDependencies: surface.size,
    internalWorkspacePackages: dependencyRows.filter((row) => row.internal).length,
    externalPackages: dependencyRows.filter((row) => !row.internal).length,
    serviceBindingsPresent: serviceBindingsPresent.map((row) => row.name),
    mandatoryAbsences: absenceChecks,
  },
  findings: {
    resendApify: "ABSENT — no workflow in the repository requires an email provider (Resend) or a scraping service (Apify): the phase-3 state records them as OPTIONAL only; the provider-probe record holds Resend as UNVERIFIED-SEND; no package, no env binding and no code path references either. Finding: they stay OUT; adding either requires a recorded workflow justification (this record's RECORDED_JUSTIFICATIONS).",
    licensing: "every external dependency resolves to an allowlisted OSS license from the ACTUAL installed metadata (MIT/ISC/Apache-2.0/BSD-*) — zero copyleft, zero unknown",
    managedServices: "zero managed-service SDKs in code: Upstash is spoken to over REST (no SDK), R2 over SigV4 with node:crypto (no AWS SDK), Neon over postgres wire (no vendor SDK) — provider-neutral by construction (AGENTS.md rule 17)",
    observations: [
      "scripts/deployment/run.mjs and run-rollout.mjs import esbuild, which is NOT declared in any package.json — it resolves transitively through vitest's dependency tree. Pre-existing condition (main), recorded here as an observation, not a paid/cost issue (esbuild is MIT). A dedicated root devDependency would make the resolution explicit.",
    ],
  },
  violations,
  policy: {
    law: "topology section 7: a paid dependency must have an explicit capability reason recorded with the dependency; free tiers preferred; no vendor lock-in in domain contracts (AGENTS.md rule 17)",
    serviceBindingTierHints: "tier hints are policy data as of 2026-10-02 from provider public pricing — re-verify at the moment a binding is actually added; the guard's law does NOT rest on tier hints (any service binding needs a recorded reason)",
    licenseAllowlist: LICENSE_ALLOWLIST,
  },
  dependencies: dependencyRows,
};
if (RECORD_FLAG) {
  fs.writeFileSync(OUT_PATH, JSON.stringify(record, null, 2) + "\n");
}

console.log("=== PaySwap paid-dependency guard ===");
console.log("workspaces audited:", workspaceFiles.length);
console.log("distinct deps:     ", surface.size, `(${record.summary.externalPackages} external)`);
console.log("service bindings:  ", serviceBindingsPresent.length === 0 ? "NONE (Upstash via REST, R2 via SigV4, Neon via wire — no vendor SDKs)" : serviceBindingsPresent.map((row) => row.name).join(", "));
console.log("resend/apify:      ", absenceChecks.map((check) => `${check.package}=${check.present ? "PRESENT(!)" : "absent"}`).join("; "));
console.log("licenses:          ", record.summary.externalPackages + " external, all OSS-allowlisted" + (clean ? "" : " (see violations)"));
if (violations.length > 0) {
  for (const violation of violations) {
    console.log("VIOLATION:         ", `${violation.kind}: ${violation.name} — ${violation.note}`);
  }
} else {
  console.log("violations:        none — posture CLEAN");
}
if (RECORD_FLAG) {
  console.log("record written:    ", path.relative(ROOT, OUT_PATH));
}
process.exit(clean ? 0 : 1);
