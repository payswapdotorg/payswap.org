/**
 * @payswap/onchain-threat-intel — the composed verdict + the no-downgrade
 * seam (Work Order P4-W3-003 hard requirement 2; AGENTS.md rule 27;
 * phase-4 policy `security_agent_cannot_override_block`).
 *
 * THE LAW (extends the W1-002 kernel law to the adversarial agent):
 *
 * - an AGENT BLOCK stays BLOCK: nothing in the composition may soften a
 *   BLOCK-grade agent recommendation;
 * - a DETERMINISTIC POLICY BLOCK overrides an agent ALLOW: the policy is
 *   authoritative;
 * - a KERNEL BLOCK is terminal: the deterministic onchain gate decision
 *   dominates everything the threat layer could say;
 * - a KERNEL UNKNOWN is never silently converted to ALLOW by an agent
 *   recommendation (INV-X01: UNKNOWN is resolved only by new evidence).
 *
 * `composeThreatVerdict` implements the law as a pure lattice join (the
 * strictly more restrictive verdict wins — which by construction cannot
 * downgrade either side). `attemptAgentVerdictOverride` exists only to be
 * rejected: like the kernel's `attemptAgentOverride`, it ALWAYS throws, so
 * the rejection is a tested first-class contract.
 *
 * `resolveOnchainSecurityDecision` composes the KERNEL gate decision
 * (ALLOW/BLOCK/UNKNOWN from @payswap/onchain-security) with the threat
 * verdict (the four-value vocabulary) into the final composed decision.
 *
 * Deterministic only: pure functions; no state, no clock, no randomness.
 */

import type { GateDecision } from "@payswap/onchain-security";
import type { ThreatVerdict } from "./policy.js";
import { isThreatVerdict, stricterVerdict, VERDICT_RANK } from "./policy.js";
import type { ThreatRecommendation, ThreatAssessment } from "./agent.js";
import type { GatedEvaluation, AgentSecurityFlag } from "@payswap/onchain-security";
import { attachAgentFlag } from "@payswap/onchain-security";
import type { ThreatFamily } from "./families.js";
import { familySignalClass } from "./families.js";

// ---------------------------------------------------------------------------
// The no-downgrade law
// ---------------------------------------------------------------------------

/** Raised when ANY agent attempts to override a composed verdict (rule 27). */
export class AgentVerdictOverrideForbiddenError extends Error {
  readonly attemptedVerdict: ThreatVerdict;

  constructor(attemptedVerdict: ThreatVerdict, claimedBy: string) {
    super(
      `Agent '${claimedBy}' attempted to override the deterministic threat verdict (${attemptedVerdict}): the adversarial agent may recommend and FLAG, but can NEVER downgrade a BLOCK or soften a composed verdict (AGENTS.md rule 27, phase-4 policy security_agent_cannot_override_block)`,
    );
    this.name = "AgentVerdictOverrideForbiddenError";
    this.attemptedVerdict = attemptedVerdict;
  }
}

function assertRecommendation(value: ThreatRecommendation, label: string): void {
  if (!isThreatVerdict(value)) {
    throw new Error(`${label}: unknown recommendation '${String(value)}'`);
  }
}

/**
 * Compose the agent recommendation with the deterministic policy verdict.
 *
 * THE LAW: the result is the STRICTER of the two (lattice join over
 * ALLOW < ALLOW_WITH_CONSTRAINTS < REQUIRE_CONFIRMATION < BLOCK):
 * - agent BLOCK + anything → BLOCK (an agent BLOCK stays BLOCK);
 * - policy BLOCK + agent ALLOW → BLOCK (the policy overrides the agent);
 * - neither BLOCKs → the more restrictive surviving verdict.
 *
 * An agent can therefore only ever HARDEN a decision, never soften it —
 * and the policy remains authoritative in the other direction.
 */
export function composeThreatVerdict(
  agentRecommendation: ThreatRecommendation,
  policyVerdict: ThreatVerdict,
): ThreatVerdict {
  assertRecommendation(agentRecommendation, "agentRecommendation");
  if (!isThreatVerdict(policyVerdict)) {
    throw new Error(
      `policyVerdict: unknown verdict '${String(policyVerdict)}'`,
    );
  }
  return stricterVerdict(agentRecommendation, policyVerdict);
}

/**
 * OVERRIDE: rejected by construction for every verdict value (the exact
 * kernel `attemptAgentOverride` contract, extended to the threat layer).
 * This function ALWAYS throws; it exists so the rejection is a tested
 * first-class seam. Agents recommend (analyze → recommendation) and FLAG
 * (threatSignalsToAgentFlags); they never compose verdicts on their own.
 */
export function attemptAgentVerdictOverride(
  policyVerdict: ThreatVerdict,
  claimedBy: string,
): never {
  if (!isThreatVerdict(policyVerdict)) {
    throw new Error(`policyVerdict: unknown verdict '${String(policyVerdict)}'`);
  }
  throw new AgentVerdictOverrideForbiddenError(policyVerdict, claimedBy);
}

// ---------------------------------------------------------------------------
// Composition with the kernel gate decision
// ---------------------------------------------------------------------------

/** The final composed decision (four-value vocabulary, task packet). */
export type ComposedSecurityDecision = ThreatVerdict;

/** The result of resolving kernel + threat layers. */
export interface OnchainThreatResolution {
  readonly decision: ComposedSecurityDecision;
  readonly kernelDecision: GateDecision["decision"];
  readonly threatVerdict: ThreatVerdict;
  /**
   * Why: the deterministic basis entries. Kernel BLOCK/UNKNOWN reasons and
   * policy basis lines; the exact seam logic is tested in
   * test/verdict.test.ts.
   */
  readonly basis: readonly string[];
}

/**
 * Resolve the KERNEL gate decision with the composed threat verdict into
 * the final four-value decision. Resolution lattice:
 *
 * - kernel BLOCK → BLOCK. Terminal (rule 27: nothing overrides, the
 *   threat layer only corroborates);
 * - threat verdict BLOCK → BLOCK (agent/policy threat BLOCK is binding
 *   even when the kernel said ALLOW — this is the adversarial extension:
 *   the agent DETECTS threats the deterministic gate dimensions do not
 *   model, and its BLOCK-grade detections bind);
 * - kernel UNKNOWN → at least REQUIRE_CONFIRMATION: an unresolved kernel
 *   dimension can never be silently allowed by an agent recommendation
 *   (INV-X01 — the agent ALLOW is capped, exactly like the kernel's own
 *   `attemptAgentOverride` contract forbids UNKNOWN → ALLOW);
 * - otherwise the threat verdict stands as the composed decision.
 */
export function resolveOnchainSecurityDecision(input: {
  readonly kernelDecision: GateDecision;
  readonly threatVerdict: ThreatVerdict;
}): OnchainThreatResolution {
  const kernel = input.kernelDecision.decision;
  if (!isThreatVerdict(input.threatVerdict)) {
    throw new Error(
      `threatVerdict: unknown verdict '${String(input.threatVerdict)}'`,
    );
  }
  const basis: string[] = [];

  if (kernel === "BLOCK") {
    basis.push("kernel:BLOCK:terminal");
    return {
      decision: "BLOCK",
      kernelDecision: kernel,
      threatVerdict: input.threatVerdict,
      basis: Object.freeze(basis),
    };
  }

  if (VERDICT_RANK[input.threatVerdict] === VERDICT_RANK.BLOCK) {
    basis.push("threat:BLOCK:binding");
    return {
      decision: "BLOCK",
      kernelDecision: kernel,
      threatVerdict: input.threatVerdict,
      basis: Object.freeze(basis),
    };
  }

  if (kernel === "UNKNOWN") {
    // UNKNOWN is never converted to ALLOW by an agent recommendation; the
    // resolution floor for an unresolved kernel dimension is human
    // confirmation (INV-X01 discipline).
    const decision = stricterVerdict(input.threatVerdict, "REQUIRE_CONFIRMATION");
    basis.push(
      `kernel:UNKNOWN:floor=REQUIRE_CONFIRMATION (threat verdict ${input.threatVerdict} composed to ${decision})`,
    );
    return {
      decision,
      kernelDecision: kernel,
      threatVerdict: input.threatVerdict,
      basis: Object.freeze(basis),
    };
  }

  // kernel ALLOW: the composed threat verdict stands.
  basis.push(`kernel:ALLOW:threat_verdict=${input.threatVerdict}`);
  return {
    decision: input.threatVerdict,
    kernelDecision: kernel,
    threatVerdict: input.threatVerdict,
    basis: Object.freeze(basis),
  };
}

// ---------------------------------------------------------------------------
// FLAG attachment (the kernel's advisory-only channel)
// ---------------------------------------------------------------------------

/** Guard-dimension each threat family corroborates (deterministic map). */
export const THREAT_FAMILY_TO_GUARD_DIMENSION: Readonly<
  Record<ThreatFamily, "chain" | "asset" | "amount" | "destination" | "spender_approval" | "expiry" | "route" | "protocol_identity" | "security_state" | "simulation_consistency" | "general">
> = Object.freeze({
  malicious_approval_permit: "spender_approval",
  unexpected_spender: "spender_approval",
  token_impersonation: "asset",
  honeypot_transfer_restriction: "asset",
  proxy_admin_change: "protocol_identity",
  oracle_manipulation: "route",
  bridge_compromise: "route",
  mev_sandwich_exposure: "route",
  destination_chain_confusion: "destination",
  replay_signature_domain: "expiry",
  unexpected_balance_delta: "simulation_consistency",
  stale_changed_simulation: "simulation_consistency",
  finality_reorg_anomaly: "security_state",
});

/**
 * Project a threat assessment onto the kernel's advisory-only channel:
 * one AgentSecurityFlag per signal, carrying the family signal-class and
 * the evidence refs in the note (security signals LINK to evidence — the
 * kernel records the link verbatim). Flags NEVER mutate a decision
 * (kernel law; the kernel's own suite proves it — ours re-proves it at
 * the composition boundary).
 */
export function threatSignalsToAgentFlags(
  assessment: ThreatAssessment,
): readonly AgentSecurityFlag[] {
  const flags: AgentSecurityFlag[] = [];
  for (const signal of assessment.signals) {
    flags.push({
      flagId: `flag:${signal.signalId}`,
      flaggedBy: assessment.agentRef,
      dimension: THREAT_FAMILY_TO_GUARD_DIMENSION[signal.family],
      note:
        `${familySignalClass(signal.family)} [${signal.severity}] ${signal.summary} ` +
        `confidence=${signal.confidenceBps}bps evidence=(obs:${signal.evidence.observationRefs.join(",")}|digest:${signal.evidence.digestRefs.join(",")})`,
      flaggedAt: assessment.analyzedAt,
    });
  }
  return flags;
}

/**
 * Attach every signal of an assessment to a gated evaluation as ADVISORY
 * flags. The returned evaluation's decision object is the SAME object
 * (never rebuilt, never mutated) — the kernel's attachAgentFlag contract.
 */
export function attachThreatAssessment(
  evaluation: GatedEvaluation,
  assessment: ThreatAssessment,
): GatedEvaluation {
  let result = evaluation;
  for (const flag of threatSignalsToAgentFlags(assessment)) {
    result = attachAgentFlag(result, flag);
  }
  return result;
}
