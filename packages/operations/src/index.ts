/**
 * @payswap/operations — deployment, browser verification and the operator
 * runbook (W3-007, terminal wave, Worker 3).
 *
 * The OPERATIONS package of the monorepo: the deterministic contracts,
 * declarations and checkers that make operations a first-class product —
 *
 * - DEPLOYMENT: environment manifests over the six worker roles of the
 *   modular monolith (local/preview/staging/production), the §3.1
 *   configuration contract, preview/production PARITY VERIFICATION,
 *   migration-compatible ordered deployment plans (INV-O03), the §6
 *   deployment-gates checklist and the restore/replay procedure (INV-O04);
 * - BROWSER VERIFICATION: a contract per major journey (the six @payswap/ux
 *   payment journeys + the twelve @payswap/journeys W1-007 certification
 *   journeys) with the six required checks (desktop, responsive/mobile,
 *   console errors, key interactions, screenshot artifact, real API wiring
 *   evidence), checked deterministically against the ACTUAL view-models —
 *   UNKNOWN renders reconciling (INV-X01) and browser evidence is never
 *   stronger than its authenticated provenance (INV-E04);
 * - OBSERVABILITY: the protocol-ID-correlated event taxonomy (every
 *   terminal-state transition, UNKNOWN outcome and reconciliation
 *   resolution observable), dashboards and alert rules as data — no orphan
 *   alerts, every alert routes to a runbook entry;
 * - SECRETS: the vault-backed reference inventory, the resolution
 *   contract (references resolve to key IDs — values never cross into
 *   config artifacts), hygiene checks and rotation procedures;
 * - OPERATOR ACTIONS: the evidenced catalog (authority level + evidence
 *   requirement + rollback path + version) for pause/resume campaign,
 *   quarantine release, reconciliation trigger, rail cutover and security
 *   epoch bump;
 * - RECOVERY + RUNBOOK: playbooks for the five W3-007 diagnosis scenarios
 *   (UNKNOWN, security quarantine, incentive dispute clawback, rail
 *   outage, restore/replay) plus the INV-O01/INV-O02 resilience drills,
 *   assembled into the indexed symptom → diagnosis → action → verification
 *   operator runbook.
 *
 * Package paradigm (repo convention): deterministic DATA + CONTRACTS +
 * CHECKERS. No live network, no browser, no vault at check time. Executing
 * the plans/actions is the production operator console's job, which
 * consumes these declarations.
 */

export const PACKAGE_NAME = "@payswap/operations" as const;

export * from "./digest.js";
export * from "./deployment.js";
export * from "./browser-verification.js";
export * from "./observability.js";
export * from "./secrets.js";
export * from "./operator-actions.js";
export * from "./recovery.js";
export * from "./runbook.js";
