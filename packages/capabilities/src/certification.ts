/**
 * Certification integration for capabilities and capability packs (W2-003,
 * FROZEN-ARCHITECTURE §LAB, INV-C03, INV-SC04, INV-E05).
 *
 * Certification records attach to capability definitions and (Connector)
 * Capability Packs with evidence references. Retirement marks a subject
 * going-forward unavailable; it can NEVER rewrite in-flight history
 * (INV-C03): the ledger is append-only, every stored record is deep-frozen,
 * and `retire` APPENDS a RETIRED record instead of mutating prior ones.
 *
 * When the certified subject declares a smart-contract extension, the
 * upgrade/governance risk profile is part of the certification (INV-SC04):
 * `certify` rejects a smart-contract-backed certification without
 * `smartContractRisk` (see ./smart-contract.js for the profile).
 *
 * Deterministic by construction: record ids are either caller-supplied or
 * minted from a per-ledger sequence; there is no ambient clock or entropy —
 * timestamps are declared by the caller.
 */

import type { SmartContractRiskProfile } from "./smart-contract.js";

export const CERTIFICATION_STATUSES = [
  "CERTIFIED",
  "SUPERSEDED",
  "REVOKED",
  "RETIRED",
] as const;
export type CertificationStatus = (typeof CERTIFICATION_STATUSES)[number];

/** What a certification record can attach to (W2-003: definitions + packs). */
export const CERTIFICATION_SUBJECT_KINDS = [
  "capability",
  "capability_pack",
] as const;
export type CertificationSubjectKind = (typeof CERTIFICATION_SUBJECT_KINDS)[number];

export const CERTIFICATION_EVIDENCE_KINDS = [
  "TEST_RUN",
  "REVIEW",
  "AUDIT",
  "REPLAY",
  "PROOF",
  "ATTESTATION",
] as const;
export type CertificationEvidenceKind =
  (typeof CERTIFICATION_EVIDENCE_KINDS)[number];

/** The certified subject: a capability definition or a capability pack. */
export interface CertificationSubjectRef {
  readonly kind: CertificationSubjectKind;
  readonly subjectId: string;
  readonly version: string;
}

/** One evidence reference backing a certification (INV-E01/E05). */
export interface CertificationEvidenceRef {
  readonly evidenceId: string;
  readonly kind: CertificationEvidenceKind;
  readonly artifactRef: string;
  readonly contentHash: string;
}

/** An immutable certification record. */
export interface CertificationRecord {
  readonly recordId: string;
  readonly subject: CertificationSubjectRef;
  readonly status: CertificationStatus;
  readonly evidence: readonly CertificationEvidenceRef[];
  /**
   * Upgrade/governance risk profile. REQUIRED when the subject declares a
   * smart-contract extension (INV-SC04) — enforced via CertificationRequirements.
   */
  readonly smartContractRisk?: SmartContractRiskProfile;
  readonly certifiedAt: string;
  readonly validUntil?: string;
  readonly notes?: readonly string[];
}

/** Extra requirements a caller asserts about the subject being certified. */
export interface CertificationRequirements {
  /**
   * True when the subject (capability definition / pack) declares a
   * smart-contract extension: then `smartContractRisk` is mandatory
   * (INV-SC04).
   */
  readonly subjectDeclaresSmartContract?: boolean;
}

/** Input to `CertificationLedger.retire`. */
export interface RetireSubjectInput {
  readonly subjectId: string;
  readonly version: string;
  readonly retiredAt: string;
  readonly note?: string;
}

/** Raised on invalid certification input or history violations. */
export class CertificationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Invalid certification: ${errors.join("; ")}`);
    this.name = "CertificationError";
    this.errors = errors;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isEvidenceKind(value: unknown): value is CertificationEvidenceKind {
  return (
    typeof value === "string" &&
    (CERTIFICATION_EVIDENCE_KINDS as readonly unknown[]).includes(value)
  );
}

/**
 * Deep-clones then freezes a JSON-ish value: stored records are immutable
 * AND caller-supplied objects are never frozen out from under their owner
 * (same policy as the protocol envelope factories).
 */
function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze((value as readonly unknown[]).map(cloneAndFreeze)) as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      copy[key] = cloneAndFreeze(source[key]);
    }
    return Object.freeze(copy) as T;
  }
  return value;
}

function validateEvidence(
  evidence: readonly CertificationEvidenceRef[],
  status: CertificationStatus,
  errors: string[],
): void {
  if (!Array.isArray(evidence)) {
    errors.push("evidence must be an array of evidence references");
    return;
  }
  if (status === "CERTIFIED" && evidence.length === 0) {
    errors.push("a CERTIFIED record requires at least one evidence reference");
  }
  for (const [index, ref] of evidence.entries()) {
    if (ref === null || typeof ref !== "object") {
      errors.push(`evidence[${index}] must be an object`);
      continue;
    }
    if (!isNonEmptyString(ref.evidenceId)) {
      errors.push(`evidence[${index}].evidenceId must be a non-empty string`);
    }
    if (!isEvidenceKind(ref.kind)) {
      errors.push(
        `evidence[${index}].kind must be one of [${CERTIFICATION_EVIDENCE_KINDS.join(", ")}]`,
      );
    }
    if (!isNonEmptyString(ref.artifactRef)) {
      errors.push(`evidence[${index}].artifactRef must be a non-empty string`);
    }
    if (!isNonEmptyString(ref.contentHash)) {
      errors.push(`evidence[${index}].contentHash must be a non-empty string`);
    }
  }
}

function validateRecord(
  record: CertificationRecord,
  errors: string[],
): void {
  if (record === null || typeof record !== "object") {
    errors.push("record must be a CertificationRecord");
    return;
  }
  if (!isNonEmptyString(record.recordId)) {
    errors.push("recordId must be a non-empty string");
  }
  const subject = record.subject;
  if (subject === null || typeof subject !== "object") {
    errors.push("subject must be a CertificationSubjectRef");
  } else {
    if (
      subject.kind !== "capability" &&
      subject.kind !== "capability_pack"
    ) {
      errors.push(
        `subject.kind must be 'capability' or 'capability_pack' (got '${String(subject.kind)}')`,
      );
    }
    if (!isNonEmptyString(subject.subjectId)) {
      errors.push("subject.subjectId must be a non-empty string");
    }
    if (!isNonEmptyString(subject.version)) {
      errors.push("subject.version must be a non-empty string");
    }
  }
  if (
    record.status !== "CERTIFIED" &&
    record.status !== "SUPERSEDED" &&
    record.status !== "REVOKED" &&
    record.status !== "RETIRED"
  ) {
    errors.push(
      `status must be one of [${CERTIFICATION_STATUSES.join(", ")}] (got '${String(record.status)}')`,
    );
  }
  validateEvidence(record.evidence ?? [], record.status, errors);
  if (!isNonEmptyString(record.certifiedAt)) {
    errors.push("certifiedAt must be a non-empty timestamp string");
  }
  if (
    record.validUntil !== undefined &&
    !isNonEmptyString(record.validUntil)
  ) {
    errors.push("validUntil, when present, must be a non-empty string");
  }
}

/**
 * Append-only certification ledger (INV-C03, INV-E05).
 *
 * - `certify` validates and APPENDS a deep-frozen record;
 * - `retire` APPENDS a RETIRED record for a previously certified subject —
 *   prior records are never mutated, so in-flight history is preserved;
 * - `historyFor` returns the immutable record sequence;
 * - `currentStatusFor` / `isAvailableForNewUse` express the going-forward
 *   view (latest record wins).
 */
export class CertificationLedger {
  private readonly records: CertificationRecord[] = [];
  private readonly recordsBySubject = new Map<string, CertificationRecord[]>();
  private readonly recordIds = new Set<string>();
  private nextMintedId = 1;

  /**
   * Validates and appends a certification record.
   * INV-SC04: when `requirements.subjectDeclaresSmartContract` is true, the
   * record MUST carry a `smartContractRisk` profile.
   */
  certify(
    record: CertificationRecord,
    requirements?: CertificationRequirements,
  ): CertificationRecord {
    const errors: string[] = [];
    validateRecord(record, errors);
    if (this.recordIds.has(record.recordId)) {
      errors.push(`recordId '${record.recordId}' already exists in this ledger`);
    }
    if (
      requirements?.subjectDeclaresSmartContract === true &&
      (record.smartContractRisk === undefined ||
        record.smartContractRisk === null)
    ) {
      errors.push(
        "INV-SC04: a subject declaring a smart-contract extension must be certified with an upgrade/governance risk profile (smartContractRisk)",
      );
    }
    if (errors.length > 0) {
      throw new CertificationError(errors);
    }
    const stored = cloneAndFreeze(record) as CertificationRecord;
    this.records.push(stored);
    const key = record.subject.subjectId;
    const history = this.recordsBySubject.get(key) ?? [];
    history.push(stored);
    this.recordsBySubject.set(key, history);
    this.recordIds.add(record.recordId);
    return stored;
  }

  /**
   * Marks a subject going-forward RETIRED by APPENDING a RETIRED record
   * (INV-C03). The subject must have been certified before. Prior records —
   * including in-flight CERTIFIED ones — are preserved untouched.
   */
  retire(input: RetireSubjectInput): CertificationRecord {
    const errors: string[] = [];
    if (!isNonEmptyString(input?.subjectId)) {
      errors.push("subjectId must be a non-empty string");
    }
    if (!isNonEmptyString(input?.version)) {
      errors.push("version must be a non-empty string");
    }
    if (!isNonEmptyString(input?.retiredAt)) {
      errors.push("retiredAt must be a non-empty timestamp string");
    }
    const prior = this.recordsBySubject.get(input.subjectId) ?? [];
    if (prior.length === 0) {
      errors.push(
        `cannot retire '${String(input.subjectId)}': no certification history exists (retirement cannot rewrite history — it only marks previously certified subjects going-forward unavailable)`,
      );
    }
    if (errors.length > 0) {
      throw new CertificationError(errors);
    }
    const firstPrior = prior[0];
    const recordId = `retired:${input.subjectId}:${this.nextMintedId}`;
    this.nextMintedId += 1;
    const notes: string[] = [
      `retired at ${input.retiredAt}`,
      "going-forward unavailability only: prior history is immutable (INV-C03)",
    ];
    if (isNonEmptyString(input.note)) {
      notes.push(input.note);
    }
    const record: CertificationRecord = {
      recordId,
      subject: {
        kind: firstPrior !== undefined ? firstPrior.subject.kind : "capability",
        subjectId: input.subjectId,
        version: input.version,
      },
      status: "RETIRED",
      evidence: [],
      certifiedAt: input.retiredAt,
      notes: Object.freeze(notes),
    };
    const stored = cloneAndFreeze(record);
    this.records.push(stored);
    const key = input.subjectId;
    const history = this.recordsBySubject.get(key) ?? [];
    history.push(stored);
    this.recordsBySubject.set(key, history);
    this.recordIds.add(recordId);
    return stored;
  }

  /** The immutable, append-only history for a subject (INV-C03). */
  historyFor(subjectId: string): readonly CertificationRecord[] {
    return Object.freeze([...(this.recordsBySubject.get(subjectId) ?? [])]);
  }

  /** The latest record for a subject, if any. */
  currentStatusFor(
    subjectId: string,
  ): { readonly status: CertificationStatus; readonly record: CertificationRecord } | undefined {
    const history = this.recordsBySubject.get(subjectId) ?? [];
    const latest = history[history.length - 1];
    if (latest === undefined) {
      return undefined;
    }
    return { status: latest.status, record: latest };
  }

  /**
   * Going-forward availability: a subject is available for NEW acquisitions
   * only while its latest record is CERTIFIED (INV-C03: retirement marks
   * going-forward unavailability; history stays immutable).
   */
  isAvailableForNewUse(subjectId: string): boolean {
    return this.currentStatusFor(subjectId)?.status === "CERTIFIED";
  }

  /** All records ever appended, in append order. */
  allRecords(): readonly CertificationRecord[] {
    return Object.freeze([...this.records]);
  }
}

