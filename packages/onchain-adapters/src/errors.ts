/**
 * @payswap/onchain-adapters — error taxonomy (Work Order P4-W2-001).
 *
 * Every error is a fail-closed signal: adapters never approximate a missing
 * semantic and never convert ambiguity into success/failure (INV-X01).
 */

import { PaySwapError } from "@payswap/protocol";
import type { PaySwapErrorDetails, ErrorCategory } from "@payswap/protocol";
import type { AdapterLifecycleStage } from "./contract.js";

/**
 * The environment/rail discriminator law (P4-W2-001 hard constraint):
 * testnet/simulation state can NEVER be production financial execution.
 * The discriminator is STRUCTURAL (chain identity + branded environment
 * types), not a runtime flag alone — see ./environment.ts.
 */
export class TestnetNeverProductionError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "TESTNET_NEVER_PRODUCTION",
      category: "AUTHORIZATION_REQUIRED" as ErrorCategory,
      message,
      details,
    });
    this.name = "TestnetNeverProductionError";
  }
}

/**
 * A family adapter was asked to perform a lifecycle stage it explicitly
 * declared unsupported (e.g. UTXO simulation). Fail closed — the adapter
 * never approximates an unimplementable stage.
 */
export class UnsupportedLifecycleStageError extends PaySwapError {
  constructor(adapterId: string, stage: AdapterLifecycleStage, reason: string) {
    super({
      code: "ADAPTER_STAGE_UNSUPPORTED",
      category: "VALIDATION" as ErrorCategory,
      message: `adapter '${adapterId}' explicitly declares lifecycle stage '${stage}' unsupported: ${reason} — the stage fails closed, it is never approximated`,
      details: { adapterId, stage, reason },
    });
    this.name = "UnsupportedLifecycleStageError";
  }
}

/**
 * The observed rail state is too old to act on (freshness violation), or the
 * chain head regressed below a previously observed head. Stale observations
 * invalidate prepared state; they never silently authorize execution.
 */
export class StaleObservationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "STALE_OBSERVATION",
      category: "STALE_STATE" as ErrorCategory,
      message,
      details,
    });
    this.name = "StaleObservationError";
  }
}

/**
 * A chain-identity cross-check failed (EVM eth_chainId, Solana genesis
 * hash, UTXO genesis block hash): the endpoint does not serve the chain the
 * adapter/instance declares. Chain confusion is a first-class threat — fail
 * closed, never routed around.
 */
export class ChainIdentityMismatchError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "CHAIN_IDENTITY_MISMATCH",
      category: "SECURITY" as ErrorCategory,
      message,
      details,
    });
    this.name = "ChainIdentityMismatchError";
  }
}

/**
 * A family semantic could not be expressed from the observed rail state
 * (e.g. an EVM block without EIP-1559 baseFee cannot express GAS_AUCTION
 * 1559 fee parameters). Fail closed — the semantic is never approximated.
 */
export class SemanticNotExpressibleError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "SEMANTIC_NOT_EXPRESSIBLE",
      category: "VALIDATION" as ErrorCategory,
      message,
      details,
    });
    this.name = "SemanticNotExpressibleError";
  }
}

/**
 * The adapter transport could not establish ANY endpoint connection. Callers
 * turn this into availability UNKNOWN (INV-C02) — the error class exists so
 * observation paths can distinguish reachability failure from a rail fact.
 */
export class RailUnreachableError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "RAIL_UNREACHABLE",
      category: "UNAVAILABLE" as ErrorCategory,
      message,
      details,
    });
    this.name = "RailUnreachableError";
  }
}
