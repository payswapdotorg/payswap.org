/**
 * @payswap/settlement — settlement, reconciliation, finality and evidence
 * (Work Order W1-004, Stage 3).
 *
 * Settlement instructions derived from protocol netting (remittance
 * references preserved end-to-end, external settlement destinations, INV-E01
 * authorization lineage); idempotent retry-safe settlement attempts
 * (INV-F05/INV-O01) with UNKNOWN as a first-class non-failure outcome
 * (INV-X01), evidence linkage (INV-E02) and reconciliation-only resolution of
 * ambiguity (INV-X03); the append-only queryable evidence graph (INV-E01/
 * E02/E05 with INV-E04 provenance caps); risk-driven proof policies with
 * refund/dispute symmetry (INV-E03); protocol-owned finality records with
 * terminal monotonicity and explicit recovery (INV-F06/INV-X04); and
 * settlement certificates issued only for protocol-authorized, fully
 * reconciled, proof-satisfied instructions — carrying the evidence chain,
 * reconciliation references (including recurring mandate renewal and
 * off-network record reconciliation) and the preserved remittance.
 *
 * Invariants structurally enforced by this package:
 * - INV-X01: UNKNOWN is never mapped to FAILED.
 * - INV-X02: UNKNOWN external writes are never blindly retried.
 * - INV-X03: reconciliation is the only definitive resolver of ambiguous
 *   external effects.
 * - INV-X04: terminal transitions are monotonic except explicit recovery.
 * - INV-E01/E02: authorization and execution evidence lineage is queryable
 *   per consequential action.
 * - INV-E03: finality requires the policy-required proof.
 * - INV-E04: UI/browser artifacts are never stronger than their
 *   authenticated provenance.
 * - INV-E05: historical evidence is immutable.
 * - INV-F06: finality is protocol-owned.
 * - INV-C06: provider revisions are reconciled append-only.
 * - INV-C09: external funds observations are never booked as PaySwap custody.
 */

export const PACKAGE_NAME = "@payswap/settlement" as const;

export * from "./instructions.js";
export * from "./evidence-graph.js";
export * from "./proof-policies.js";
export * from "./reconciliation.js";
export * from "./finality.js";
export * from "./certificates.js";
