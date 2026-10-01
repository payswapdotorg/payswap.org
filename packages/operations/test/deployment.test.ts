import { describe, expect, it } from "vitest";

import {
  CONFIGURATION_CONTRACT,
  type EnvironmentManifest,
  type ServiceDeployment,
  MigrationCompatibilityError,
  PARITY_ALLOWED_DIFFERENCES,
  checkEnvironmentVariableCompleteness,
  defineEnvironmentManifest,
  computeConfigFingerprint,
  planDeploymentOrder,
  verifyEnvironmentParity,
} from "../src/deployment.js";

// ---------------------------------------------------------------------------
// Fixtures — a reference two-service manifest pair used across the suite
// ---------------------------------------------------------------------------

function referenceService(
  overrides: Partial<ServiceDeployment> = {},
): ServiceDeployment {
  return {
    serviceId: "payswap-web-api",
    role: "web-api",
    version: "1.0.0",
    config: {
      WORKER_ROLE: "web-api",
      DATABASE_URL: "postgres://vault:ref/db-main",
      OBJECT_STORAGE_ENDPOINT: "https://storage.example.internal",
      OBJECT_STORAGE_BUCKET: "payswap-evidence",
      OBJECT_STORAGE_REGION: "auto",
      OBJECT_STORAGE_ACCESS_KEY_ID: "vault://payswap/storage-key-id",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "vault://payswap/storage-secret",
      VAULT_REF: "vault://payswap/main",
      API_VERSION: "2026-09-30",
      OBSERVABILITY_ENDPOINT: "https://otel.example.internal",
    },
    ...overrides,
  };
}

function referenceManifest(
  environment: "preview" | "production",
): EnvironmentManifest {
  return defineEnvironmentManifest({
    environment,
    services: [
      referenceService(),
      {
        serviceId: "payswap-notification-worker",
        role: "notification-worker",
        version: "1.0.0",
        config: {
          WORKER_ROLE: "notification-worker",
          DATABASE_URL: "postgres://vault:ref/db-main",
          OBJECT_STORAGE_ENDPOINT: "https://storage.example.internal",
          OBJECT_STORAGE_BUCKET: "payswap-evidence",
          OBJECT_STORAGE_REGION: "auto",
          VAULT_REF: "vault://payswap/main",
          QUEUE_URL: "queue://main",
          REDIS_URL: "redis://main",
          WEBHOOK_SIGNING_SECRET_REF: "vault://payswap/webhook-signing",
          OBSERVABILITY_ENDPOINT: "https://otel.example.internal",
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Parity verification (W3-007 acceptance)
// ---------------------------------------------------------------------------

describe("preview/production parity verification", () => {
  it("passes when the manifests are identical", () => {
    const report = verifyEnvironmentParity(
      referenceManifest("preview"),
      referenceManifest("production"),
    );
    expect(report.passed).toBe(true);
    expect(report.servicesMissingInProduction).toEqual([]);
    expect(report.servicesMissingInPreview).toEqual([]);
    expect(report.serviceDiffs.every((diff) => diff.passed)).toBe(true);
    expect(report.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it("passes when differences are only on the explicit allowlist", () => {
    const production = defineEnvironmentManifest({
      environment: "production",
      services: [
        referenceService({
          config: {
            ...referenceService().config,
            DATABASE_URL: "postgres://vault:ref/db-prod",
            OBJECT_STORAGE_ENDPOINT: "https://storage.example.prod",
            OBJECT_STORAGE_BUCKET: "payswap-evidence-prod",
            OBSERVABILITY_ENDPOINT: "https://otel.example.prod",
          },
        }),
      ],
    });
    const preview = defineEnvironmentManifest({
      environment: "preview",
      services: [
        referenceService({
          config: {
            ...referenceService().config,
            DATABASE_URL: "postgres://vault:ref/db-preview",
          },
        }),
      ],
    });
    const report = verifyEnvironmentParity(preview, production);
    expect(report.passed).toBe(true);
    for (const key of [
      "DATABASE_URL",
      "OBJECT_STORAGE_ENDPOINT",
      "OBJECT_STORAGE_BUCKET",
      "OBSERVABILITY_ENDPOINT",
    ]) {
      expect(PARITY_ALLOWED_DIFFERENCES).toContain(key);
    }
  });

  it("FAILS when a config key drifts outside the allowlist", () => {
    const preview = referenceManifest("preview");
    const production = defineEnvironmentManifest({
      environment: "production",
      services: [
        referenceService({
          config: {
            ...referenceService().config,
            API_VERSION: "2026-10-31",
          },
        }),
        ...referenceManifest("production").services.slice(1),
      ],
    });
    const report = verifyEnvironmentParity(preview, production);
    expect(report.passed).toBe(false);
    const webDiff = report.serviceDiffs.find(
      (diff) => diff.serviceId === "payswap-web-api",
    );
    expect(webDiff?.unexpectedConfigDifferences).toEqual(["API_VERSION"]);
    expect(webDiff?.passed).toBe(false);
  });

  it("FAILS on version drift between environments", () => {
    const preview = referenceManifest("preview");
    const production = defineEnvironmentManifest({
      environment: "production",
      services: [
        referenceService({ version: "1.1.0" }),
        ...referenceManifest("production").services.slice(1),
      ],
    });
    const report = verifyEnvironmentParity(preview, production);
    expect(report.passed).toBe(false);
    const webDiff = report.serviceDiffs.find(
      (diff) => diff.serviceId === "payswap-web-api",
    );
    expect(webDiff?.versionDrift).toBe(true);
    expect(webDiff?.previewVersion).toBe("1.0.0");
    expect(webDiff?.productionVersion).toBe("1.1.0");
  });

  it("FAILS when a service exists only in one environment", () => {
    const preview = referenceManifest("preview");
    const productionServices = referenceManifest("production").services.slice(1);
    const production = defineEnvironmentManifest({
      environment: "production",
      services: productionServices,
    });
    const report = verifyEnvironmentParity(preview, production);
    expect(report.passed).toBe(false);
    expect(report.servicesMissingInProduction).toEqual(["payswap-web-api"]);
    expect(report.servicesMissingInPreview).toEqual([]);
  });

  it("FAILS when a config key exists only on one side (even allowlisted keys are reported as equal-or-absent)", () => {
    const preview = referenceManifest("preview");
    const production = defineEnvironmentManifest({
      environment: "production",
      services: [
        referenceService({
          config: {
            ...referenceService().config,
            EXTRA_TUNING: "enabled",
          },
        }),
        ...referenceManifest("production").services.slice(1),
      ],
    });
    const report = verifyEnvironmentParity(preview, production);
    expect(report.passed).toBe(false);
    expect(
      report.serviceDiffs
        .find((diff) => diff.serviceId === "payswap-web-api")
        ?.unexpectedConfigDifferences,
    ).toEqual(["EXTRA_TUNING"]);
  });
});

// ---------------------------------------------------------------------------
// Environment-variable completeness (§3.2 rule 2; §6 gate 2)
// ---------------------------------------------------------------------------

describe("environment-variable completeness", () => {
  it("passes for a manifest that satisfies the configuration contract", () => {
    const report = checkEnvironmentVariableCompleteness(
      referenceManifest("production"),
    );
    expect(report.passed).toBe(true);
    expect(report.services.map((check) => check.missing)).toEqual([[], []]);
  });

  it("detects a missing required variable per role", () => {
    const { VAULT_REF: _omitted, ...webConfig } = referenceService().config;
    const preview = defineEnvironmentManifest({
      environment: "preview",
      services: [referenceService({ config: webConfig })],
    });
    const report = checkEnvironmentVariableCompleteness(preview);
    expect(report.passed).toBe(false);
    expect(report.services[0]?.missing).toContain("VAULT_REF");
  });

  it("rejects empty-string values as missing", () => {
    const preview = defineEnvironmentManifest({
      environment: "preview",
      services: [
        referenceService({
          config: { ...referenceService().config, API_VERSION: "" },
        }),
      ],
    });
    const report = checkEnvironmentVariableCompleteness(preview);
    expect(report.passed).toBe(false);
    expect(report.services[0]?.missing).toContain("API_VERSION");
  });

  it("accepts any PROVIDER_<NAME>_CREDENTIAL_REF for rail adapter roles", () => {
    const adapter = defineEnvironmentManifest({
      environment: "production",
      services: [
        {
          serviceId: "payswap-rail-adapters",
          role: "rail-adapter-worker",
          version: "1.0.0",
          config: {
            WORKER_ROLE: "rail-adapter-worker",
            DATABASE_URL: "postgres://vault:ref/db-main",
            VAULT_REF: "vault://payswap/main",
            PROVIDER_STRIPE_CREDENTIAL_REF: "vault://payswap/providers/stripe",
            PROVIDER_WISE_CREDENTIAL_REF: "vault://payswap/providers/wise",
            QUEUE_URL: "queue://main",
            REDIS_URL: "redis://main",
            OBSERVABILITY_ENDPOINT: "https://otel.example.internal",
          },
        },
      ],
    });
    const report = checkEnvironmentVariableCompleteness(adapter);
    expect(report.passed).toBe(true);
  });

  it("requires at least one provider credential reference for adapter roles", () => {
    const adapter = defineEnvironmentManifest({
      environment: "production",
      services: [
        {
          serviceId: "payswap-rail-adapters",
          role: "rail-adapter-worker",
          version: "1.0.0",
          config: {
            WORKER_ROLE: "rail-adapter-worker",
            DATABASE_URL: "postgres://vault:ref/db-main",
            VAULT_REF: "vault://payswap/main",
            QUEUE_URL: "queue://main",
            REDIS_URL: "redis://main",
            OBSERVABILITY_ENDPOINT: "https://otel.example.internal",
          },
        },
      ],
    });
    const report = checkEnvironmentVariableCompleteness(adapter);
    expect(report.passed).toBe(false);
    expect(report.services[0]?.missing).toContain("PROVIDER_CREDENTIAL_REF");
  });

  it("covers every worker role in the contract", () => {
    const roles = new Set(
      CONFIGURATION_CONTRACT.flatMap((requirement) => requirement.requiredBy),
    );
    expect(roles.size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Deployment ordering + migration compatibility (INV-O03 / INV-O04)
// ---------------------------------------------------------------------------

describe("migration-compatible deployment planning", () => {
  it("orders expansion migrations before the code that reads them", () => {
    const manifest = defineEnvironmentManifest({
      environment: "production",
      services: [
        referenceService({
          migration: {
            migrationId: "m-2026-10-add-outbox-index",
            fromSchemaVersion: "1.3",
            toSchemaVersion: "1.4",
            phase: "EXPANSION",
            rollbackStrategy: "ROLL_FORWARD",
          },
        }),
      ],
    });
    const plan = planDeploymentOrder(manifest);
    const migrationStage = plan.stages.find(
      (stage) => stage.stageId === "pre-deploy-expansion-migrations",
    );
    const webStage = plan.stages.find(
      (stage) => stage.stageId === "deploy-web-api",
    );
    expect(migrationStage?.order).toBe(1);
    expect(migrationStage?.serviceIds).toEqual(["payswap-web-api"]);
    expect(webStage && migrationStage && webStage.order > migrationStage.order).toBe(
      true,
    );
    expect(plan.migrations.every((entry) => entry.compatible)).toBe(true);
  });

  it("REJECTS a contraction migration in the same phase as the dropping code (INV-O03)", () => {
    const manifest = defineEnvironmentManifest({
      environment: "production",
      services: [
        referenceService({
          migration: {
            migrationId: "m-2026-10-drop-legacy-column",
            fromSchemaVersion: "1.3",
            toSchemaVersion: "1.4",
            phase: "CONTRACTION",
            rollbackStrategy: "RESTORE_FROM_BACKUP",
          },
        }),
      ],
    });
    expect(() => planDeploymentOrder(manifest)).toThrowError(
      MigrationCompatibilityError,
    );
  });

  it("deploys the protocol worker before rails, reconciliation and web-api", () => {
    const plan = planDeploymentOrder(referenceManifest("production"));
    const order = new Map(plan.stages.map((stage) => [stage.stageId, stage.order]));
    expect(order.get("deploy-protocol-worker")).toBeLessThan(
      order.get("deploy-rail-adapter-and-reconciliation-workers") as number,
    );
    expect(order.get("deploy-rail-adapter-and-reconciliation-workers")).toBeLessThan(
      order.get("deploy-web-api") as number,
    );
    expect(order.get("deploy-web-api")).toBeLessThan(
      order.get("post-deploy-verification") as number,
    );
  });

  it("finishes with the post-deploy verification stage covering INV-O01/O02/O04", () => {
    const plan = planDeploymentOrder(referenceManifest("production"));
    const final = plan.stages[plan.stages.length - 1];
    expect(final?.stageId).toBe("post-deploy-verification");
    expect(final?.invariants).toEqual(["INV-O01", "INV-O02", "INV-O04"]);
  });

  it("rejects a migration that does not move the schema forward", () => {
    expect(() =>
      defineEnvironmentManifest({
        environment: "production",
        services: [
          referenceService({
            migration: {
              migrationId: "m-bad",
              fromSchemaVersion: "1.4",
              toSchemaVersion: "1.4",
              phase: "EXPANSION",
              rollbackStrategy: "ROLL_FORWARD",
            },
          }),
        ],
      }),
    ).toThrowError(/does not move the schema forward/);
  });
});

// ---------------------------------------------------------------------------
// Fingerprints and manifests
// ---------------------------------------------------------------------------

describe("environment manifests and fingerprints", () => {
  it("fingerprints are deterministic and config-order independent", () => {
    const a = computeConfigFingerprint({
      A: "1",
      B: "2",
    });
    const b = computeConfigFingerprint({
      B: "2",
      A: "1",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it("fingerprints change when the config changes", () => {
    const a = computeConfigFingerprint({ A: "1" });
    const b = computeConfigFingerprint({ A: "2" });
    expect(a).not.toBe(b);
  });

  it("manifest assembly rejects duplicate services and unknown environments", () => {
    const service = referenceService();
    expect(() =>
      defineEnvironmentManifest({
        environment: "production",
        services: [service, { ...service }],
      }),
    ).toThrowError(/duplicate serviceId/);
    expect(() =>
      defineEnvironmentManifest({
        environment: "qa" as "production",
        services: [service],
      }),
    ).toThrowError(/unknown environment/);
  });
});
