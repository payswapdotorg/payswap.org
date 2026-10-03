/**
 * @payswap/onchain-adapters — the production settlement gate (P4-W2-001).
 *
 * Adapters map into canonical SettlementInstruction / SettlementAttempt /
 * RailOperation / FinalityRecord via the EXISTING settlement-mapping
 * vocabulary of @payswap/onchain-domain (onchainRailId,
 * mapObservationToRailOutcome, mapToRailOperation,
 * settlementAttemptEventCandidate) — NO parallel ledger, NO duplicate
 * connector vocabulary.
 *
 * This module adds the one thing the neutral vocabulary deliberately does not
 * carry: the STRUCTURAL environment gate. Only a PRODUCTION environment may
 * feed observations into production settlement machinery:
 * - type level: `AdapterSettlementEnvelope<"PRODUCTION">` is required;
 * - runtime: the environment class is re-derived from the frozen
 *   chain-environment registry (a forged brand cannot pass) and the
 *   observation's chainKey must match the envelope's chain.
 *
 * Testnet/simulation observations structurally CANNOT become production
 * financial execution (TestnetNeverProductionError).
 *
 * Finality stays protocol-owned: this gate exposes
 * `observationPermitsFinalityDeclaration` (always false, INV-F06) and NEVER
 * constructs a FinalityRecord — it can only reference one minted by the
 * settlement plane's authority.
 */

import { mapToRailOperation, onchainRailId } from "@payswap/onchain-domain";
import type { OnchainRailOperationMapping } from "@payswap/onchain-domain";
import { validateOnchainExecutionObservation } from "@payswap/onchain-domain";
import { classifyChainEnvironment, productionEnvironment } from "./environment.js";
import type { RailEnvironment } from "./environment.js";
import { TestnetNeverProductionError } from "./errors.js";

/**
 * The settlement envelope: structural proof that an adapter operates a
 * PRODUCTION rail. Constructible ONLY via `adapterSettlementEnvelope`, which
 * re-derives the environment class from chain identity.
 */
export interface AdapterSettlementEnvelope<Class extends "PRODUCTION" = "PRODUCTION"> {
  readonly brand: "AdapterSettlementEnvelope";
  readonly environment: RailEnvironment<Class>;
  readonly adapterId: string;
}

/**
 * Constructs the production settlement envelope for an adapter-shaped value
 * ({ adapterId, chainKey, environmentClass }). The chainKey is RE-CLASSIFIED
 * from the frozen registry; anything but PRODUCTION throws
 * TestnetNeverProductionError — testnet/simulation can never produce
 * production financial execution, structurally.
 */
export function adapterSettlementEnvelope(adapter: {
  readonly adapterId: string;
  readonly chainKey: string;
  readonly environmentClass: string;
}): AdapterSettlementEnvelope<"PRODUCTION"> {
  if (adapter.environmentClass !== "PRODUCTION") {
    throw new TestnetNeverProductionError(
      `adapter '${adapter.adapterId}' operates a '${adapter.environmentClass}' rail — a ${adapter.environmentClass} adapter envelope can never feed production settlement machinery (environment/rail discrimination is structural: chain '${adapter.chainKey}' classifies as '${classifyChainEnvironment(adapter.chainKey)}')`,
      { adapterId: adapter.adapterId, chainKey: adapter.chainKey },
    );
  }
  // Re-derive from chain identity — a forged class string cannot pass.
  const environment = productionEnvironment(adapter.chainKey);
  return Object.freeze({ brand: "AdapterSettlementEnvelope", environment, adapterId: adapter.adapterId });
}

/**
 * Maps an adapter observation into the canonical rail-operation mapping via
 * the EXISTING settlement vocabulary, behind the production environment gate.
 * Deterministic rules (fail closed):
 * - the observation is a valid OnchainExecutionObservation;
 * - the observation's chainKey matches the envelope's chainKey (chain
 *   confusion is a first-class threat);
 * - only PRODUCTION envelopes pass (structural + runtime re-derivation);
 * - the rail id is the canonical `onchain.${chainKey}`.
 */
export function mapAdapterObservationToRailOperation(input: {
  readonly envelope: AdapterSettlementEnvelope<"PRODUCTION">;
  readonly observation: unknown;
  readonly settlementInstructionId: string;
  readonly settlementAttemptId: string;
}): OnchainRailOperationMapping {
  const observation = validateOnchainExecutionObservation(input.observation);
  if (observation.chainKey !== input.envelope.environment.chainKey) {
    throw new TestnetNeverProductionError(
      `observation chainKey '${observation.chainKey}' does not match the settlement envelope chain '${input.envelope.environment.chainKey}' — cross-chain/cross-environment mapping is a chain-confusion attack and fails closed`,
      { observationChainKey: observation.chainKey, envelopeChainKey: input.envelope.environment.chainKey },
    );
  }
  // mapToRailOperation re-validates the observation, derives the deterministic
  // rail id `onchain.${chainKey}` and maps the outcome (UNKNOWN stays UNKNOWN).
  return mapToRailOperation({
    observation,
    settlementInstructionId: input.settlementInstructionId,
    settlementAttemptId: input.settlementAttemptId,
  });
}

/** The canonical rail id for the envelope's chain (settlement attempt rail). */
export function envelopeRailId(envelope: AdapterSettlementEnvelope<"PRODUCTION">): string {
  return onchainRailId(envelope.environment.chainKey);
}

/**
 * Deterministic restatement of the protocol-owned-finality law for adapter
 * callers: an adapter observation NEVER permits a finality declaration —
 * finality is declared by the settlement plane's authority only (INV-F06,
 * rule 29). Returns false, always.
 */
export function adapterObservationPermitsFinalityDeclaration(): false {
  return false;
}
