/**
 * @payswap/operations — provider activation records and safe operator
 * controls (P2-W1-001, Phase 2: REAL PROVIDER ACTIVATION).
 *
 * Authority: spec/phase-2/work-items/P2-W1-001.md ("provider activation
 * records and safe operator controls"; "historical provider activation
 * records are immutable"; "phase-2 state is updated only by the TL after
 * verified merges") + spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md
 * (the canonical separation: account ownership ≠ authorization ≠
 * authentication material ≠ execution ≠ custody) +
 * spec/development-state/provider-probes-20261002.json (the vault
 * reconciliation contract: repo + manifests carry PROVIDER_<NAME>_
 * CREDENTIAL_REF references; raw values stay in the operator vault) +
 * spec/research/PROVIDER-COVERAGE-STRATEGY-2026-10-02.md ("Phase 2 creates
 * a new provider-activation record after live verification"; the existing
 * historical release record still records zero connected financial
 * providers and is never rewritten).
 *
 * The laws this module enforces:
 *
 * 1. ACTIVATION RECORDS ARE VERSIONED, IMMUTABLE AND APPEND-ONLY. A new
 *    provider-activation record (record_type "provider-activation",
 *    schema_version "1.0") SUPERSEDES a prior one by reference — the prior
 *    record is never mutated (INV-E05, historical records immutable). The
 *    ledger is functional: `append` returns a NEW ledger; existing
 *    snapshots cannot change underneath a holder.
 *
 * 2. NO SECRET VALUES, EVER. Records carry the vault REFERENCE and the
 *    credential CONFIG KEY (PROVIDER_<NAME>_CREDENTIAL_REF) only. The
 *    checker rejects secret-shaped values in every string field
 *    (fail-closed byte heuristics — the same class the secrets-hygiene
 *    checker uses).
 *
 * 3. ACTIVATION REQUIRES EVIDENCE. A record may claim status ACTIVATED
 *    only with live probe evidence (verdict VERIFIED/ELIGIBLE) AND a
 *    connected-instance reference; a BLOCKED provider (honest operator-
 *    input status — e.g. MTN MoMo's rejected subscription key, 2026-10-02)
 *    can never carry an instance reference. Operator input is never
 *    treated as proof of integration.
 *
 * 4. ENABLEMENT IS DATA, NOT ENVIRONMENT. Per-provider enablement derives
 *    from the activation records in the system of record plus explicit
 *    operator overrides — never from domain-contract redeployment
 *    (DEPLOYMENT-TOPOLOGY §3.2 rule 4). Fail-closed: a provider with no
 *    verified activation record is NOT enabled, whatever an override says.
 *
 * 5. ROTATION FOLLOWS THE RECORDED PROCEDURE. The per-provider rotation
 *    plan is DERIVED from the canonical `rotate-provider-credentials`
 *    procedure in secrets.ts (swap-reference-then-verify with connected-
 *    instance re-verification, INV-C05) — specialized to the provider's
 *    config key and ledger state, never re-invented here.
 *
 * 6. The canonical AUTHORIZATION-MODE union is owned by @payswap/connectors
 *    (activation.ts). This package's boundary forbids importing it, so the
 *    checker RECEIVES the allowed modes as an input argument — the caller
 *    (the TL gate / operator console) passes the canonical list. No drift:
 *    this module never redefines the vocabulary.
 *
 * Deterministic only: no ambient clock, no entropy, no network. All
 * timestamps are caller-supplied ISO-8601 UTC strings.
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
import type { ErrorCategory, PaySwapErrorDetails } from "@payswap/protocol";
import { SECRET_ROTATION_PROCEDURES } from "./secrets.js";

/** Raised when the provider-activation record contract is violated. */
export class ProviderActivationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "PROVIDER_ACTIVATION_RECORD_INVALID",
      category: "VALIDATION" as ErrorCategory,
      message,
      details,
    });
  }
}

// ---------------------------------------------------------------------------
// Record shape (record_type "provider-activation", schema_version "1.0")
// ---------------------------------------------------------------------------

export const PROVIDER_ACTIVATION_RECORD_TYPE = "provider-activation";
export const PROVIDER_ACTIVATION_SCHEMA_VERSION = "1.0";

/** Honest activation statuses. BLOCKED never carries an instance. */
export const PROVIDER_ACTIVATION_STATUSES = [
  "ACTIVATED",
  "BLOCKED",
  "REVOKED",
  "SUPERSEDED",
] as const;
export type ProviderActivationStatus =
  (typeof PROVIDER_ACTIVATION_STATUSES)[number];

/** Probe verdicts that can back an ACTIVATED record (live evidence only). */
export const ACTIVATION_EVIDENCE_VERDICTS = [
  "VERIFIED",
  "ELIGIBLE",
  "READY",
] as const;
export type ActivationEvidenceVerdict =
  (typeof ACTIVATION_EVIDENCE_VERDICTS)[number];

const VAULT_REFERENCE_PATTERN =
  /^vault:\/\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/;
const PROVIDER_CREDENTIAL_CONFIG_KEY_PATTERN =
  /^PROVIDER_[A-Z0-9]+(?:_[A-Z0-9]+)*_CREDENTIAL_REF$/;
const ISO_8601_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Secret-shaped byte patterns rejected in EVERY record string field. */
const SECRET_SHAPED_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk_live_[A-Za-z0-9]+/,
  /\bpk_live_[A-Za-z0-9]+/,
  /\bsk_test_[A-Za-z0-9]{8,}/,
  /\bwhsec_[A-Za-z0-9]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bvcp_[A-Za-z0-9]{20,}/,
  /\bnapi_[A-Za-z0-9]{20,}/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{8,}/i,
];

/** The live-probe evidence backing an activation record (a reference, not a copy). */
export interface ProviderProbeEvidenceRef {
  /** Path to the probe-evidence record (e.g. spec/development-state/provider-probes-20261002.json). */
  readonly evidencePath: string;
  readonly probedAt: string;
  readonly verdict: ActivationEvidenceVerdict;
  /** Sanitized summary of what was probed (no secret material). */
  readonly summary: string;
}

/** The vault-backed credential binding of a connected provider. */
export interface ProviderCredentialBinding {
  /** The environment/manifest config key (PROVIDER_<NAME>_CREDENTIAL_REF template). */
  readonly configKey: string;
  /** The vault object reference (vault://…) — never a value. */
  readonly vaultReference: string;
  /** The authorization mode claimed for this binding (canonical union value). */
  readonly authorizationMode: string;
}

/** A versioned, immutable provider activation record. */
export interface ProviderActivationRecord {
  readonly record_type: typeof PROVIDER_ACTIVATION_RECORD_TYPE;
  readonly schema_version: typeof PROVIDER_ACTIVATION_SCHEMA_VERSION;
  readonly recordId: string;
  readonly providerName: string;
  readonly credential: ProviderCredentialBinding;
  readonly probeEvidence: ProviderProbeEvidenceRef;
  readonly status: ProviderActivationStatus;
  /** ConnectedCapabilityInstance id — REQUIRED for ACTIVATED, FORBIDDEN otherwise. */
  readonly connectedInstanceId?: string;
  /** Honest limitations carried into every consumer (e.g. "test-mode keys"). */
  readonly limitations: readonly string[];
  /** A superseding record references its predecessor; history is never rewritten. */
  readonly supersedes?: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export interface ProviderActivationCheckIssue {
  readonly field: string;
  readonly problem: string;
}

export interface ProviderActivationCheckReport {
  readonly ok: boolean;
  readonly issues: readonly ProviderActivationCheckIssue[];
}

function isSecretShaped(value: string): boolean {
  return SECRET_SHAPED_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Validates a provider-activation record against the Phase 2 laws.
 * `allowedAuthorizationModes` MUST be the canonical union passed in by the
 * caller (from @payswap/connectors AUTHORIZATION_MODES — this package
 * cannot import it by boundary law, so it is an input, never a copy).
 */
export function checkProviderActivationRecord(
  record: unknown,
  allowedAuthorizationModes: readonly string[],
): ProviderActivationCheckReport {
  const issues: ProviderActivationCheckIssue[] = [];
  const push = (field: string, problem: string): void => {
    issues.push({ field, problem });
  };

  if (typeof record !== "object" || record === null) {
    return { ok: false, issues: [{ field: "record", problem: "not an object" }] };
  }
  const r = record as Record<string, unknown>;

  if (r.record_type !== PROVIDER_ACTIVATION_RECORD_TYPE) {
    push("record_type", `must be "${PROVIDER_ACTIVATION_RECORD_TYPE}"`);
  }
  if (r.schema_version !== PROVIDER_ACTIVATION_SCHEMA_VERSION) {
    push("schema_version", `must be "${PROVIDER_ACTIVATION_SCHEMA_VERSION}"`);
  }
  if (typeof r.recordId !== "string" || r.recordId.length < 3) {
    push("recordId", "must be a non-trivial string");
  }
  if (typeof r.providerName !== "string" || r.providerName.length < 2) {
    push("providerName", "must be a non-trivial string");
  }

  // Credential binding: reference-only, template-conformant config key.
  const credential = r.credential;
  if (typeof credential !== "object" || credential === null) {
    push("credential", "missing credential binding");
  } else {
    const c = credential as Record<string, unknown>;
    if (
      typeof c.configKey !== "string" ||
      !PROVIDER_CREDENTIAL_CONFIG_KEY_PATTERN.test(c.configKey)
    ) {
      push(
        "credential.configKey",
        "must match PROVIDER_<NAME>_CREDENTIAL_REF (the deployment-contract template)",
      );
    }
    if (
      typeof c.vaultReference !== "string" ||
      !VAULT_REFERENCE_PATTERN.test(c.vaultReference)
    ) {
      push("credential.vaultReference", "must be a vault:// reference (never a value)");
    }
    if (
      typeof c.authorizationMode !== "string" ||
      !allowedAuthorizationModes.includes(c.authorizationMode)
    ) {
      push(
        "credential.authorizationMode",
        `must be one of the canonical authorization modes [${allowedAuthorizationModes.join(", ")}]`,
      );
    }
  }

  // Probe evidence: live evidence only, correctly shaped.
  const evidence = r.probeEvidence;
  if (typeof evidence !== "object" || evidence === null) {
    push("probeEvidence", "missing probe evidence (operator input is never proof of integration)");
  } else {
    const e = evidence as Record<string, unknown>;
    if (typeof e.evidencePath !== "string" || e.evidencePath.length < 5) {
      push("probeEvidence.evidencePath", "must reference the probe-evidence record");
    }
    if (typeof e.probedAt !== "string" || !ISO_8601_UTC_PATTERN.test(e.probedAt)) {
      push("probeEvidence.probedAt", "must be an ISO-8601 UTC timestamp");
    }
    if (
      typeof e.verdict !== "string" ||
      !ACTIVATION_EVIDENCE_VERDICTS.includes(e.verdict as ActivationEvidenceVerdict)
    ) {
      push(
        "probeEvidence.verdict",
        `must be one of [${ACTIVATION_EVIDENCE_VERDICTS.join(", ")}] (live-evidence verdicts only)`,
      );
    }
    if (typeof e.summary !== "string" || e.summary.length < 3) {
      push("probeEvidence.summary", "must summarize what was probed");
    }
  }

  // Status + instance coupling: ACTIVATED requires live evidence + an instance;
  // every other status forbids one.
  const status = r.status;
  if (
    typeof status !== "string" ||
    !PROVIDER_ACTIVATION_STATUSES.includes(status as ProviderActivationStatus)
  ) {
    push("status", `must be one of [${PROVIDER_ACTIVATION_STATUSES.join(", ")}]`);
  } else if (status === "ACTIVATED") {
    if (typeof r.connectedInstanceId !== "string" || r.connectedInstanceId.length < 3) {
      push(
        "connectedInstanceId",
        "an ACTIVATED record must reference its ConnectedCapabilityInstance (INV-C05)",
      );
    }
    const verdict = (r.probeEvidence as Record<string, unknown> | undefined)?.verdict;
    if (typeof verdict !== "string" || !ACTIVATION_EVIDENCE_VERDICTS.includes(verdict as ActivationEvidenceVerdict)) {
      push(
        "probeEvidence.verdict",
        "ACTIVATED requires a live-evidence verdict (operator input is never integration proof)",
      );
    }
  } else if (typeof r.connectedInstanceId === "string") {
    push(
      "connectedInstanceId",
      `only an ACTIVATED record may carry a connected-instance reference (status is ${status})`,
    );
  }

  if (typeof r.recordedAt !== "string" || !ISO_8601_UTC_PATTERN.test(r.recordedAt)) {
    push("recordedAt", "must be an ISO-8601 UTC timestamp");
  }
  if (typeof r.recordedBy !== "string" || r.recordedBy.length < 2) {
    push("recordedBy", "must record who recorded it (lineage)");
  }
  if (
    r.limitations !== undefined &&
    (!Array.isArray(r.limitations) ||
      r.limitations.some((l) => typeof l !== "string"))
  ) {
    push("limitations", "must be an array of strings when present");
  }
  if (r.supersedes !== undefined && typeof r.supersedes !== "string") {
    push("supersedes", "must be a recordId string when present");
  }

  // Secret hygiene: no secret-shaped value anywhere in the record.
  const scan = (value: unknown, field: string): void => {
    if (typeof value === "string") {
      if (isSecretShaped(value)) {
        push(field, "secret-shaped value in an activation record (references only)");
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => scan(item, `${field}[${i}]`));
    } else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) scan(v, `${field}.${k}`);
    }
  };
  scan(r, "record");

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Append-only ledger (functional — snapshots never mutate)
// ---------------------------------------------------------------------------

export interface ProviderActivationLedger {
  readonly records: readonly ProviderActivationRecord[];
}

export function emptyProviderActivationLedger(): ProviderActivationLedger {
  return { records: [] };
}

/**
 * Appends a record to the ledger and returns a NEW ledger. Fails closed:
 * the record must pass {@link checkProviderActivationRecord}, the recordId
 * must be unique, a `supersedes` reference must resolve to an existing
 * record of the SAME provider, and a superseded record may not itself be
 * superseded twice (chains are linear). History is never rewritten.
 */
export function appendProviderActivationRecord(
  ledger: ProviderActivationLedger,
  record: unknown,
  allowedAuthorizationModes: readonly string[],
): ProviderActivationLedger {
  const report = checkProviderActivationRecord(record, allowedAuthorizationModes);
  if (!report.ok) {
    throw new ProviderActivationError(
      "provider activation record failed the Phase 2 contract",
      { issues: report.issues as unknown as PaySwapErrorDetails },
    );
  }
  const r = record as ProviderActivationRecord;
  if (ledger.records.some((existing) => existing.recordId === r.recordId)) {
    throw new ProviderActivationError(
      `duplicate provider activation recordId '${r.recordId}' (the ledger is append-only)`,
    );
  }
  if (r.supersedes !== undefined) {
    const predecessor = ledger.records.find((x) => x.recordId === r.supersedes);
    if (predecessor === undefined) {
      throw new ProviderActivationError(
        `supersedes reference '${r.supersedes}' does not resolve (append-only ledger)`,
      );
    }
    if (predecessor.providerName !== r.providerName) {
      throw new ProviderActivationError(
        `supersedes chain crosses providers ('${predecessor.providerName}' -> '${r.providerName}')`,
      );
    }
    if (ledger.records.some((x) => x.supersedes === r.supersedes)) {
      throw new ProviderActivationError(
        `record '${r.supersedes}' is already superseded (chains are linear, history immutable)`,
      );
    }
  }
  const frozen: ProviderActivationRecord = deepFreeze({
    ...r,
    limitations: [...r.limitations],
    credential: { ...r.credential },
    probeEvidence: { ...r.probeEvidence },
  });
  return { records: [...ledger.records, frozen] };
}

/** The latest non-superseded record per provider (the current truth). */
export function currentProviderActivationRecords(
  ledger: ProviderActivationLedger,
): readonly ProviderActivationRecord[] {
  const superseded = new Set(
    ledger.records
      .map((r) => r.supersedes)
      .filter((id): id is string => id !== undefined),
  );
  return ledger.records.filter((r) => !superseded.has(r.recordId));
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item));
  } else if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((item) => deepFreeze(item));
  }
  return Object.freeze(value) as T;
}

// ---------------------------------------------------------------------------
// Operator enablement — DATA in the system of record (never a redeploy)
// ---------------------------------------------------------------------------

export interface ProviderEnablementOverride {
  readonly providerName: string;
  /** An operator may DISABLE a verified provider; enabling cannot bypass evidence. */
  readonly enabled: boolean;
  readonly reason: string;
  readonly decidedAt: string;
}

export interface ProviderEnablement {
  readonly providerName: string;
  readonly enabled: boolean;
  readonly reason: string;
}

/**
 * Resolves per-provider enablement from the LEDGER (the system of record)
 * plus explicit operator overrides. Fail-closed:
 * - no current ACTIVATED record -> NOT ENABLED (whatever an override says);
 * - an override may only DISABLE (an override can never manufacture
 *   enablement without evidence — that would be operator input posing as
 *   integration proof);
 * - providers with only BLOCKED/REVOKED/SUPERSEDED-current records are
 *   not enabled, with the honest reason carried forward.
 */
export function resolveProviderEnablement(
  ledger: ProviderActivationLedger,
  overrides: readonly ProviderEnablementOverride[] = [],
): readonly ProviderEnablement[] {
  const byProvider = new Map<string, ProviderActivationRecord>();
  for (const record of currentProviderActivationRecords(ledger)) {
    byProvider.set(record.providerName, record);
  }
  const overrideByProvider = new Map<string, ProviderEnablementOverride>();
  for (const override of overrides) {
    overrideByProvider.set(override.providerName, override);
  }

  const result: ProviderEnablement[] = [];
  for (const [providerName, record] of byProvider) {
    const override = overrideByProvider.get(providerName);
    if (record.status !== "ACTIVATED") {
      result.push({
        providerName,
        enabled: false,
        reason: `current activation status ${record.status} (evidence-gated, fail-closed)`,
      });
      continue;
    }
    if (override !== undefined && !override.enabled) {
      result.push({
        providerName,
        enabled: false,
        reason: `operator override: ${override.reason} (${override.decidedAt})`,
      });
      continue;
    }
    result.push({
      providerName,
      enabled: true,
      reason: `verified activation ${record.recordId} (probe evidence ${record.probeEvidence.verdict} @ ${record.probeEvidence.probedAt})`,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Credential rotation — derived from the canonical secrets procedure
// ---------------------------------------------------------------------------

export interface ProviderRotationStep {
  readonly stepId: string;
  readonly description: string;
}

export interface ProviderCredentialRotationPlan {
  readonly providerName: string;
  readonly configKey: string;
  readonly procedureId: string;
  readonly steps: readonly ProviderRotationStep[];
  readonly verificationBinding:
    | { readonly kind: "CONNECTED_INSTANCE"; readonly instanceId: string }
    | { readonly kind: "NO_ACTIVE_INSTANCE"; readonly note: string };
}

/**
 * Derives the per-provider credential-rotation plan from the canonical
 * `rotate-provider-credentials` procedure (secrets.ts — swap-reference-
 * then-verify with connected-instance re-verification, INV-C05). The plan
 * binds the procedure to the provider's config key and, when the provider
 * has a current ACTIVATED record, to its connected instance for the
 * verify step. Never re-invented here: a missing canonical procedure is
 * an error, not an improvisation.
 */
export function planProviderCredentialRotation(
  providerName: string,
  ledger: ProviderActivationLedger,
): ProviderCredentialRotationPlan {
  const canonical = SECRET_ROTATION_PROCEDURES.find(
    (procedure) => procedure.configKey === "PROVIDER_CREDENTIAL_REF",
  );
  if (canonical === undefined) {
    throw new ProviderActivationError(
      "canonical rotate-provider-credentials procedure missing from the secrets inventory (cannot improvise rotation)",
    );
  }
  const configKey = `PROVIDER_${providerName.toUpperCase()}_CREDENTIAL_REF`;
  const current = currentProviderActivationRecords(ledger).find(
    (r) => r.providerName === providerName,
  );
  return {
    providerName,
    configKey,
    procedureId: canonical.procedureId,
    steps: canonical.steps.map((step) => ({ ...step })),
    verificationBinding:
      current !== undefined && current.status === "ACTIVATED" && current.connectedInstanceId !== undefined
        ? {
            kind: "CONNECTED_INSTANCE",
            instanceId: current.connectedInstanceId,
          }
        : {
            kind: "NO_ACTIVE_INSTANCE",
            note: "no current ACTIVATED record — the verify step must re-run the live authorization/eligibility probe before any instance is (re)activated",
          },
  };
}
