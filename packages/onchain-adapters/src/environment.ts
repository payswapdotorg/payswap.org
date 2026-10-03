/**
 * @payswap/onchain-adapters — the STRUCTURAL environment/rail discriminator
 * (Work Order P4-W2-001 hard constraint: "testnet/simulation can NEVER be
 * production financial execution. The environment/rail discriminator must be
 * structural, not a runtime flag alone").
 *
 * Structural enforcement, three layers:
 *
 * 1. CHAIN IDENTITY: a chainKey itself classifies into an environment class
 *    through a frozen registry (`classifyChainEnvironment`) — `ethereum:sepolia`
 *    IS a testnet chain, `ethereum:mainnet` IS a production chain. An adapter
 *    for a testnet chain cannot even be CONSTRUCTED claiming production: the
 *    constructor cross-checks the declared class against the registry and
 *    throws. A runtime flag cannot lie about the chain identity.
 *
 * 2. BRANDED TYPES: `RailEnvironment<Class>` is a branded nominal type. The
 *    production-settlement gate (./settlement-gate.ts) accepts only
 *    `RailEnvironment<"PRODUCTION">` — a `RailEnvironment<"TESTNET">` value is
 *    TYPE-INCOMPATIBLE with mapping observations into production settlement
 *    machinery, and the runtime re-derives the class from the chainKey so a
 *    forged brand cannot pass either.
 *
 * 3. RUNTIME RE-DERIVATION: every environment-carrying record (observations,
 *    envelopes) is re-validated against the registry on the settlement path —
 *    defense in depth against brand forgery.
 *
 * Unknown chainKeys classify fail-closed (ValidationError) — environment is
 * never guessed (rule: an adapter that cannot express a semantic fails closed).
 */

import { ValidationError } from "@payswap/protocol";
import { TestnetNeverProductionError } from "./errors.js";

export const RAIL_ENVIRONMENT_CLASSES = [
  "PRODUCTION",
  "TESTNET",
  "REGTEST",
  "SIMULATION",
] as const;

export type RailEnvironmentClass = (typeof RAIL_ENVIRONMENT_CLASSES)[number];

export function isRailEnvironmentClass(
  value: unknown,
): value is RailEnvironmentClass {
  return (
    typeof value === "string" &&
    (RAIL_ENVIRONMENT_CLASSES as readonly unknown[]).includes(value)
  );
}

/**
 * The frozen chain-environment registry: which chainKey is which environment
 * class. This registry is a DECLARATION (chain identity is the environment);
 * adding a chain requires an explicit registry entry — never a guess.
 * Registry provenance: PaySwap chain-environment declaration,
 * P4-W2-001, architecture 1.6-frozen-2026-10-02.
 */
export const CHAIN_ENVIRONMENT_REGISTRY: Readonly<Record<string, RailEnvironmentClass>> =
  Object.freeze({
    // EVM family
    "ethereum:mainnet": "PRODUCTION",
    "ethereum:sepolia": "TESTNET",
    "ethereum:holesky": "TESTNET",
    // SOLANA family
    "solana:mainnet-beta": "PRODUCTION",
    "solana:devnet": "TESTNET",
    "solana:testnet": "TESTNET",
    // UTXO family (Bitcoin)
    "bitcoin:mainnet": "PRODUCTION",
    "bitcoin:testnet": "TESTNET",
    "bitcoin:signet": "TESTNET",
    "bitcoin:regtest": "REGTEST",
  });

/**
 * Deterministic chain-environment classification. Unknown chainKeys throw
 * (fail closed): the environment of an undeclared chain is never guessed.
 */
export function classifyChainEnvironment(chainKey: string): RailEnvironmentClass {
  const classified = CHAIN_ENVIRONMENT_REGISTRY[chainKey];
  if (classified === undefined) {
    throw new ValidationError(
      `chainKey '${chainKey}' has no declared environment classification in the frozen chain-environment registry — the rail environment is structural (chain identity), never guessed (fail closed)`,
    );
  }
  return classified;
}

/** Nominal brand: this value is a rail environment token, not a plain string. */
declare const RAIL_ENVIRONMENT_BRAND: unique symbol;

/**
 * A STRUCTURAL rail environment token. The brand parameter is the environment
 * class, so `RailEnvironment<"PRODUCTION">` and `RailEnvironment<"TESTNET">`
 * are distinct, non-interchangeable types on the settlement path.
 */
export interface RailEnvironment<Class extends RailEnvironmentClass = RailEnvironmentClass> {
  readonly [RAIL_ENVIRONMENT_BRAND]: Class;
  readonly environmentClass: Class;
  readonly chainKey: string;
  /** Registry declaration provenance. */
  readonly declaredBy: string;
}

/**
 * Constructs the structural rail environment token for a chainKey. The class
 * is DERIVED from the frozen registry (never passed in), so the token cannot
 * disagree with the chain identity. The returned type is narrowed to the
 * derived class — use `productionEnvironment()` for the production-branded
 * construction used on settlement paths.
 */
export function railEnvironment<Class extends RailEnvironmentClass>(
  chainKey: string,
): RailEnvironment<Class> {
  const environmentClass = classifyChainEnvironment(chainKey);
  return Object.freeze({
    environmentClass,
    chainKey,
    declaredBy: "CHAIN_ENVIRONMENT_REGISTRY@p4-w2-001",
  }) as RailEnvironment<Class>;
}

/**
 * Constructs the PRODUCTION-branded rail environment. Throws
 * `TestnetNeverProductionError` when the chainKey is not a production chain —
 * the only way to obtain a `RailEnvironment<"PRODUCTION">` is a chain the
 * registry classifies as production.
 */
export function productionEnvironment(chainKey: string): RailEnvironment<"PRODUCTION"> {
  const environmentClass = classifyChainEnvironment(chainKey);
  if (environmentClass !== "PRODUCTION") {
    throw new TestnetNeverProductionError(
      `chainKey '${chainKey}' is classified '${environmentClass}' by the frozen chain-environment registry and can never carry a PRODUCTION environment token: testnet/simulation rails are structurally barred from production financial execution`,
      { chainKey, environmentClass },
    );
  }
  return railEnvironment<"PRODUCTION">(chainKey);
}

/**
 * Runtime re-derivation guard (defense in depth): re-classifies the chainKey
 * from the registry and asserts the expected class. A forged brand cannot
 * pass — the chain identity always re-derives the truth.
 */
export function assertEnvironmentClass(
  chainKey: string,
  expected: RailEnvironmentClass,
): void {
  const actual = classifyChainEnvironment(chainKey);
  if (actual !== expected) {
    throw new ValidationError(
      `chainKey '${chainKey}' structurally classifies as '${actual}', not '${expected}' — the environment discriminator is derived from chain identity (never a runtime flag)`,
    );
  }
}
