/**
 * @payswap/onchain-security — deterministic security gates (Work Order
 * P4-W1-002; AGENTS.md rules 26-28; INV-S01..S03, INV-A05, INV-X01).
 *
 * The gates are a DETERMINISTIC STATE EVALUATION, not an agent judgment:
 * a pure function of (prepared write, optional simulation observation,
 * versioned policy, composed security state, evaluation instant) that
 * outputs exactly one of:
 *
 * - BLOCK  — a guard dimension is definitively violated. Terminal: no
 *   agent, heuristic or adversarial signal can override or downgrade it
 *   (rule 27); `attemptAgentOverride` is rejected by construction.
 * - ALLOW  — every dimension passed on current evidence.
 * - UNKNOWN — a dimension cannot be verified from available evidence
 *   (uncertified protocol, inconclusive simulation, stale security state).
 *   UNKNOWN is NEVER silently converted to ALLOW or BLOCK; it can only be
 *   resolved by NEW evidence: a policy-authority escalation record
 *   (versioned policy input with evidence refs) or re-running the gates
 *   after certification/state refresh.
 *
 * Guard dimensions evaluated BEFORE authorization (task contract): chain,
 * asset, amount, destination, spender/approval changes, expiry, route and
 * protocol/contract identity — plus composed immune-system state and
 * simulation consistency.
 *
 * The immune-system composition is pure data: `OnchainSecurityState` is
 * supplied by the wiring layer from the REAL @payswap/security machinery
 * (network SecurityEpoch, quarantine ledger, advisory restriction view);
 * test/security-composition.test.ts proves the composition with the real
 * machinery.
 *
 * Adversarial/heuristic agents may FLAG (`attachAgentFlag`): flags are
 * recorded as evidence and can never mutate a decision.
 *
 * Deterministic only: no ambient clock (callers pass `at`), no randomness.
 */

import { compareAmounts } from "@payswap/trust";
import { assertNoSecretMaterial } from "./secrets.js";
import type { PreparedWrite } from "./write-intent.js";
import type { SimulationObservation } from "./simulation.js";
import type { AssetIdentity, ProtocolIdentity } from "./types.js";
import { sameAsset, sameProtocol } from "./types.js";

// ---------------------------------------------------------------------------
// Guard dimensions, checks, reasons
// ---------------------------------------------------------------------------

/** Every guard dimension evaluated before authorization. */
export const GUARD_DIMENSIONS = [
  "chain",
  "asset",
  "amount",
  "destination",
  "spender_approval",
  "expiry",
  "route",
  "protocol_identity",
  "security_state",
  "simulation_consistency",
] as const;

export type GuardDimension = (typeof GUARD_DIMENSIONS)[number];

export type GuardOutcome = "pass" | "block" | "unknown";

/** One dimension's outcome with its exact evidence. */
export interface GuardCheck {
  readonly dimension: GuardDimension;
  readonly outcome: GuardOutcome;
  /** Machine code, e.g. `chain_not_permitted`. */
  readonly code: string;
  readonly detail: string;
}

/** A definitive violation. Terminal — no override path exists (rule 27). */
export interface BlockReason {
  readonly dimension: GuardDimension;
  readonly code: string;
  readonly message: string;
  /** INV-xxx invariant ids + AGENTS.md rule numbers exercised. */
  readonly invariantRefs: readonly string[];
}

/** A dimension that cannot be verified from available evidence. */
export interface UnknownDimension {
  readonly dimension: GuardDimension;
  readonly code: string;
  readonly message: string;
}

export type GateDecision =
  | {
      readonly decision: "ALLOW";
      readonly checks: readonly GuardCheck[];
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly decision: "BLOCK";
      readonly reasons: readonly BlockReason[];
      readonly checks: readonly GuardCheck[];
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly decision: "UNKNOWN";
      readonly dimensions: readonly UnknownDimension[];
      readonly checks: readonly GuardCheck[];
      readonly evidenceRefs: readonly string[];
    };

// ---------------------------------------------------------------------------
// Policy (versioned deterministic input — frozen at evaluation)
// ---------------------------------------------------------------------------

/**
 * A POLICY-AUTHORITY resolution of one UNKNOWN dimension (rule 28's
 * "explicit escalation according to policy"). Escalations are versioned
 * policy INPUTS with evidence refs — agents can never mint them at
 * runtime; the adversarial suite proves an injected escalation is ignored.
 */
export interface UnknownDimensionEscalation {
  readonly escalationId: string;
  readonly dimension: Extract<GuardDimension, "route" | "protocol_identity" | "security_state" | "simulation_consistency">;
  /** The exact target this resolves: routeHash, protocolId, contract target or asset id. */
  readonly targetRef: string;
  readonly disposition: "allow_with_evidence";
  readonly evidenceRefs: readonly string[];
  /** Policy authority ref that recorded the resolution. */
  readonly resolvedBy: string;
  readonly resolvedAt: number;
  readonly expiresAt: number;
}

/** Deterministic security policy: versioned, immutable input. */
export interface OnchainSecurityPolicy {
  readonly policyId: string;
  readonly version: number;
  /** Allowed chains (exact). Undefined = policy leaves chains unrestricted. */
  readonly allowedChains?: readonly string[];
  /** Allowed assets (exact chain+assetId+identity). Undefined = unrestricted. */
  readonly allowedAssets?: readonly AssetIdentity[];
  /** Allowed destination addresses (exact strings). Undefined = unrestricted. */
  readonly allowedDestinations?: readonly string[];
  /** Allowed spender addresses for approvals. Undefined = unrestricted. */
  readonly allowedSpenders?: readonly string[];
  /** Cap on any single approval amount. */
  readonly maxApprovalAmount?: { readonly currency: string; readonly minorUnits: string };
  /** Forbid unlimited (max-integer) approvals outright. */
  readonly forbidUnlimitedApprovals: boolean;
  /** Certified route hashes. */
  readonly knownRoutes?: readonly string[];
  /** Certified protocol/contract identities (INV-SC01 declarations). */
  readonly certifiedProtocols?: readonly ProtocolIdentity[];
  /** Rule 28: unknown generic contract writes never execute silently. */
  readonly unknownContractPolicy: "block" | "escalate";
  readonly unknownRoutePolicy: "block" | "escalate";
  /** Policy-authority resolutions of UNKNOWN dimensions (with evidence). */
  readonly escalations?: readonly UnknownDimensionEscalation[];
  /** Max age of the composed security state before it is itself UNKNOWN. */
  readonly maxSecurityStateAgeMs?: number;
}

/**
 * Composed immune-system state — PURE DATA produced by the wiring layer
 * from the REAL @payswap/security machinery (SecurityEpochAuthority,
 * QuarantineLedger, SecurityAdvisoryRegistry). The gates treat these as
 * authoritative immune-system observations (INV-S01/S02/S03).
 */
export interface OnchainSecurityState {
  /** Observation instant of this security state. */
  readonly observedAt: number;
  /** Current network SecurityEpoch value. */
  readonly networkEpoch: bigint;
  /** Quarantined component keys (`kind:id`, from QuarantineLedger). */
  readonly quarantinedComponents: readonly string[];
  /** Restricted component keys (from active advisory restrictions). */
  readonly restrictedComponents: readonly string[];
  /** Active security advisory refs. */
  readonly activeAdvisoryRefs: readonly string[];
}

/** Raised on malformed gate input (fail closed). */
export class InvalidGateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGateInputError";
  }
}

/** Raised when ANY agent attempts to override a gate decision (rule 27). */
export class AgentOverrideForbiddenError extends Error {
  readonly attemptedDecision: GateDecision["decision"];

  constructor(attemptedDecision: GateDecision["decision"], claimedBy: string) {
    super(
      `Agent '${claimedBy}' attempted to override a deterministic ${attemptedDecision} gate decision: agents may FLAG but can NEVER override a BLOCK or convert UNKNOWN to ALLOW (AGENTS.md rule 27)`,
    );
    this.name = "AgentOverrideForbiddenError";
    this.attemptedDecision = attemptedDecision;
  }
}

// ---------------------------------------------------------------------------
// Agent flags (advisory only — never authority, never mutation)
// ---------------------------------------------------------------------------

/** An adversarial/heuristic agent observation attached as evidence. */
export interface AgentSecurityFlag {
  readonly flagId: string;
  readonly flaggedBy: string;
  readonly dimension: GuardDimension | "general";
  readonly note: string;
  readonly flaggedAt: number;
}

/** A gate decision plus attached advisory agent flags (decision immutable). */
export interface GatedEvaluation {
  readonly decision: GateDecision;
  readonly flags: readonly AgentSecurityFlag[];
}

/**
 * FLAG: attach an adversarial/heuristic observation. The decision object
 * is NEVER mutated — flags ride alongside as evidence. This is the ONLY
 * influence an agent has on a gated evaluation, and it has none on the
 * decision itself (rule 27).
 */
export function attachAgentFlag(evaluation: GatedEvaluation, flag: AgentSecurityFlag): GatedEvaluation {
  assertNoSecretMaterial(flag, "agent security flag");
  if (flag.flagId.length === 0) {
    throw new InvalidGateInputError("flagId must be a non-empty string");
  }
  if (flag.flaggedBy.length === 0) {
    throw new InvalidGateInputError("flaggedBy must be a non-empty string (agent ref)");
  }
  return {
    decision: evaluation.decision,
    flags: [...evaluation.flags, Object.freeze(flag)],
  };
}

/**
 * OVERRIDE: rejected by construction for every decision value. An agent
 * never needs to override anything: ALLOW needs no override, BLOCK is
 * untouchable (rule 27), and UNKNOWN → ALLOW by agent judgment is exactly
 * the silent conversion the architecture forbids. This function ALWAYS
 * throws; it exists so the rejection is a tested, first-class contract.
 */
export function attemptAgentOverride(
  decision: GateDecision,
  claimedBy: string,
): never {
  throw new AgentOverrideForbiddenError(decision.decision, claimedBy);
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

export interface GateEvaluationInput {
  readonly write: PreparedWrite;
  /** Simulation observation for the SAME write, when one was run. */
  readonly simulation?: SimulationObservation;
  readonly policy: OnchainSecurityPolicy;
  readonly securityState: OnchainSecurityState;
  /** Deterministic evaluation instant (ms). */
  readonly at: number;
}

function check(dimension: GuardDimension, outcome: GuardOutcome, code: string, detail: string): GuardCheck {
  return Object.freeze({ dimension, outcome, code, detail });
}

function block(
  dimension: GuardDimension,
  code: string,
  message: string,
  invariantRefs: readonly string[],
): BlockReason {
  return Object.freeze({ dimension, code, message, invariantRefs: Object.freeze([...invariantRefs]) });
}

function unknown(dimension: GuardDimension, code: string, message: string): UnknownDimension {
  return Object.freeze({ dimension, code, message });
}

function escalationCovers(
  policy: OnchainSecurityPolicy,
  dimension: UnknownDimensionEscalation["dimension"],
  targetRef: string,
  at: number,
): UnknownDimensionEscalation | undefined {
  return (policy.escalations ?? []).find(
    (escalation) =>
      escalation.dimension === dimension &&
      escalation.targetRef === targetRef &&
      escalation.disposition === "allow_with_evidence" &&
      at < escalation.expiresAt,
  );
}

/** Component ids of the write that immune-system components can match. */
function writeComponentIds(write: PreparedWrite): readonly string[] {
  const ids: string[] = [];
  if (write.protocol !== undefined) {
    ids.push(write.protocol.protocolId, write.protocol.contract.contractAddress);
  }
  if (write.contractCall !== undefined) {
    ids.push(write.contractCall.target);
  }
  for (const hop of write.route.hops ?? []) {
    ids.push(hop.venue);
  }
  for (const approval of write.approvals) {
    ids.push(approval.spender);
  }
  return ids;
}

/**
 * The deterministic security gates. Pure function of the input; every
 * dimension produces exactly one GuardCheck; the decision is:
 * BLOCK (any block reason) > UNKNOWN (any unresolved dimension) > ALLOW.
 */
export function evaluateOnchainWriteGates(input: GateEvaluationInput): GateDecision {
  const { write, simulation, policy, securityState, at } = input;

  assertNoSecretMaterial(policy, "onchain security policy");
  assertNoSecretMaterial(securityState, "onchain security state");
  if (policy.policyId.length === 0) {
    throw new InvalidGateInputError("policy.policyId must be non-empty");
  }
  if (policy.version < 1) {
    throw new InvalidGateInputError("policy.version must be >= 1");
  }
  if (!Number.isInteger(at) || at < 0) {
    throw new InvalidGateInputError("evaluation instant `at` must be a non-negative integer (ms)");
  }

  const checks: GuardCheck[] = [];
  const reasons: BlockReason[] = [];
  const unknowns: UnknownDimension[] = [];
  const evidenceRefs: string[] = [
    `policy:${policy.policyId}@${policy.version}`,
    `write:${write.writeDigest}`,
  ];
  if (simulation !== undefined) {
    evidenceRefs.push(`simulation:${simulation.simulationId}`);
  }
  evidenceRefs.push(`securityState:epoch-${securityState.networkEpoch.toString()}`);

  // 1. chain
  if (policy.allowedChains !== undefined && !policy.allowedChains.includes(write.chain)) {
    reasons.push(
      block("chain", "chain_not_permitted", `chain '${write.chain}' is not permitted by policy`, ["AGENTS-26", "INV-A05"]),
    );
    checks.push(check("chain", "block", "chain_not_permitted", `chain ${write.chain} not in allowedChains`));
  } else {
    checks.push(check("chain", "pass", "chain_permitted", `chain ${write.chain} permitted`));
  }

  // 2. asset + 3. amount (per leg / approval)
  const transfer = write.transfer;
  if (transfer !== undefined) {
    const assetAllowed =
      policy.allowedAssets === undefined || policy.allowedAssets.some((a) => sameAsset(a, transfer.asset));
    if (!assetAllowed) {
      reasons.push(
        block("asset", "asset_not_permitted", `asset ${transfer.asset.assetId} (${transfer.asset.symbol} on ${transfer.asset.chain}) is not in the policy allowlist (fake-token defense)`, ["INV-C05", "INV-A05"]),
      );
      checks.push(check("asset", "block", "asset_not_permitted", `asset ${transfer.asset.assetId} not allowlisted`));
    } else {
      checks.push(check("asset", "pass", "asset_permitted", `asset ${transfer.asset.assetId} allowlisted`));
    }
    if (transfer.amount.minorUnits === "0") {
      reasons.push(
        block("amount", "transfer_amount_not_positive", "a value transfer must carry a positive exact amount", ["INV-F01"]),
      );
      checks.push(check("amount", "block", "transfer_amount_not_positive", "zero-amount transfer"));
    } else {
      checks.push(check("amount", "pass", "transfer_amount_positive", `exact integer amount ${transfer.amount.minorUnits} ${transfer.amount.currency}`));
    }
  } else {
    checks.push(check("asset", "pass", "no_transfer", "write carries no transfer leg"));
    checks.push(check("amount", "pass", "no_transfer", "write carries no transfer amount"));
  }

  // 4. destination
  if (transfer !== undefined && policy.allowedDestinations !== undefined) {
    if (!policy.allowedDestinations.includes(transfer.to)) {
      reasons.push(
        block("destination", "destination_not_permitted", `destination ${transfer.to} is not a permitted beneficiary`, ["INV-A01", "INV-A03", "INV-A05"]),
      );
      checks.push(check("destination", "block", "destination_not_permitted", `destination ${transfer.to} not allowlisted`));
    } else {
      checks.push(check("destination", "pass", "destination_permitted", `destination ${transfer.to} permitted`));
    }
  } else if (transfer !== undefined) {
    checks.push(check("destination", "pass", "destination_unrestricted", "policy leaves destinations unrestricted"));
  } else {
    checks.push(check("destination", "pass", "no_transfer", "write carries no destination"));
  }

  // 5. spender / approval changes
  for (const approval of write.approvals) {
    const spenderAllowed =
      policy.allowedSpenders === undefined || policy.allowedSpenders.includes(approval.spender);
    if (!spenderAllowed) {
      reasons.push(
        block("spender_approval", "spender_not_permitted", `spender ${approval.spender} is not a permitted spender (malicious-approval defense)`, ["INV-SC03", "INV-A05"]),
      );
      checks.push(check("spender_approval", "block", "spender_not_permitted", `spender ${approval.spender} not allowlisted`));
      continue;
    }
    if (approval.unlimited && policy.forbidUnlimitedApprovals) {
      reasons.push(
        block("spender_approval", "unlimited_approval_forbidden", `unlimited approval to spender ${approval.spender} is forbidden by policy`, ["INV-SC03", "INV-A05"]),
      );
      checks.push(check("spender_approval", "block", "unlimited_approval_forbidden", `unlimited approval for ${approval.spender}`));
      continue;
    }
    const cap = policy.maxApprovalAmount;
    if (!approval.unlimited && cap !== undefined) {
      if (cap.currency !== approval.amount.currency) {
        reasons.push(
          block("spender_approval", "approval_cap_currency_mismatch", `approval currency ${approval.amount.currency} does not match policy cap currency ${cap.currency}`, ["INV-F01", "INV-A05"]),
        );
        checks.push(check("spender_approval", "block", "approval_cap_currency_mismatch", `currency mismatch vs cap`));
        continue;
      }
      if (compareAmounts(approval.amount, cap) > 0) {
        reasons.push(
          block("spender_approval", "approval_exceeds_cap", `approval of ${approval.amount.minorUnits} ${approval.amount.currency} to ${approval.spender} exceeds the policy cap ${cap.minorUnits}`, ["INV-SC03", "INV-F01", "INV-A05"]),
        );
        checks.push(check("spender_approval", "block", "approval_exceeds_cap", `approval exceeds cap`));
        continue;
      }
    }
    checks.push(check("spender_approval", "pass", "approval_permitted", `approval for spender ${approval.spender} permitted`));
  }
  if (write.approvals.length === 0) {
    checks.push(check("spender_approval", "pass", "no_approvals", "write carries no approval changes"));
  }

  // 6. expiry
  if (write.expiry <= at) {
    reasons.push(
      block("expiry", "write_expired", `write expired at ${write.expiry}; the evaluation instant is ${at}`, ["INV-A02", "AGENTS-26"]),
    );
    checks.push(check("expiry", "block", "write_expired", `expiry ${write.expiry} <= at ${at}`));
  } else {
    checks.push(check("expiry", "pass", "write_live", `expiry ${write.expiry} > at ${at}`));
  }

  // 7. route
  if (policy.knownRoutes !== undefined && !policy.knownRoutes.includes(write.route.routeHash)) {
    if (policy.unknownRoutePolicy === "block") {
      reasons.push(
        block("route", "route_not_certified", `route ${write.route.routeId} (hash ${write.route.routeHash}) is not a certified route`, ["INV-C05", "INV-A05", "AGENTS-26"]),
      );
      checks.push(check("route", "block", "route_not_certified", `routeHash ${write.route.routeHash} not certified`));
    } else {
      const escalation = escalationCovers(policy, "route", write.route.routeHash, at);
      if (escalation !== undefined) {
        checks.push(check("route", "pass", "route_escalated", `route ${write.route.routeHash} covered by policy escalation ${escalation.escalationId}`));
        evidenceRefs.push(`escalation:${escalation.escalationId}`, ...escalation.evidenceRefs);
      } else {
        unknowns.push(
          unknown("route", "route_certification_unknown", `route ${write.route.routeHash} is not certified and carries no policy escalation`),
        );
        checks.push(check("route", "unknown", "route_certification_unknown", `routeHash ${write.route.routeHash} unknown`));
      }
    }
  } else {
    checks.push(check("route", "pass", "route_permitted", `route ${write.route.routeHash} permitted`));
  }

  // 8. protocol / contract identity (INV-SC01, rule 28)
  if (write.protocol !== undefined) {
    const certified =
      policy.certifiedProtocols === undefined ||
      policy.certifiedProtocols.some((p) => sameProtocol(p, write.protocol!));
    if (!certified) {
      if (policy.unknownContractPolicy === "block") {
        reasons.push(
          block("protocol_identity", "protocol_not_certified", `protocol ${write.protocol.protocolId}@${write.protocol.version} on ${write.protocol.contract.chainRef} at ${write.protocol.contract.contractAddress} is not a certified protocol identity`, ["INV-SC01", "INV-SC04", "INV-A05", "AGENTS-28"]),
        );
        checks.push(check("protocol_identity", "block", "protocol_not_certified", `protocol ${write.protocol.protocolId} not certified`));
      } else {
        const escalation = escalationCovers(policy, "protocol_identity", write.protocol.protocolId, at);
        if (escalation !== undefined) {
          checks.push(check("protocol_identity", "pass", "protocol_escalated", `protocol ${write.protocol.protocolId} covered by policy escalation ${escalation.escalationId}`));
          evidenceRefs.push(`escalation:${escalation.escalationId}`, ...escalation.evidenceRefs);
        } else {
          unknowns.push(
            unknown("protocol_identity", "protocol_certification_unknown", `protocol ${write.protocol.protocolId}@${write.protocol.version} is not certified and carries no policy escalation`),
          );
          checks.push(check("protocol_identity", "unknown", "protocol_certification_unknown", `protocol ${write.protocol.protocolId} unknown`));
        }
      }
    } else {
      checks.push(check("protocol_identity", "pass", "protocol_certified", `protocol ${write.protocol.protocolId}@${write.protocol.version} certified`));
    }
  } else if (write.contractCall !== undefined) {
    // Generic contract interaction: the controlled escape hatch (rule 28).
    if (policy.unknownContractPolicy === "block") {
      reasons.push(
        block("protocol_identity", "unknown_contract_write", `generic contract write to ${write.contractCall.target} on ${write.chain} has no certified protocol identity and policy blocks unknown writes`, ["AGENTS-28", "INV-SC01", "INV-A05"]),
      );
      checks.push(check("protocol_identity", "block", "unknown_contract_write", `target ${write.contractCall.target} unknown`));
    } else {
      const escalation = escalationCovers(policy, "protocol_identity", write.contractCall.target, at);
      if (escalation !== undefined) {
        checks.push(check("protocol_identity", "pass", "contract_escalated", `target ${write.contractCall.target} covered by policy escalation ${escalation.escalationId}`));
        evidenceRefs.push(`escalation:${escalation.escalationId}`, ...escalation.evidenceRefs);
      } else {
        unknowns.push(
          unknown("protocol_identity", "unknown_contract_requires_escalation", `generic contract write to ${write.contractCall.target} on ${write.chain} requires explicit policy escalation (never executes silently)`),
        );
        checks.push(check("protocol_identity", "unknown", "unknown_contract_requires_escalation", `target ${write.contractCall.target} requires escalation`));
      }
    }
  } else {
    checks.push(check("protocol_identity", "pass", "no_protocol_identity", "write carries no protocol/contract identity (value movement only)"));
  }

  // 9. composed security state (INV-S01/S02/S03)
  const maxAge = policy.maxSecurityStateAgeMs;
  if (maxAge !== undefined && at - securityState.observedAt > maxAge) {
    unknowns.push(
      unknown("security_state", "security_state_stale", `security state observed at ${securityState.observedAt} is older than the policy max age ${maxAge}ms at evaluation instant ${at}`),
    );
    checks.push(check("security_state", "unknown", "security_state_stale", `state age ${at - securityState.observedAt}ms > maxAge`));
  } else {
    const componentIds = new Set(writeComponentIds(write));
    const offending = [...securityState.quarantinedComponents, ...securityState.restrictedComponents].find(
      (componentKey) => {
        const id = componentKey.includes(":") ? componentKey.slice(componentKey.indexOf(":") + 1) : componentKey;
        return componentIds.has(id);
      },
    );
    if (offending !== undefined) {
      reasons.push(
        block("security_state", "component_quarantined_or_restricted", `component '${offending}' referenced by this write is quarantined or restricted by an active security advisory (cached capability state can never bypass this)`, ["INV-S01", "INV-S03", "AGENTS-27"]),
      );
      checks.push(check("security_state", "block", "component_quarantined_or_restricted", `component ${offending} blocked by immune system`));
      for (const advisoryRef of securityState.activeAdvisoryRefs) {
        evidenceRefs.push(`advisory:${advisoryRef}`);
      }
    } else {
      checks.push(check("security_state", "pass", "security_state_clean", `no quarantined/restricted component referenced (epoch ${securityState.networkEpoch.toString()})`));
    }
  }

  // 10. simulation consistency (INV-L01: simulation is not production truth)
  if (simulation !== undefined) {
    if (simulation.writeId !== write.writeId) {
      reasons.push(
        block("simulation_consistency", "simulation_write_mismatch", `simulation ${simulation.simulationId} observed write '${simulation.writeId}', not this write '${write.writeId}'`, ["INV-E01", "AGENTS-26"]),
      );
      checks.push(check("simulation_consistency", "block", "simulation_write_mismatch", `writeId mismatch`));
    } else if (simulation.status === "REVERTED" || simulation.status === "FAILED") {
      reasons.push(
        block("simulation_consistency", "simulation_reverted", `simulation ${simulation.simulationId} reports status ${simulation.status}`, ["AGENTS-26", "INV-L01"]),
      );
      checks.push(check("simulation_consistency", "block", "simulation_reverted", `status ${simulation.status}`));
    } else if (simulation.status === "OUTCOME_UNKNOWN") {
      // INV-X01: UNKNOWN is not FAILED — surfaced, never converted.
      unknowns.push(
        unknown("simulation_consistency", "simulation_outcome_unknown", `simulation ${simulation.simulationId} could not determine the outcome (OUTCOME_UNKNOWN is not FAILED)`),
      );
      checks.push(check("simulation_consistency", "unknown", "simulation_outcome_unknown", `simulation inconclusive`));
    } else {
      // SUCCEEDED: observed deltas must match the intent exactly.
      const transferLeg = write.transfer;
      if (transferLeg !== undefined) {
        const debit = simulation.balanceDeltas.find(
          (delta) =>
            delta.direction === "debit" &&
            delta.holder === transferLeg.from &&
            sameAsset(delta.asset, transferLeg.asset),
        );
        if (debit === undefined) {
          reasons.push(
            block("simulation_consistency", "simulation_debit_missing", `simulation observed no debit of ${transferLeg.asset.symbol} from ${transferLeg.from}`, ["INV-F01", "AGENTS-26"]),
          );
          checks.push(check("simulation_consistency", "block", "simulation_debit_missing", `no debit for ${transferLeg.from}`));
        } else if (compareAmounts(debit.amount, transferLeg.amount) !== 0) {
          reasons.push(
            block("simulation_consistency", "simulation_amount_mismatch", `simulation observed a debit of ${debit.amount.minorUnits} ${debit.amount.currency}, but the intent moves ${transferLeg.amount.minorUnits} ${transferLeg.amount.currency}`, ["INV-F01", "AGENTS-26"]),
          );
          checks.push(check("simulation_consistency", "block", "simulation_amount_mismatch", `debit ${debit.amount.minorUnits} != intent ${transferLeg.amount.minorUnits}`));
        }
        const credit = simulation.balanceDeltas.find(
          (delta) =>
            delta.direction === "credit" &&
            delta.holder === transferLeg.to &&
            sameAsset(delta.asset, transferLeg.asset),
        );
        if (credit === undefined || compareAmounts(credit.amount, transferLeg.amount) !== 0) {
          reasons.push(
            block("simulation_consistency", "simulation_destination_mismatch", `simulation did not observe the intended credit of ${transferLeg.amount.minorUnits} ${transferLeg.amount.currency} to ${transferLeg.to}`, ["INV-F01", "AGENTS-26"]),
          );
          checks.push(check("simulation_consistency", "block", "simulation_destination_mismatch", `credit to ${transferLeg.to} missing or divergent`));
        }
      }
      for (const approval of write.approvals) {
        const observed = simulation.approvals.find(
          (candidate) =>
            candidate.owner === approval.owner &&
            candidate.spender === approval.spender &&
            sameAsset(candidate.asset, approval.asset),
        );
        const observedEqual =
          observed !== undefined &&
          observed.unlimited === approval.unlimited &&
          (approval.unlimited || compareAmounts(observed.allowance, approval.amount) === 0);
        if (!observedEqual) {
          reasons.push(
            block("simulation_consistency", "simulation_approval_mismatch", `simulation did not observe the intended allowance for spender ${approval.spender} on ${approval.asset.symbol} (owner ${approval.owner})`, ["INV-SC03", "AGENTS-26"]),
          );
          checks.push(check("simulation_consistency", "block", "simulation_approval_mismatch", `allowance for spender ${approval.spender} divergent`));
        }
      }
      if (
        !reasons.some((r) => r.dimension === "simulation_consistency") &&
        !checks.some((c) => c.dimension === "simulation_consistency")
      ) {
        checks.push(check("simulation_consistency", "pass", "simulation_consistent", `simulation ${simulation.simulationId} consistent with intent`));
      }
    }
  } else {
    checks.push(check("simulation_consistency", "pass", "no_simulation", "no simulation was run (policy decides whether one is required)"));
  }

  const frozenChecks = Object.freeze(checks);
  const frozenEvidence = Object.freeze(evidenceRefs);

  if (reasons.length > 0) {
    return Object.freeze({
      decision: "BLOCK",
      reasons: Object.freeze(reasons),
      checks: frozenChecks,
      evidenceRefs: frozenEvidence,
    });
  }
  if (unknowns.length > 0) {
    return Object.freeze({
      decision: "UNKNOWN",
      dimensions: Object.freeze(unknowns),
      checks: frozenChecks,
      evidenceRefs: frozenEvidence,
    });
  }
  return Object.freeze({
    decision: "ALLOW",
    checks: frozenChecks,
    evidenceRefs: frozenEvidence,
  });
}
