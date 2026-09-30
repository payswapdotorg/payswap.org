import { contentDigest } from "../canonical.js";
import type { AgentPackage, PackageLifecycleState } from "../package.js";
import { canTransitionPackage, transitionPackage } from "../package.js";

/**
 * Package lifecycle ledger and certification metadata (W2-002,
 * FROZEN-ARCHITECTURE §13).
 *
 * The Stage-0 state machine (`transitionPackage`) defines WHICH transitions
 * are legal. This ledger adds the §13 evidence discipline on top:
 *
 * - every promotion requires an EXPLICIT actor (`decidedBy`), a timestamp and
 *   at least one evidence reference — silent promotions are impossible;
 * - promotion history is APPEND-ONLY (`PromotionRecord { from; to;
 *   evidenceRefs; decidedBy; decidedAt }`), in decision order;
 * - certification metadata (§13) is attached at `certify` (reviewers,
 *   evaluation suite, report references);
 * - `publish` SEALS the distributable content under its frozen content hash:
 *   the published artifact is deep-frozen, `resume` re-verifies integrity, and
 *   any content drift from the sealed hash fails closed (released versions are
 *   immutable, INV-G02 — changes require a new package version);
 * - `retire` is terminal (Stage-0 graph; INV-X04 monotonic terminal states).
 */

/** Raised on invalid lifecycle evidence or integrity violations. */
export class PackageLifecycleLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageLifecycleLedgerError";
  }
}

/** Evidence every promotion must carry (§13: actor, timestamp, evidence refs). */
export interface LifecycleEvidence {
  readonly decidedBy: string;
  readonly decidedAt: number;
  readonly evidenceRefs: readonly string[];
}

/** Certification evidence: reviewers plus evaluation report references. */
export interface CertificationEvidence extends LifecycleEvidence {
  readonly certifiedBy: readonly string[];
  readonly evaluationReportRefs: readonly string[];
}

/** Append-only promotion record — the explicit promotion state trail. */
export interface PromotionRecord {
  readonly from: PackageLifecycleState;
  readonly to: PackageLifecycleState;
  readonly evidenceRefs: readonly string[];
  readonly decidedBy: string;
  readonly decidedAt: number;
}

/** §13 certification metadata attached at the `certify` step. */
export interface CertificationMetadata {
  readonly certifiedAt: number;
  readonly certifiedBy: readonly string[];
  readonly evaluationSuiteRef: string;
  readonly evaluationReportRefs: readonly string[];
  /** Content hash of the certified version — sealed at publish. */
  readonly contentHash: string;
}

/** A published, sealed package version: immutable and content-addressed (INV-G02). */
export interface SealedPackageVersion {
  readonly package: AgentPackage;
  readonly contentHash: string;
  readonly sealedAt: number;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new PackageLifecycleLedgerError(`${label} must not be empty`);
  }
}

function validateEvidence(evidence: LifecycleEvidence, minimumDecidedAt: number): void {
  requireNonEmpty(evidence.decidedBy, "evidence.decidedBy");
  if (evidence.evidenceRefs.length === 0) {
    throw new PackageLifecycleLedgerError(
      "evidence.evidenceRefs must carry at least one reference: silent promotions are impossible (§13)",
    );
  }
  for (const ref of evidence.evidenceRefs) {
    requireNonEmpty(ref, "evidence.evidenceRefs entry");
  }
  if (evidence.decidedAt < minimumDecidedAt) {
    throw new PackageLifecycleLedgerError(
      `evidence.decidedAt ${evidence.decidedAt} precedes the previous decision at ${minimumDecidedAt}: promotion history is monotonic`,
    );
  }
}

function deepFreeze(value: object): void {
  if (Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const child = (value as Readonly<Record<string, unknown>>)[key];
    if (child !== null && typeof child === "object") {
      deepFreeze(child);
    }
  }
}

/**
 * Deterministic content hash of the DISTRIBUTABLE package content: every
 * AgentPackage field EXCEPT the mutable lifecycle marker. Two versions of the
 * same id+version with different content hash are different artifacts.
 */
export function packageContentHash(pkg: AgentPackage): string {
  const { lifecycle: _excluded, ...distributable } = pkg;
  return contentDigest(distributable);
}

/**
 * In-memory package lifecycle ledger. Deterministic: the ledger never reads a
 * clock or mints ids — every timestamp and reference arrives explicitly in
 * the evidence.
 */
export class PackageLifecycleLedger {
  #pkg: AgentPackage;
  readonly #records: PromotionRecord[] = [];
  #certification: CertificationMetadata | undefined;
  #sealed: SealedPackageVersion | undefined;
  readonly #registeredAt: number;

  constructor(pkg: AgentPackage, registeredAt: number) {
    requireNonEmpty(pkg.id, "package id");
    if (pkg.version < 1) {
      throw new PackageLifecycleLedgerError("package version must be >= 1");
    }
    if (registeredAt < 0) {
      throw new PackageLifecycleLedgerError("registeredAt must be >= 0");
    }
    this.#pkg = { ...pkg };
    this.#registeredAt = registeredAt;
  }

  /** The current package artifact (frozen once published). */
  current(): AgentPackage {
    return this.#pkg;
  }

  /** Current lifecycle state. */
  state(): PackageLifecycleState {
    return this.#pkg.lifecycle;
  }

  /** Append-only promotion history, in decision order. */
  history(): readonly PromotionRecord[] {
    return [...this.#records];
  }

  /** Certification metadata (defined after `certify`). */
  certification(): CertificationMetadata | undefined {
    return this.#certification;
  }

  /** The sealed published version (defined after `publish`). */
  sealedVersion(): SealedPackageVersion | undefined {
    return this.#sealed;
  }

  /**
   * True iff `candidate` is byte-for-byte the sealed distributable content
   * (same content hash). Tampered or re-versioned content fails closed.
   */
  verifyIntegrity(candidate: AgentPackage): boolean {
    const sealed = this.#sealed;
    if (sealed === undefined) {
      return false;
    }
    return packageContentHash(candidate) === sealed.contentHash;
  }

  #lastDecidedAt(): number {
    const last = this.#records[this.#records.length - 1];
    return last === undefined ? this.#registeredAt : last.decidedAt;
  }

  #apply(to: PackageLifecycleState, evidence: LifecycleEvidence): AgentPackage {
    if (this.#sealed !== undefined && !this.verifyIntegrity(this.#pkg)) {
      throw new PackageLifecycleLedgerError(
        "package content no longer matches the sealed published hash: released versions are immutable (INV-G02); create a new version instead",
      );
    }
    validateEvidence(evidence, this.#lastDecidedAt());
    if (!canTransitionPackage(this.#pkg.lifecycle, to)) {
      // Delegate to the Stage-0 error for the exact allowed-target message.
      transitionPackage(this.#pkg, to);
    }
    const from = this.#pkg.lifecycle;
    this.#pkg = transitionPackage(this.#pkg, to);
    this.#records.push({
      from,
      to,
      evidenceRefs: [...evidence.evidenceRefs],
      decidedBy: evidence.decidedBy,
      decidedAt: evidence.decidedAt,
    });
    return this.#pkg;
  }

  /** DRAFT → STATIC_ANALYSIS. */
  submitForStaticAnalysis(evidence: LifecycleEvidence): AgentPackage {
    return this.#apply("STATIC_ANALYSIS", evidence);
  }

  /** STATIC_ANALYSIS → BENCHMARKED. */
  benchmark(evidence: LifecycleEvidence): AgentPackage {
    return this.#apply("BENCHMARKED", evidence);
  }

  /** BENCHMARKED → SECURITY_REVIEW. */
  securityReview(evidence: LifecycleEvidence): AgentPackage {
    return this.#apply("SECURITY_REVIEW", evidence);
  }

  /**
   * SECURITY_REVIEW → CERTIFIED: attaches §13 certification metadata
   * (reviewers, evaluation suite and report references, content hash).
   */
  certify(evidence: CertificationEvidence): AgentPackage {
    if (evidence.certifiedBy.length === 0) {
      throw new PackageLifecycleLedgerError(
        "certification requires at least one reviewer (certifiedBy)",
      );
    }
    for (const reviewer of evidence.certifiedBy) {
      requireNonEmpty(reviewer, "certifiedBy entry");
    }
    if (evidence.evaluationReportRefs.length === 0) {
      throw new PackageLifecycleLedgerError(
        "certification requires at least one evaluation report reference",
      );
    }
    for (const ref of evidence.evaluationReportRefs) {
      requireNonEmpty(ref, "evaluationReportRefs entry");
    }
    const certified = this.#apply("CERTIFIED", evidence);
    this.#certification = {
      certifiedAt: evidence.decidedAt,
      certifiedBy: [...evidence.certifiedBy],
      evaluationSuiteRef: certified.evaluationSuiteRef,
      evaluationReportRefs: [...evidence.evaluationReportRefs],
      contentHash: packageContentHash(certified),
    };
    return certified;
  }

  /**
   * CERTIFIED → AVAILABLE: seals the distributable content under its frozen
   * content hash and deep-freezes the published artifact. From here the
   * version is immutable (INV-G02).
   */
  publish(evidence: LifecycleEvidence): SealedPackageVersion {
    const published = this.#apply("AVAILABLE", evidence);
    const sealed: SealedPackageVersion = {
      package: published,
      contentHash: packageContentHash(published),
      sealedAt: evidence.decidedAt,
    };
    deepFreeze(sealed);
    this.#sealed = sealed;
    return sealed;
  }

  /** AVAILABLE → SUSPENDED. */
  suspend(evidence: LifecycleEvidence): AgentPackage {
    return this.#apply("SUSPENDED", evidence);
  }

  /**
   * SUSPENDED → AVAILABLE: integrity is re-verified against the sealed hash
   * BEFORE the transition — a tampered artifact can never return to
   * circulation.
   */
  resume(evidence: LifecycleEvidence): AgentPackage {
    return this.#apply("AVAILABLE", evidence);
  }

  /** SUSPENDED → RETIRED (terminal). */
  retire(evidence: LifecycleEvidence): AgentPackage {
    return this.#apply("RETIRED", evidence);
  }
}
