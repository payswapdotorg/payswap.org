/**
 * @payswap/security — the security immune system + Arena expert bridge.
 * Work Order: W2-005 (Stage 5).
 *
 * Modules:
 * - signatures.ts:    threat signatures (matchable patterns scoped to
 *                     vulnerable package/agent/extension identities and
 *                     version ranges) + the component identity model + the
 *                     package content digest;
 * - advisories.ts:    SecurityAdvisory and the GLOBAL restriction view
 *                     (INV-S01) with an append-only lifecycle;
 * - epochs.ts:        network SecurityEpoch + the sensitive delegated-action
 *                     epoch gate (INV-S02, INV-A02), composed with
 *                     @payswap/trust per-principal credential epochs;
 * - quarantine.ts:    quarantine ledger (release only through explicit
 *                     remediation + advisory closure), the INV-S03
 *                     cached-capability-state bypass rejection, and the
 *                     composed SecurityGate;
 * - capability-cases.ts: CapabilityCase incidents/observations + the
 *                     immutable security learning feed (INV-S04);
 * - experts.ts:       expert qualification/matching contracts, the expert
 *                     task board and VERSIONED Arena-compatible resolution
 *                     records (INV-L04) whose only consumable form is an
 *                     evidence artifact — never hidden authority.
 *
 * Architecture: 1.5-frozen-2026-09-30; FROZEN-ARCHITECTURE §17/§18;
 * SECURITY-EVIDENCE-RECOURSE.md; LAB.md "Arena bridge" / "Production
 * learning"; INV-S01..S04, INV-A02, INV-C03, INV-L04.
 *
 * Boundary notes:
 * - the Lab package is deliberately NOT imported (its own boundary test
 *   forbids any other package's src importing it); Arena compatibility is
 *   structural (versioned, content-addressed, append-only artifacts);
 * - this package owns NO financial mutation path, NO rail execution and NO
 *   approval issuance: it restricts, quarantines and produces evidence.
 */

export const PACKAGE_NAME = "@payswap/security" as const;

export * from "./signatures.js";
export * from "./advisories.js";
export * from "./epochs.js";
export * from "./quarantine.js";
export * from "./capability-cases.js";
export * from "./experts.js";
