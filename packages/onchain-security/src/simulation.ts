/**
 * @payswap/onchain-security — simulation observations (Work Order
 * P4-W1-002; AGENTS.md rule 26/29; INV-L01; INV-X01).
 *
 * A simulation result is an OBSERVATION, never authority. No function in
 * this package accepts a SimulationObservation and produces an
 * authorization artifact or advances the pipeline to AUTHORIZED — the
 * adversarial test suite proves simulation-never-authority by construction.
 * Simulations inform the expected-state diff shown to the user and feed
 * the deterministic gates (consistency checks), nothing more.
 *
 * UNKNOWN is not FAILED (INV-X01): an inconclusive simulation is
 * OUTCOME_UNKNOWN, a first-class status that the gates surface as the
 * UNKNOWN decision dimension — never silently converted into BLOCK or
 * ALLOW.
 *
 * Deterministic only: the simulator supplies `observedAt`; no ambient
 * clock, no randomness.
 */

import { assertNoSecretMaterial } from "./secrets.js";
import type { AssetIdentity } from "./types.js";
import { validateAddress, validateAssetIdentity } from "./types.js";
import type { AmountSpec } from "@payswap/trust";
import { validateAmountSpec } from "@payswap/trust";

/** Simulation outcome. OUTCOME_UNKNOWN is never FAILED (INV-X01). */
export type SimulationStatus =
  | "SUCCEEDED"
  | "REVERTED"
  | "FAILED"
  | "OUTCOME_UNKNOWN";

/** Raised on malformed simulation input (fail closed). */
export class InvalidSimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSimulationError";
  }
}

/** One observed balance delta (direction-signed exact minor units). */
export interface SimulatedBalanceDelta {
  readonly holder: string;
  readonly asset: AssetIdentity;
  readonly amount: AmountSpec;
  readonly direction: "credit" | "debit";
}

/** One observed post-simulation allowance state. */
export interface ObservedApprovalState {
  readonly owner: string;
  readonly spender: string;
  readonly asset: AssetIdentity;
  readonly allowance: AmountSpec;
  readonly unlimited: boolean;
}

/**
 * A simulation observation of one prepared write. AGENT-FACING: secret
 * scan applies (the simulator must never leak node/provider credentials
 * into the observation).
 */
export interface SimulationObservation {
  readonly simulationId: string;
  readonly writeId: string;
  readonly status: SimulationStatus;
  readonly observedAt: number;
  /** Block reference the simulation ran against (provenance). */
  readonly blockRef?: string;
  readonly balanceDeltas: readonly SimulatedBalanceDelta[];
  readonly approvals: readonly ObservedApprovalState[];
  /** Exact integer gas estimate string, when the simulator provides one. */
  readonly gasEstimate?: string;
  /** Simulator component ref (provenance). */
  readonly simulator: string;
}

/** Validate, secret-scan and freeze a simulation observation. */
export function recordSimulation(observation: SimulationObservation): SimulationObservation {
  assertNoSecretMaterial(observation, "simulation observation");

  if (observation.simulationId.length === 0) {
    throw new InvalidSimulationError("simulationId must be a non-empty string");
  }
  if (observation.writeId.length === 0) {
    throw new InvalidSimulationError("writeId must be a non-empty string");
  }
  if (!Number.isInteger(observation.observedAt) || observation.observedAt < 0) {
    throw new InvalidSimulationError("observedAt must be a non-negative integer (ms)");
  }
  if (observation.simulator.length === 0) {
    throw new InvalidSimulationError("simulator must be a non-empty component ref (provenance)");
  }
  for (const delta of observation.balanceDeltas) {
    validateAddress(delta.holder, "balanceDeltas.holder");
    validateAssetIdentity(delta.asset);
    validateAmountSpec(delta.amount);
    if (delta.amount.currency !== delta.asset.symbol) {
      throw new InvalidSimulationError(
        `delta amount currency '${delta.amount.currency}' does not match asset symbol '${delta.asset.symbol}'`,
      );
    }
  }
  for (const approval of observation.approvals) {
    validateAddress(approval.owner, "approvals.owner");
    validateAddress(approval.spender, "approvals.spender");
    validateAssetIdentity(approval.asset);
    validateAmountSpec(approval.allowance);
    if (approval.unlimited && approval.allowance.minorUnits !== "0") {
      throw new InvalidSimulationError(
        "an unlimited observed allowance must carry allowance 0 (unbounded is explicit)",
      );
    }
  }
  if (observation.gasEstimate !== undefined && !/^\d+$/.test(observation.gasEstimate)) {
    throw new InvalidSimulationError("gasEstimate must be an exact non-negative integer string");
  }

  return Object.freeze({
    simulationId: observation.simulationId,
    writeId: observation.writeId,
    status: observation.status,
    observedAt: observation.observedAt,
    ...(observation.blockRef !== undefined ? { blockRef: observation.blockRef } : {}),
    balanceDeltas: Object.freeze(observation.balanceDeltas.map((d) => Object.freeze(d))),
    approvals: Object.freeze(observation.approvals.map((a) => Object.freeze(a))),
    ...(observation.gasEstimate !== undefined ? { gasEstimate: observation.gasEstimate } : {}),
    simulator: observation.simulator,
  });
}
