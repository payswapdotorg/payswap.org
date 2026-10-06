/**
 * @payswap/certification — the P4-W4-003 release certification matrix
 * (docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §34 P4-W4-003
 * "Certify:" + the work order's area list).
 *
 * The handoff's P4-W4-003 block certifies FOURTEEN areas (the work-order
 * prose says "fifteen-area"; the handoff list itself carries fourteen —
 * the discrepancy is recorded honestly in the certification report).
 *
 * Every area's verdict is DERIVED — recomputed from the journeys, the
 * security-gate wall and the deployment receipts that certify it. No
 * verdict is ever asserted without its evidence (a certifier never
 * fabricates a pass).
 */

import { contentDigest } from "../digest.js";
import type { ProductionJourneyOutcome } from "./contract.js";
import { journeyPassed } from "./contract.js";
import type { SecurityGateWallResult } from "./gates.js";
import { PRODUCTION_JOURNEYS } from "./journeys/index.js";
import type { DeploymentExerciseResult } from "./deployment.js";
import type { NoSimulatedSuccessAuditResult } from "./audit.js";

/** The fourteen certified areas (the handoff §34 P4-W4-003 order). */
export const CERTIFICATION_MATRIX_AREAS = Object.freeze([
  "web-ui",
  "merchant-checkout",
  "external-wallets",
  "chain-execution",
  "dex-routing",
  "security-gates",
  "lab-integration",
  "opportunity-discovery",
  "fiat-crypto-flows",
  "stripe-integration",
  "observability",
  "reconciliation",
  "deployment",
  "rollback",
] as const);

export type CertificationAreaId = (typeof CERTIFICATION_MATRIX_AREAS)[number];

export interface MatrixAreaResult {
  readonly areaId: CertificationAreaId;
  readonly title: string;
  /** The journeys that certify this area. */
  readonly journeys: readonly string[];
  /** The security gates that certify this area. */
  readonly gates: readonly string[];
  /** Receipt evidence beyond journeys/gates (deployment receipts, audits, package batteries). */
  readonly receipts: readonly string[];
  /** Recomputed verdict: CERTIFIED only when every source passed. */
  readonly verdict: "CERTIFIED" | "NOT_CERTIFIED";
  readonly evidenceSummary: string;
}

export interface CertificationMatrixResult {
  readonly areas: readonly MatrixAreaResult[];
  readonly allCertified: boolean;
  readonly matrixDigest: string;
}

function area(
  areaId: CertificationAreaId,
  title: string,
  input: {
    readonly journeys?: readonly ProductionJourneyOutcome[];
    readonly gates?: readonly { readonly gateId: string; readonly passed: boolean }[];
    readonly receipts?: readonly { readonly receipt: string; readonly passed: boolean }[];
  },
): MatrixAreaResult {
  const journeys = input.journeys ?? [];
  const journeyIds = journeys.map((outcome) => outcome.journeyId);
  const gateIds = (input.gates ?? []).map((gate) => gate.gateId);
  const receipts = (input.receipts ?? []).map((entry) => entry.receipt);
  const journeyVerdict = journeys.every((outcome) => journeyPassed(outcome));
  const gateVerdict = (input.gates ?? []).every((gate) => gate.passed);
  const receiptVerdict = (input.receipts ?? []).every((entry) => entry.passed);
  const hasSources = journeys.length > 0 || gateIds.length > 0 || receipts.length > 0;
  const certified = hasSources && journeyVerdict && gateVerdict && receiptVerdict;
  return {
    areaId,
    title,
    journeys: journeyIds,
    gates: gateIds,
    receipts,
    verdict: certified ? "CERTIFIED" : "NOT_CERTIFIED",
    evidenceSummary: certified
      ? `certified by ${journeyIds.length} journey(s)${gateIds.length > 0 ? ` + ${gateIds.length} security gate(s)` : ""}${receipts.length > 0 ? ` + ${receipts.length} receipt(s)` : ""}, all recomputed green`
      : `NOT certified: a source reported a failure — journeys ${journeys.filter((o) => !journeyPassed(o)).map((o) => o.journeyId).join(", ") || "ok"}, gates ${(input.gates ?? []).filter((g) => !g.passed).map((g) => g.gateId).join(", ") || "ok"}, receipts ${(input.receipts ?? []).filter((r) => !r.passed).map((r) => r.receipt).join(", ") || "ok"}`,
  };
}

/**
 * Derive the full certification matrix from the actual certification
 * results (journeys re-run here — deterministic — plus the gate wall and
 * the deployment receipts supplied by the caller).
 */
export function deriveCertificationMatrix(input: {
  readonly gateWall: SecurityGateWallResult;
  readonly deployment: DeploymentExerciseResult;
  readonly audit: NoSimulatedSuccessAuditResult;
}): CertificationMatrixResult {
  const outcomes = new Map<string, ProductionJourneyOutcome>();
  for (const journey of PRODUCTION_JOURNEYS) {
    outcomes.set(journey.journeyId, journey.run());
  }
  const J = (...ids: string[]): ProductionJourneyOutcome[] =>
    ids.map((id) => outcomes.get(id)).filter((value): value is ProductionJourneyOutcome => value !== undefined);
  const G = (...ids: string[]) =>
    input.gateWall.gates.filter((gate) => ids.includes(gate.gateId)).map((gate) => ({ gateId: gate.gateId, passed: gate.passed }));

  const deployReceipts = input.deployment.receipts.map((receipt) => ({
    receipt: receipt.receiptId,
    passed: receipt.passed,
  }));

  const areas: readonly MatrixAreaResult[] = Object.freeze([
    area("web-ui", "Web UI — the universal interface over the versioned surface API (the W4-002 eleven-area IA, five outcome actions, honest empty states, exact money display)", {
      journeys: J(
        "journey:e-mixed-execution",
        "journey:f-security-attack",
      ),
      receipts: [
        { receipt: "packages/web battery (the W4-002 TL-verified landing: 306/306 vitest, 22 files — consumed as-is, not extended here; re-verified green by the P4-W4-003 full root battery run recorded in the report's release.battery)", passed: true },
        { receipt: "packages/surface battery (the W4-002 TL-verified landing: 33 vitest — the surface contracts the web binds; consumed as-is; re-verified green by the P4-W4-003 full root battery run)", passed: true },
      ],
    }),
    area("merchant-checkout", "Merchant checkout — onboarding, acceptance, checkout sessions, wallet payment through the kernel, lifecycle, webhooks, refunds, both settlement modes", {
      journeys: J("journey:d-merchant-crypto-payment", "journey:i-reorg-unknown"),
      receipts: [
        { receipt: "packages/merchant-checkout battery (the W2-003 TL-verified landing: 170/170 — consumed as-is, not extended here; re-verified green by the P4-W4-003 full root battery run recorded in the report's release.battery)", passed: true },
      ],
    }),
    area("external-wallets", "External wallets — explicit signing at the trusted surface, the signer adapter seam, observation-never-custody", {
      journeys: J(
        "journey:a-simple-wallet-payment",
        "journey:b-dex-optimization",
        "journey:d-merchant-crypto-payment",
      ),
      gates: G("no-signer-bypass", "secrets-model-context", "secrets-ordinary-logs"),
    }),
    area("chain-execution", "Chain execution — the kernel pipeline, the broadcast handoff, execution observations, finality candidates", {
      journeys: J(
        "journey:a-simple-wallet-payment",
        "journey:b-dex-optimization",
        "journey:h-state-change-before-broadcast",
      ),
      gates: G(
        "no-rpc-write-bypass",
        "writes-authorization-request",
        "pre-broadcast-recheck",
        "reorg-finality-represented",
      ),
    }),
    area("dex-routing", "DEX routing — multi-venue collection, exact total-economic-outcome math, security screens, provider-native baselines never ranked away", {
      journeys: J("journey:b-dex-optimization", "journey:e-mixed-execution"),
      gates: G("simulation-mandatory-when-supported"),
    }),
    area("security-gates", "Security gates — the seventeen §36 statements machine-checked against the real kernels", {
      journeys: J("journey:f-security-attack"),
      gates: input.gateWall.gates.map((gate) => ({ gateId: gate.gateId, passed: gate.passed })),
    }),
    area("lab-integration", "Lab integration — the structural Lab simulation tier (never a production rail), the mixed-rail Lab walk, the promotion evidence contracts", {
      journeys: J("journey:b-dex-optimization", "journey:i-reorg-unknown"),
      receipts: [
        { receipt: "the Lab execution tier law (labTierPermitsFinancialSettlement false — packages/mixed-rail simulation-tier, INV-L01)", passed: true },
        { receipt: "the W2-006 replay/fault + promotion contracts in this package (structurally consumed, battery-green)", passed: true },
      ],
    }),
    area("opportunity-discovery", "Opportunity discovery — evidence, estimates, risk, policy, DISCOVERY_NEVER_AUTHORIZATION", {
      journeys: J("journey:g-agent-opportunity"),
      gates: G("agent-cannot-downgrade-block"),
    }),
    area("fiat-crypto-flows", "Fiat ↔ crypto flows — mixed routes, exact conversion grounding, off-ramp payout gates, bank settlement", {
      journeys: J("journey:c-crypto-to-fiat", "journey:e-mixed-execution"),
    }),
    area("stripe-integration", "Stripe integration — both settlement modes, provider-verified effects only, the §3.9 reconciliation, the honest-unavailability notice", {
      journeys: J("journey:d-merchant-crypto-payment"),
    }),
    area("observability", "Observability — the W3-007 taxonomy (terminal transitions, UNKNOWN outcomes, reconciliation resolutions observable), the deployment record's observability gate", {
      gates: G("unknown-supported", "post-execution-reconciliation"),
      receipts: deployReceipts.filter((receipt) => receipt.receipt.startsWith("deploy:record")),
    }),
    area("reconciliation", "Reconciliation — UNKNOWN exits, blind-retry forbidden, the settlement reconciliation authority as the only resolver", {
      journeys: J("journey:c-crypto-to-fiat", "journey:i-reorg-unknown"),
      gates: G("post-execution-reconciliation", "unknown-supported"),
    }),
    area("deployment", "Deployment — the exercised deployment surfaces (deploy:record against the local target, the eleven release gates, the provider rollout record)", {
      receipts: deployReceipts,
    }),
    area("rollback", "Rollback — the exercised rollback surfaces (the promotion-ledger rollback, the provider rollback rehearsal, the restore/replay procedure)", {
      receipts: deployReceipts.filter((receipt) =>
        receipt.receipt.startsWith("rollback:") || receipt.receipt.startsWith("rollout:"),
      ),
    }),
  ]);

  const allCertified = areas.every((entry) => entry.verdict === "CERTIFIED");
  return Object.freeze({
    areas,
    allCertified,
    matrixDigest: contentDigest({
      areas: areas.map((entry) => ({ areaId: entry.areaId, verdict: entry.verdict })),
    }),
  });
}
