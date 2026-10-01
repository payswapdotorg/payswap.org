/**
 * @payswap/certification — certification suites, security review gates,
 * replay/fault test contracts, production promotion/rollback artifacts and
 * THE uniform gate wall.
 * Work Order: W2-006 (Stage 6).
 *
 * Architecture: 1.5-frozen-2026-09-30; FROZEN-ARCHITECTURE §2A/§17/§19;
 * LAB.md "Promotion"; SECURITY-EVIDENCE-RECOURSE.md; INV-C03, INV-C05..C09,
 * INV-L02/L03/L04, INV-S01..S04, INV-SC04, INV-X01..X03.
 *
 * Modules:
 * - digest.ts:        package-local canonical serialization + content digest
 *                     (content addressing for certification artifacts);
 * - suites.ts:        certification suites parameterized by component kind
 *                     (strategy / organization / agent package / connector),
 *                     the append-only suite registry, suite evaluation, and
 *                     connector certification (hierarchy, connected-instance
 *                     scope, provider-state preservation, execution modes,
 *                     external-funds observation semantics);
 * - security-gates.ts: the security review gate over the immune-system state
 *                     (advisories, quarantine, epochs — consumed
 *                     structurally) plus remediation evidence verification;
 * - replay-fault.ts:  fault-injection declarations (provider outage →
 *                     UNKNOWN, webhook loss → reconciliation recovery, epoch
 *                     bump → re-authorization), deterministic re-run
 *                     contracts and the replay/fault suite runner;
 * - promotion.ts:     versioned production promotion/rollback/retirement
 *                     artifacts over the Lab's versioned promotion: security
 *                     failures halt promotion irreversibly, rollback appends
 *                     reversal records, evaluation history is immutable;
 * - uniform-gates.ts: THE uniform gate wall — PASS_THROUGH_NATIVE,
 *                     COMPOSED_PAYSWAP and OPTIMIZED_MULTI_PROVIDER share the
 *                     SAME authorization/compliance/evidence gates; no
 *                     mode-specific bypass exists (type-, value- and
 *                     source-level proofs).
 *
 * Boundary notes:
 * - the immune-system package and the Lab package are consumed
 *   STRUCTURALLY (view interfaces the concrete artifacts satisfy), keeping
 *   their package-level boundary rules intact; the connector and agent
 *   vocabularies are consumed directly and never redefined;
 * - this package owns NO financial mutation path and NO rail execution: it
 *   orders, gates and records artifacts.
 */

export const PACKAGE_NAME = "@payswap/certification" as const;

export * from "./digest.js";
export * from "./suites.js";
export * from "./security-gates.js";
export * from "./replay-fault.js";
export * from "./promotion.js";
export * from "./uniform-gates.js";
