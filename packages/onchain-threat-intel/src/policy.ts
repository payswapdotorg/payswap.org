/**
 * @payswap/onchain-threat-intel — the deterministic threat policy
 * (Work Order P4-W3-003; task packet: "deterministic policy remains
 * authoritative: ALLOW | ALLOW_WITH_CONSTRAINTS | REQUIRE_CONFIRMATION |
 * BLOCK").
 *
 * The POLICY — a versioned, immutable, explicit input, never agent output —
 * maps observed threat signals to the four-value verdict vocabulary:
 *
 *   ALLOW < ALLOW_WITH_CONSTRAINTS < REQUIRE_CONFIRMATION < BLOCK
 *
 * The mapping is a fully explicit default table
 * (DEFAULT_FAMILY_SEVERITY_VERDICTS: family × severity → verdict), which a
 * supplied policy may override per family. Confidence floors apply on top:
 * a signal whose calibrated confidence band is below the family floor can
 * at most REQUIRE_CONFIRMATION (weak evidence escalates to a human, it
 * never silently BLOCKs — but it also never silently ALLOWs).
 *
 * The agent (./agent.ts) computes its own RECOMMENDATION from the same
 * signals, but that recommendation is never authority: ./verdict.ts
 * composes the two under the kernel no-downgrade law
 * (security_agent_cannot_override_block).
 *
 * Deterministic only: a pure function of (signals, policy). No clock, no
 * randomness, no hidden constants — every threshold is a typed policy
 * field; the default table is exported data.
 */

import { ValidationError } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/trust";
import type { ChainRef, ProtocolIdentity } from "@payswap/onchain-security";
import type { ThreatFamily, ThreatSeverity } from "./families.js";
import { isThreatFamily, isThreatSeverity, threatSeverityRank } from "./families.js";
import type { ThreatSignal } from "./signals.js";

// ---------------------------------------------------------------------------
// The verdict vocabulary
// ---------------------------------------------------------------------------

/**
 * The four-value deterministic verdict (task packet vocabulary). Order of
 * restriction: ALLOW < ALLOW_WITH_CONSTRAINTS < REQUIRE_CONFIRMATION <
 * BLOCK.
 */
export const THREAT_VERDICTS = [
  "ALLOW",
  "ALLOW_WITH_CONSTRAINTS",
  "REQUIRE_CONFIRMATION",
  "BLOCK",
] as const;

export type ThreatVerdict = (typeof THREAT_VERDICTS)[number];

export function isThreatVerdict(value: unknown): value is ThreatVerdict {
  return (
    typeof value === "string" &&
    (THREAT_VERDICTS as readonly unknown[]).includes(value)
  );
}

/** Deterministic restriction rank (higher = more restrictive). */
export const VERDICT_RANK: Readonly<Record<ThreatVerdict, number>> =
  Object.freeze({
    ALLOW: 0,
    ALLOW_WITH_CONSTRAINTS: 1,
    REQUIRE_CONFIRMATION: 2,
    BLOCK: 3,
  });

/** The more restrictive of two verdicts (deterministic, symmetric). */
export function stricterVerdict(a: ThreatVerdict, b: ThreatVerdict): ThreatVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// The default severity→verdict table (explicit, exported data)
// ---------------------------------------------------------------------------

/**
 * DEFAULT policy: family × severity → verdict. The deterministic heart of
 * the threat policy. Every cell is deliberate:
 *
 * - families whose success is immediate value loss or contract compromise
 *   (malicious approvals, impersonation, honeypots, chain confusion,
 *     proxy/admin changes) BLOCK at high/critical;
 * - exposure/aggravation families (MEV/sandwich, spender freshness,
 *   reorg anomalies) REQUIRE_CONFIRMATION at high, BLOCK only at critical;
 * - low severity generally allows-with-constraints or escalates;
 * - nothing BLOCKs on `info` — a BLOCK always needs real severity.
 */
export const DEFAULT_FAMILY_SEVERITY_VERDICTS: Readonly<
  Record<ThreatFamily, Readonly<Record<ThreatSeverity, ThreatVerdict>>>
> = Object.freeze({
  malicious_approval_permit: severityVerdicts("ALLOW", "REQUIRE_CONFIRMATION", "REQUIRE_CONFIRMATION", "BLOCK", "BLOCK"),
  unexpected_spender: severityVerdicts("ALLOW", "ALLOW_WITH_CONSTRAINTS", "REQUIRE_CONFIRMATION", "REQUIRE_CONFIRMATION", "BLOCK"),
  token_impersonation: severityVerdicts("ALLOW", "REQUIRE_CONFIRMATION", "BLOCK", "BLOCK", "BLOCK"),
  honeypot_transfer_restriction: severityVerdicts("ALLOW", "REQUIRE_CONFIRMATION", "BLOCK", "BLOCK", "BLOCK"),
  proxy_admin_change: severityVerdicts("ALLOW_WITH_CONSTRAINTS", "REQUIRE_CONFIRMATION", "REQUIRE_CONFIRMATION", "BLOCK", "BLOCK"),
  oracle_manipulation: severityVerdicts("ALLOW", "ALLOW_WITH_CONSTRAINTS", "REQUIRE_CONFIRMATION", "BLOCK", "BLOCK"),
  bridge_compromise: severityVerdicts("ALLOW", "ALLOW_WITH_CONSTRAINTS", "REQUIRE_CONFIRMATION", "BLOCK", "BLOCK"),
  mev_sandwich_exposure: severityVerdicts("ALLOW", "ALLOW_WITH_CONSTRAINTS", "REQUIRE_CONFIRMATION", "REQUIRE_CONFIRMATION", "BLOCK"),
  destination_chain_confusion: severityVerdicts("ALLOW", "REQUIRE_CONFIRMATION", "BLOCK", "BLOCK", "BLOCK"),
  replay_signature_domain: severityVerdicts("ALLOW", "REQUIRE_CONFIRMATION", "REQUIRE_CONFIRMATION", "BLOCK", "BLOCK"),
  unexpected_balance_delta: severityVerdicts("ALLOW", "ALLOW_WITH_CONSTRAINTS", "REQUIRE_CONFIRMATION", "BLOCK", "BLOCK"),
  stale_changed_simulation: severityVerdicts("ALLOW", "REQUIRE_CONFIRMATION", "REQUIRE_CONFIRMATION", "BLOCK", "BLOCK"),
  finality_reorg_anomaly: severityVerdicts("ALLOW", "ALLOW_WITH_CONSTRAINTS", "REQUIRE_CONFIRMATION", "REQUIRE_CONFIRMATION", "BLOCK"),
});

function severityVerdicts(
  info: ThreatVerdict,
  low: ThreatVerdict,
  medium: ThreatVerdict,
  high: ThreatVerdict,
  critical: ThreatVerdict,
): Readonly<Record<ThreatSeverity, ThreatVerdict>> {
  return Object.freeze({ info, low, medium, high, critical });
}

// ---------------------------------------------------------------------------
// The policy contract
// ---------------------------------------------------------------------------

/**
 * A confidence floor: signals below `floor` are capped to `below`
 * (typically REQUIRE_CONFIRMATION); signals at or above keep the table
 * verdict.
 */
export interface ConfidenceFloor {
  readonly floor: number;
  readonly below: ThreatVerdict;
}

/**
 * The versioned deterministic threat policy. Every threshold the detectors
 * and the verdict evaluation consume is an explicit typed field — no hidden
 * constants. `undefined` optional collections mean "no policy constraint on
 * this axis".
 */
export interface OnchainThreatPolicy {
  readonly policyId: string;
  readonly version: number;
  // --- approvals/permits + spenders -----------------------------------
  /** Forbid unlimited (max-integer) approvals/permits outright. */
  readonly forbidUnlimitedApprovals: boolean;
  /** Cap on any single approval amount (exact integer minor units). */
  readonly maxApprovalAmount?: AmountSpec;
  /** Permitted spender addresses (exact). */
  readonly allowedSpenders?: readonly string[];
  /** Minimum age (ms) a spender must have in intelligence history. */
  readonly spenderMinimumAgeMs?: number;
  /** Spender incident count at/above which the spender is flagged. */
  readonly spenderIncidentThreshold?: number;
  // --- tokens ----------------------------------------------------------
  /** Every referenced asset must appear in the observed registry as canonical. */
  readonly requireTokenRegistryCoverage: boolean;
  // --- protocols/proxies -----------------------------------------------
  /** Certified protocol/contract identities (proxy/admin drift reference). */
  readonly certifiedProtocols?: readonly ProtocolIdentity[];
  // --- oracles ----------------------------------------------------------
  /** Max pairwise oracle deviation for the same pair (basis points). */
  readonly maxOracleDeviationBasisPoints?: number;
  /** Max oracle feed age (ms). */
  readonly maxOracleFeedAgeMs?: number;
  /** Reference prices per pair ("num/den"), when the policy pins them. */
  readonly referenceOraclePrices?: readonly { pair: string; price: string }[];
  /** Max deviation from the reference price (basis points). */
  readonly maxOracleReferenceDeviationBasisPoints?: number;
  // --- bridges ----------------------------------------------------------
  /** Route hops that cross chains must have observed bridge health. */
  readonly requireBridgeHealthForBridgeHops: boolean;
  /** Window (ms) in which a validator-set change is treated as suspicious. */
  readonly bridgeValidatorChangeWindowMs?: number;
  /** Minimum acceptable attestation quorum (exact rational "num/den"). */
  readonly minBridgeAttestationQuorum?: string;
  // --- MEV/sandwich -----------------------------------------------------
  /** Max declared slippage limit (basis points). */
  readonly maxSlippageBasisPoints?: number;
  /** Slippage at/above which a VISIBLE (public mempool) swap is critical exposure. */
  readonly sandwichSensitiveSlippageBasisPoints?: number;
  /** Max declared price impact (basis points). */
  readonly maxPriceImpactBasisPoints?: number;
  // --- destination/chain confusion ---------------------------------------
  /** The chain this operation is expected to execute on. */
  readonly expectedChain?: ChainRef;
  // --- simulation freshness ----------------------------------------------
  /** Max age of a simulation observation (ms). */
  readonly maxSimulationAgeMs?: number;
  /** Max lag between the simulation's block and the chain head (blocks). */
  readonly maxSimulationLagBlocks?: number;
  // --- finality/reorg -----------------------------------------------------
  /** Max tolerated reorg depth (blocks). */
  readonly maxReorgDepthBlocks?: number;
  /** Max tolerated head→safe gap (blocks). */
  readonly maxFinalityLagBlocks?: number;
  /** Max age of the observation bundle / security state (ms). */
  readonly maxObservationAgeMs?: number;
  // --- verdict mapping ------------------------------------------------------
  /** Whole-family overrides of the default severity→verdict table. */
  readonly familyVerdicts?: Partial<Record<ThreatFamily, Readonly<Record<ThreatSeverity, ThreatVerdict>>>>;
  /** Confidence floors: below-floor signals are capped to `below`. */
  readonly confidenceFloors?: Partial<Record<ThreatFamily, ConfidenceFloor>>;
  /**
   * Explicit opt-in for RETIRE-grade advisory proposals from critical
   * detections of retire-eligible families (impersonation, honeypots,
   * proxy/admin drift, bridge compromise). Retirement is irreversible —
   * it is never a heuristic default.
   */
  readonly retireCompromisedContracts?: boolean;
}

/** Raised on malformed policy input (fail closed). */
export class InvalidThreatPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidThreatPolicyError";
  }
}

function validateBps(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new InvalidThreatPolicyError(
      `${label} must be an integer in [0, 10000] basis points`,
    );
  }
}

function validateMs(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidThreatPolicyError(`${label} must be a non-negative integer (ms)`);
  }
}

function validateVerdictTable(
  table: Readonly<Record<ThreatSeverity, ThreatVerdict>>,
  family: ThreatFamily,
): void {
  for (const severity of Object.keys(table) as ThreatSeverity[]) {
    if (!isThreatSeverity(severity)) {
      throw new InvalidThreatPolicyError(
        `family verdicts for '${family}': unknown severity '${String(severity)}'`,
      );
    }
    if (!isThreatVerdict(table[severity])) {
      throw new InvalidThreatPolicyError(
        `family verdicts for '${family}'/${severity}: unknown verdict '${String(table[severity])}'`,
      );
    }
  }
}

/** Validate a threat policy (fail closed on malformed fields). */
export function validateThreatPolicy(policy: OnchainThreatPolicy): void {
  if (policy.policyId.length === 0) {
    throw new InvalidThreatPolicyError("policyId must be a non-empty string");
  }
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    throw new InvalidThreatPolicyError("policy.version must be an integer >= 1");
  }
  if (policy.maxApprovalAmount !== undefined && policy.maxApprovalAmount.minorUnits === "") {
    throw new InvalidThreatPolicyError("maxApprovalAmount must be a complete amount");
  }
  for (const spender of policy.allowedSpenders ?? []) {
    if (spender.length === 0) {
      throw new InvalidThreatPolicyError("allowedSpenders entries must be non-empty");
    }
  }
  if (policy.spenderMinimumAgeMs !== undefined) {
    validateMs(policy.spenderMinimumAgeMs, "spenderMinimumAgeMs");
  }
  if (policy.spenderIncidentThreshold !== undefined) {
    if (!Number.isInteger(policy.spenderIncidentThreshold) || policy.spenderIncidentThreshold < 0) {
      throw new InvalidThreatPolicyError("spenderIncidentThreshold must be a non-negative integer");
    }
  }
  if (policy.maxOracleDeviationBasisPoints !== undefined) {
    validateBps(policy.maxOracleDeviationBasisPoints, "maxOracleDeviationBasisPoints");
  }
  if (policy.maxOracleFeedAgeMs !== undefined) {
    validateMs(policy.maxOracleFeedAgeMs, "maxOracleFeedAgeMs");
  }
  for (const reference of policy.referenceOraclePrices ?? []) {
    if (reference.pair.length === 0) {
      throw new InvalidThreatPolicyError("referenceOraclePrices entries require a pair");
    }
    if (!/^(0|[1-9][0-9]*)\/([1-9][0-9]*)$/.test(reference.price)) {
      throw new InvalidThreatPolicyError(
        `reference price '${reference.price}' must be a canonical rational "num/den"`,
      );
    }
  }
  if (policy.maxOracleReferenceDeviationBasisPoints !== undefined) {
    validateBps(policy.maxOracleReferenceDeviationBasisPoints, "maxOracleReferenceDeviationBasisPoints");
  }
  if (policy.bridgeValidatorChangeWindowMs !== undefined) {
    validateMs(policy.bridgeValidatorChangeWindowMs, "bridgeValidatorChangeWindowMs");
  }
  if (
    policy.minBridgeAttestationQuorum !== undefined &&
    !/^(0|[1-9][0-9]*)\/([1-9][0-9]*)$/.test(policy.minBridgeAttestationQuorum)
  ) {
    throw new InvalidThreatPolicyError(
      `minBridgeAttestationQuorum '${policy.minBridgeAttestationQuorum}' must be a canonical rational "num/den"`,
    );
  }
  if (policy.maxSlippageBasisPoints !== undefined) {
    validateBps(policy.maxSlippageBasisPoints, "maxSlippageBasisPoints");
  }
  if (policy.sandwichSensitiveSlippageBasisPoints !== undefined) {
    validateBps(policy.sandwichSensitiveSlippageBasisPoints, "sandwichSensitiveSlippageBasisPoints");
  }
  if (policy.maxPriceImpactBasisPoints !== undefined) {
    validateBps(policy.maxPriceImpactBasisPoints, "maxPriceImpactBasisPoints");
  }
  if (policy.expectedChain !== undefined) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$/.test(policy.expectedChain)) {
      throw new InvalidThreatPolicyError(
        `expectedChain '${policy.expectedChain}' must be a canonical chain reference`,
      );
    }
  }
  if (policy.maxSimulationAgeMs !== undefined) {
    validateMs(policy.maxSimulationAgeMs, "maxSimulationAgeMs");
  }
  if (policy.maxSimulationLagBlocks !== undefined) {
    if (!Number.isInteger(policy.maxSimulationLagBlocks) || policy.maxSimulationLagBlocks < 0) {
      throw new InvalidThreatPolicyError("maxSimulationLagBlocks must be a non-negative integer");
    }
  }
  if (policy.maxReorgDepthBlocks !== undefined) {
    if (!Number.isInteger(policy.maxReorgDepthBlocks) || policy.maxReorgDepthBlocks < 0) {
      throw new InvalidThreatPolicyError("maxReorgDepthBlocks must be a non-negative integer");
    }
  }
  if (policy.maxFinalityLagBlocks !== undefined) {
    if (!Number.isInteger(policy.maxFinalityLagBlocks) || policy.maxFinalityLagBlocks < 0) {
      throw new InvalidThreatPolicyError("maxFinalityLagBlocks must be a non-negative integer");
    }
  }
  if (policy.maxObservationAgeMs !== undefined) {
    validateMs(policy.maxObservationAgeMs, "maxObservationAgeMs");
  }
  for (const [family, table] of Object.entries(policy.familyVerdicts ?? {})) {
    if (!isThreatFamily(family)) {
      throw new InvalidThreatPolicyError(
        `familyVerdicts key '${family}' is not a known threat family`,
      );
    }
    validateVerdictTable(table as Readonly<Record<ThreatSeverity, ThreatVerdict>>, family);
  }
  for (const [family, floor] of Object.entries(policy.confidenceFloors ?? {})) {
    if (!isThreatFamily(family)) {
      throw new InvalidThreatPolicyError(
        `confidenceFloors key '${family}' is not a known threat family`,
      );
    }
    const { floor: value, below } = floor as ConfidenceFloor;
    if (!Number.isInteger(value) || value < 0 || value > 10_000) {
      throw new InvalidThreatPolicyError(
        `confidenceFloors for '${family}': floor must be an integer in [0, 10000] bps`,
      );
    }
    if (!isThreatVerdict(below)) {
      throw new InvalidThreatPolicyError(
        `confidenceFloors for '${family}': unknown below verdict '${String(below)}'`,
      );
    }
  }
  if (
    policy.retireCompromisedContracts !== undefined &&
    typeof policy.retireCompromisedContracts !== "boolean"
  ) {
    throw new InvalidThreatPolicyError(
      "retireCompromisedContracts must be boolean when present",
    );
  }
}

// ---------------------------------------------------------------------------
// Policy evaluation (deterministic, authoritative)
// ---------------------------------------------------------------------------

/** The result of evaluating the policy over a signal set. */
export interface ThreatPolicyEvaluation {
  readonly verdict: ThreatVerdict;
  /** Signals driving the final verdict (most severe first, stable order). */
  readonly drivingSignals: readonly ThreatSignal[];
  /** Human/machine basis entries: one per contributing signal. */
  readonly basis: readonly string[];
  /** The policy ref (id@version) recorded as evidence. */
  readonly policyRef: string;
}

function verdictForSignal(
  signal: ThreatSignal,
  policy: OnchainThreatPolicy,
): { verdict: ThreatVerdict; capped: boolean } {
  const table =
    policy.familyVerdicts?.[signal.family] ??
    DEFAULT_FAMILY_SEVERITY_VERDICTS[signal.family];
  const verdict = table[signal.severity];
  const floor = policy.confidenceFloors?.[signal.family];
  if (floor !== undefined && signal.confidenceBps < floor.floor) {
    return { verdict: stricterVerdict(floor.below, "REQUIRE_CONFIRMATION"), capped: true };
  }
  return { verdict, capped: false };
}

/** Deterministic signal ordering: severity desc, then family, then code. */
export function orderThreatSignals(
  signals: readonly ThreatSignal[],
): readonly ThreatSignal[] {
  return [...signals].sort((a, b) => {
    const rank = threatSeverityRank(b.severity) - threatSeverityRank(a.severity);
    if (rank !== 0) {
      return rank;
    }
    if (a.family !== b.family) {
      return a.family < b.family ? -1 : 1;
    }
    if (a.code !== b.code) {
      return a.code < b.code ? -1 : 1;
    }
    return 0;
  });
}

/**
 * Evaluate the deterministic threat policy over a set of signals.
 * The verdict is the MOST RESTRICTIVE per-signal verdict, with confidence
 * floors applied (a below-floor signal caps at the floor's `below` verdict
 * — weak evidence escalates to humans, it never silently blocks or
 * allows). Deterministic: same (signals, policy) → same evaluation.
 */
export function evaluateThreatPolicy(
  signals: readonly ThreatSignal[],
  policy: OnchainThreatPolicy,
): ThreatPolicyEvaluation {
  validateThreatPolicy(policy);
  if (signals.length === 0) {
    return {
      verdict: "ALLOW",
      drivingSignals: [],
      basis: [],
      policyRef: `${policy.policyId}@${policy.version}`,
    };
  }

  const ordered = orderThreatSignals(signals);
  let verdict: ThreatVerdict = "ALLOW";
  const driving: ThreatSignal[] = [];
  const basis: string[] = [];
  for (const signal of ordered) {
    const perSignal = verdictForSignal(signal, policy);
    if (VERDICT_RANK[perSignal.verdict] > VERDICT_RANK[verdict]) {
      verdict = perSignal.verdict;
    }
    if (VERDICT_RANK[perSignal.verdict] >= VERDICT_RANK["REQUIRE_CONFIRMATION"]) {
      driving.push(signal);
      basis.push(
        `${signal.signalId}:${signal.family}:${signal.severity}:verdict=${perSignal.verdict}` +
          (perSignal.capped
            ? `:confidence_capped(${signal.confidenceBps}bps<floor)`
            : `:confidence=${signal.confidenceBps}bps`),
      );
    }
  }
  return {
    verdict,
    drivingSignals: Object.freeze(driving),
    basis: Object.freeze(basis),
    policyRef: `${policy.policyId}@${policy.version}`,
  };
}
