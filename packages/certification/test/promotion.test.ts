import { describe, expect, it } from "vitest";
import { PromotionLedger } from "@payswap/lab";
import type { PromotionEvidenceRef } from "@payswap/lab";
import {
  SecurityAdvisoryRegistry,
  SecurityEpochAuthority,
  SecurityGate,
  QuarantineLedger,
} from "@payswap/security";
import {
  ProductionPromotionLedger,
  SecurityHaltError,
  defaultSuiteFor,
  evaluateSuite,
  runSecurityReview,
  runUniformGateWall,
} from "@payswap/certification";
import type {
  RemediationPackage,
  SecurityReviewOutcome,
  SuiteEvidenceSubmission,
  SuiteGateResult,
} from "@payswap/certification";

/**
 * Production promotion and rollback artifacts (W2-006 acceptance: rollback
 * is versioned; evaluation history is immutable; security failures halt
 * promotion irreversibly until a NEW order with remediation evidence;
 * retirement history is preserved — INV-C03/L03/L04). The Lab's REAL
 * PromotionLedger walks a candidate to PRODUCTION and the real promotion
 * order flows into the production ledger (structural consumption).
 */

function labEvidence(
  kinds: readonly PromotionEvidenceRef["kind"][],
): PromotionEvidenceRef[] {
  return kinds.map((kind, index) => ({
    evidenceId: `ev-${kind}-${index}`,
    kind,
    artifactRef: `artifacts/${kind}-${index}`,
    contentDigest: `digest-${kind}-${index}`,
  }));
}

const TRIPLE = labEvidence(["REPLAY", "COUNTERFACTUAL", "ROBUSTNESS"]);

/** Walks a REAL Lab promotion ledger to the PRODUCTION stage. */
function labOrderAtProduction(candidateId: string) {
  const ledger = new PromotionLedger();
  ledger.orderPromotion({
    candidateId,
    candidateVersion: 1,
    targetStage: "BENCHMARKED",
    evidence: labEvidence(["BASELINE_SUITE_EVALUATION"]),
    orderedAt: "t0",
  });
  ledger.orderPromotion({
    candidateId,
    candidateVersion: 1,
    targetStage: "VALIDATED",
    evidence: TRIPLE,
    orderedAt: "t1",
  });
  ledger.orderPromotion({
    candidateId,
    candidateVersion: 1,
    targetStage: "SHADOW",
    evidence: TRIPLE,
    orderedAt: "t2",
  });
  const canary = ledger.orderPromotion({
    candidateId,
    candidateVersion: 1,
    targetStage: "CANARY",
    evidence: [...TRIPLE, ...labEvidence(["SHADOW_REPORT"])],
    orderedAt: "t3",
  });
  const production = ledger.orderPromotion({
    candidateId,
    candidateVersion: 1,
    targetStage: "PRODUCTION",
    evidence: [
      ...TRIPLE,
      ...labEvidence(["SHADOW_REPORT", "CANARY_REPORT"]),
    ],
    orderedAt: "t4",
  });
  return { ledger, canary, production };
}

function suiteEvidenceFor(
  kinds: readonly string[],
): SuiteEvidenceSubmission[] {
  return kinds.map((kind, index) => ({
    evidenceId: `ev-suite-${kind}-${index}`,
    kind: kind as SuiteEvidenceSubmission["kind"],
    artifactRef: `artifacts/suite-${kind}-${index}`,
    contentDigest: `digest-suite-${kind}-${index}`,
  }));
}

function suiteGateResultsFor(
  gateIds: readonly string[],
): SuiteGateResult[] {
  return gateIds.map((gateId) => ({
    gateId: gateId as SuiteGateResult["gateId"],
    passed: true,
  }));
}

function passingSuiteEvaluation(candidateId: string) {
  const suite = defaultSuiteFor("strategy");
  return evaluateSuite({
    suite,
    subject: { componentKind: "strategy", subjectId: candidateId, version: "1" },
    evidence: suiteEvidenceFor(suite.requiredEvidenceKinds),
    gateResults: suiteGateResultsFor(suite.requiredGates),
  });
}

function passingUniformGate(candidateId: string) {
  return runUniformGateWall({
    candidateId,
    executionMode: "COMPOSED_PAYSWAP",
    isIncumbentBaseline: false,
    authorizationEvidence: [
      {
        authorizationRef: "auth:prod-1",
        evidenceRef: "evidence:auth-1",
        issuedAtEpoch: 0n,
      },
    ],
    complianceClearances: [
      {
        clearanceId: "clearance:eu",
        policyRef: "policy:eu-payments@2",
        evidenceRef: "evidence:screening-1",
      },
    ],
    evidence: [
      { evidenceId: "ev-1", kind: "REPLAY", artifactRef: "a/1", contentDigest: "d/1" },
      { evidenceId: "ev-2", kind: "COUNTERFACTUAL", artifactRef: "a/2", contentDigest: "d/2" },
      { evidenceId: "ev-3", kind: "ROBUSTNESS", artifactRef: "a/3", contentDigest: "d/3" },
    ],
  });
}

function cleanImmune() {
  const advisories = new SecurityAdvisoryRegistry();
  const quarantine = new QuarantineLedger();
  const epochs = new SecurityEpochAuthority();
  const gate = new SecurityGate({ advisories, quarantine, epochs });
  return { advisories, quarantine, epochs, gate };
}

function passingSecurityReview(candidateId: string, issuedAtEpoch = 0n): SecurityReviewOutcome {
  return runSecurityReview({
    subject: {
      componentKind: "strategy",
      subjectId: candidateId,
      version: "1",
      screenedComponents: [{ kind: "agent_package", id: "pkg:routing", version: "1.0.0" }],
      authorizationIssuedAtEpoch: issuedAtEpoch,
    },
    immune: cleanImmune().gate,
  });
}

function failingSecurityReview(candidateId: string): SecurityReviewOutcome {
  const { advisories, quarantine, epochs, gate } = cleanImmune();
  const advisory = advisories.publish({
    advisoryId: "PSA-HALT-1",
    title: "Critical vulnerability in the routing package",
    severity: "critical",
    description: "deterministic fixture",
    affected: [{ kind: "agent_package", id: "pkg:routing" }],
    action: "quarantine",
    remediation: { summary: "Upgrade.", patchedVersion: "1.0.1", workarounds: [] },
    declaredBy: "security-team",
    publishedAt: 1_000,
  });
  gate.enforceAdvisory(advisory, { advanceEpoch: true });
  return runSecurityReview({
    subject: {
      componentKind: "strategy",
      subjectId: candidateId,
      version: "1",
      screenedComponents: [{ kind: "agent_package", id: "pkg:routing", version: "1.0.0" }],
      authorizationIssuedAtEpoch: 0n,
    },
    immune: gate,
  });
}

describe("versioned production promotion (INV-L03)", () => {
  it("promotes over the Lab's real versioned PRODUCTION order", () => {
    const { production } = labOrderAtProduction("cand-promote-1");
    expect(production.toStage).toBe("PRODUCTION");
    expect(production.candidateVersion).toBe(1);

    const ledger = new ProductionPromotionLedger();
    const order = ledger.orderProductionPromotion({
      productionOrderId: "prod-order-1",
      subject: { componentKind: "strategy", subjectId: "cand-promote-1", version: "1" },
      subjectVersion: 1,
      labOrder: production, // the REAL Lab promotion order, structurally consumed
      suiteEvaluation: passingSuiteEvaluation("cand-promote-1"),
      uniformGate: passingUniformGate("cand-promote-1"),
      securityReview: passingSecurityReview("cand-promote-1"),
      immune: cleanImmune().gate,
      orderedAt: "2026-10-01T12:00:00Z",
    });
    expect(order.orderKind).toBe("PROMOTE");
    expect(order.subjectVersion).toBe(1);
    expect(order.labOrder.orderDigest).toBe(production.orderDigest);
    expect(order.orderDigest.length).toBeGreaterThan(0);
    expect(ledger.currentProductionStage("cand-promote-1")).toBe("PRODUCTION");
    expect(ledger.historyFor("cand-promote-1")).toHaveLength(1);
    // The successful promotion appended an evaluation-history entry.
    expect(ledger.evaluationHistoryFor("cand-promote-1")).toHaveLength(1);
  });

  it("rejects unversioned promotion references (INV-L03)", () => {
    const { production } = labOrderAtProduction("cand-unversioned-1");
    const ledger = new ProductionPromotionLedger();
    expect(() =>
      ledger.orderProductionPromotion({
        productionOrderId: "prod-order-2",
        subject: { componentKind: "strategy", subjectId: "cand-unversioned-1", version: "1" },
        subjectVersion: 0,
        labOrder: production,
        suiteEvaluation: passingSuiteEvaluation("cand-unversioned-1"),
        uniformGate: passingUniformGate("cand-unversioned-1"),
        securityReview: passingSecurityReview("cand-unversioned-1"),
        immune: cleanImmune().gate,
        orderedAt: "t",
      }),
    ).toThrow(/published immutable snapshot/);

    expect(() =>
      ledger.orderProductionPromotion({
        productionOrderId: "prod-order-3",
        subject: { componentKind: "strategy", subjectId: "cand-unversioned-1", version: "1" },
        subjectVersion: 1,
        labOrder: { ...production, candidateVersion: 0 },
        suiteEvaluation: passingSuiteEvaluation("cand-unversioned-1"),
        uniformGate: passingUniformGate("cand-unversioned-1"),
        securityReview: passingSecurityReview("cand-unversioned-1"),
        immune: cleanImmune().gate,
        orderedAt: "t",
      }),
    ).toThrow(/unversioned promotion is forbidden/);
  });

  it("rejects Lab orders that did not reach the PRODUCTION stage", () => {
    const { canary } = labOrderAtProduction("cand-stage-1");
    const ledger = new ProductionPromotionLedger();
    expect(() =>
      ledger.orderProductionPromotion({
        productionOrderId: "prod-order-4",
        subject: { componentKind: "strategy", subjectId: "cand-stage-1", version: "1" },
        subjectVersion: 1,
        labOrder: canary, // an ADVANCE to CANARY, not PRODUCTION
        suiteEvaluation: passingSuiteEvaluation("cand-stage-1"),
        uniformGate: passingUniformGate("cand-stage-1"),
        securityReview: passingSecurityReview("cand-stage-1"),
        immune: cleanImmune().gate,
        orderedAt: "t",
      }),
    ).toThrow(/ADVANCE order that reached the PRODUCTION stage/);
  });

  it("rejects a failed suite evaluation and a failed uniform gate wall", () => {
    const { production } = labOrderAtProduction("cand-failed-suite");
    const ledger = new ProductionPromotionLedger();
    const suite = defaultSuiteFor("strategy");
    const failedEvaluation = evaluateSuite({
      suite,
      subject: { componentKind: "strategy", subjectId: "cand-failed-suite", version: "1" },
      evidence: suiteEvidenceFor(["REPLAY"]),
      gateResults: suiteGateResultsFor(suite.requiredGates),
    });
    expect(() =>
      ledger.orderProductionPromotion({
        productionOrderId: "prod-order-5",
        subject: { componentKind: "strategy", subjectId: "cand-failed-suite", version: "1" },
        subjectVersion: 1,
        labOrder: production,
        suiteEvaluation: failedEvaluation,
        uniformGate: passingUniformGate("cand-failed-suite"),
        securityReview: passingSecurityReview("cand-failed-suite"),
        immune: cleanImmune().gate,
        orderedAt: "t",
      }),
    ).toThrow(/did not pass/);

    const failedWall = runUniformGateWall({
      candidateId: "cand-failed-suite",
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      isIncumbentBaseline: false,
      authorizationEvidence: [],
      complianceClearances: [],
      evidence: [],
    });
    expect(() =>
      ledger.orderProductionPromotion({
        productionOrderId: "prod-order-6",
        subject: { componentKind: "strategy", subjectId: "cand-failed-suite", version: "1" },
        subjectVersion: 1,
        labOrder: production,
        suiteEvaluation: passingSuiteEvaluation("cand-failed-suite"),
        uniformGate: failedWall,
        securityReview: passingSecurityReview("cand-failed-suite"),
        immune: cleanImmune().gate,
        orderedAt: "t",
      }),
    ).toThrow(/uniform gate wall rejected/);
  });
});

describe("security failures halt promotion irreversibly", () => {
  it("a failed security review halts the order; only a NEW order with remediation promotes", () => {
    const { production } = labOrderAtProduction("cand-halt-1");
    const ledger = new ProductionPromotionLedger();
    const failing = failingSecurityReview("cand-halt-1");
    expect(failing.passed).toBe(false);

    // 1. The failed gate HALTS the order.
    let haltError: unknown;
    try {
      ledger.orderProductionPromotion({
        productionOrderId: "prod-halt-1",
        subject: { componentKind: "strategy", subjectId: "cand-halt-1", version: "1" },
        subjectVersion: 1,
        labOrder: production,
        suiteEvaluation: passingSuiteEvaluation("cand-halt-1"),
        uniformGate: passingUniformGate("cand-halt-1"),
        securityReview: failing,
        immune: cleanImmune().gate,
        orderedAt: "t-halt",
      });
    } catch (error) {
      haltError = error;
    }
    expect(haltError).toBeInstanceOf(SecurityHaltError);
    expect(ledger.haltedOrders()).toHaveLength(1);
    expect(ledger.currentProductionStage("cand-halt-1")).toBe("NOT_IN_PRODUCTION");
    expect(ledger.historyFor("cand-halt-1")).toHaveLength(0);

    // 2. The halted order id can never be completed: a retry with a PASSING
    //    review but no remediation is still blocked.
    expect(() =>
      ledger.orderProductionPromotion({
        productionOrderId: "prod-halt-1",
        subject: { componentKind: "strategy", subjectId: "cand-halt-1", version: "1" },
        subjectVersion: 1,
        labOrder: production,
        suiteEvaluation: passingSuiteEvaluation("cand-halt-1"),
        uniformGate: passingUniformGate("cand-halt-1"),
        securityReview: passingSecurityReview("cand-halt-1", 1n),
        immune: cleanImmune().gate,
        orderedAt: "t-retry",
      }),
    ).toThrow(/unremediated security halt/);

    // 3. A NEW order with a remediation package whose driving advisory is
    //    STILL ACTIVE in the supplied immune state is rejected (fail closed).
    const stillActiveRemediation: RemediationPackage = {
      haltedOrderRef: "halt:prod-halt-1",
      closedAdvisoryRefs: ["PSA-HALT-1"],
      evidence: [
        {
          evidenceId: "ev-rem-1",
          artifactRef: "artifacts/patch-report",
          contentDigest: "digest-rem-1",
        },
      ],
    };
    const remediationImmune = cleanImmune();
    remediationImmune.advisories.publish({
      advisoryId: "PSA-HALT-1",
      title: "Critical vulnerability in the routing package",
      severity: "critical",
      description: "deterministic fixture",
      affected: [{ kind: "agent_package", id: "pkg:routing" }],
      action: "quarantine",
      remediation: { summary: "Upgrade.", patchedVersion: "1.0.1", workarounds: [] },
      declaredBy: "security-team",
      publishedAt: 1_000,
    });
    // The review itself passes (the candidate's screened component is clean);
    // the REMEDIATION check is what must reject the still-active advisory.
    const reviewOverCleanComponents = runSecurityReview({
      subject: {
        componentKind: "strategy",
        subjectId: "cand-halt-1",
        version: "1",
        screenedComponents: [{ kind: "agent_package", id: "pkg:other", version: "1.0.0" }],
        authorizationIssuedAtEpoch: 0n,
      },
      immune: remediationImmune.gate,
    });
    expect(reviewOverCleanComponents.passed).toBe(true);
    expect(() =>
      ledger.orderProductionPromotion({
        productionOrderId: "prod-halt-2",
        subject: { componentKind: "strategy", subjectId: "cand-halt-1", version: "1" },
        subjectVersion: 1,
        labOrder: production,
        suiteEvaluation: passingSuiteEvaluation("cand-halt-1"),
        uniformGate: passingUniformGate("cand-halt-1"),
        securityReview: reviewOverCleanComponents,
        remediation: stillActiveRemediation,
        immune: remediationImmune.gate,
        orderedAt: "t-retry-2",
      }),
    ).toThrow(/still active/);

    // 4. The advisory is closed with verified remediation → the NEW order
    //    with the remediation package promotes.
    remediationImmune.advisories.close({
      advisoryId: "PSA-HALT-1",
      closedAt: 2_000,
      closureNote: "patched and verified",
      remediationVerified: true,
    });
    const order = ledger.orderProductionPromotion({
      productionOrderId: "prod-halt-3",
      subject: { componentKind: "strategy", subjectId: "cand-halt-1", version: "1" },
      subjectVersion: 1,
      labOrder: production,
      suiteEvaluation: passingSuiteEvaluation("cand-halt-1"),
      uniformGate: passingUniformGate("cand-halt-1"),
      securityReview: runSecurityReview({
        subject: {
          componentKind: "strategy",
          subjectId: "cand-halt-1",
          version: "1",
          screenedComponents: [{ kind: "agent_package", id: "pkg:routing", version: "1.0.0" }],
          authorizationIssuedAtEpoch: 0n,
        },
        immune: remediationImmune.gate,
      }),
      remediation: stillActiveRemediation,
      immune: remediationImmune.gate,
      orderedAt: "t-retry-3",
    });
    expect(order.orderKind).toBe("PROMOTE");
    expect(order.remediation?.haltedOrderRef).toBe("halt:prod-halt-1");
    expect(ledger.currentProductionStage("cand-halt-1")).toBe("PRODUCTION");
    expect(ledger.unremediatedHaltsFor("cand-halt-1")).toHaveLength(0);
  });

  it("promotion past a failed security gate is impossible — there is no override input", () => {
    const { production } = labOrderAtProduction("cand-halt-2");
    const ledger = new ProductionPromotionLedger();
    const failing = failingSecurityReview("cand-halt-2");
    let attempts = 0;
    for (const orderedAt of ["t1", "t2", "t3"]) {
      attempts += 1;
      expect(() =>
        ledger.orderProductionPromotion({
          productionOrderId: `prod-halt-2-${attempts}`,
          subject: { componentKind: "strategy", subjectId: "cand-halt-2", version: "1" },
          subjectVersion: 1,
          labOrder: production,
          suiteEvaluation: passingSuiteEvaluation("cand-halt-2"),
          uniformGate: passingUniformGate("cand-halt-2"),
          securityReview: failing,
          immune: cleanImmune().gate,
          orderedAt,
        }),
      ).toThrow(SecurityHaltError);
    }
    expect(ledger.haltedOrders()).toHaveLength(3);
    expect(ledger.currentProductionStage("cand-halt-2")).toBe("NOT_IN_PRODUCTION");
    expect(ledger.allArtifacts()).toHaveLength(0);
  });
});

describe("versioned rollback + history preservation (INV-L03)", () => {
  it("rollback appends a reversal record and never deletes history", () => {
    const { production } = labOrderAtProduction("cand-rollback-1");
    const ledger = new ProductionPromotionLedger();
    const promote = ledger.orderProductionPromotion({
      productionOrderId: "prod-promote-1",
      subject: { componentKind: "strategy", subjectId: "cand-rollback-1", version: "1" },
      subjectVersion: 3,
      labOrder: production,
      suiteEvaluation: passingSuiteEvaluation("cand-rollback-1"),
      uniformGate: passingUniformGate("cand-rollback-1"),
      securityReview: passingSecurityReview("cand-rollback-1"),
      immune: cleanImmune().gate,
      orderedAt: "t1",
    });
    const rollback = ledger.orderRollback({
      productionOrderId: "prod-rollback-1",
      reversesOrderId: "prod-promote-1",
      reason: "canary regression: deadline misses above threshold",
      orderedAt: "t2",
    });
    expect(rollback.orderKind).toBe("ROLLBACK");
    expect(rollback.reversesOrderId).toBe("prod-promote-1");
    // VERSIONED rollback: it carries the subject version of the reversed order.
    expect(rollback.subjectVersion).toBe(3);
    expect(rollback.orderDigest.length).toBeGreaterThan(0);
    expect(ledger.currentProductionStage("cand-rollback-1")).toBe("ROLLED_BACK");

    // History is APPEND-ONLY: the promotion artifact is still there, before
    // the reversal record.
    const history = ledger.historyFor("cand-rollback-1");
    expect(history).toHaveLength(2);
    expect(history[0]?.productionOrderId).toBe("prod-promote-1");
    expect(history[1]?.productionOrderId).toBe("prod-rollback-1");
    expect(history[0]?.orderDigest).toBe(promote.orderDigest);

    // Evaluation history survives the rollback untouched (INV-L04).
    expect(ledger.evaluationHistoryFor("cand-rollback-1")).toHaveLength(1);
  });

  it("a rollback cannot exist without the versioned promotion order it reverses", () => {
    const ledger = new ProductionPromotionLedger();
    expect(() =>
      ledger.orderRollback({
        productionOrderId: "prod-rollback-x",
        reversesOrderId: "prod-does-not-exist",
        reason: "orphan reversal",
        orderedAt: "t",
      }),
    ).toThrow(/reversal RECORD of an existing versioned promotion order/);
  });

  it("only a PROMOTE order can be reversed, exactly once", () => {
    const { production } = labOrderAtProduction("cand-rollback-2");
    const ledger = new ProductionPromotionLedger();
    ledger.orderProductionPromotion({
      productionOrderId: "prod-promote-2",
      subject: { componentKind: "strategy", subjectId: "cand-rollback-2", version: "1" },
      subjectVersion: 1,
      labOrder: production,
      suiteEvaluation: passingSuiteEvaluation("cand-rollback-2"),
      uniformGate: passingUniformGate("cand-rollback-2"),
      securityReview: passingSecurityReview("cand-rollback-2"),
      immune: cleanImmune().gate,
      orderedAt: "t1",
    });
    const rollback = ledger.orderRollback({
      productionOrderId: "prod-rollback-2",
      reversesOrderId: "prod-promote-2",
      reason: "regression",
      orderedAt: "t2",
    });
    // Reversing the rollback itself is not a PROMOTE reversal.
    expect(() =>
      ledger.orderRollback({
        productionOrderId: "prod-rollback-3",
        reversesOrderId: "prod-rollback-2",
        reason: "reverse the reversal",
        orderedAt: "t3",
      }),
    ).toThrow(/only a PROMOTE order can be reversed/);
    // The subject is no longer in production → no second reversal.
    expect(() =>
      ledger.orderRollback({
        productionOrderId: "prod-rollback-4",
        reversesOrderId: "prod-promote-2",
        reason: "double reversal",
        orderedAt: "t4",
      }),
    ).toThrow(/currently in production/);
    expect(rollback.orderDigest.length).toBeGreaterThan(0);
  });

  it("order ids are never reused in the append-only ledger", () => {
    const { production } = labOrderAtProduction("cand-reuse-1");
    const ledger = new ProductionPromotionLedger();
    ledger.orderProductionPromotion({
      productionOrderId: "prod-reuse-1",
      subject: { componentKind: "strategy", subjectId: "cand-reuse-1", version: "1" },
      subjectVersion: 1,
      labOrder: production,
      suiteEvaluation: passingSuiteEvaluation("cand-reuse-1"),
      uniformGate: passingUniformGate("cand-reuse-1"),
      securityReview: passingSecurityReview("cand-reuse-1"),
      immune: cleanImmune().gate,
      orderedAt: "t1",
    });
    expect(() =>
      ledger.orderRollback({
        productionOrderId: "prod-reuse-1",
        reversesOrderId: "prod-reuse-1",
        reason: "id reuse",
        orderedAt: "t2",
      }),
    ).toThrow(/never reused/);
  });
});

describe("evaluation history is immutable (INV-L04 discipline)", () => {
  it("entries are frozen, unique and survive rollback and retirement", () => {
    const { production } = labOrderAtProduction("cand-history-1");
    const ledger = new ProductionPromotionLedger();
    ledger.orderProductionPromotion({
      productionOrderId: "prod-history-1",
      subject: { componentKind: "strategy", subjectId: "cand-history-1", version: "1" },
      subjectVersion: 1,
      labOrder: production,
      suiteEvaluation: passingSuiteEvaluation("cand-history-1"),
      uniformGate: passingUniformGate("cand-history-1"),
      securityReview: passingSecurityReview("cand-history-1"),
      immune: cleanImmune().gate,
      orderedAt: "t1",
    });
    const entries = ledger.evaluationHistoryFor("cand-history-1");
    expect(entries).toHaveLength(1);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(() => {
      (entries[0] as { recordedAt: string }).recordedAt = "tampered";
    }).toThrow();

    // Duplicate entry ids are rejected.
    expect(() =>
      ledger.recordEvaluation({
        entryId: "eval:prod-history-1",
        subject: { componentKind: "strategy", subjectId: "cand-history-1", version: "1" },
        suiteEvaluation: passingSuiteEvaluation("cand-history-1"),
        recordedAt: "t2",
      }),
    ).toThrow(/immutable/);

    ledger.orderRollback({
      productionOrderId: "prod-history-rollback-1",
      reversesOrderId: "prod-history-1",
      reason: "regression",
      orderedAt: "t3",
    });
    ledger.retireFromProduction({
      productionOrderId: "prod-history-retire-1",
      subject: { componentKind: "strategy", subjectId: "cand-history-1", version: "1" },
      subjectVersion: 1,
      reason: "superseded by cand-history-2",
      orderedAt: "t4",
    });
    // The evaluation entry is STILL there, unchanged.
    const after = ledger.evaluationHistoryFor("cand-history-1");
    expect(after).toHaveLength(1);
    expect(after[0]?.evaluationDigest).toBe(entries[0]?.evaluationDigest);
    expect(after[0]?.recordedAt).toBe("t1");
  });
});

describe("retirement history is preserved (INV-C03 discipline)", () => {
  it("retirement appends a going-forward record; in-flight history stays intact", () => {
    const { production } = labOrderAtProduction("cand-retire-1");
    const ledger = new ProductionPromotionLedger();
    const promote = ledger.orderProductionPromotion({
      productionOrderId: "prod-retire-1",
      subject: { componentKind: "strategy", subjectId: "cand-retire-1", version: "1" },
      subjectVersion: 2,
      labOrder: production,
      suiteEvaluation: passingSuiteEvaluation("cand-retire-1"),
      uniformGate: passingUniformGate("cand-retire-1"),
      securityReview: passingSecurityReview("cand-retire-1"),
      immune: cleanImmune().gate,
      orderedAt: "t1",
    });
    const retirement = ledger.retireFromProduction({
      productionOrderId: "prod-retire-2",
      subject: { componentKind: "strategy", subjectId: "cand-retire-1", version: "1" },
      subjectVersion: 2,
      reason: "provider sunset",
      orderedAt: "t2",
    });
    expect(retirement.orderKind).toBe("RETIRE");
    expect(ledger.currentProductionStage("cand-retire-1")).toBe("RETIRED");

    // In-flight history preserved: the promotion artifact and the evaluation
    // entry are untouched by retirement.
    const history = ledger.historyFor("cand-retire-1");
    expect(history).toHaveLength(2);
    expect(history[0]?.orderDigest).toBe(promote.orderDigest);
    expect(ledger.evaluationHistoryFor("cand-retire-1")).toHaveLength(1);

    // A retired subject cannot be promoted again (promote a NEW version).
    expect(() =>
      ledger.orderProductionPromotion({
        productionOrderId: "prod-retire-3",
        subject: { componentKind: "strategy", subjectId: "cand-retire-1", version: "1" },
        subjectVersion: 2,
        labOrder: production,
        suiteEvaluation: passingSuiteEvaluation("cand-retire-1"),
        uniformGate: passingUniformGate("cand-retire-1"),
        securityReview: passingSecurityReview("cand-retire-1"),
        immune: cleanImmune().gate,
        orderedAt: "t3",
      }),
    ).toThrow(/retired/);

    // Double retirement is rejected.
    expect(() =>
      ledger.retireFromProduction({
        productionOrderId: "prod-retire-4",
        subject: { componentKind: "strategy", subjectId: "cand-retire-1", version: "1" },
        subjectVersion: 2,
        reason: "again",
        orderedAt: "t4",
      }),
    ).toThrow(/going-forward record/);
  });
});
