/**
 * @payswap/operations — deployment planning and parity verification (W3-007).
 *
 * Authority: spec/experience/DEPLOYMENT-TOPOLOGY.md (the configuration and
 * gate contract) + spec/architecture/FRONTEND-UX-DEPLOYMENT.md ("Deployment
 * gates"). This module is DETERMINISTIC DATA + CONTRACTS + CHECKERS:
 *
 * - the ENVIRONMENT MODEL is the six deployable worker roles of the modular
 *   monolith (§1) across local/preview/staging/production (§2);
 * - the CONFIGURATION CONTRACT is §3.1 verbatim: every environment variable,
 *   the roles that consume it, and whether it is secret-backed (secrets are
 *   vault-resolved through `*_REF` names ONLY — never values in any config
 *   artifact; see secrets.ts);
 * - PREVIEW/PRODUCTION PARITY is a deterministic diff over two environment
 *   manifests: the service sets, versions and every non-environment-specific
 *   config key must match — differences are allowed ONLY on the explicit
 *   allowlist (endpoints/credentials/observability sinks), because
 *   "environment differences are explicit and checked";
 * - the DEPLOYMENT PLAN is an ORDERED, migration-compatible sequence
 *   (INV-O03): expansion migrations run BEFORE the code that reads them is
 *   deployed; contraction migrations may never ship in the same phase as
 *   the code that dropped the old column (two-phase deploy or rollback
 *   blocked); restore/replay reconstructs authoritative state (INV-O04);
 * - the DEPLOYMENT GATES checklist is §6 as data — every release checks all
 *   eleven gates.
 *
 * Deterministic only: pure functions; no network, no filesystem, no ambient
 * time. Fingerprints use the package-local canonical digest (digest.ts).
 */

import { contentDigest } from "./digest.js";

// ---------------------------------------------------------------------------
// Environments and service roles (DEPLOYMENT-TOPOLOGY §1–§2)
// ---------------------------------------------------------------------------

export const ENVIRONMENTS = ["local", "preview", "staging", "production"] as const;
export type EnvironmentName = (typeof ENVIRONMENTS)[number];

export function isEnvironmentName(value: unknown): value is EnvironmentName {
  return (
    typeof value === "string" &&
    (ENVIRONMENTS as readonly unknown[]).includes(value)
  );
}

/** The six deployable worker roles of the modular monolith (§1). */
export const SERVICE_ROLES = [
  "web-api",
  "protocol-worker",
  "rail-adapter-worker",
  "reconciliation-worker",
  "lab-worker",
  "notification-worker",
] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

export function isServiceRole(value: unknown): value is ServiceRole {
  return (
    typeof value === "string" &&
    (SERVICE_ROLES as readonly unknown[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Configuration contract (DEPLOYMENT-TOPOLOGY §3.1) — as checkable data
// ---------------------------------------------------------------------------

/** One environment variable of the configuration contract. */
export interface EnvironmentVariableRequirement {
  /** The variable name exactly as documented in §3.1. */
  readonly name: string;
  /** The worker roles that consume it. */
  readonly requiredBy: readonly ServiceRole[];
  /**
   * True when the variable is a vault-backed SECRET REFERENCE (`*_REF`)
   * resolved at runtime — never a committed value (see secrets.ts).
   */
  readonly secretBacked: boolean;
  readonly purpose: string;
}

/**
 * The configuration contract (§3.1), verbatim. Provider credential
 * references follow the `PROVIDER_<NAME>_CREDENTIAL_REF` template and are
 * declared per provider family in secrets.ts.
 */
export const CONFIGURATION_CONTRACT: readonly EnvironmentVariableRequirement[] =
  Object.freeze([
    {
      name: "DATABASE_URL",
      requiredBy: [...SERVICE_ROLES],
      secretBacked: true,
      purpose: "PostgreSQL system-of-record connection",
    },
    {
      name: "OBJECT_STORAGE_ENDPOINT",
      requiredBy: ["web-api", "protocol-worker", "notification-worker"],
      secretBacked: false,
      purpose: "Large/immutable evidence artifacts (R2-compatible)",
    },
    {
      name: "OBJECT_STORAGE_BUCKET",
      requiredBy: ["web-api", "protocol-worker", "notification-worker"],
      secretBacked: false,
      purpose: "Evidence artifact bucket",
    },
    {
      name: "OBJECT_STORAGE_REGION",
      requiredBy: ["web-api", "protocol-worker", "notification-worker"],
      secretBacked: false,
      purpose: "Evidence artifact region",
    },
    {
      name: "OBJECT_STORAGE_ACCESS_KEY_ID",
      requiredBy: ["web-api", "protocol-worker"],
      secretBacked: true,
      purpose: "Storage credential (vault-resolved)",
    },
    {
      name: "OBJECT_STORAGE_SECRET_ACCESS_KEY",
      requiredBy: ["web-api", "protocol-worker"],
      secretBacked: true,
      purpose: "Storage credential (vault-resolved)",
    },
    {
      name: "VAULT_REF",
      requiredBy: [...SERVICE_ROLES],
      secretBacked: true,
      purpose: "Vault/secret-store mount holding all secrets",
    },
    {
      name: "PROVIDER_CREDENTIAL_REF",
      requiredBy: ["rail-adapter-worker"],
      secretBacked: true,
      purpose: "Per-provider credential reference (PROVIDER_<NAME>_CREDENTIAL_REF template)",
    },
    {
      name: "WORKER_ROLE",
      requiredBy: [...SERVICE_ROLES],
      secretBacked: false,
      purpose: "Selects the worker role within the monolith",
    },
    {
      name: "QUEUE_URL",
      requiredBy: [
        "protocol-worker",
        "rail-adapter-worker",
        "reconciliation-worker",
        "lab-worker",
        "notification-worker",
      ],
      secretBacked: false,
      purpose: "Queue/bus connection for async work",
    },
    {
      name: "REDIS_URL",
      requiredBy: [
        "protocol-worker",
        "rail-adapter-worker",
        "reconciliation-worker",
        "lab-worker",
        "notification-worker",
      ],
      secretBacked: false,
      purpose: "Queue/bus connection for async work",
    },
    {
      name: "WEBHOOK_SIGNING_SECRET_REF",
      requiredBy: ["notification-worker"],
      secretBacked: true,
      purpose: "Resolves the X-PaySwap-Signature (v1) key",
    },
    {
      name: "API_VERSION",
      requiredBy: ["web-api"],
      secretBacked: false,
      purpose: "Value returned in X-PaySwap-API-Version",
    },
    {
      name: "OBSERVABILITY_ENDPOINT",
      requiredBy: [...SERVICE_ROLES],
      secretBacked: false,
      purpose: "Vendor-neutral metrics/logs/traces sink",
    },
  ]);

/** Deployment error taxonomy (checked failures, never silent). */
export class DeploymentContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentContractError";
  }
}

/** A migration violation of INV-O03 (deployment compatibility). */
export class MigrationCompatibilityError extends DeploymentContractError {
  constructor(message: string) {
    super(message);
    this.name = "MigrationCompatibilityError";
  }
}

// ---------------------------------------------------------------------------
// Environment manifests
// ---------------------------------------------------------------------------

/** A schema migration attached to a service deployment (INV-O03). */
export interface MigrationPlan {
  readonly migrationId: string;
  readonly fromSchemaVersion: string;
  readonly toSchemaVersion: string;
  /**
   * EXPANSION = additive only (old code keeps running against the new
   * schema); CONTRACTION = removes/renames what old code may still read;
   * DATA_BACKFILL = expansion plus a backfill, still old-code-safe.
   */
  readonly phase: "EXPANSION" | "CONTRACTION" | "DATA_BACKFILL";
  /**
   * How state reconstruction happens on rollback (INV-O04):
   * ROLL_FORWARD (preferred — apply the next forward fix),
   * REVERSIBLE_MIGRATION (a tested down-migration exists),
   * RESTORE_FROM_BACKUP (replay the journal from the backup point).
   */
  readonly rollbackStrategy:
    | "ROLL_FORWARD"
    | "REVERSIBLE_MIGRATION"
    | "RESTORE_FROM_BACKUP";
  readonly notes?: string;
}

/** One deployable service inside an environment manifest. */
export interface ServiceDeployment {
  /** Stable service identity, e.g. `payswap-web-api`. */
  readonly serviceId: string;
  readonly role: ServiceRole;
  /** The version being deployed for this service. */
  readonly version: string;
  /**
   * Effective configuration — VALUES with secrets as REFERENCE NAMES only
   * (`*_REF`); checked by checkSecretReferenceHygiene (secrets.ts).
   */
  readonly config: Readonly<Record<string, string>>;
  /** The schema migration shipped with this deployment, if any. */
  readonly migration?: MigrationPlan;
}

/** The manifest of one environment (§2): its services and their config. */
export interface EnvironmentManifest {
  readonly environment: EnvironmentName;
  readonly services: readonly ServiceDeployment[];
  /** Deterministic fingerprint of the effective configuration. */
  readonly configFingerprint: string;
}

/** Compute the deterministic fingerprint of a service's config map. */
export function computeConfigFingerprint(
  config: Readonly<Record<string, string>>,
): string {
  return contentDigest(config);
}

/** Assemble an environment manifest, fingerprinting every service config. */
export function defineEnvironmentManifest(input: {
  readonly environment: EnvironmentName;
  readonly services: readonly ServiceDeployment[];
}): EnvironmentManifest {
  if (!isEnvironmentName(input.environment)) {
    throw new DeploymentContractError(
      `unknown environment '${String(input.environment)}'`,
    );
  }
  const seen = new Set<string>();
  for (const service of input.services) {
    if (!isServiceRole(service.role)) {
      throw new DeploymentContractError(
        `service '${service.serviceId}' has unknown role '${String(service.role)}'`,
      );
    }
    if (seen.has(service.serviceId)) {
      throw new DeploymentContractError(
        `duplicate serviceId '${service.serviceId}' in environment '${input.environment}'`,
      );
    }
    seen.add(service.serviceId);
    if (service.migration !== undefined) {
      if (service.migration.fromSchemaVersion >= service.migration.toSchemaVersion) {
        throw new MigrationCompatibilityError(
          `migration '${service.migration.migrationId}' does not move the schema forward`,
        );
      }
    }
  }
  return {
    environment: input.environment,
    services: input.services,
    configFingerprint: contentDigest(
      input.services.map((service) => ({
        serviceId: service.serviceId,
        role: service.role,
        version: service.version,
        config: service.config,
        migration: service.migration ?? null,
      })),
    ),
  };
}

// ---------------------------------------------------------------------------
// Environment-variable completeness gate (§3.2 rule 2; §6 gate 2)
// ---------------------------------------------------------------------------

export interface ServiceEnvCheck {
  readonly serviceId: string;
  readonly role: ServiceRole;
  readonly missing: readonly string[];
  readonly passed: boolean;
}

export interface EnvCompletenessReport {
  readonly passed: boolean;
  readonly services: readonly ServiceEnvCheck[];
}

/**
 * Check every service against the configuration contract: a missing
 * variable for the declared environment BLOCKS release (§3.2 rule 2).
 * Secret-backed entries must be present as their documented name (the
 * value itself is only ever a vault reference — never checked here).
 */
export function checkEnvironmentVariableCompleteness(
  manifest: EnvironmentManifest,
  contract: readonly EnvironmentVariableRequirement[] = CONFIGURATION_CONTRACT,
): EnvCompletenessReport {
  const services: ServiceEnvCheck[] = manifest.services.map((service) => {
    const missing = contract
      .filter((requirement) => requirement.requiredBy.includes(service.role))
      .filter((requirement) => !isProviderTemplateMatch(requirement, service.config))
      .filter((requirement) => {
        const present =
          requirement.name === "PROVIDER_CREDENTIAL_REF"
            ? providerCredentialRefPresent(service.config)
            : !(service.config[requirement.name] === undefined) &&
              service.config[requirement.name] !== "";
        return !present;
      })
      .map((requirement) => requirement.name);
    return {
      serviceId: service.serviceId,
      role: service.role,
      missing,
      passed: missing.length === 0,
    };
  });
  return { passed: services.every((check) => check.passed), services };
}

/**
 * `PROVIDER_CREDENTIAL_REF` is a template — any `PROVIDER_<NAME>_CREDENTIAL_REF`
 * key in the config satisfies it (at least one required for adapter roles).
 */
function isProviderTemplateMatch(
  requirement: EnvironmentVariableRequirement,
  config: Readonly<Record<string, string>>,
): boolean {
  if (requirement.name !== "PROVIDER_CREDENTIAL_REF") {
    return false;
  }
  return providerCredentialRefPresent(config);
}

function providerCredentialRefPresent(
  config: Readonly<Record<string, string>>,
): boolean {
  return Object.keys(config).some(
    (key) =>
      key.startsWith("PROVIDER_") &&
      key.endsWith("_CREDENTIAL_REF") &&
      key !== "PROVIDER_CREDENTIAL_REF" &&
      config[key] !== "",
  );
}

// ---------------------------------------------------------------------------
// Preview/production parity verification (W3-007 acceptance)
// ---------------------------------------------------------------------------

/**
 * Config keys that are LEGITIMATELY environment-specific (explicit
 * differences). Everything else must be byte-identical between preview and
 * production: "environment differences are explicit and checked" (§2).
 */
export const PARITY_ALLOWED_DIFFERENCES: readonly string[] = Object.freeze([
  "DATABASE_URL",
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "VAULT_REF",
  "QUEUE_URL",
  "REDIS_URL",
  "OBSERVABILITY_ENDPOINT",
]);

export interface ServiceParityDiff {
  readonly serviceId: string;
  readonly role: ServiceRole;
  readonly versionDrift: boolean;
  readonly previewVersion?: string;
  readonly productionVersion?: string;
  /** Config keys that differ and are NOT on the allowlist. */
  readonly unexpectedConfigDifferences: readonly string[];
  readonly passed: boolean;
}

export interface ParityReport {
  readonly previewEnvironment: EnvironmentName;
  readonly productionEnvironment: EnvironmentName;
  readonly servicesMissingInProduction: readonly string[];
  readonly servicesMissingInPreview: readonly string[];
  readonly serviceDiffs: readonly ServiceParityDiff[];
  readonly passed: boolean;
  readonly digest: string;
}

/**
 * Deterministic preview/production parity diff over two environment
 * manifests. Passes iff:
 *  1. both manifests expose the SAME service set (same serviceIds);
 *  2. every common service deploys the SAME version;
 *  3. every config key difference is on the explicit allowlist
 *     (PARITY_ALLOWED_DIFFERENCES) — config parity everywhere else.
 */
export function verifyEnvironmentParity(
  preview: EnvironmentManifest,
  production: EnvironmentManifest,
): ParityReport {
  const previewIds = new Set(preview.services.map((service) => service.serviceId));
  const productionIds = new Set(
    production.services.map((service) => service.serviceId),
  );
  const missingInProduction = [...previewIds].filter((id) => !productionIds.has(id));
  const missingInPreview = [...productionIds].filter((id) => !previewIds.has(id));

  const serviceDiffs: ServiceParityDiff[] = [];
  for (const previewService of preview.services) {
    const productionService = production.services.find(
      (candidate) => candidate.serviceId === previewService.serviceId,
    );
    if (productionService === undefined) {
      continue; // already reported in missingInProduction
    }
    const versionDrift = previewService.version !== productionService.version;
    const unexpected = unexpectedConfigDeltas(
      previewService.config,
      productionService.config,
    );
    serviceDiffs.push({
      serviceId: previewService.serviceId,
      role: previewService.role,
      versionDrift,
      previewVersion: previewService.version,
      productionVersion: productionService.version,
      unexpectedConfigDifferences: unexpected,
      passed: !versionDrift && unexpected.length === 0,
    });
  }

  const body = {
    previewEnvironment: preview.environment,
    productionEnvironment: production.environment,
    servicesMissingInProduction: missingInProduction,
    servicesMissingInPreview: missingInPreview,
    serviceDiffs,
  };
  const passed =
    missingInProduction.length === 0 &&
    missingInPreview.length === 0 &&
    serviceDiffs.every((diff) => diff.passed);
  return { ...body, passed, digest: contentDigest(body) };
}

function unexpectedConfigDeltas(
  previewConfig: Readonly<Record<string, string>>,
  productionConfig: Readonly<Record<string, string>>,
): string[] {
  const keys = new Set([...Object.keys(previewConfig), ...Object.keys(productionConfig)]);
  const deltas: string[] = [];
  for (const key of keys) {
    const previewValue = previewConfig[key];
    const productionValue = productionConfig[key];
    const differs =
      previewValue === undefined || productionValue === undefined
        ? true
        : previewValue !== productionValue;
    if (differs && !PARITY_ALLOWED_DIFFERENCES.includes(key)) {
      deltas.push(key);
    }
  }
  return deltas.sort();
}

// ---------------------------------------------------------------------------
// Migration-compatible deployment ordering (INV-O03 / INV-O04)
// ---------------------------------------------------------------------------

/** One stage of the ordered deployment plan. */
export interface DeploymentStage {
  readonly stageId: string;
  readonly order: number;
  readonly description: string;
  readonly serviceIds: readonly string[];
  readonly invariants: readonly string[];
}

export interface DeploymentPlan {
  readonly environment: EnvironmentName;
  readonly stages: readonly DeploymentStage[];
  /** Every shipped migration with its compatibility verdict. */
  readonly migrations: readonly {
    readonly serviceId: string;
    readonly migration: MigrationPlan;
    readonly compatible: boolean;
    readonly reason: string;
  }[];
  readonly passed: boolean;
}

/**
 * The canonical deploy order and WHY (INV-O03):
 *
 *  1. EXPANSION MIGRATIONS FIRST — additive schema changes run before any
 *     new code that reads them is deployed; the running old code ignores
 *     additive columns (forward compatibility).
 *  2. protocol-worker — the Financial Protocol Authority must be able to
 *     accept commands in the new shape before any other role sends them.
 *  3. rail-adapter-worker + reconciliation-worker — external effects and
 *     ambiguity resolution follow the protocol.
 *  4. web-api — user-facing surfaces flip last, after the backend plane
 *     is ready (this is also the stage browser verification gates).
 *  5. notification-worker, then lab-worker.
 *  6. POST-DEPLOY VERIFICATION — parity re-check, outbox drain, browser
 *     journeys, observability event flow (§6 gates 6–11).
 *
 * A CONTRACTION (or data-destroying) migration in the SAME phase as the code
 * that dropped the old shape is REJECTED — contraction requires a separate
 * phase after every old-code reader is gone (two-phase deploy).
 */
export function planDeploymentOrder(
  manifest: EnvironmentManifest,
): DeploymentPlan {
  const migrations = manifest.services
    .filter((service) => service.migration !== undefined)
    .map((service) => {
      const migration = service.migration as MigrationPlan;
      const compatible = migration.phase !== "CONTRACTION";
      return {
        serviceId: service.serviceId,
        migration,
        compatible,
        reason: compatible
          ? `${migration.phase} migration is forward-compatible when applied before the new code (INV-O03)`
          : `CONTRACTION migration '${migration.migrationId}' cannot ship with the code that drops the old shape — deploy expansion first, retire old readers, then contract in a separate phase (INV-O03)`,
      };
    });
  if (migrations.some((entry) => !entry.compatible)) {
    throw new MigrationCompatibilityError(
      migrations
        .filter((entry) => !entry.compatible)
        .map((entry) => entry.reason)
        .join(" | "),
    );
  }

  const byRole = (role: ServiceRole): readonly string[] =>
    manifest.services
      .filter((service) => service.role === role)
      .map((service) => service.serviceId);
  const expansionMigrations = manifest.services
    .filter(
      (service) =>
        service.migration !== undefined &&
        (service.migration.phase === "EXPANSION" ||
          service.migration.phase === "DATA_BACKFILL"),
    )
    .map((service) => service.serviceId);

  const stages: DeploymentStage[] = [
    {
      stageId: "pre-deploy-expansion-migrations",
      order: 1,
      description:
        "Apply every forward-compatible (EXPANSION/DATA_BACKFILL) schema migration BEFORE deploying the code that reads it — old code keeps running against the expanded schema (INV-O03).",
      serviceIds: expansionMigrations,
      invariants: ["INV-O03"],
    },
    {
      stageId: "deploy-protocol-worker",
      order: 2,
      description:
        "Deploy the protocol worker first: the Financial Protocol Authority accepts the new command shape before any other role sends it.",
      serviceIds: byRole("protocol-worker"),
      invariants: ["INV-F06"],
    },
    {
      stageId: "deploy-rail-adapter-and-reconciliation-workers",
      order: 3,
      description:
        "Deploy rail adapter workers and the reconciliation worker: external effects and ambiguity resolution follow the protocol; adapter outages stay isolated per provider.",
      serviceIds: [
        ...byRole("rail-adapter-worker"),
        ...byRole("reconciliation-worker"),
      ],
      invariants: ["INV-C06", "INV-X03"],
    },
    {
      stageId: "deploy-web-api",
      order: 4,
      description:
        "Deploy web/API surfaces after the backend plane is ready; this stage is gated by browser-journey verification (desktop + responsive, console-error check, key interactions, screenshot artifact, real API wiring).",
      serviceIds: byRole("web-api"),
      invariants: ["INV-E04"],
    },
    {
      stageId: "deploy-notification-and-lab-workers",
      order: 5,
      description:
        "Deploy the notification worker and the Lab worker (Lab stays hard-isolated from production rails — INV-L01).",
      serviceIds: [...byRole("notification-worker"), ...byRole("lab-worker")],
      invariants: ["INV-L01"],
    },
    {
      stageId: "post-deploy-verification",
      order: 6,
      description:
        "Re-run the deployment gates: preview/production parity, environment completeness, secret hygiene, queue/outbox health, browser journeys, API conformance, invariant suite, observability event flow, rollback rehearsal (INV-O04 restore/replay drill).",
      serviceIds: [],
      invariants: ["INV-O01", "INV-O02", "INV-O04"],
    },
  ];

  return {
    environment: manifest.environment,
    stages,
    migrations,
    passed: true,
  };
}

/**
 * Restore/replay state-reconstruction contract (INV-O04): what a restore
 * MUST replay, in order, to reconstruct authoritative state. Data for the
 * recovery playbook `restore-replay` (recovery.ts).
 */
export const RESTORE_REPLAY_PROCEDURE: readonly {
  readonly stepId: string;
  readonly description: string;
}[] = Object.freeze([
  {
    stepId: "freeze-writes",
    description:
      "Freeze protocol command intake (pause campaign surfaces where user-visible) so no new authoritative mutations race the restore.",
  },
  {
    stepId: "restore-journal",
    description:
      "Restore the append-only journal from the last verified backup — the journal is the authoritative record (balances are projections, INV-F02).",
  },
  {
    stepId: "replay-events",
    description:
      "Replay committed journal events and outbox records after the backup point; idempotency keys keep replays single-effect (INV-F05).",
  },
  {
    stepId: "drain-outbox",
    description:
      "Drain the outbox with idempotent publishers — committed mutations must not lose their events (INV-O02); publishers deduplicate at-least-once redelivery.",
  },
  {
    stepId: "reconcile-external-effects",
    description:
      "Open reconciliation cases for every external effect whose outcome cannot be confirmed from replayed evidence; reconciliation is authoritative for ambiguity (INV-X03), never blind retry (INV-X02).",
  },
  {
    stepId: "verify-projections",
    description:
      "Rebuild balance projections and verify every terminal state matches its evidence; UNKNOWN outcomes stay UNKNOWN until reconciled (INV-X01).",
  },
]);

// ---------------------------------------------------------------------------
// The deployment gates checklist (§6) — as data
// ---------------------------------------------------------------------------

export interface DeploymentGate {
  readonly gateId: string;
  readonly title: string;
  readonly description: string;
  readonly invariants: readonly string[];
}

/** The eleven release gates (§6 Deployment gates checklist), verbatim order. */
export const DEPLOYMENT_GATES: readonly DeploymentGate[] = Object.freeze([
  {
    gateId: "schema-migration-compatibility",
    title: "Schema migration compatibility",
    description:
      "Forward-compatible migrations (INV-O03); restore/replay can reconstruct authoritative state (INV-O04).",
    invariants: ["INV-O03", "INV-O04"],
  },
  {
    gateId: "environment-variable-completeness",
    title: "Environment-variable completeness",
    description:
      "Effective configuration matches the declared environment contract; drift blocks deploy.",
    invariants: [],
  },
  {
    gateId: "secret-exposure",
    title: "Secret exposure",
    description:
      "Scan for secrets in repo/artifacts; vault-only resolution verified.",
    invariants: [],
  },
  {
    gateId: "provider-capability-configuration",
    title: "Provider capability configuration",
    description:
      "Declared ConnectedCapabilityInstances consistent with actual account authorization/entitlement.",
    invariants: ["INV-C05", "INV-NC04"],
  },
  {
    gateId: "database-connectivity",
    title: "Database connectivity",
    description: "Connectivity checked from every worker role.",
    invariants: [],
  },
  {
    gateId: "queue-outbox-health",
    title: "Queue/outbox health",
    description:
      "No stuck commands; outbox drain verified.",
    invariants: ["INV-O02"],
  },
  {
    gateId: "browser-journeys",
    title: "Browser journeys",
    description:
      "Desktop + responsive verification, console-error check, key interactions, screenshot artifact, evidence of real API/protocol wiring.",
    invariants: ["INV-E04"],
  },
  {
    gateId: "api-conformance",
    title: "API conformance",
    description:
      "Contract tests: envelope shape, error category → status mapping, idempotency-key enforcement, webhook signature and replay-window semantics.",
    invariants: ["INV-F05"],
  },
  {
    gateId: "architecture-invariant-suite",
    title: "Architecture/invariant suite",
    description:
      "Invariants including INV-X01 (UNKNOWN never mapped to FAILED) hold in tests.",
    invariants: ["INV-X01"],
  },
  {
    gateId: "observability",
    title: "Observability",
    description:
      "Dashboards/alerts receive terminal and reconciliation events from the new release.",
    invariants: [],
  },
  {
    gateId: "rollback",
    title: "Rollback",
    description:
      "Documented, rehearsed path — migrations must roll back or forward-safely.",
    invariants: ["INV-O03", "INV-O04"],
  },
]);
