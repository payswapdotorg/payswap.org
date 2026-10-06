/**
 * @payswap/certification — the P4-W4-003 deployment + rollback exercise
 * (src layer: the contracts, the release identity and THIS package's own
 * W2-006 promotion-ledger rollback recording).
 *
 * The @payswap/operations machinery (the environment manifests, the four
 * machine checkers, the ordered deployment plan, the eleven release
 * gates, the provider rollout + rollback rehearsal) is driven from the
 * TEST layer (test/production/deployment-machinery.ts) — the same
 * consumption pattern as the deployment scripts themselves
 * (scripts/deployment/*.mjs bundle it with esbuild rather than pulling it
 * into a workspace TS program): operations' vendored node-builtins are
 * program-global ambient declarations, so a src-level import here would
 * change every consuming workspace's typecheck program. The composed
 * exercise (src receipts + the operations-driven receipts) is assembled
 * in the test layer and feeds the certification report as an input.
 */

import { registerCurrency } from "@payswap/protocol";
import { contentDigest } from "../digest.js";
import { ProductionPromotionLedger, UNIFORM_GATE_REQUIREMENTS } from "../index.js";

registerCurrency("USC", 6);
registerCurrency("EUR", 2);
/** The certification release identity (the pinned base the assembled system certifies at). */
export const CERTIFICATION_RELEASE_SHA = "bf414753a8dce86b7d3afafbd447ecf74dd3e497" as const;
export const CERTIFICATION_RELEASE_BATTERY = "4694 + the P4-W4-003 production-certification suites" as const;
export const CERTIFICATION_AUTHORIZED_AT = "2026-10-06T00:00:00Z" as const;

export interface DeploymentReceipt {
  readonly receiptId: string;
  readonly surface: string;
  readonly passed: boolean;
  readonly summary: string;
  readonly evidence: readonly string[];
}

export interface DeploymentExerciseResult {
  readonly receipts: readonly DeploymentReceipt[];
  readonly passed: boolean;
  readonly exerciseDigest: string;
}

// ---------------------------------------------------------------------------
// THIS package's rollback recording (the W2-006 promotion ledger surface)
// ---------------------------------------------------------------------------

/**
 * The promotion-ledger rollback exercise: record a certified production
 * promotion, then record the rollback (the versioned production
 * promotion/rollback artifacts of this package's own W2-006 surface).
 * Deterministic.
 */
export function runPromotionLedgerRollbackExercise(): DeploymentExerciseResult {
  const receipts: DeploymentReceipt[] = [];
  // 5. ROLLBACK RECORDING (b): the production promotion ledger —
  //    promote the certified release, then record the rollback (the
  //    versioned production promotion/rollback artifacts of THIS
  //    package's W2-006 surface).
  const ledger = new ProductionPromotionLedger();
  const candidateId = "payswap-release-bf41475";
  const promotion = ledger.orderProductionPromotion({
    productionOrderId: "po:cert:1",
    subject: { componentKind: "strategy", subjectId: candidateId, version: "1" },
    subjectVersion: 1,
    labOrder: {
      orderId: "lo:cert:1",
      orderKind: "ADVANCE",
      candidateId,
      candidateVersion: 1,
      fromStage: "SHADOW",
      toStage: "PRODUCTION",
      evidence: [
        { evidenceId: "ev:cert:replay", kind: "REPLAY", artifactRef: "evidence:cert:promotion:replay", contentDigest: contentDigest({ replay: 1 }) },
        { evidenceId: "ev:cert:counterfactual", kind: "COUNTERFACTUAL", artifactRef: "evidence:cert:promotion:counterfactual", contentDigest: contentDigest({ counterfactual: 1 }) },
        { evidenceId: "ev:cert:robustness", kind: "ROBUSTNESS", artifactRef: "evidence:cert:promotion:robustness", contentDigest: contentDigest({ robustness: 1 }) },
      ],
      orderedAt: "2026-10-06T00:00:00Z",
      orderDigest: contentDigest({ orderId: "lo:cert:1", toStage: "PRODUCTION" }),
    },
    suiteEvaluation: {
      subject: { componentKind: "strategy", subjectId: candidateId, version: "1" },
      suiteId: "payswap.production-certification",
      suiteVersion: 1,
      passed: true,
      missingEvidenceKinds: [],
      failedGates: [],
      missingGates: [],
      evaluationDigest: contentDigest({ suite: "production-certification", passed: true }),
    },
    uniformGate: {
      candidateId,
      executionMode: "COMPOSED_PAYSWAP",
      isIncumbentBaseline: false,
      requirements: UNIFORM_GATE_REQUIREMENTS,
      gateChecks: [],
      passed: true,
      wallDigest: contentDigest({ wall: 1, passed: true }),
    },
    securityReview: {
      passed: true,
      screened: 0,
      currentEpoch: 1n,
      reviewDigest: contentDigest({ review: 1, passed: true }),
    },
    immune: {
      advisories: {
        listActive: () => [],
        restrictionFor: () => ({ restricted: false, quarantined: false, retired: false, advisoryRefs: [] }),
        byId: () => undefined,
      },
      quarantine: {
        isQuarantined: () => false,
        activeQuarantinesFor: () => [],
      },
      epochs: {
        currentEpoch: () => ({ value: 1n }),
      },
    },
    orderedAt: "2026-10-06T00:00:01Z",
  });
  const rollback = ledger.orderRollback({
    productionOrderId: "po:cert:rollback:1",
    reversesOrderId: promotion.productionOrderId,
    reason: "certification rollback recording: the drilled reversal of the certified promotion",
    orderedAt: "2026-10-06T00:00:02Z",
  });
  const rolledBack = ledger.currentProductionStage(candidateId) === "ROLLED_BACK";
  receipts.push({
    receiptId: "rollback:promotion-ledger",
    surface: "@payswap/certification ProductionPromotionLedger (W2-006)",
    passed: rolledBack && rollback.reversesOrderId === promotion.productionOrderId,
    summary: `the production promotion was recorded (${promotion.productionOrderId}), then the rollback was recorded (${rollback.productionOrderId} reversing ${rollback.reversesOrderId}) — the candidate's production stage is now ROLLED_BACK`,
    evidence: ["evidence:cert:rollback:promotion-ledger"],
  });

  const passed = receipts.every((receipt) => receipt.passed);
  return Object.freeze({
    receipts,
    passed,
    exerciseDigest: contentDigest({
      receipts: receipts.map((receipt) => ({ receiptId: receipt.receiptId, passed: receipt.passed })),
    }),
  });
}

// ---------------------------------------------------------------------------
// The committed CLI receipt descriptors (verified by the test battery)
// ---------------------------------------------------------------------------

/** The expected receipt files under packages/certification/evidence/deployment/. */
export const DEPLOYMENT_CLI_RECEIPT_FILES = Object.freeze([
  {
    file: "deploy-record.json",
    surface: "npm run deploy:record (run as: node scripts/deployment/run.mjs <sha> <battery> <authorized-at>, cwd = the local record target)",
    expectations: [
      "machine_checks true",
      "eleven gates with verdicts",
      "runtime-plane gates honest NOT-EXECUTABLE (no probe artifact — the probe failed closed at the vault gate)",
    ],
  },
  {
    file: "runtime-plane-probe.txt",
    surface: "npm run deploy:probe (run as: bun scripts/deployment/runtime-plane-probe.ts <sha>, cwd = the local record target)",
    expectations: [
      "the fail-closed refusal: no vault bindings in the certification sandbox (exit 1, recorded verbatim — never a fabricated PASS)",
    ],
  },
  {
    file: "runtime-plane-probe-reprobe.txt",
    surface: "the re-probe (same command, second receipt)",
    expectations: [
      "the identical fail-closed refusal (the re-probe receipt)",
    ],
  },
  {
    file: "provider-rollout.json",
    surface: "npm run rollout:record (run as: node scripts/deployment/run-rollout.mjs, cwd = the local record target)",
    expectations: [
      "the deterministic provider rollout release record (releaseId, connected providers, honest non-connections, parity)",
    ],
  },
] as const);
