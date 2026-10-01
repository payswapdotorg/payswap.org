import { describe, expect, it } from "vitest";

import {
  type EnvironmentManifest,
  defineEnvironmentManifest,
} from "../src/deployment.js";
import {
  DeclarativeSecretResolver,
  REQUIRED_SECRET_REFERENCES,
  SECRET_ROTATION_PROCEDURES,
  checkSecretReferenceHygiene,
  rotationProcedureFor,
} from "../src/secrets.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A SYNTHETIC, never-valid, non-secret test fixture shaped like a live
 * provider secret key, assembled at RUNTIME from fragments so the literal
 * never appears in the file — secret scanners (GitHub push protection,
 * pre-commit hooks) correctly do not flag test fixtures that exist only to
 * verify the hygiene checker DETECTS this shape. The value is fabricated
 * and authorizes nothing.
 */
const SYNTHETIC_LIVE_PROVIDER_KEY = [
  "sk_",
  "live_",
  "51H8xQz2vTq9wZxYw",
  "1234567890abcdef",
].join("");

/**
 * Same discipline for the PEM-shaped fixture: a synthetic, invalid PEM
 * block assembled at runtime (the base64 body is filler, not a real key) so
 * the literal never appears in the file for secret scanners.
 */
const SYNTHETIC_INVALID_PEM = [
  "-----BEGIN RSA PRIVATE ",
  "KEY-----",
  "MIIBOgIBAAJBAK",
  "-----END RSA PRIVATE ",
  "KEY-----",
].join("");

function cleanManifest(): EnvironmentManifest {
  return defineEnvironmentManifest({
    environment: "production",
    services: [
      {
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
      },
      {
        serviceId: "payswap-rail-adapters",
        role: "rail-adapter-worker",
        version: "1.0.0",
        config: {
          WORKER_ROLE: "rail-adapter-worker",
          DATABASE_URL: "postgres://vault:ref/db-main",
          VAULT_REF: "vault://payswap/main",
          PROVIDER_STRIPE_CREDENTIAL_REF: "vault://payswap/providers/stripe",
          QUEUE_URL: "queue://main",
          REDIS_URL: "redis://main",
          OBSERVABILITY_ENDPOINT: "https://otel.example.internal",
        },
      },
      {
        serviceId: "payswap-notification-worker",
        role: "notification-worker",
        version: "1.0.0",
        config: {
          WORKER_ROLE: "notification-worker",
          DATABASE_URL: "postgres://vault:ref/db-main",
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
// Manifest hygiene — no secret values in config artifacts (§6 gate 3)
// ---------------------------------------------------------------------------

describe("secret reference hygiene", () => {
  it("passes for a manifest holding only vault references", () => {
    const report = checkSecretReferenceHygiene(cleanManifest());
    expect(report.passed).toBe(true);
  });

  it("REJECTS an embedded live provider secret key value", () => {
    const manifest = defineEnvironmentManifest({
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
            PROVIDER_STRIPE_CREDENTIAL_REF: SYNTHETIC_LIVE_PROVIDER_KEY,
            QUEUE_URL: "queue://main",
            REDIS_URL: "redis://main",
            OBSERVABILITY_ENDPOINT: "https://otel.example.internal",
          },
        },
      ],
    });
    const report = checkSecretReferenceHygiene(manifest);
    expect(report.passed).toBe(false);
    expect(report.services[0]?.embeddedValues).toEqual([
      { key: "PROVIDER_STRIPE_CREDENTIAL_REF", pattern: "live provider secret key" },
    ]);
  });

  it("REJECTS an embedded private key block", () => {
    const manifest = defineEnvironmentManifest({
      environment: "production",
      services: [
        {
          serviceId: "payswap-web-api",
          role: "web-api",
          version: "1.0.0",
          config: {
            ...cleanManifest().services[0]!.config,
            TLS_KEY: SYNTHETIC_INVALID_PEM,
          },
        },
      ],
    });
    const report = checkSecretReferenceHygiene(manifest);
    expect(report.passed).toBe(false);
    expect(report.services[0]?.embeddedValues[0]?.pattern).toBe("private key block");
  });

  it("REJECTS a direct (non-REF) secret key name", () => {
    const manifest = defineEnvironmentManifest({
      environment: "production",
      services: [
        {
          serviceId: "payswap-notification-worker",
          role: "notification-worker",
          version: "1.0.0",
          config: {
            ...cleanManifest().services[2]!.config,
            WEBHOOK_SIGNING_SECRET: "vault://payswap/webhook-signing",
          },
        },
      ],
    });
    const report = checkSecretReferenceHygiene(manifest);
    expect(report.passed).toBe(false);
    expect(report.services[0]?.forbiddenKeys).toEqual(["WEBHOOK_SIGNING_SECRET"]);
  });

  it("REJECTS an inline password assignment in any value", () => {
    const manifest = defineEnvironmentManifest({
      environment: "production",
      services: [
        {
          serviceId: "payswap-web-api",
          role: "web-api",
          version: "1.0.0",
          config: {
            ...cleanManifest().services[0]!.config,
            FEATURE_FLAG_DOC: "see password=hunter2 for details",
          },
        },
      ],
    });
    const report = checkSecretReferenceHygiene(manifest);
    expect(report.passed).toBe(false);
    expect(report.services[0]?.embeddedValues[0]?.key).toBe("FEATURE_FLAG_DOC");
  });

  it("reports per service, not globally", () => {
    const manifest = defineEnvironmentManifest({
      environment: "production",
      services: [
        cleanManifest().services[0]!,
        {
          serviceId: "payswap-bad-worker",
          role: "protocol-worker",
          version: "1.0.0",
          config: {
            WORKER_ROLE: "protocol-worker",
            DATABASE_URL: "postgres://vault:ref/db-main",
            VAULT_REF: "vault://payswap/main",
            QUEUE_URL: "queue://main",
            REDIS_URL: "redis://main",
            OBSERVABILITY_ENDPOINT: "postgres://db?password=sekrit",
          },
        },
      ],
    });
    const report = checkSecretReferenceHygiene(manifest);
    expect(report.services[0]?.passed).toBe(true);
    expect(report.services[1]?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The resolution contract — references resolve to key IDs, never values
// ---------------------------------------------------------------------------

describe("secret resolution contract", () => {
  it("resolves a reference to a KEY ID, never a value", () => {
    const resolver = new DeclarativeSecretResolver({
      "vault://payswap/webhook-signing": ["2026-10-01-key-a"],
    });
    const resolution = resolver.resolve("vault://payswap/webhook-signing");
    expect(resolution.status).toBe("RESOLVED");
    if (resolution.status === "RESOLVED") {
      expect(resolution.keyId).toBe(
        "key:vault://payswap/webhook-signing:2026-10-01-key-a",
      );
      // INV (structural): the resolution type carries NO value field.
      expect(Object.keys(resolution)).toEqual(["status", "keyId"]);
    }
  });

  it("reports UNRESOLVED with a reason instead of guessing", () => {
    const resolver = new DeclarativeSecretResolver({});
    const resolution = resolver.resolve("vault://payswap/missing");
    expect(resolution.status).toBe("UNRESOLVED");
    if (resolution.status === "UNRESOLVED") {
      expect(resolution.reason).toContain("missing");
    }
  });

  it("enumerates active key ids for rotation overlap windows", () => {
    const resolver = new DeclarativeSecretResolver({
      "vault://payswap/webhook-signing": ["key-old", "key-new"],
    });
    expect(resolver.activeKeyIds("vault://payswap/webhook-signing")).toEqual([
      "key-old",
      "key-new",
    ]);
    expect(resolver.activeKeyIds("vault://payswap/none")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The inventory and rotation procedures
// ---------------------------------------------------------------------------

describe("required secret inventory", () => {
  it("covers the §3.1 secret-bearing configuration keys", () => {
    const names = REQUIRED_SECRET_REFERENCES.map((requirement) => requirement.configKey);
    expect(names).toEqual(
      expect.arrayContaining([
        "VAULT_REF",
        "DATABASE_URL",
        "OBJECT_STORAGE_ACCESS_KEY_ID",
        "OBJECT_STORAGE_SECRET_ACCESS_KEY",
        "PROVIDER_CREDENTIAL_REF",
        "WEBHOOK_SIGNING_SECRET_REF",
      ]),
    );
  });

  it("every requirement declares a rotation policy with a bounded max age", () => {
    for (const requirement of REQUIRED_SECRET_REFERENCES) {
      expect(requirement.rotation.maxAgeDays).toBeGreaterThan(0);
      expect(requirement.rotation.overlapWindowDays).toBeGreaterThanOrEqual(0);
      expect(["automatic", "manual"]).toContain(requirement.rotation.mode);
      expect(["critical", "high"]).toContain(requirement.impact);
    }
  });
});

describe("secret rotation procedures", () => {
  it("every required secret family has a rotation procedure", () => {
    for (const requirement of REQUIRED_SECRET_REFERENCES) {
      const procedure = rotationProcedureFor(requirement.configKey);
      expect(procedure).toBeDefined();
    }
  });

  it("every procedure has ordered steps and required actions resolve", () => {
    const actionIds = new Set([
      "pause-campaign",
      "resume-campaign",
      "release-quarantine",
      "trigger-reconciliation",
      "rail-cutover",
      "bump-security-epoch",
    ]);
    for (const procedure of SECRET_ROTATION_PROCEDURES) {
      expect(procedure.steps.length).toBeGreaterThan(0);
      for (const actionId of procedure.requiredOperatorActions) {
        expect(actionIds.has(actionId)).toBe(true);
      }
    }
  });

  it("the webhook signing key rotation requires the epoch bump (INV-A02)", () => {
    const procedure = rotationProcedureFor("WEBHOOK_SIGNING_SECRET_REF");
    expect(procedure?.requiredOperatorActions).toContain("bump-security-epoch");
    expect(procedure?.invariants).toContain("INV-A02");
  });
});
