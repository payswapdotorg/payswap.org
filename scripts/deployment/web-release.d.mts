/**
 * Type declarations for the web-release driver's PURE CORE
 * (scripts/deployment/web-release.mjs), consumed by the fixture-based
 * reproducibility test in packages/web/test/infra-release-repro.test.ts.
 *
 * The driver keeps its CLI side effects (git, npm build, file writes) behind
 * a run-as-script guard — importing the module executes nothing. Only the
 * deterministic, side-effect-free functions are exported and declared here.
 */

/** Canonical serialization (sorted keys, bigint-safe) — house pattern. */
export function serialize(value: unknown): string;

/** fnv1a64 digest of the canonical serialization — house pattern. */
export function contentDigest(value: unknown): string;

/** Explicit inputs of a web-release record (all deterministic). */
export interface ReleaseRecordInputs {
  recordDate: string;
  commitSha: string;
  buildId: string;
  buildIdVerifiedAgainstSources: boolean;
  productionUrl?: string | null;
  previewUrl?: string | null;
  /** The work order under whose authority this release runs (deploy:record extension, 2026-10-06). */
  workOrder?: string;
  /** The route inventory the record reports (defaults to the P3-W1-001 list; a --live record passes the tree-derived inventory). */
  routes?: string[];
  /** The deployment-URLs note (defaults to the placeholder note; a --live record passes the live-verified note). */
  deploymentUrlsNote?: string;
}

/** A serialized web-release record (digest included). */
export interface WebReleaseRecord {
  schema_version: string;
  record_type: "web-release";
  workOrder: string;
  package: string;
  release: {
    date: string;
    commit: string;
    buildId: string;
    buildIdScheme: string;
    buildIdVerifiedAgainstSources: boolean;
  };
  vercelProject: {
    name: string;
    rootDirectory: string;
    framework: string;
    deploymentUrls: { production: string | null; preview: string | null };
    deploymentUrlsNote: string;
  };
  apiRuntimeSeparation: {
    law: string;
    webProject: string;
    apiRuntimeProject: string;
    apiRuntimeProjectRole: string;
    apiBaseUrlEnvVar: string;
    apiBaseUrlValue: null;
    apiBaseUrlNote: string;
  };
  healthEndpoint: string;
  routes: string[];
  digest: string;
}

/** Assemble the deterministic web-release record (digest included). Pure. */
export function assembleReleaseRecord(inputs: ReleaseRecordInputs): WebReleaseRecord;

/**
 * Derive the route inventory from the actual tree: every page.tsx/route.ts
 * under packages/web/src/app, route groups flattened, [param] segments kept
 * literal, sorted with "/" first. Pure function of the filesystem.
 */
export function deriveRouteInventory(webRoot: string): string[];

/** Explicit inputs of a web-rollback record (all deterministic). */
export interface RollbackRecordInputs {
  recordDate: string;
  fromDeployment: string;
  toDeployment: string;
  reason: string;
  toBuildId?: string | null;
  toCommit?: string | null;
}

/** A serialized web-rollback record (digest included). */
export interface WebRollbackRecord {
  schema_version: string;
  record_type: "web-rollback";
  workOrder: string;
  package: string;
  rollback: {
    date: string;
    fromDeployment: string;
    toDeployment: string;
    toBuildId: string | null;
    toCommit: string | null;
    reason: string;
    method: string;
    verification: string;
  };
  vercelProject: { name: string; rootDirectory: string; framework: string };
  apiRuntimeSeparation: {
    law: string;
    webProject: string;
    apiRuntimeProject: string;
    apiRuntimeProjectRole: string;
  };
  healthEndpoint: string;
  digest: string;
}

/** Assemble the deterministic web-rollback record (digest included). Pure. */
export function assembleRollbackRecord(inputs: RollbackRecordInputs): WebRollbackRecord;

/** Canonical on-disk form: 2-space JSON + trailing newline (house style). */
export function formatRecord(record: unknown): string;

/** The deterministic record filename for a record type + explicit date. */
export function recordFileName(recordType: "web-release" | "web-rollback", recordDate: string): string;
