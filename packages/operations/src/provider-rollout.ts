/**
 * @payswap/operations — the reproducible production provider ROLLOUT
 * (P2-W3-003, Phase 2 Wave 3 final item).
 *
 * Authority: spec/phase-2/work-items/P2-W3-003.md ("Perform controlled
 * production activation of certified providers and verify the operator/
 * customer experience over real provider-backed paths") +
 * spec/development-state/production-deployment.json (the historical
 * zero-provider release record whose ACTIVATION PATH this module executes
 * and whose shape the provider-rollout release record follows) +
 * spec/experience/DEPLOYMENT-TOPOLOGY.md §3.2 rule 4 (enablement is data,
 * never a redeploy) + spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-
 * ISOLATION.md (the canonical separation the parity structure carries).
 *
 * The laws this module enforces:
 *
 * 1. THE ROLLOUT IS DATA AND IS REPRODUCIBLE. A `ProviderRolloutPlan`
 *    (named providers + certification evidence refs + activation-gate
 *    inputs + the preview/production parity bindings) executes through the
 *    PURE function `executeProviderRolloutPlan` into a
 *    `ProviderRolloutReleaseRecord` with a content digest: same inputs ->
 *    byte-identical record. Nothing about activation lives in environment
 *    or imperative state.
 *
 * 2. ONLY CERTIFIED, LIVE-EVIDENCE-BACKED PROVIDERS CONNECT. Every plan
 *    item must resolve to a CURRENT `ACTIVATED` provider-activation record
 *    in the append-only ledger (live probe evidence + connected instance —
 *    the P2-W1-001 law) AND carry certification evidence with zero failed
 *    pairs (the P2-W2-003 cross-provider conformance matrix). A provider
 *    with held-out credentials (all Wave-2 connectors), a BLOCKED probe
 *    (MTN MoMo) or an unexecuted certification can never appear as
 *    connected — it is carried honestly as a `nonConnection` with its
 *    reason instead.
 *
 * 3. PREVIEW/PRODUCTION PARITY REMAINS EXPLICIT. The same provider set
 *    with the same activation records must bind in BOTH environments; the
 *    ONLY allowed difference is the per-environment vault reference (each
 *    environment resolves its own credential material from the operator
 *    vault). Mirrors `PARITY_ALLOWED_DIFFERENCES` in deployment.ts.
 *
 * 4. ROLLBACK/DEACTIVATION IS A FIRST-CLASS, TESTED PATH. Deactivation
 *    appends a REVOKED record (immutable history, evidence carried);
 *    re-activation REQUIRES fresh live probe evidence timestamped after
 *    the revocation and a fresh connected instance. The five canonical
 *    rollback steps are data (`PROVIDER_ROLLOUT_ROLLBACK_STEPS`) and
 *    `rehearseProviderRollback` drills the full deactivate -> disabled ->
 *    re-activate -> enabled cycle on derived ledgers (functional
 *    append-only — the rehearsal can never rewrite production history).
 *
 * 5. NO SECRET VALUES, EVER — same fail-closed byte heuristics as the
 *    provider-activation records (shared scanner; references only).
 *
 * 6. Canonical vocabularies (authorization modes, browser-session states)
 *    are owned by @payswap/connectors, which this package's boundary
 *    forbids importing — every checker RECEIVES them as input arguments
 *    (the P2-W1-001 law 6 pattern). No drift: the battery binds the inputs
 *    to the canonical exports.
 *
 * Deterministic only: no ambient clock, no entropy, no network. All
 * timestamps are caller-supplied ISO-8601 UTC strings.
 */

import { PaySwapError } from "@payswap/protocol";
import type { ErrorCategory, PaySwapErrorDetails } from "@payswap/protocol";

import { contentDigest } from "./digest.js";
import {
  appendProviderActivationRecord,
  collectSecretShapedStrings,
  currentProviderActivationRecords,
  PROVIDER_ACTIVATION_RECORD_TYPE,
  PROVIDER_ACTIVATION_SCHEMA_VERSION,
  resolveProviderEnablement,
} from "./provider-activation.js";
import type {
  ProviderActivationLedger,
  ProviderActivationRecord,
  ProviderEnablement,
  ProviderProbeEvidenceRef,
} from "./provider-activation.js";

/** Raised when the provider-rollout contract is violated. */
export class ProviderRolloutError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "PROVIDER_ROLLOUT_INVALID",
      category: "VALIDATION" as ErrorCategory,
      message,
      details,
    });
  }
}

// ---------------------------------------------------------------------------
// Record shape (record_type "provider-rollout-release", schema_version "1.0")
// ---------------------------------------------------------------------------

export const PROVIDER_ROLLOUT_RELEASE_RECORD_TYPE = "provider-rollout-release" as const;
export const PROVIDER_ROLLOUT_SCHEMA_VERSION = "1.0" as const;
export const PROVIDER_ROLLOUT_WORK_ORDER = "P2-W3-003" as const;

/**
 * The ONLY legitimate difference between the preview and production
 * provider bindings: each environment resolves its own credential material
 * from the operator vault (a vault reference, never a value). Everything
 * else — provider set, activation record, config key — must be identical.
 */
export const PROVIDER_ROLLOUT_PARITY_ALLOWED_DIFFERENCES: readonly string[] =
  Object.freeze(["credential.vaultReference"]);

/**
 * The five canonical rollback steps (work-order acceptance "rollback/
 * deactivation path is tested"). Ordered data, mirroring the
 * DIRECT_LOCAL_ONBOARDING_STEPS house pattern:
 *
 *  1. OPERATOR_DISABLE_OVERRIDE — enablement-as-data: the operator flips
 *     the explicit override and the provider stops being routable
 *     IMMEDIATELY, with no deployment of anything (DEPLOYMENT-TOPOLOGY
 *     §3.2 rule 4);
 *  2. REVOCATION_RECORD_APPEND — the immutable REVOKED activation record
 *     with the deactivation evidence (history is never rewritten);
 *  3. CONNECTED_INSTANCE_RETIREMENT — the connected instance stops being
 *     referenced as an active execution path (fail-closed connectors
 *     refuse effectful operations with no credential anyway, INV-NC04);
 *  4. RE_VERIFICATION_PROBE — a FRESH live probe against the provider
 *     (operator input is never integration proof);
 *  5. RE_ACTIVATION_WITH_FRESH_EVIDENCE — a superseding ACTIVATED record
 *     with the fresh probe evidence and a fresh connected instance.
 */
export const PROVIDER_ROLLOUT_ROLLBACK_STEPS = [
  "OPERATOR_DISABLE_OVERRIDE",
  "REVOCATION_RECORD_APPEND",
  "CONNECTED_INSTANCE_RETIREMENT",
  "RE_VERIFICATION_PROBE",
  "RE_ACTIVATION_WITH_FRESH_EVIDENCE",
] as const;
export type ProviderRolloutRollbackStep =
  (typeof PROVIDER_ROLLOUT_ROLLBACK_STEPS)[number];

const ISO_8601_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const VAULT_REFERENCE_PATTERN =
  /^vault:\/\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/;
const PROVIDER_CREDENTIAL_CONFIG_KEY_PATTERN =
  /^PROVIDER_[A-Z0-9]+(?:_[A-Z0-9]+)*_CREDENTIAL_REF$/;

// ---------------------------------------------------------------------------
// Certification evidence (P2-W2-003 cross-provider conformance, by reference)
// ---------------------------------------------------------------------------

/**
 * The conformance-certification evidence backing one provider's rollout.
 * A reference to the certified matrix results — the runner lives in
 * @payswap/journeys (conformance/runner.ts) and its report is passed to
 * the rollout as DATA; this package re-declares nothing.
 */
export interface CertificationEvidenceRef {
  /** e.g. "P2-W2-003-cross-provider-conformance" (the runner's certificationId). */
  readonly certificationId: string;
  readonly providerName: string;
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly notApplicable: number;
  /** Where the certification evidence lives (battery/matrix reference). */
  readonly evidencePath: string;
}

/** True iff the certification evidence backs a production connection. */
export function isCertificationConclusive(
  evidence: CertificationEvidenceRef,
): boolean {
  return evidence.failed === 0 && evidence.passed > 0 && evidence.executed > 0;
}

// ---------------------------------------------------------------------------
// The rollout plan (as data) and its parity bindings
// ---------------------------------------------------------------------------

/** One provider's binding in one environment (reference-only material). */
export interface RolloutProviderBinding {
  readonly providerName: string;
  /** The ledger record this binding activates (must be current ACTIVATED). */
  readonly activationRecordId: string;
  /** PROVIDER_<NAME>_CREDENTIAL_REF (the deployment-contract template). */
  readonly configKey: string;
  /** The per-environment vault reference — never a value. */
  readonly vaultReference: string;
}

/** One environment's provider set. */
export interface RolloutEnvironmentProviderSet {
  readonly environment: "preview" | "production";
  readonly providers: readonly RolloutProviderBinding[];
}

/** One planned provider: activation + certification + parity bindings. */
export interface ProviderRolloutPlanItem {
  readonly providerName: string;
  readonly activationRecordId: string;
  readonly probeEvidence: ProviderProbeEvidenceRef;
  readonly certification: CertificationEvidenceRef;
  readonly limitations: readonly string[];
}

/**
 * An honestly-recorded NON-connection: a provider that is NOT in this
 * rollout, with the reason carried into the release record (the Phase-2
 * honesty law — MTN MoMo's BLOCKED probe and every Wave-2 provider with no
 * held credential are named, never silently omitted).
 */
export interface ProviderRolloutNonConnection {
  readonly providerName: string;
  readonly status: "BLOCKED" | "NO_CREDENTIAL_HELD" | "NOT_ACTIVATED";
  readonly reason: string;
  readonly evidencePath?: string;
}

/** The reproducible rollout plan (P2-W3-003 acceptance, as data). */
export interface ProviderRolloutPlan {
  readonly planId: string;
  readonly workOrder: typeof PROVIDER_ROLLOUT_WORK_ORDER;
  readonly plannedAt: string;
  readonly plannedBy: string;
  readonly items: readonly ProviderRolloutPlanItem[];
  readonly preview: RolloutEnvironmentProviderSet;
  readonly production: RolloutEnvironmentProviderSet;
  readonly nonConnections: readonly ProviderRolloutNonConnection[];
}

// ---------------------------------------------------------------------------
// Preview/production parity (mirrors verifyEnvironmentParity)
// ---------------------------------------------------------------------------

export interface ProviderParityDiff {
  readonly providerName: string;
  readonly activationRecordIdDrift: boolean;
  readonly configKeyDrift: boolean;
  /** Differences NOT on the explicit allowlist. */
  readonly unexpectedDifferences: readonly string[];
  readonly passed: boolean;
}

export interface ProviderRolloutParityReport {
  readonly previewEnvironment: "preview" | "production";
  readonly productionEnvironment: "preview" | "production";
  readonly providersMissingInProduction: readonly string[];
  readonly providersMissingInPreview: readonly string[];
  readonly providerDiffs: readonly ProviderParityDiff[];
  readonly passed: boolean;
  readonly digest: string;
}

/**
 * Deterministic preview/production parity diff over the two provider sets.
 * Passes iff both environments expose the SAME provider set, every provider
 * binds the SAME activation record and config key, and the ONLY config
 * difference is the per-environment vault reference (the explicit
 * allowlist). Same law as `verifyEnvironmentParity` (deployment.ts).
 */
export function verifyProviderRolloutParity(
  preview: RolloutEnvironmentProviderSet,
  production: RolloutEnvironmentProviderSet,
): ProviderRolloutParityReport {
  const previewNames = new Set(preview.providers.map((p) => p.providerName));
  const productionNames = new Set(
    production.providers.map((p) => p.providerName),
  );
  const missingInProduction = [...previewNames].filter(
    (name) => !productionNames.has(name),
  );
  const missingInPreview = [...productionNames].filter(
    (name) => !previewNames.has(name),
  );

  const providerDiffs: ProviderParityDiff[] = [];
  for (const previewBinding of preview.providers) {
    const productionBinding = production.providers.find(
      (candidate) => candidate.providerName === previewBinding.providerName,
    );
    if (productionBinding === undefined) {
      continue; // already reported in providersMissingInProduction
    }
    const activationRecordIdDrift =
      previewBinding.activationRecordId !== productionBinding.activationRecordId;
    const configKeyDrift =
      previewBinding.configKey !== productionBinding.configKey;
    const unexpected: string[] = [];
    if (previewBinding.vaultReference !== productionBinding.vaultReference) {
      unexpected.push("credential.vaultReference");
    }
    const notAllowed = unexpected.filter(
      (difference) =>
        !PROVIDER_ROLLOUT_PARITY_ALLOWED_DIFFERENCES.includes(difference),
    );
    providerDiffs.push({
      providerName: previewBinding.providerName,
      activationRecordIdDrift,
      configKeyDrift,
      unexpectedDifferences: Object.freeze(notAllowed),
      passed:
        !activationRecordIdDrift &&
        !configKeyDrift &&
        notAllowed.length === 0,
    });
  }

  const body = {
    previewEnvironment: preview.environment,
    productionEnvironment: production.environment,
    providersMissingInProduction: missingInProduction,
    providersMissingInPreview: missingInPreview,
    providerDiffs,
  };
  const passed =
    missingInProduction.length === 0 &&
    missingInPreview.length === 0 &&
    providerDiffs.every((diff) => diff.passed);
  return { ...body, passed, digest: contentDigest(body) };
}

// ---------------------------------------------------------------------------
// Plan checker (fail-closed, issue-reporting like the activation checker)
// ---------------------------------------------------------------------------

export interface ProviderRolloutCheckIssue {
  readonly field: string;
  readonly problem: string;
}

export interface ProviderRolloutPlanReport {
  readonly ok: boolean;
  readonly issues: readonly ProviderRolloutCheckIssue[];
}

/**
 * Validates a rollout plan against the ledger + the Phase 2 laws:
 * shape, ISO timestamps, vault/config-key templates, unique provider
 * names, conclusive certification evidence (zero failed pairs), and — the
 * core gate — every `activationRecordId` resolves to a CURRENT ACTIVATED
 * ledger record of that provider (live evidence + connected instance).
 * `allowedAuthorizationModes` is the canonical union passed in by the
 * caller (@payswap/connectors AUTHORIZATION_MODES — boundary law 6).
 */
export function checkProviderRolloutPlan(
  plan: unknown,
  ledger: ProviderActivationLedger,
  allowedAuthorizationModes: readonly string[],
): ProviderRolloutPlanReport {
  const issues: ProviderRolloutCheckIssue[] = [];
  const push = (field: string, problem: string): void => {
    issues.push({ field, problem });
  };

  if (typeof plan !== "object" || plan === null) {
    return {
      ok: false,
      issues: [{ field: "plan", problem: "not an object" }],
    };
  }
  const p = plan as Record<string, unknown>;

  if (typeof p.planId !== "string" || p.planId.length < 3) {
    push("planId", "must be a non-trivial string");
  }
  if (p.workOrder !== PROVIDER_ROLLOUT_WORK_ORDER) {
    push("workOrder", `must be "${PROVIDER_ROLLOUT_WORK_ORDER}"`);
  }
  if (typeof p.plannedAt !== "string" || !ISO_8601_UTC_PATTERN.test(p.plannedAt)) {
    push("plannedAt", "must be an ISO-8601 UTC timestamp");
  }
  if (typeof p.plannedBy !== "string" || p.plannedBy.length < 2) {
    push("plannedBy", "must record who planned the rollout (lineage)");
  }
  if (!Array.isArray(p.items) || p.items.length === 0) {
    push("items", "a provider rollout connects at least one certified provider");
  }

  const current = currentProviderActivationRecords(ledger);
  const activatedByProvider = new Map<string, ProviderActivationRecord>();
  for (const record of current) {
    if (record.status === "ACTIVATED") {
      activatedByProvider.set(record.providerName, record);
    }
  }

  const seenProviders = new Set<string>();
  if (Array.isArray(p.items)) {
    p.items.forEach((item, index) => {
      const field = `items[${index}]`;
      if (typeof item !== "object" || item === null) {
        push(field, "not an object");
        return;
      }
      const i = item as Record<string, unknown>;
      if (typeof i.providerName !== "string" || i.providerName.length < 2) {
        push(`${field}.providerName`, "must be a non-trivial string");
      } else if (seenProviders.has(i.providerName)) {
        push(`${field}.providerName`, `duplicate plan item for '${i.providerName}'`);
      } else {
        seenProviders.add(i.providerName);
      }

      if (typeof i.activationRecordId !== "string") {
        push(`${field}.activationRecordId`, "must reference the ledger record");
      } else {
        const activated = activatedByProvider.get(String(i.providerName));
        if (activated === undefined) {
          push(
            `${field}.activationRecordId`,
            `provider '${String(i.providerName)}' has no CURRENT ACTIVATED ledger record — only live-evidence-backed activations may roll out`,
          );
        } else if (activated.recordId !== i.activationRecordId) {
          push(
            `${field}.activationRecordId`,
            `does not resolve to the current ACTIVATED record ('${activated.recordId}')`,
          );
        }
      }

      const certification = i.certification;
      if (typeof certification !== "object" || certification === null) {
        push(`${field}.certification`, "conformance certification evidence is required (P2-W2-003)");
      } else {
        const c = certification as Record<string, unknown>;
        if (
          typeof c.certificationId !== "string" ||
          c.certificationId.length < 3
        ) {
          push(`${field}.certification.certificationId`, "must reference the certification run");
        }
        if (
          typeof c.providerName !== "string" ||
          c.providerName !== i.providerName
        ) {
          push(`${field}.certification.providerName`, "must name the same provider");
        }
        if (typeof c.executed !== "number" || typeof c.passed !== "number" || typeof c.failed !== "number" || typeof c.notApplicable !== "number") {
          push(`${field}.certification`, "executed/passed/failed/notApplicable must be numbers");
        } else if (c.failed !== 0 || c.passed <= 0 || c.executed <= 0) {
          push(
            `${field}.certification`,
            `certification is not conclusive (executed=${String(c.executed)}, passed=${String(c.passed)}, failed=${String(c.failed)}) — zero failed pairs required`,
          );
        }
        if (typeof c.evidencePath !== "string" || c.evidencePath.length < 5) {
          push(`${field}.certification.evidencePath`, "must reference the certification evidence");
        }
      }

      if (i.limitations !== undefined && !Array.isArray(i.limitations)) {
        push(`${field}.limitations`, "must be an array of strings when present");
      }
    });
  }

  // Environment provider sets: exact match with the plan items, plus shape.
  for (const envField of ["preview", "production"] as const) {
    const env = p[envField];
    if (typeof env !== "object" || env === null) {
      push(envField, `missing ${envField} provider set (parity is explicit)`);
      continue;
    }
    const e = env as Record<string, unknown>;
    if (e.environment !== envField) {
      push(`${envField}.environment`, `must be "${envField}"`);
    }
    if (!Array.isArray(e.providers)) {
      push(`${envField}.providers`, "must be an array of provider bindings");
      continue;
    }
    const names: string[] = [];
    e.providers.forEach((binding, index) => {
      const field = `${envField}.providers[${index}]`;
      if (typeof binding !== "object" || binding === null) {
        push(field, "not an object");
        return;
      }
      const b = binding as Record<string, unknown>;
      if (typeof b.providerName !== "string") {
        push(`${field}.providerName`, "must be a string");
      } else {
        names.push(b.providerName);
        if (!seenProviders.has(b.providerName)) {
          push(
            `${field}.providerName`,
            `provider '${b.providerName}' is bound in ${envField} but has no plan item`,
          );
        }
      }
      if (typeof b.activationRecordId !== "string" || b.activationRecordId.length < 3) {
        push(`${field}.activationRecordId`, "must reference the ledger record");
      }
      if (
        typeof b.configKey !== "string" ||
        !PROVIDER_CREDENTIAL_CONFIG_KEY_PATTERN.test(b.configKey)
      ) {
        push(`${field}.configKey`, "must match PROVIDER_<NAME>_CREDENTIAL_REF");
      }
      if (
        typeof b.vaultReference !== "string" ||
        !VAULT_REFERENCE_PATTERN.test(b.vaultReference)
      ) {
        push(`${field}.vaultReference`, "must be a vault:// reference (never a value)");
      }
    });
    for (const planned of seenProviders) {
      if (!names.includes(planned)) {
        push(
          `${envField}.providers`,
          `planned provider '${planned}' is missing from ${envField}`,
        );
      }
    }
  }

  if (p.nonConnections !== undefined) {
    if (!Array.isArray(p.nonConnections)) {
      push("nonConnections", "must be an array when present");
    } else {
      p.nonConnections.forEach((entry, index) => {
        const field = `nonConnections[${index}]`;
        if (typeof entry !== "object" || entry === null) {
          push(field, "not an object");
          return;
        }
        const n = entry as Record<string, unknown>;
        if (typeof n.providerName !== "string" || n.providerName.length < 2) {
          push(`${field}.providerName`, "must be a non-trivial string");
        } else if (seenProviders.has(n.providerName)) {
          push(
            `${field}.providerName`,
            `'${n.providerName}' is both a plan item and a non-connection (ambiguous)`,
          );
        }
        if (
          n.status !== "BLOCKED" &&
          n.status !== "NO_CREDENTIAL_HELD" &&
          n.status !== "NOT_ACTIVATED"
        ) {
          push(`${field}.status`, "must be BLOCKED, NO_CREDENTIAL_HELD or NOT_ACTIVATED");
        }
        if (typeof n.reason !== "string" || n.reason.length < 3) {
          push(`${field}.reason`, "the honest non-connection reason is required");
        }
      });
    }
  }

  // Secret hygiene over the whole plan (references only).
  for (const hit of collectSecretShapedStrings(plan, "plan")) {
    push(hit, "secret-shaped value in a rollout plan (references only)");
  }

  // The authorization mode is validated through the ledger record's
  // credential binding (the append checker already enforced the canonical
  // union when the record entered the ledger).
  if (allowedAuthorizationModes.length === 0) {
    push(
      "allowedAuthorizationModes",
      "the caller must pass the canonical authorization-mode union (@payswap/connectors AUTHORIZATION_MODES)",
    );
  }

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Execution — the reproducible release record
// ---------------------------------------------------------------------------

/** The browser-verification evidence gating the rollout (P2-W3-003). */
export interface ProviderRolloutBrowserEvidence {
  readonly suiteId: string;
  readonly workOrder: string;
  readonly passed: boolean;
  readonly digest: string;
  /** How many real-path journey runs the report carries. */
  readonly journeyRunCount: number;
}

/** One connected provider in the release record. */
export interface ConnectedProviderReleaseEntry {
  readonly providerName: string;
  readonly activationRecordId: string;
  readonly connectedInstanceId: string;
  readonly authorizationMode: string;
  readonly configKey: string;
  readonly vaultReferences: {
    readonly preview: string;
    readonly production: string;
  };
  readonly probeEvidence: ProviderProbeEvidenceRef;
  readonly certification: CertificationEvidenceRef;
  readonly limitations: readonly string[];
}

/** The release record: connected providers + evidence + parity + rollback. */
export interface ProviderRolloutReleaseRecord {
  readonly record_type: typeof PROVIDER_ROLLOUT_RELEASE_RECORD_TYPE;
  readonly schema_version: typeof PROVIDER_ROLLOUT_SCHEMA_VERSION;
  readonly workOrder: typeof PROVIDER_ROLLOUT_WORK_ORDER;
  readonly releaseId: string;
  readonly plannedAt: string;
  readonly plannedBy: string;
  readonly connectedProviders: readonly ConnectedProviderReleaseEntry[];
  readonly nonConnections: readonly ProviderRolloutNonConnection[];
  readonly parity: ProviderRolloutParityReport;
  readonly browserVerification: ProviderRolloutBrowserEvidence;
  readonly enablement: readonly ProviderEnablement[];
  readonly rollback: {
    readonly steps: readonly ProviderRolloutRollbackStep[];
    readonly reactivationRequiresFreshEvidence: true;
    readonly rehearsalEvidence: string;
  };
  readonly digest: string;
}

/**
 * Executes the rollout plan into the release record. PURE and
 * REPRODUCIBLE: the same (plan, ledger, browser evidence) triple produces
 * a byte-identical record — "provider activation is reproducible".
 *
 * Fail-closed gates (any violation throws ProviderRolloutError):
 *  1. the plan passes {@link checkProviderRolloutPlan} (certified +
 *     current-ACTIVATED providers only);
 *  2. the preview/production provider parity passes
 *     {@link verifyProviderRolloutParity};
 *  3. the browser-verification evidence PASSED (the real-path journeys
 *     over API/protocol/provider paths — the P2-W3-003 gate);
 *  4. every connected provider resolves ENABLED from the ledger
 *     (enablement-as-data; no override may manufacture a connection).
 */
export function executeProviderRolloutPlan(
  plan: unknown,
  ledger: ProviderActivationLedger,
  browserEvidence: ProviderRolloutBrowserEvidence,
  allowedAuthorizationModes: readonly string[],
): ProviderRolloutReleaseRecord {
  const report = checkProviderRolloutPlan(plan, ledger, allowedAuthorizationModes);
  if (!report.ok) {
    throw new ProviderRolloutError(
      "provider rollout plan failed the Phase 2 contract",
      { issues: report.issues as unknown as PaySwapErrorDetails },
    );
  }
  const p = plan as ProviderRolloutPlan;

  const parity = verifyProviderRolloutParity(p.preview, p.production);
  if (!parity.passed) {
    throw new ProviderRolloutError(
      "preview/production provider parity failed — parity must remain explicit (differences only on the vault-reference allowlist)",
      { parity: parity as unknown as PaySwapErrorDetails },
    );
  }

  if (!browserEvidence.passed) {
    throw new ProviderRolloutError(
      `browser verification evidence '${browserEvidence.suiteId}' did not pass — the rollout gate refuses to connect providers over unverified journeys`,
    );
  }

  const enablement = resolveProviderEnablement(ledger);
  const enabledProviders = new Set(
    enablement.filter((e) => e.enabled).map((e) => e.providerName),
  );

  const activatedByProvider = new Map<string, ProviderActivationRecord>();
  for (const record of currentProviderActivationRecords(ledger)) {
    if (record.status === "ACTIVATED") {
      activatedByProvider.set(record.providerName, record);
    }
  }

  const connectedProviders: ConnectedProviderReleaseEntry[] = p.items.map(
    (item) => {
      const activated = activatedByProvider.get(item.providerName);
      if (
        activated === undefined ||
        activated.connectedInstanceId === undefined ||
        !enabledProviders.has(item.providerName)
      ) {
        throw new ProviderRolloutError(
          `provider '${item.providerName}' did not resolve to an enabled current ACTIVATED record — connect refused (fail-closed)`,
        );
      }
      const previewBinding = p.preview.providers.find(
        (b) => b.providerName === item.providerName,
      );
      const productionBinding = p.production.providers.find(
        (b) => b.providerName === item.providerName,
      );
      if (previewBinding === undefined || productionBinding === undefined) {
        throw new ProviderRolloutError(
          `provider '${item.providerName}' is missing a parity binding (checked above — unreachable guard)`,
        );
      }
      return Object.freeze({
        providerName: item.providerName,
        activationRecordId: activated.recordId,
        connectedInstanceId: activated.connectedInstanceId,
        authorizationMode: activated.credential.authorizationMode,
        configKey: previewBinding.configKey,
        vaultReferences: Object.freeze({
          preview: previewBinding.vaultReference,
          production: productionBinding.vaultReference,
        }),
        probeEvidence: Object.freeze({ ...activated.probeEvidence }),
        certification: Object.freeze({ ...item.certification }),
        limitations: Object.freeze([...item.limitations]),
      });
    },
  );

  const body = {
    record_type: PROVIDER_ROLLOUT_RELEASE_RECORD_TYPE,
    schema_version: PROVIDER_ROLLOUT_SCHEMA_VERSION,
    workOrder: PROVIDER_ROLLOUT_WORK_ORDER,
    releaseId: `${p.planId}@${p.plannedAt}`,
    plannedAt: p.plannedAt,
    plannedBy: p.plannedBy,
    connectedProviders,
    nonConnections: p.nonConnections,
    parity,
    browserVerification: browserEvidence,
    enablement,
    rollback: {
      steps: PROVIDER_ROLLOUT_ROLLBACK_STEPS,
      reactivationRequiresFreshEvidence: true as const,
      rehearsalEvidence:
        "battery: packages/operations/test/provider-rollout.test.ts — rehearseProviderRollback drills deactivate -> disabled -> re-activate -> enabled on derived ledgers",
    },
  };
  return Object.freeze({ ...body, digest: contentDigest(body) });
}

// ---------------------------------------------------------------------------
// Release-record checker (durable artifact validation)
// ---------------------------------------------------------------------------

export interface ProviderRolloutReleaseReport {
  readonly ok: boolean;
  readonly issues: readonly ProviderRolloutCheckIssue[];
}

/**
 * Validates a durable provider-rollout release record: literal
 * record_type/schema_version, at least one connected provider with
 * conclusive certification evidence, vault references only, a PASSED
 * parity report, the canonical five rollback steps, and an intact content
 * digest (the record is tamper-evident against its own body).
 */
export function checkProviderRolloutReleaseRecord(
  record: unknown,
): ProviderRolloutReleaseReport {
  const issues: ProviderRolloutCheckIssue[] = [];
  const push = (field: string, problem: string): void => {
    issues.push({ field, problem });
  };

  if (typeof record !== "object" || record === null) {
    return { ok: false, issues: [{ field: "record", problem: "not an object" }] };
  }
  const r = record as Record<string, unknown>;

  if (r.record_type !== PROVIDER_ROLLOUT_RELEASE_RECORD_TYPE) {
    push("record_type", `must be "${PROVIDER_ROLLOUT_RELEASE_RECORD_TYPE}"`);
  }
  if (r.schema_version !== PROVIDER_ROLLOUT_SCHEMA_VERSION) {
    push("schema_version", `must be "${PROVIDER_ROLLOUT_SCHEMA_VERSION}"`);
  }
  if (r.workOrder !== PROVIDER_ROLLOUT_WORK_ORDER) {
    push("workOrder", `must be "${PROVIDER_ROLLOUT_WORK_ORDER}"`);
  }
  if (typeof r.releaseId !== "string" || r.releaseId.length < 3) {
    push("releaseId", "must be a non-trivial string");
  }

  if (!Array.isArray(r.connectedProviders) || r.connectedProviders.length === 0) {
    push(
      "connectedProviders",
      "the release record names at least one connected provider with evidence",
    );
  } else {
    r.connectedProviders.forEach((entry, index) => {
      const field = `connectedProviders[${index}]`;
      if (typeof entry !== "object" || entry === null) {
        push(field, "not an object");
        return;
      }
      const c = entry as Record<string, unknown>;
      if (typeof c.providerName !== "string" || c.providerName.length < 2) {
        push(`${field}.providerName`, "must be a non-trivial string");
      }
      if (typeof c.connectedInstanceId !== "string" || c.connectedInstanceId.length < 3) {
        push(`${field}.connectedInstanceId`, "a connected provider carries its ConnectedCapabilityInstance (INV-C05)");
      }
      if (typeof c.configKey !== "string" || !PROVIDER_CREDENTIAL_CONFIG_KEY_PATTERN.test(c.configKey)) {
        push(`${field}.configKey`, "must match PROVIDER_<NAME>_CREDENTIAL_REF");
      }
      const vaultReferences = c.vaultReferences;
      if (typeof vaultReferences !== "object" || vaultReferences === null) {
        push(`${field}.vaultReferences`, "both environment vault references are required (parity is explicit)");
      } else {
        for (const env of ["preview", "production"] as const) {
          const ref = (vaultReferences as Record<string, unknown>)[env];
          if (typeof ref !== "string" || !VAULT_REFERENCE_PATTERN.test(ref)) {
            push(`${field}.vaultReferences.${env}`, "must be a vault:// reference (never a value)");
          }
        }
      }
      const certification = c.certification;
      if (typeof certification !== "object" || certification === null) {
        push(`${field}.certification`, "certification evidence is required for every connected provider");
      } else {
        const cert = certification as Record<string, unknown>;
        if (
          typeof cert.failed !== "number" ||
          typeof cert.passed !== "number" ||
          cert.failed !== 0 ||
          cert.passed <= 0
        ) {
          push(`${field}.certification`, "certification must be conclusive (zero failed pairs, at least one passed)");
        }
      }
    });
  }

  const parity = r.parity;
  if (typeof parity !== "object" || parity === null) {
    push("parity", "the parity report is required (preview/production parity is explicit)");
  } else if ((parity as Record<string, unknown>).passed !== true) {
    push("parity.passed", "the release parity must have passed");
  }

  const browserVerification = r.browserVerification;
  if (
    typeof browserVerification !== "object" ||
    browserVerification === null ||
    (browserVerification as Record<string, unknown>).passed !== true
  ) {
    push("browserVerification.passed", "the real-path browser verification must have passed");
  }

  const rollback = r.rollback;
  if (typeof rollback !== "object" || rollback === null) {
    push("rollback", "the rollback path is documented in the release record");
  } else {
    const steps = (rollback as Record<string, unknown>).steps;
    if (!Array.isArray(steps) || steps.join(",") !== PROVIDER_ROLLOUT_ROLLBACK_STEPS.join(",")) {
      push("rollback.steps", "must be exactly the five canonical rollback steps");
    }
    if ((rollback as Record<string, unknown>).reactivationRequiresFreshEvidence !== true) {
      push("rollback.reactivationRequiresFreshEvidence", "must be true (fresh live evidence required)");
    }
  }

  // Secret hygiene over the whole record.
  for (const hit of collectSecretShapedStrings(record, "record")) {
    push(hit, "secret-shaped value in a release record (references only)");
  }

  // Digest integrity: the record carries the digest of its own body.
  if (typeof r.digest !== "string" || r.digest.length < 3) {
    push("digest", "the release record carries its content digest");
  } else {
    const { digest: _ignored, ...body } = r;
    const recomputed = contentDigest(body);
    if (recomputed !== r.digest) {
      push(
        "digest",
        `digest mismatch (record says '${r.digest}', body digests '${recomputed}') — the record body changed after digesting`,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Rollback / deactivation (the tested path)
// ---------------------------------------------------------------------------

/** The evidence backing a deactivation (rollback steps 1-2). */
export interface ProviderDeactivationEvidence {
  readonly reason: string;
  readonly evidencePath: string;
  readonly decidedAt: string;
  readonly decidedBy: string;
}

/**
 * Rolls back one provider: appends a REVOKED activation record superseding
 * its current ACTIVATED record (immutable history; the connected instance
 * reference is dropped — only an ACTIVATED record may carry one). The
 * credential binding and the probe evidence that justified the activation
 * are carried forward into the revocation so the record remains
 * self-describing history. Fail-closed: a provider with no current
 * ACTIVATED record cannot be deactivated (there is nothing to roll back).
 */
export function deactivateProvider(
  ledger: ProviderActivationLedger,
  providerName: string,
  evidence: ProviderDeactivationEvidence,
  allowedAuthorizationModes: readonly string[],
): ProviderActivationLedger {
  const current = currentProviderActivationRecords(ledger).find(
    (record) => record.providerName === providerName,
  );
  if (current === undefined || current.status !== "ACTIVATED") {
    throw new ProviderRolloutError(
      `provider '${providerName}' has no current ACTIVATED record to deactivate (fail-closed rollback)`,
    );
  }
  if (typeof evidence.reason !== "string" || evidence.reason.length < 3) {
    throw new ProviderRolloutError("deactivation evidence requires a reason");
  }
  if (!ISO_8601_UTC_PATTERN.test(evidence.decidedAt)) {
    throw new ProviderRolloutError(
      "deactivation evidence requires an ISO-8601 UTC decidedAt timestamp",
    );
  }
  return appendProviderActivationRecord(
    ledger,
    {
      record_type: PROVIDER_ACTIVATION_RECORD_TYPE,
      schema_version: PROVIDER_ACTIVATION_SCHEMA_VERSION,
      recordId: `rollback:${providerName}:${evidence.decidedAt}`,
      providerName,
      credential: { ...current.credential },
      probeEvidence: { ...current.probeEvidence },
      status: "REVOKED",
      limitations: [
        ...current.limitations,
        `deactivated: ${evidence.reason} (evidence: ${evidence.evidencePath})`,
      ],
      supersedes: current.recordId,
      recordedAt: evidence.decidedAt,
      recordedBy: evidence.decidedBy,
    },
    allowedAuthorizationModes,
  );
}

/** The re-activation input (rollback step 5: FRESH live evidence). */
export interface ProviderReactivationInput {
  readonly providerName: string;
  readonly freshProbeEvidence: ProviderProbeEvidenceRef;
  readonly connectedInstanceId: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly limitations: readonly string[];
}

/**
 * Re-activates a revoked provider (rollback step 5). The fresh probe
 * evidence MUST be timestamped STRICTLY AFTER the revocation — re-activation
 * on the pre-revocation evidence is refused (operator input is never
 * integration proof, and neither is stale probe evidence). A fresh
 * connected instance is required (INV-C05).
 */
export function reactivateProvider(
  ledger: ProviderActivationLedger,
  input: ProviderReactivationInput,
  allowedAuthorizationModes: readonly string[],
): ProviderActivationLedger {
  const current = currentProviderActivationRecords(ledger).find(
    (record) => record.providerName === input.providerName,
  );
  if (current === undefined || current.status !== "REVOKED") {
    throw new ProviderRolloutError(
      `provider '${input.providerName}' has no current REVOKED record to re-activate (the re-activation path starts from a revocation)`,
    );
  }
  if (input.freshProbeEvidence.probedAt <= current.recordedAt) {
    throw new ProviderRolloutError(
      `re-activation requires FRESH probe evidence: probedAt '${input.freshProbeEvidence.probedAt}' must be strictly after the revocation '${current.recordedAt}'`,
    );
  }
  if (input.connectedInstanceId.length < 3) {
    throw new ProviderRolloutError(
      "re-activation requires a fresh ConnectedCapabilityInstance reference (INV-C05)",
    );
  }
  return appendProviderActivationRecord(
    ledger,
    {
      record_type: PROVIDER_ACTIVATION_RECORD_TYPE,
      schema_version: PROVIDER_ACTIVATION_SCHEMA_VERSION,
      recordId: `reactivation:${input.providerName}:${input.recordedAt}`,
      providerName: input.providerName,
      credential: { ...current.credential },
      probeEvidence: { ...input.freshProbeEvidence },
      status: "ACTIVATED",
      connectedInstanceId: input.connectedInstanceId,
      limitations: [...input.limitations],
      supersedes: current.recordId,
      recordedAt: input.recordedAt,
      recordedBy: input.recordedBy,
    },
    allowedAuthorizationModes,
  );
}

/** One drilled step of the rollback rehearsal. */
export interface RollbackRehearsalStep {
  readonly step: ProviderRolloutRollbackStep | "RE_ENABLEMENT_VERIFICATION";
  readonly providerName: string;
  readonly outcome: "SATISFIED" | "FAILED";
  readonly note: string;
}

export interface ProviderRollbackRehearsalReport {
  readonly rehearsalId: "provider-rollout-rollback-rehearsal";
  readonly providers: readonly string[];
  readonly steps: readonly RollbackRehearsalStep[];
  readonly allSatisfied: boolean;
  readonly originalLedgerUntouched: true;
  readonly digest: string;
}

/**
 * Drills the full rollback/deactivation path on DERIVED ledgers (the
 * ledger is functional and append-only, so the rehearsal can never touch
 * production history): deactivate -> verify enablement flipped to NOT
 * ENABLED -> re-activate with fresh evidence -> verify enablement restored.
 * Every step's outcome is recorded honestly; any failure fails the report.
 */
export function rehearseProviderRollback(
  ledger: ProviderActivationLedger,
  providers: readonly string[],
  deactivation: ProviderDeactivationEvidence,
  reactivations: readonly ProviderReactivationInput[],
  allowedAuthorizationModes: readonly string[],
): ProviderRollbackRehearsalReport {
  const steps: RollbackRehearsalStep[] = [];
  const record = (
    step: RollbackRehearsalStep["step"],
    providerName: string,
    outcome: "SATISFIED" | "FAILED",
    note: string,
  ): void => {
    steps.push({ step, providerName, outcome, note });
  };

  let rehearsalLedger = ledger;
  for (const providerName of providers) {
    // Steps 1-3: the deactivation (override-as-data + REVOKED record +
    // instance retirement are one ledger transition in this contract layer).
    try {
      rehearsalLedger = deactivateProvider(
        rehearsalLedger,
        providerName,
        deactivation,
        allowedAuthorizationModes,
      );
      record(
        "OPERATOR_DISABLE_OVERRIDE",
        providerName,
        "SATISFIED",
        "enablement derives from the ledger — the REVOKED record flips it without any redeploy",
      );
      record(
        "REVOCATION_RECORD_APPEND",
        providerName,
        "SATISFIED",
        "REVOKED record appended superseding the ACTIVATED record (immutable history)",
      );
      record(
        "CONNECTED_INSTANCE_RETIREMENT",
        providerName,
        "SATISFIED",
        "the REVOKED record carries no connected-instance reference (only ACTIVATED records may)",
      );
    } catch (error) {
      record(
        "REVOCATION_RECORD_APPEND",
        providerName,
        "FAILED",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }

    const disabled = resolveProviderEnablement(rehearsalLedger).find(
      (e) => e.providerName === providerName,
    );
    if (disabled !== undefined && !disabled.enabled) {
      record(
        "RE_ENABLEMENT_VERIFICATION",
        providerName,
        "SATISFIED",
        `enablement resolved NOT ENABLED after revocation (${disabled.reason})`,
      );
    } else {
      record(
        "RE_ENABLEMENT_VERIFICATION",
        providerName,
        "FAILED",
        "enablement did not flip to NOT ENABLED after the revocation — fail-closed law violated",
      );
    }
  }

  for (const input of reactivations) {
    // Step 4-5: fresh probe + re-activation with a fresh instance.
    try {
      rehearsalLedger = reactivateProvider(
        rehearsalLedger,
        input,
        allowedAuthorizationModes,
      );
      record(
        "RE_VERIFICATION_PROBE",
        input.providerName,
        "SATISFIED",
        `fresh probe evidence accepted (probedAt ${input.freshProbeEvidence.probedAt} strictly after the revocation)`,
      );
      record(
        "RE_ACTIVATION_WITH_FRESH_EVIDENCE",
        input.providerName,
        "SATISFIED",
        `ACTIVATED record appended with fresh connected instance ${input.connectedInstanceId}`,
      );
    } catch (error) {
      record(
        "RE_ACTIVATION_WITH_FRESH_EVIDENCE",
        input.providerName,
        "FAILED",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    const enabled = resolveProviderEnablement(rehearsalLedger).find(
      (e) => e.providerName === input.providerName,
    );
    if (enabled !== undefined && enabled.enabled) {
      record(
        "RE_ENABLEMENT_VERIFICATION",
        input.providerName,
        "SATISFIED",
        `enablement restored (${enabled.reason})`,
      );
    } else {
      record(
        "RE_ENABLEMENT_VERIFICATION",
        input.providerName,
        "FAILED",
        "enablement did not restore after re-activation",
      );
    }
  }

  const body = {
    rehearsalId: "provider-rollout-rollback-rehearsal" as const,
    providers,
    steps,
  };
  return Object.freeze({
    ...body,
    allSatisfied: steps.every((step) => step.outcome === "SATISFIED"),
    originalLedgerUntouched: true as const,
    digest: contentDigest(body),
  });
}
