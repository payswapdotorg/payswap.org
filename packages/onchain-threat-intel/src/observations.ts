/**
 * @payswap/onchain-threat-intel — the threat-intelligence observation
 * bundle (Work Order P4-W3-003).
 *
 * The adversarial agent never guesses: it consumes an OBSERVATION BUNDLE —
 * deterministic, secret-scanned, provenance-carrying intelligence about the
 * world the write will execute in:
 *
 * - spender intelligence (drain patterns, first observation, incidents);
 * - token registry observations (canonical assets, impersonators,
 *   honeypot/transfer-restriction markers);
 * - oracle readings (exact rationals, observation times, feed ages);
 * - bridge health (status, validator-set changes, attestation quorum);
 * - chain finality (head/safe blocks, last reorg depth);
 * - mempool visibility of the pending write;
 * - signature-domain intelligence (previously observed payload digests,
 *   domain/chain refs, nonce reuse, permit deadlines);
 * - the execution-quote disclosures (slippage/liquidity impact) as typed
 *   inputs from @payswap/best-execution (the P4-W2-002 composition).
 *
 * Every entry carries an observation id: signals reference exactly these
 * ids in their evidence chains (./evidence.ts). The bundle itself is
 * content-addressed (kernel digest) — assessments pin it.
 *
 * The bundle is AGENT-FACING: the kernel secret scan
 * (assertNoSecretMaterial) runs on the whole bundle at record time; node
 * credentials, provider secrets or key-shaped material are rejected by
 * construction (AGENTS.md rule 25).
 *
 * Deterministic only: the observer supplies every instant; no ambient
 * clock, no randomness, no network.
 */

import { ValidationError } from "@payswap/protocol";
import type { SlippageDisclosure, LiquidityImpactDisclosure } from "@payswap/best-execution";
import type { AssetIdentity, ChainRef } from "@payswap/onchain-security";
import { validateAssetIdentity, validateChainRef, validateAddress } from "@payswap/onchain-security";
import { assertNoSecretMaterial, contentDigest } from "@payswap/onchain-security";

// ---------------------------------------------------------------------------
// Spender intelligence
// ---------------------------------------------------------------------------

/**
 * Intelligence about one spender (allowance recipient). Behavioral,
 * provenance-carrying; NEVER a judgment — the policy decides.
 */
export interface SpenderIntelligence {
  /** Observation id (referenced by evidence chains). */
  readonly observationId: string;
  readonly spender: string;
  /** A known drain pattern is associated with this spender. */
  readonly knownDrainPattern: boolean;
  /** When the spender first appeared in the intelligence horizon (ms). */
  readonly firstObservedAt?: number;
  /** Count of incidents attributed to this spender, when tracked. */
  readonly observedIncidents?: number;
  /** Intelligence sources contributing this entry. */
  readonly sources?: readonly string[];
}

function validateSpenderIntelligence(entry: SpenderIntelligence): void {
  if (entry.observationId.length === 0) {
    throw new ValidationError("spender intelligence requires an observationId");
  }
  validateAddress(entry.spender, "spender intelligence address");
  if (entry.firstObservedAt !== undefined && entry.firstObservedAt < 0) {
    throw new ValidationError("firstObservedAt must be a non-negative ms value");
  }
  if (
    entry.observedIncidents !== undefined &&
    (!Number.isInteger(entry.observedIncidents) || entry.observedIncidents < 0)
  ) {
    throw new ValidationError("observedIncidents must be a non-negative integer");
  }
  for (const source of entry.sources ?? []) {
    if (source.length === 0) {
      throw new ValidationError("spender intelligence sources must be non-empty refs");
    }
  }
}

// ---------------------------------------------------------------------------
// Token registry observations
// ---------------------------------------------------------------------------

/**
 * One token-registry observation: the observed status of an asset the
 * write touches (transfer asset, approval assets). The registry view is an
 * OBSERVATION of the registry at bundle-observedAt — never a live lookup.
 */
export interface TokenRegistryEntry {
  readonly observationId: string;
  readonly asset: AssetIdentity;
  /** The registry certifies this exact (chain, assetId, symbol) as canonical. */
  readonly canonical: boolean;
  /** When this entry is an impersonator: the canonical assetId it mimics. */
  readonly impersonatesAssetId?: string;
  /** Registry-observed transfer restriction (honeypot marker). */
  readonly transferRestricted?: boolean;
  /** Registry-observed sellability (false = cannot move value out). */
  readonly sellable?: boolean;
}

function validateTokenRegistryEntry(entry: TokenRegistryEntry): void {
  if (entry.observationId.length === 0) {
    throw new ValidationError("token registry entry requires an observationId");
  }
  validateAssetIdentity(entry.asset);
  if (entry.impersonatesAssetId !== undefined && entry.impersonatesAssetId.length === 0) {
    throw new ValidationError("impersonatesAssetId must be non-empty when present");
  }
}

// ---------------------------------------------------------------------------
// Oracle readings
// ---------------------------------------------------------------------------

/**
 * One oracle reading (exact rational price, e.g. "998750/1000"). Prices are
 * canonical "num/den" rationals — never floating point.
 */
export interface OracleObservation {
  readonly observationId: string;
  /** Oracle component id (e.g. "oracle:chainlink-usdc-eth"). */
  readonly oracleId: string;
  /** The quoted pair, e.g. "USC/USD". */
  readonly pair: string;
  /** Exact rational price "num/den" (den > 0). */
  readonly observedPrice: string;
  /** When the oracle last updated this price (ms). */
  readonly priceUpdatedAt: number;
  /** Age of the oracle update at bundle observation (ms, ≥ 0). */
  readonly feedAgeMs: number;
}

function validateOracleObservation(entry: OracleObservation): void {
  if (entry.observationId.length === 0) {
    throw new ValidationError("oracle observation requires an observationId");
  }
  if (entry.oracleId.length === 0 || entry.pair.length === 0) {
    throw new ValidationError("oracle observation requires oracleId and pair");
  }
  if (!/^(0|[1-9][0-9]*)\/([1-9][0-9]*)$/.test(entry.observedPrice)) {
    throw new ValidationError(
      `oracle price '${entry.observedPrice}' must be a canonical rational "num/den"`,
    );
  }
  if (
    !Number.isInteger(entry.priceUpdatedAt) ||
    entry.priceUpdatedAt < 0 ||
    !Number.isInteger(entry.feedAgeMs) ||
    entry.feedAgeMs < 0
  ) {
    throw new ValidationError(
      "oracle observation requires non-negative integer priceUpdatedAt and feedAgeMs",
    );
  }
}

// ---------------------------------------------------------------------------
// Bridge health
// ---------------------------------------------------------------------------

/** Observed health of one bridge the route may cross. */
export interface BridgeHealthObservation {
  readonly observationId: string;
  readonly bridgeId: string;
  readonly status: "healthy" | "degraded" | "halted";
  /** When the validator set last changed (ms), when known. */
  readonly validatorSetChangedAt?: number;
  /** Observed attestation quorum as exact rational "num/den", when known. */
  readonly attestationQuorum?: string;
  readonly observedAt: number;
}

function validateBridgeHealthObservation(entry: BridgeHealthObservation): void {
  if (entry.observationId.length === 0) {
    throw new ValidationError("bridge health observation requires an observationId");
  }
  if (entry.bridgeId.length === 0) {
    throw new ValidationError("bridge health observation requires a bridgeId");
  }
  if (
    entry.status !== "healthy" &&
    entry.status !== "degraded" &&
    entry.status !== "halted"
  ) {
    throw new ValidationError(
      `unknown bridge status '${String(entry.status)}'`,
    );
  }
  if (entry.validatorSetChangedAt !== undefined && entry.validatorSetChangedAt < 0) {
    throw new ValidationError("validatorSetChangedAt must be non-negative ms");
  }
  if (
    entry.attestationQuorum !== undefined &&
    !/^(0|[1-9][0-9]*)\/([1-9][0-9]*)$/.test(entry.attestationQuorum)
  ) {
    throw new ValidationError(
      `attestation quorum '${entry.attestationQuorum}' must be a canonical rational "num/den"`,
    );
  }
  if (!Number.isInteger(entry.observedAt) || entry.observedAt < 0) {
    throw new ValidationError("bridge observedAt must be a non-negative integer");
  }
}

// ---------------------------------------------------------------------------
// Chain finality + mempool
// ---------------------------------------------------------------------------

/** Observed chain finality state (head, safe head, last reorg depth). */
export interface FinalityObservation {
  readonly observationId: string;
  readonly chain: ChainRef;
  /** Observed chain head block (non-negative integer). */
  readonly headBlock: number;
  /** Observed safe/finality-candidate block (≤ head). */
  readonly safeBlock: number;
  /** Depth of the last observed reorg in blocks, when one occurred. */
  readonly lastReorgDepthBlocks?: number;
  readonly observedAt: number;
}

function validateFinalityObservation(entry: FinalityObservation): void {
  if (entry.observationId.length === 0) {
    throw new ValidationError("finality observation requires an observationId");
  }
  validateChainRef(entry.chain);
  if (
    !Number.isInteger(entry.headBlock) ||
    entry.headBlock < 0 ||
    !Number.isInteger(entry.safeBlock) ||
    entry.safeBlock < 0
  ) {
    throw new ValidationError(
      "finality observation requires non-negative integer headBlock and safeBlock",
    );
  }
  if (entry.safeBlock > entry.headBlock) {
    throw new ValidationError(
      `safeBlock ${entry.safeBlock} cannot exceed headBlock ${entry.headBlock}`,
    );
  }
  if (
    entry.lastReorgDepthBlocks !== undefined &&
    (!Number.isInteger(entry.lastReorgDepthBlocks) ||
      entry.lastReorgDepthBlocks < 0)
  ) {
    throw new ValidationError("lastReorgDepthBlocks must be a non-negative integer");
  }
  if (!Number.isInteger(entry.observedAt) || entry.observedAt < 0) {
    throw new ValidationError("finality observedAt must be a non-negative integer");
  }
}

/** Observed mempool visibility of the pending write. */
export interface MempoolObservation {
  readonly observationId: string;
  readonly chain: ChainRef;
  /** True when the write's payload is visible pre-confirmation (public mempool). */
  readonly writeVisible: boolean;
  /** Count of competing transactions observed for the same venue/pool. */
  readonly competingTransactions?: number;
  readonly observedAt: number;
}

function validateMempoolObservation(entry: MempoolObservation): void {
  if (entry.observationId.length === 0) {
    throw new ValidationError("mempool observation requires an observationId");
  }
  validateChainRef(entry.chain);
  if (
    entry.competingTransactions !== undefined &&
    (!Number.isInteger(entry.competingTransactions) ||
      entry.competingTransactions < 0)
  ) {
    throw new ValidationError("competingTransactions must be a non-negative integer");
  }
  if (!Number.isInteger(entry.observedAt) || entry.observedAt < 0) {
    throw new ValidationError("mempool observedAt must be a non-negative integer");
  }
}

// ---------------------------------------------------------------------------
// Signature-domain intelligence
// ---------------------------------------------------------------------------

/**
 * Signature-domain intelligence for the exact payload digest of this write
 * (EIP-712 style): has this digest been observed before (replay), under
 * which domain/chain, and has its nonce/permit deadline expired.
 */
export interface DomainObservation {
  readonly observationId: string;
  /** The payload digest this intelligence is bound to. */
  readonly payloadDigest: string;
  /** The observed signing-domain identifier (opaque, e.g. domain hash ref). */
  readonly domainRef: string;
  /** The chain the signing domain is bound to, when known. */
  readonly domainChain?: ChainRef;
  /** True when this exact digest was previously observed (replay risk). */
  readonly digestPreviouslyObserved: boolean;
  /** When the write's nonce was last used (nonce reuse), when known. */
  readonly nonceLastUsedAt?: number;
  /** Permit deadline (ms) carried by the signed payload, when present. */
  readonly permitDeadline?: number;
  readonly observedAt: number;
}

function validateDomainObservation(entry: DomainObservation): void {
  if (entry.observationId.length === 0) {
    throw new ValidationError("domain observation requires an observationId");
  }
  if (entry.payloadDigest.length === 0 || entry.domainRef.length === 0) {
    throw new ValidationError(
      "domain observation requires payloadDigest and domainRef",
    );
  }
  if (entry.domainChain !== undefined) {
    validateChainRef(entry.domainChain);
  }
  if (entry.nonceLastUsedAt !== undefined && entry.nonceLastUsedAt < 0) {
    throw new ValidationError("nonceLastUsedAt must be non-negative ms");
  }
  if (entry.permitDeadline !== undefined && entry.permitDeadline < 0) {
    throw new ValidationError("permitDeadline must be non-negative ms");
  }
  if (!Number.isInteger(entry.observedAt) || entry.observedAt < 0) {
    throw new ValidationError("domain observedAt must be a non-negative integer");
  }
}

// ---------------------------------------------------------------------------
// Address intelligence (destination/chain confusion)
// ---------------------------------------------------------------------------

/**
 * Intelligence about one address: the chains it is known to be active on.
 * Used for destination/chain confusion (an address reused across chains).
 */
export interface AddressIntelligence {
  readonly observationId: string;
  readonly address: string;
  /** Chains the address is observed active on (may be several). */
  readonly chainsActiveOn: readonly ChainRef[];
  readonly observedAt: number;
}

function validateAddressIntelligence(entry: AddressIntelligence): void {
  if (entry.observationId.length === 0) {
    throw new ValidationError("address intelligence requires an observationId");
  }
  validateAddress(entry.address, "address intelligence address");
  if (entry.chainsActiveOn.length === 0) {
    throw new ValidationError(
      "address intelligence requires at least one active chain",
    );
  }
  for (const chain of entry.chainsActiveOn) {
    validateChainRef(chain);
  }
  if (!Number.isInteger(entry.observedAt) || entry.observedAt < 0) {
    throw new ValidationError("address observedAt must be a non-negative integer");
  }
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/**
 * The observation bundle: one deterministic, secret-scanned,
 * content-addressed intelligence snapshot the agent analyzes. Optional
 * sections are ABSENT intelligence, not clean bills: detectors treat
 * absence as evidence-weak (registry_absence method, low band) only where
 * the policy demands coverage.
 */
export interface OnchainThreatObservationBundle {
  readonly bundleId: string;
  /** Observer provenance (who assembled this bundle). */
  readonly observer: string;
  /** Observation instant (ms) — the bundle's freshness anchor. */
  readonly observedAt: number;
  readonly spenders?: readonly SpenderIntelligence[];
  readonly tokens?: readonly TokenRegistryEntry[];
  readonly oracles?: readonly OracleObservation[];
  readonly bridges?: readonly BridgeHealthObservation[];
  readonly finality?: FinalityObservation;
  readonly mempool?: MempoolObservation;
  readonly domain?: DomainObservation;
  readonly addresses?: readonly AddressIntelligence[];
  /** Execution-quote disclosures (P4-W2-002 typed inputs). */
  readonly quoteSlippage?: SlippageDisclosure;
  readonly quoteLiquidityImpact?: LiquidityImpactDisclosure;
  /** When the quote was observed / expires (ms), when quotes are supplied. */
  readonly quoteObservedAt?: number;
  readonly quoteValidUntil?: number;
  /** Content digest binding the whole bundle (computed at record time). */
  readonly bundleDigest: string;
}

/** Raised when a bundle fails structural validation (fail closed). */
export class InvalidObservationBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidObservationBundleError";
  }
}

function requireUniqueIds(
  entries: readonly { observationId: string }[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.observationId)) {
      throw new InvalidObservationBundleError(
        `duplicate observationId '${entry.observationId}' in ${label}`,
      );
    }
    seen.add(entry.observationId);
  }
}

/**
 * Validate, secret-scan, freeze and content-address an observation bundle.
 * Fail-closed: malformed intelligence is never repaired or guessed. The
 * secret scan is the kernel's (rule 25: no key material crosses the
 * agent-facing boundary — not even inside "intelligence").
 */
export function recordObservationBundle(
  bundle: Omit<OnchainThreatObservationBundle, "bundleDigest">,
): OnchainThreatObservationBundle {
  assertNoSecretMaterial(bundle, "onchain threat observation bundle");

  if (bundle.bundleId.length === 0) {
    throw new InvalidObservationBundleError("bundleId must be non-empty");
  }
  if (bundle.observer.length === 0) {
    throw new InvalidObservationBundleError("observer must be a non-empty provenance ref");
  }
  if (!Number.isInteger(bundle.observedAt) || bundle.observedAt < 0) {
    throw new InvalidObservationBundleError(
      "observedAt must be a non-negative integer (ms)",
    );
  }

  if (bundle.spenders !== undefined) {
    requireUniqueIds(bundle.spenders, "spender intelligence");
    for (const entry of bundle.spenders) {
      validateSpenderIntelligence(entry);
    }
  }
  if (bundle.tokens !== undefined) {
    requireUniqueIds(bundle.tokens, "token registry");
    for (const entry of bundle.tokens) {
      validateTokenRegistryEntry(entry);
    }
  }
  if (bundle.oracles !== undefined) {
    requireUniqueIds(bundle.oracles, "oracle observations");
    for (const entry of bundle.oracles) {
      validateOracleObservation(entry);
    }
  }
  if (bundle.bridges !== undefined) {
    requireUniqueIds(bundle.bridges, "bridge health");
    for (const entry of bundle.bridges) {
      validateBridgeHealthObservation(entry);
    }
  }
  if (bundle.finality !== undefined) {
    validateFinalityObservation(bundle.finality);
  }
  if (bundle.mempool !== undefined) {
    validateMempoolObservation(bundle.mempool);
  }
  if (bundle.domain !== undefined) {
    validateDomainObservation(bundle.domain);
  }
  if (bundle.addresses !== undefined) {
    requireUniqueIds(bundle.addresses, "address intelligence");
    for (const entry of bundle.addresses) {
      validateAddressIntelligence(entry);
    }
  }
  for (const instant of [bundle.quoteObservedAt, bundle.quoteValidUntil]) {
    if (instant !== undefined && (!Number.isInteger(instant) || instant < 0)) {
      throw new InvalidObservationBundleError(
        "quote instants must be non-negative integers (ms)",
      );
    }
  }
  if (
    bundle.quoteSlippage === undefined &&
    bundle.quoteLiquidityImpact !== undefined
  ) {
    throw new InvalidObservationBundleError(
      "quoteLiquidityImpact requires quoteSlippage (a quote carries both or neither)",
    );
  }
  if (
    (bundle.quoteObservedAt === undefined) !==
    (bundle.quoteSlippage === undefined)
  ) {
    throw new InvalidObservationBundleError(
      "quoteObservedAt is mandatory exactly when a quote is supplied",
    );
  }

  const bundleDigest = contentDigest({
    bundleId: bundle.bundleId,
    observer: bundle.observer,
    observedAt: bundle.observedAt,
    spenders: bundle.spenders,
    tokens: bundle.tokens,
    oracles: bundle.oracles,
    bridges: bundle.bridges,
    finality: bundle.finality,
    mempool: bundle.mempool,
    domain: bundle.domain,
    addresses: bundle.addresses,
    quoteSlippage: bundle.quoteSlippage,
    quoteLiquidityImpact: bundle.quoteLiquidityImpact,
    quoteObservedAt: bundle.quoteObservedAt,
    quoteValidUntil: bundle.quoteValidUntil,
  });

  return Object.freeze({
    bundleId: bundle.bundleId,
    observer: bundle.observer,
    observedAt: bundle.observedAt,
    ...(bundle.spenders === undefined
      ? {}
      : { spenders: Object.freeze(bundle.spenders.map((s) => Object.freeze(s))) }),
    ...(bundle.tokens === undefined
      ? {}
      : { tokens: Object.freeze(bundle.tokens.map((t) => Object.freeze(t))) }),
    ...(bundle.oracles === undefined
      ? {}
      : { oracles: Object.freeze(bundle.oracles.map((o) => Object.freeze(o))) }),
    ...(bundle.bridges === undefined
      ? {}
      : {
          bridges: Object.freeze(
            bundle.bridges.map((b) => Object.freeze(b)),
          ),
        }),
    ...(bundle.finality === undefined ? {} : { finality: Object.freeze(bundle.finality) }),
    ...(bundle.mempool === undefined ? {} : { mempool: Object.freeze(bundle.mempool) }),
    ...(bundle.domain === undefined ? {} : { domain: Object.freeze(bundle.domain) }),
    ...(bundle.addresses === undefined
      ? {}
      : {
          addresses: Object.freeze(
            bundle.addresses.map((a) => Object.freeze(a)),
          ),
        }),
    ...(bundle.quoteSlippage === undefined
      ? {}
      : { quoteSlippage: bundle.quoteSlippage }),
    ...(bundle.quoteLiquidityImpact === undefined
      ? {}
      : { quoteLiquidityImpact: bundle.quoteLiquidityImpact }),
    ...(bundle.quoteObservedAt === undefined ? {} : { quoteObservedAt: bundle.quoteObservedAt }),
    ...(bundle.quoteValidUntil === undefined ? {} : { quoteValidUntil: bundle.quoteValidUntil }),
    bundleDigest,
  });
}
