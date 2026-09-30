import { describe, expect, it } from "vitest";
import {
  PACKAGE_LIFECYCLE,
  PackageLifecycleError,
  canTransitionPackage,
  transitionPackage,
} from "../src/index.js";
import type { AgentPackage } from "../src/index.js";

/**
 * FROZEN-ARCHITECTURE §13 lifecycle:
 * DRAFT → STATIC_ANALYSIS → BENCHMARKED → SECURITY_REVIEW → CERTIFIED →
 * AVAILABLE → SUSPENDED → RETIRED. Skipping states is rejected; AVAILABLE↔
 * SUSPENDED is allowed in both directions; RETIRED is terminal.
 */

function makePackage(): AgentPackage {
  return {
    id: "pkg:payer-agent",
    version: 1,
    bodies: [{ id: "body:payer", version: 1 }],
    organizationTemplates: [{ templateId: "org:payops", version: 1 }],
    requiredExtensions: [{ extensionId: "ext:fx-quotes", version: "1.0.0" }],
    securityEpochRequirements: { requireCurrentEpoch: true },
    runtimeRequirements: { minRuntimeContractVersion: 1, requiredOperations: ["execute", "checkpoint"] },
    modelCompatibility: { interfaceVersion: 1 },
    evaluationSuiteRef: "evalsuite:payer@sha256:abc",
    provenance: { source: "https://github.com/payswapdotorg/payswap.org", contentHash: "fnv1a64:00ff", createdAt: 1_000_000 },
    lifecycle: "DRAFT",
  };
}

describe("AgentPackage lifecycle", () => {
  it("walks the full valid path step by step to RETIRED", () => {
    let pkg = makePackage();
    const seen: string[] = [pkg.lifecycle];
    for (const next of PACKAGE_LIFECYCLE.slice(1)) {
      pkg = transitionPackage(pkg, next);
      seen.push(pkg.lifecycle);
    }
    expect(seen).toEqual([...PACKAGE_LIFECYCLE]);
  });

  it("rejects skipping states", () => {
    expect(() => transitionPackage(makePackage(), "BENCHMARKED")).toThrow(PackageLifecycleError);
    expect(() => transitionPackage(makePackage(), "AVAILABLE")).toThrow(/skipping|allowed targets/i);
    // SUSPENDED -> AVAILABLE (backwards) is allowed, so AVAILABLE -> RETIRED is the skip case
    const suspended = [ "STATIC_ANALYSIS", "BENCHMARKED", "SECURITY_REVIEW", "CERTIFIED", "AVAILABLE", "SUSPENDED" ].reduce(
      (pkg, next) => transitionPackage(pkg, next as AgentPackage["lifecycle"]),
      makePackage(),
    );
    // SUSPENDED -> RETIRED is legal (single step)
    expect(() => transitionPackage(suspended, "RETIRED")).not.toThrow();
  });

  it("rejects AVAILABLE -> RETIRED (must pass through SUSPENDED)", () => {
    const available = ["STATIC_ANALYSIS", "BENCHMARKED", "SECURITY_REVIEW", "CERTIFIED", "AVAILABLE"].reduce(
      (pkg, next) => transitionPackage(pkg, next as AgentPackage["lifecycle"]),
      makePackage(),
    );
    expect(() => transitionPackage(available, "RETIRED")).toThrow(PackageLifecycleError);
  });

  it("allows the AVAILABLE <-> SUSPENDED toggle in both directions", () => {
    const available = ["STATIC_ANALYSIS", "BENCHMARKED", "SECURITY_REVIEW", "CERTIFIED", "AVAILABLE"].reduce(
      (pkg, next) => transitionPackage(pkg, next as AgentPackage["lifecycle"]),
      makePackage(),
    );
    const suspended = transitionPackage(available, "SUSPENDED");
    expect(suspended.lifecycle).toBe("SUSPENDED");
    const restored = transitionPackage(suspended, "AVAILABLE");
    expect(restored.lifecycle).toBe("AVAILABLE");
  });

  it("RETIRED is terminal: every transition out of it is rejected", () => {
    const retired = [...PACKAGE_LIFECYCLE.slice(1)].reduce(
      (pkg, next) => transitionPackage(pkg, next as AgentPackage["lifecycle"]),
      makePackage(),
    );
    expect(retired.lifecycle).toBe("RETIRED");
    for (const target of PACKAGE_LIFECYCLE) {
      if (target === "RETIRED") {
        continue;
      }
      expect(() => transitionPackage(retired, target)).toThrow(PackageLifecycleError);
    }
    expect(() => transitionPackage(retired, "RETIRED")).toThrow(/terminal/i);
  });

  it("transitionPackage is immutable: it returns a new package", () => {
    const draft = makePackage();
    const analyzed = transitionPackage(draft, "STATIC_ANALYSIS");
    expect(draft.lifecycle).toBe("DRAFT");
    expect(analyzed.lifecycle).toBe("STATIC_ANALYSIS");
    expect(analyzed).not.toBe(draft);
  });

  it("canTransitionPackage mirrors transitionPackage exactly", () => {
    expect(canTransitionPackage("DRAFT", "STATIC_ANALYSIS")).toBe(true);
    expect(canTransitionPackage("DRAFT", "CERTIFIED")).toBe(false);
    expect(canTransitionPackage("AVAILABLE", "SUSPENDED")).toBe(true);
    expect(canTransitionPackage("SUSPENDED", "AVAILABLE")).toBe(true);
    expect(canTransitionPackage("RETIRED", "DRAFT")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W2-002 — lifecycle ledger: explicit promotion records, certification
// metadata, sealed immutable published versions (INV-G02, INV-X04).
// ---------------------------------------------------------------------------

import {
  PackageLifecycleLedger,
  PackageLifecycleLedgerError,
  packageContentHash,
} from "../src/index.js";
import type {
  CertificationEvidence,
  LifecycleEvidence,
  PromotionRecord,
  SealedPackageVersion,
} from "../src/index.js";

const REGISTERED_AT = 1_000_000;
const T0 = REGISTERED_AT + 100;
const T1 = T0 + 100;
const T2 = T1 + 100;
const T3 = T2 + 100;
const T4 = T3 + 100;
const T5 = T4 + 100;
const T6 = T5 + 100;
const T7 = T6 + 100;

function evidence(at: number, ref: string, by = "tl:payswapdotorg"): LifecycleEvidence {
  return { decidedBy: by, decidedAt: at, evidenceRefs: [ref] };
}

function certification(at: number): CertificationEvidence {
  return {
    ...evidence(at, "review:security-review-1"),
    certifiedBy: ["reviewer:alice", "reviewer:bob"],
    evaluationReportRefs: ["report:eval-1", "report:eval-2"],
  };
}

function fullLedger(): PackageLifecycleLedger {
  const ledger = new PackageLifecycleLedger(makePackage(), REGISTERED_AT);
  ledger.submitForStaticAnalysis(evidence(T0, "analysis:static-1"));
  ledger.benchmark(evidence(T1, "bench:results-1"));
  ledger.securityReview(evidence(T2, "review:security-1"));
  ledger.certify(certification(T3));
  return ledger;
}

describe("PackageLifecycleLedger — promotion records (W2-002)", () => {
  it("walks the full chain with append-only, explicit promotion records", () => {
    const ledger = fullLedger();
    ledger.publish(evidence(T4, "release:1"));
    ledger.suspend(evidence(T5, "incident:1"));
    ledger.resume(evidence(T6, "incident:1-resolved"));
    // retire passes through SUSPENDED (the Stage-0 graph is frozen)
    ledger.suspend(evidence(T6 + 1, "eol:prepare"));
    ledger.retire(evidence(T7, "eol:1"));
    expect(ledger.state()).toBe("RETIRED");
    expect(ledger.history()).toEqual([
      { from: "DRAFT", to: "STATIC_ANALYSIS", evidenceRefs: ["analysis:static-1"], decidedBy: "tl:payswapdotorg", decidedAt: T0 },
      { from: "STATIC_ANALYSIS", to: "BENCHMARKED", evidenceRefs: ["bench:results-1"], decidedBy: "tl:payswapdotorg", decidedAt: T1 },
      { from: "BENCHMARKED", to: "SECURITY_REVIEW", evidenceRefs: ["review:security-1"], decidedBy: "tl:payswapdotorg", decidedAt: T2 },
      { from: "SECURITY_REVIEW", to: "CERTIFIED", evidenceRefs: ["review:security-review-1"], decidedBy: "tl:payswapdotorg", decidedAt: T3 },
      { from: "CERTIFIED", to: "AVAILABLE", evidenceRefs: ["release:1"], decidedBy: "tl:payswapdotorg", decidedAt: T4 },
      { from: "AVAILABLE", to: "SUSPENDED", evidenceRefs: ["incident:1"], decidedBy: "tl:payswapdotorg", decidedAt: T5 },
      { from: "SUSPENDED", to: "AVAILABLE", evidenceRefs: ["incident:1-resolved"], decidedBy: "tl:payswapdotorg", decidedAt: T6 },
      { from: "AVAILABLE", to: "SUSPENDED", evidenceRefs: ["eol:prepare"], decidedBy: "tl:payswapdotorg", decidedAt: T6 + 1 },
      { from: "SUSPENDED", to: "RETIRED", evidenceRefs: ["eol:1"], decidedBy: "tl:payswapdotorg", decidedAt: T7 },
    ] satisfies PromotionRecord[]);
    // history() returns copies: external mutation cannot rewrite the trail
    const history = ledger.history() as PromotionRecord[];
    history.pop();
    expect(ledger.history()).toHaveLength(9);
  });

  it("rejects silent promotions: empty actor, empty evidence, backwards time", () => {
    const ledger = new PackageLifecycleLedger(makePackage(), REGISTERED_AT);
    expect(() =>
      ledger.submitForStaticAnalysis({ decidedBy: "", decidedAt: T0, evidenceRefs: ["x"] }),
    ).toThrow(PackageLifecycleLedgerError);
    expect(() =>
      ledger.submitForStaticAnalysis({ decidedBy: "tl:x", decidedAt: T0, evidenceRefs: [] }),
    ).toThrow(/silent promotions are impossible/);
    ledger.submitForStaticAnalysis(evidence(T1, "a:1"));
    expect(() => ledger.benchmark(evidence(T0, "b:1"))).toThrow(/monotonic/);
  });

  it("skipping states still throws the Stage-0 PackageLifecycleError", () => {
    const ledger = new PackageLifecycleLedger(makePackage(), REGISTERED_AT);
    expect(() => ledger.publish(evidence(T0, "x"))).toThrow(PackageLifecycleError);
  });
});

describe("PackageLifecycleLedger — certification metadata (W2-002)", () => {
  it("certify attaches reviewers, suite, reports and the content hash", () => {
    const ledger = fullLedger();
    const meta = ledger.certification();
    expect(meta).toEqual({
      certifiedAt: T3,
      certifiedBy: ["reviewer:alice", "reviewer:bob"],
      evaluationSuiteRef: "evalsuite:payer@sha256:abc",
      evaluationReportRefs: ["report:eval-1", "report:eval-2"],
      contentHash: packageContentHash(ledger.current()),
    });
  });

  it("certification requires reviewers and evaluation reports", () => {
    const ledger = new PackageLifecycleLedger(makePackage(), REGISTERED_AT);
    ledger.submitForStaticAnalysis(evidence(T0, "a"));
    ledger.benchmark(evidence(T1, "b"));
    ledger.securityReview(evidence(T2, "c"));
    expect(() =>
      ledger.certify({ ...certification(T3), certifiedBy: [] }),
    ).toThrow(/at least one reviewer/);
    expect(() =>
      ledger.certify({ ...certification(T3), evaluationReportRefs: [] }),
    ).toThrow(/evaluation report reference/);
    expect(ledger.certification()).toBeUndefined();
  });
});

describe("PackageLifecycleLedger — sealed immutable published versions (INV-G02)", () => {
  it("publish seals the content hash and deep-freezes the artifact", () => {
    const ledger = fullLedger();
    const sealed: SealedPackageVersion = ledger.publish(evidence(T4, "release:1"));
    expect(sealed.contentHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(sealed.sealedAt).toBe(T4);
    expect(ledger.sealedVersion()?.contentHash).toBe(sealed.contentHash);
    // the published artifact is frozen: mutation throws in strict mode
    const mutable = sealed as unknown as Record<string, unknown>;
    expect(() => {
      mutable["lifecycle"] = "RETIRED";
    }).toThrow(TypeError);
    const bodies = sealed.package.bodies as unknown as Record<string, unknown>[];
    expect(() => {
      bodies[0]!["id"] = "body:evil";
    }).toThrow(TypeError);
  });

  it("packageContentHash covers the distributable content, not the lifecycle marker", () => {
    const draft = makePackage();
    const analyzed = transitionPackage(draft, "STATIC_ANALYSIS");
    expect(packageContentHash(draft)).toBe(packageContentHash(analyzed));
    const changed: AgentPackage = {
      ...draft,
      evaluationSuiteRef: "evalsuite:payer@sha256:zzz",
    };
    expect(packageContentHash(changed)).not.toBe(packageContentHash(draft));
  });

  it("verifyIntegrity detects tampered content and fails closed on resume", () => {
    const ledger = fullLedger();
    const sealed = ledger.publish(evidence(T4, "release:1"));
    expect(ledger.verifyIntegrity(ledger.current())).toBe(true);
    const tampered: AgentPackage = {
      ...makePackage(),
      evaluationSuiteRef: "evalsuite:payer@sha256:evil",
    };
    expect(ledger.verifyIntegrity(tampered)).toBe(false);
    ledger.suspend(evidence(T5, "incident:1"));
    expect(() => ledger.resume(evidence(T6, "resolved"))).not.toThrow();
    expect(ledger.verifyIntegrity(sealed.package)).toBe(true);
  });

  it("verifyIntegrity is false before anything was published", () => {
    const ledger = new PackageLifecycleLedger(makePackage(), REGISTERED_AT);
    expect(ledger.verifyIntegrity(makePackage())).toBe(false);
  });

  it("retired is terminal in the ledger too (INV-X04)", () => {
    const ledger = fullLedger();
    ledger.publish(evidence(T4, "release:1"));
    ledger.suspend(evidence(T5, "incident:1"));
    ledger.retire(evidence(T6, "eol:1"));
    expect(ledger.state()).toBe("RETIRED");
    expect(() => ledger.resume(evidence(T7, "zombie"))).toThrow(PackageLifecycleError);
    expect(() => ledger.suspend(evidence(T7, "zombie"))).toThrow(PackageLifecycleError);
  });
});
