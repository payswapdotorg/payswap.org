/**
 * @payswap/surface — the security gate vocabulary in people language
 * (P4-W4-002 §3.4; the STRIPE-UX-DIRECTIVE §11 "security UX must be
 * substantially better than a raw wallet").
 *
 * The onchain-security package owns the deterministic vocabulary
 * (GateDecision: BLOCK / ALLOW / UNKNOWN with typed reasons, dimensions
 * and evidence refs). This module FOLDS that typed decision into the
 * human-readable presentation contract — never a raw error dump, never a
 * redefinition: BLOCK stays BLOCK (non-overridable), UNKNOWN stays
 * UNKNOWN (never rendered as failure or success), and every fold carries
 * the drill-down so the typed detail is one explicit step away.
 */

import type { GateDecision } from "@payswap/onchain-security";

import { surfaceProvenance, type SurfaceContractProvenance } from "./version.js";

/** The people-language tone for each verdict (UI tone, not a new verdict). */
export type GatePresentationTone = "danger" | "success" | "warning";

/** The human-readable fold of one gate decision. */
export interface GateDecisionView {
  /** The verdict, verbatim from the typed decision. */
  readonly verdict: "BLOCK" | "ALLOW" | "UNKNOWN";
  readonly tone: GatePresentationTone;
  /** The headline a person reads first (why + what it means). */
  readonly headline: string;
  /** The person-actionable explanation (expected action / recommendation). */
  readonly explanation: string;
  /**
   * The typed drill-down items (rendered only on explicit disclosure —
   * progressive disclosure law; the raw dump is never the default view).
   */
  readonly drilldown: readonly string[];
  /** Evidence references — every definitive statement is evidence-backed. */
  readonly evidenceRefs: readonly string[];
  readonly provenance: SurfaceContractProvenance;
}

/**
 * Fold a typed GateDecision into the people-language view.
 *
 * Laws (INV-X01 + rule 27 + the directive §11):
 * - BLOCK renders as a block with the violated reasons in human terms and
 *   an explicit do-not-proceed recommendation — never overridable here;
 * - UNKNOWN renders as UNKNOWN: what is unobserved, what it would take to
 *   resolve, and that no success or failure is implied;
 * - ALLOW renders what passed and the evidence — it never implies more
 *   authority than the checks establish.
 */
export function foldGateDecision(decision: GateDecision): GateDecisionView {
  switch (decision.decision) {
    case "BLOCK": {
      const reasons = decision.reasons.map(
        (reason) =>
          `${reason.dimension} [${reason.code}]: ${reason.message}${
            reason.invariantRefs.length > 0 ? ` (invariants: ${reason.invariantRefs.join(", ")})` : ""
          }`,
      );
      return {
        verdict: "BLOCK",
        tone: "danger",
        headline: "This action is blocked",
        explanation:
          "A deterministic security gate stopped this action before anything moved. Blocked actions are final for this request — no setting, agent or optimization overrides them.",
        drilldown: reasons,
        evidenceRefs: decision.evidenceRefs,
        provenance: surfaceProvenance("P4-W4-002"),
      };
    }
    case "UNKNOWN": {
      const dimensions = decision.dimensions.map(
        (dimension) => `${dimension.dimension} [${dimension.code}]: ${dimension.message}`,
      );
      return {
        verdict: "UNKNOWN",
        tone: "warning",
        headline: "This action is not yet decided",
        explanation:
          "The security evaluation could not establish a definitive verdict on every dimension. UNKNOWN is neither failure nor success — nothing is retried blindly, and resolution follows the observation/reconciliation path below.",
        drilldown: dimensions,
        evidenceRefs: decision.evidenceRefs,
        provenance: surfaceProvenance("P4-W4-002"),
      };
    }
    case "ALLOW": {
      const checks = decision.checks.map(
        (check) => `${check.dimension}: ${check.outcome} [${check.code}] ${check.detail}`,
      );
      return {
        verdict: "ALLOW",
        tone: "success",
        headline: "This action passed the security gates",
        explanation:
          "Every deterministic gate dimension evaluated to pass for this request. Passing gates authorizes this action only — it is not a blanket trust statement about anything else.",
        drilldown: checks,
        evidenceRefs: decision.evidenceRefs,
        provenance: surfaceProvenance("P4-W4-002"),
      };
    }
  }
}

/**
 * The mode-indicator contract for every money-adjacent surface
 * (§3.5 + directive §13): test/live AND testnet/mainnet must be VISIBLE
 * and honest. `modeLockedTo` records the credential-determined mode — the
 * UI can switch only what the authority allows (Stripe's keys-determine-
 * mode law, mapped).
 */
export interface SurfaceModeIndicator {
  readonly testOrLive: "TEST" | "LIVE";
  readonly testnetOrMainnet: "TESTNET" | "MAINNET" | "NOT-APPLICABLE";
  /** True when the surface refuses mode switching (authority-locked). */
  readonly modeLocked: boolean;
  /** One-line honesty note rendered with the indicator. */
  readonly note: string;
}

export function modeIndicator(input: {
  readonly testOrLive: "TEST" | "LIVE";
  readonly onchain: boolean;
  readonly testnet: boolean;
  readonly modeLocked?: boolean;
}): SurfaceModeIndicator {
  const testnetOrMainnet: SurfaceModeIndicator["testnetOrMainnet"] = input.onchain
    ? input.testnet
      ? "TESTNET"
      : "MAINNET"
    : "NOT-APPLICABLE";
  return {
    testOrLive: input.testOrLive,
    testnetOrMainnet,
    modeLocked: input.modeLocked ?? false,
    note:
      input.testOrLive === "TEST"
        ? "Test mode — no real money moves. Test data is visually distinct and never presented as a live transaction."
        : "Live mode — real money. Every definitive state below is evidence-backed.",
  };
}
