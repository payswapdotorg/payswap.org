/**
 * @payswap/onchain-threat-intel — the 13-family detectors
 * (Work Order P4-W3-003; task packet threat families, in order).
 *
 * Each detector is a DETERMINISTIC PURE FUNCTION of
 * (prepared write, optional simulation observation, threat policy,
 * observation bundle, evaluation instant) that returns raw signals —
 * observations of threats with their evidence chains, NEVER verdicts.
 * Verdicts belong to the deterministic policy (./policy.ts) and the
 * composed resolution (./verdict.ts).
 *
 * Detection discipline:
 * - evidence-generating: every raw signal names its observation refs,
 *   digest refs and exact deltas (a detector cannot emit an evidence-free
 *   signal — buildThreatSignal would reject it);
 * - exact arithmetic only: deviations/limits are integers, BigInt
 *   cross-multiplications or canonical rationals — never floating point;
 * - absence of intelligence is weak evidence (registry_absence) only
 *   where the policy demands coverage; otherwise detectors stay silent
 *   (UNKNOWN is not FAILED, and absence is not a threat);
 * - deterministic ordering of emitted signals per family.
 */

import { compareAmounts } from "@payswap/trust";
import type { PreparedWrite, SimulationObservation } from "@payswap/onchain-security";
import { sameAsset } from "@payswap/onchain-security";
import type { OnchainThreatPolicy } from "./policy.js";
import type { OnchainThreatObservationBundle, OracleObservation } from "./observations.js";
import type { EvidenceDelta, ThreatEvidence } from "./evidence.js";
import { parseRational, rationalDeviationBps, rationalExceedsInteger } from "./evidence.js";
import type { ThreatFamily, ThreatSeverity } from "./families.js";
import type { DetectionMethod } from "./confidence.js";

/**
 * A raw (un-built) detector output. `corroborations` counts independent
 * observations that support the same detection (calibration input).
 */
export interface RawSignal {
  readonly family: ThreatFamily;
  readonly code: string;
  readonly severity: ThreatSeverity;
  readonly method: DetectionMethod;
  readonly evidence: ThreatEvidence;
  readonly summary: string;
  /** Independent corroborating observations (0 = the evidence is all of it). */
  readonly corroborations: number;
}

/** Everything a detector consumes (all deterministic inputs). */
export interface DetectionContext {
  readonly write: PreparedWrite;
  readonly simulation?: SimulationObservation;
  readonly policy: OnchainThreatPolicy;
  readonly bundle: OnchainThreatObservationBundle;
  readonly at: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function baseEvidence(
  context: DetectionContext,
  observationRefs: readonly string[],
  deltas?: readonly EvidenceDelta[],
): ThreatEvidence {
  const digestRefs = [
    `write:${context.write.writeDigest}`,
    `bundle:${context.bundle.bundleId}`,
  ];
  if (context.simulation !== undefined) {
    digestRefs.push(`simulation:${context.simulation.simulationId}`);
  }
  return {
    observationRefs,
    digestRefs,
    ...(deltas === undefined ? {} : { deltas }),
    note: `bound to write ${context.write.writeId} via bundle ${context.bundle.bundleId}`,
  };
}

/** Asset identities referenced by the write (transfer + approvals). */
function intentAssets(context: DetectionContext) {
  const assets = [];
  if (context.write.transfer !== undefined) {
    assets.push(context.write.transfer.asset);
  }
  for (const approval of context.write.approvals) {
    assets.push(approval.asset);
  }
  return assets;
}

/** Route hop chains that differ from the write chain (confusion surface). */
function hopChains(write: PreparedWrite): readonly string[] {
  return (write.route.hops ?? []).map((hop) => hop.chain);
}

/** Bridge hop venues (hops on a chain different from the write chain). */
function bridgeHops(write: PreparedWrite): readonly string[] {
  return (write.route.hops ?? [])
    .filter((hop) => hop.chain !== write.chain)
    .map((hop) => hop.venue);
}

// ---------------------------------------------------------------------------
// Family 1 — malicious approvals/permits
// ---------------------------------------------------------------------------

/**
 * Detect malicious approvals/permits: unlimited approvals when forbidden,
 * over-cap approvals, allowances to drain-pattern spenders, and expired
 * permit deadlines.
 */
export function detectMaliciousApprovalPermit(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { write, policy, bundle, at } = context;

  for (const approval of write.approvals) {
    const spenderIntel = (bundle.spenders ?? []).find(
      (entry) => entry.spender === approval.spender,
    );
    const observationRefs = [
      `approval:${approval.spender}`,
      ...(spenderIntel === undefined ? [] : [spenderIntel.observationId]),
    ];

    if (approval.unlimited && policy.forbidUnlimitedApprovals) {
      signals.push({
        family: "malicious_approval_permit",
        code: "unlimited_approval_forbidden",
        severity: "critical",
        method: "structural_mismatch",
        corroborations: spenderIntel?.knownDrainPattern === true ? 1 : 0,
        evidence: baseEvidence(context, observationRefs, [
          {
            label: "approval_allowance",
            unit: "boolean",
            observed: "true",
            expected: "false",
          },
        ]),
        summary: `unlimited approval to spender ${approval.spender} while policy forbids unlimited allowances`,
      });
      continue;
    }

    const cap = policy.maxApprovalAmount;
    if (cap !== undefined && !approval.unlimited) {
      if (cap.currency !== approval.amount.currency) {
        signals.push({
          family: "malicious_approval_permit",
          code: "approval_cap_currency_mismatch",
          severity: "high",
          method: "structural_mismatch",
          corroborations: 0,
          evidence: baseEvidence(context, observationRefs, [
            {
              label: "approval_currency",
              unit: "count",
              observed: "1",
              expected: "1",
            },
          ]),
          summary: `approval currency ${approval.amount.currency} does not match policy cap currency ${cap.currency}`,
        });
        continue;
      }
      if (compareAmounts(approval.amount, cap) > 0) {
        signals.push({
          family: "malicious_approval_permit",
          code: "approval_exceeds_policy_cap",
          severity: "high",
          method: "threshold_breach",
          corroborations: spenderIntel?.knownDrainPattern === true ? 1 : 0,
          evidence: baseEvidence(context, observationRefs, [
            {
              label: "approval_minor_units",
              unit: "minor_units",
              observed: approval.amount.minorUnits,
              expected: cap.minorUnits,
            },
          ]),
          summary: `approval of ${approval.amount.minorUnits} ${approval.amount.currency} to ${approval.spender} exceeds the policy cap ${cap.minorUnits}`,
        });
        continue;
      }
    }

    if (spenderIntel?.knownDrainPattern === true) {
      signals.push({
        family: "malicious_approval_permit",
        code: "approval_to_drain_pattern_spender",
        severity: "critical",
        method: "behavioral_pattern",
        corroborations: (spenderIntel.observedIncidents ?? 0) > 0 ? 1 : 0,
        evidence: baseEvidence(context, observationRefs),
        summary: `spender ${approval.spender} carries a known drain pattern in spender intelligence`,
      });
    }
  }

  const domain = bundle.domain;
  if (domain?.permitDeadline !== undefined && domain.permitDeadline <= at) {
    signals.push({
      family: "malicious_approval_permit",
      code: "permit_deadline_expired",
      severity: "high",
      method: "threshold_breach",
      corroborations: 0,
      evidence: baseEvidence(context, [domain.observationId], [
        {
          label: "permit_deadline_ms",
          unit: "milliseconds",
          observed: domain.permitDeadline.toString(),
          expected: (at + 1).toString(),
        },
      ]),
      summary: `permit deadline ${domain.permitDeadline} is at/before the evaluation instant ${at}`,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 2 — unexpected spenders
// ---------------------------------------------------------------------------

/** Detect unexpected spenders: unapproved, too-recent, incident-heavy. */
export function detectUnexpectedSpender(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { write, policy, bundle, at } = context;

  for (const approval of write.approvals) {
    const intel = (bundle.spenders ?? []).find(
      (entry) => entry.spender === approval.spender,
    );
    const observationRefs = [`approval:${approval.spender}`];

    if (policy.allowedSpenders !== undefined && !policy.allowedSpenders.includes(approval.spender)) {
      signals.push({
        family: "unexpected_spender",
        code: "spender_not_in_policy_allowlist",
        severity: "high",
        method: "exact_identity_match",
        corroborations: 0,
        evidence: baseEvidence(context, observationRefs),
        summary: `spender ${approval.spender} is not in the policy allowlist`,
      });
    }

    if (intel !== undefined) {
      observationRefs.push(intel.observationId);
      if (
        intel.firstObservedAt !== undefined &&
        policy.spenderMinimumAgeMs !== undefined &&
        at - intel.firstObservedAt < policy.spenderMinimumAgeMs
      ) {
        signals.push({
          family: "unexpected_spender",
          code: "spender_below_minimum_age",
          severity: "medium",
          method: "threshold_breach",
          corroborations: 0,
          evidence: baseEvidence(context, observationRefs, [
            {
              label: "spender_age_ms",
              unit: "milliseconds",
              observed: (at - intel.firstObservedAt).toString(),
              expected: policy.spenderMinimumAgeMs.toString(),
            },
          ]),
          summary: `spender ${approval.spender} was first observed ${at - intel.firstObservedAt}ms ago (minimum ${policy.spenderMinimumAgeMs}ms)`,
        });
      }
      if (
        policy.spenderIncidentThreshold !== undefined &&
        (intel.observedIncidents ?? 0) >= policy.spenderIncidentThreshold
      ) {
        signals.push({
          family: "unexpected_spender",
          code: "spender_incident_threshold_reached",
          severity: "high",
          method: "behavioral_pattern",
          corroborations: 0,
          evidence: baseEvidence(context, observationRefs, [
            {
              label: "spender_incidents",
              unit: "count",
              observed: (intel.observedIncidents ?? 0).toString(),
              expected: policy.spenderIncidentThreshold.toString(),
            },
          ]),
          summary: `spender ${approval.spender} carries ${intel.observedIncidents} observed incidents (threshold ${policy.spenderIncidentThreshold})`,
        });
      }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 3 — token impersonation
// ---------------------------------------------------------------------------

/** Detect token impersonation: fake/uncertified tokens mimicking canonical assets. */
export function detectTokenImpersonation(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { write, policy, bundle } = context;
  const tokens = bundle.tokens ?? [];

  for (const asset of intentAssets(context)) {
    const entry = tokens.find((candidate) => sameAsset(candidate.asset, asset));
    const registryRef = `registry:${asset.chain}:${asset.assetId}`;
    if (entry !== undefined) {
      if (entry.impersonatesAssetId !== undefined) {
        signals.push({
          family: "token_impersonation",
          code: "impersonator_token_identified",
          severity: "critical",
          method: "exact_identity_match",
          corroborations: entry.canonical === false ? 1 : 0,
          evidence: baseEvidence(context, [entry.observationId, registryRef], [
            {
              label: "impersonated_asset_id",
              unit: "count",
              observed: "1",
              expected: "0",
            },
          ]),
          summary: `asset ${asset.assetId} (${asset.symbol} on ${asset.chain}) is an impersonator of canonical asset ${entry.impersonatesAssetId}`,
        });
      } else if (policy.requireTokenRegistryCoverage && !entry.canonical) {
        signals.push({
          family: "token_impersonation",
          code: "asset_not_canonical_in_registry",
          severity: "high",
          method: "exact_identity_match",
          corroborations: 0,
          evidence: baseEvidence(context, [entry.observationId, registryRef], [
            {
              label: "registry_canonical",
              unit: "boolean",
              observed: entry.canonical ? "true" : "false",
              expected: "true",
            },
          ]),
          summary: `asset ${asset.assetId} (${asset.symbol} on ${asset.chain}) is not canonical in the observed registry`,
        });
      }
    } else if (policy.requireTokenRegistryCoverage) {
      // Absence of registry coverage: weak evidence — the policy's
      // confidence floor keeps this at REQUIRE_CONFIRMATION, never BLOCK.
      signals.push({
        family: "token_impersonation",
        code: "asset_absent_from_registry_observation",
        severity: "medium",
        method: "registry_absence",
        corroborations: 0,
        evidence: baseEvidence(context, [
          `registry:${asset.chain}:${asset.assetId}`,
        ], [
          {
            label: "registry_coverage",
            unit: "count",
            observed: "0",
            expected: "1",
          },
        ]),
        summary: `asset ${asset.assetId} (${asset.symbol} on ${asset.chain}) is absent from the observed token registry (coverage required by policy)`,
      });
    }
  }

  // Lookalike detection inside the registry itself: two entries, same
  // symbol+chain, different assetIds, one canonical and one not.
  for (const candidate of tokens) {
    if (candidate.canonical || candidate.impersonatesAssetId === undefined) {
      continue;
    }
    const target = tokens.find(
      (other) =>
        other.canonical &&
        other.asset.chain === candidate.asset.chain &&
        other.asset.assetId === candidate.impersonatesAssetId,
    );
    if (target !== undefined && target.asset.symbol === candidate.asset.symbol) {
      const touchesIntent = intentAssets(context).some((asset) => sameAsset(asset, candidate.asset));
      if (touchesIntent) {
        signals.push({
          family: "token_impersonation",
          code: "registry_impersonation_pair_observed",
          severity: "high",
          method: "behavioral_pattern",
          corroborations: 1,
          evidence: baseEvidence(context, [
            candidate.observationId,
            target.observationId,
          ], [
            {
              label: "impersonation_pairs",
              unit: "count",
              observed: "1",
              expected: "0",
            },
          ]),
          summary: `registry observes impersonation pair: ${candidate.asset.assetId} mimics canonical ${target.asset.assetId} (${candidate.asset.symbol} on ${candidate.asset.chain})`,
        });
      }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 4 — honeypot/transfer restrictions
// ---------------------------------------------------------------------------

/** Detect honeypot/transfer restrictions via registry markers. */
export function detectHoneypotTransferRestriction(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { bundle } = context;
  const tokens = bundle.tokens ?? [];

  for (const asset of intentAssets(context)) {
    const entry = tokens.find((candidate) => sameAsset(candidate.asset, asset));
    if (entry === undefined) {
      continue;
    }
    if (entry.transferRestricted === true) {
      signals.push({
        family: "honeypot_transfer_restriction",
        code: "token_transfer_restricted",
        severity: "critical",
        method: "behavioral_pattern",
        corroborations: entry.sellable === false ? 1 : 0,
        evidence: baseEvidence(context, [entry.observationId, `registry:${asset.chain}:${asset.assetId}`], [
          {
            label: "transfer_restricted",
            unit: "boolean",
            observed: "true",
            expected: "false",
          },
        ]),
        summary: `asset ${asset.assetId} (${asset.symbol}) is registry-observed as transfer-restricted (honeypot marker)`,
      });
    }
    if (entry.sellable === false) {
      signals.push({
        family: "honeypot_transfer_restriction",
        code: "token_not_sellable",
        severity: "high",
        method: "behavioral_pattern",
        corroborations: 0,
        evidence: baseEvidence(context, [entry.observationId, `registry:${asset.chain}:${asset.assetId}`], [
          {
            label: "sellable",
          unit: "boolean",
            observed: "false",
            expected: "true",
          },
        ]),
        summary: `asset ${asset.assetId} (${asset.symbol}) is registry-observed as not sellable (value in, no value out)`,
      });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 5 — proxy/admin/implementation changes
// ---------------------------------------------------------------------------

/**
 * Detect proxy/admin/implementation drift: the write's declared protocol
 * contract diverges from the policy's certified reference on
 * bytecode/source hashes, upgrade authority or admin authority.
 */
export function detectProxyAdminChange(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { write, policy } = context;
  if (write.protocol === undefined) {
    return signals;
  }
  const certified = policy.certifiedProtocols ?? [];
  const reference = certified.find((candidate) => candidate.protocolId === write.protocol!.protocolId);
  if (reference === undefined) {
    return signals; // certification itself is the kernel's dimension (rule 28)
  }

  const writeContract = write.protocol.contract;
  const referenceContract = reference.contract;
  const observationRefs = [
    `protocol:${write.protocol.protocolId}@${write.protocol.contract.contractAddress}`,
  ];

  if (writeContract.bytecodeHash !== referenceContract.bytecodeHash) {
    signals.push({
      family: "proxy_admin_change",
      code: "implementation_bytecode_drift",
      severity: "critical",
      method: "structural_mismatch",
      corroborations: writeContract.sourceHash !== referenceContract.sourceHash ? 1 : 0,
      evidence: baseEvidence(context, observationRefs, [
        {
          label: "bytecode_hash",
          unit: "count",
          observed: "1",
          expected: "1",
        },
      ]),
      summary: `implementation bytecode of ${write.protocol.protocolId} at ${writeContract.contractAddress} drifted from the certified declaration (hash ${writeContract.bytecodeHash} ≠ ${referenceContract.bytecodeHash})`,
    });
  }

  if (writeContract.upgradeAuthority.kind !== referenceContract.upgradeAuthority.kind) {
    signals.push({
      family: "proxy_admin_change",
      code: "upgrade_authority_changed",
      severity: "critical",
      method: "structural_mismatch",
      corroborations: 0,
      evidence: baseEvidence(context, observationRefs, [
        {
          label: "upgrade_authority_kind",
          unit: "count",
          observed: "1",
          expected: "1",
        },
      ]),
      summary: `upgrade authority of ${write.protocol.protocolId} changed from '${referenceContract.upgradeAuthority.kind}' to '${writeContract.upgradeAuthority.kind}'`,
    });
  }

  if (writeContract.adminAuthority.kind !== referenceContract.adminAuthority.kind) {
    signals.push({
      family: "proxy_admin_change",
      code: "admin_authority_changed",
      severity: "high",
      method: "structural_mismatch",
      corroborations: 0,
      evidence: baseEvidence(context, observationRefs, [
        {
          label: "admin_authority_kind",
          unit: "count",
          observed: "1",
          expected: "1",
        },
      ]),
      summary: `admin authority of ${write.protocol.protocolId} changed from '${referenceContract.adminAuthority.kind}' to '${writeContract.adminAuthority.kind}'`,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 6 — oracle manipulation
// ---------------------------------------------------------------------------

/**
 * Detect oracle manipulation: pairwise deviation between same-pair oracle
 * readings beyond the policy threshold, stale feeds, and deviation from
 * policy reference prices. All arithmetic is exact (BigInt rationals).
 */
export function detectOracleManipulation(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { policy, bundle } = context;
  const oracles = bundle.oracles ?? [];

  const byPair = new Map<string, OracleObservation[]>();
  for (const reading of oracles) {
    const bucket = byPair.get(reading.pair) ?? [];
    bucket.push(reading);
    byPair.set(reading.pair, bucket);
  }

  for (const [pair, readings] of byPair) {
    if (policy.maxOracleDeviationBasisPoints !== undefined && readings.length >= 2) {
      // Compare the FIRST TWO observations deterministically (the
      // observation bundle is order-stable by construction).
      const left = readings[0];
      const right = readings[1];
      if (left !== undefined && right !== undefined) {
      const deviation = rationalDeviationBps(left.observedPrice, right.observedPrice);
      if (rationalExceedsInteger(deviation, policy.maxOracleDeviationBasisPoints)) {
        signals.push({
          family: "oracle_manipulation",
          code: "oracle_pairwise_deviation_exceeds_threshold",
          severity: "critical",
          method: "threshold_breach",
          corroborations: readings.length - 2,
          evidence: baseEvidence(context, [left.observationId, right.observationId], [
            {
              label: "pairwise_price_deviation_bps",
              unit: "rational",
              observed: deviation,
              expected: `${policy.maxOracleDeviationBasisPoints}/1`,
            },
          ]),
          summary: `oracle readings for ${pair} deviate by ${deviation} bps (threshold ${policy.maxOracleDeviationBasisPoints} bps): ${left.oracleId}=${left.observedPrice} vs ${right.oracleId}=${right.observedPrice}`,
        });
      }
      }
    }

    if (policy.maxOracleFeedAgeMs !== undefined) {
      for (const reading of readings) {
        if (reading.feedAgeMs > policy.maxOracleFeedAgeMs) {
          signals.push({
            family: "oracle_manipulation",
            code: "oracle_feed_stale",
            severity: "high",
            method: "threshold_breach",
            corroborations: 0,
            evidence: baseEvidence(context, [reading.observationId], [
              {
                label: "oracle_feed_age_ms",
                unit: "milliseconds",
                observed: reading.feedAgeMs.toString(),
                expected: policy.maxOracleFeedAgeMs.toString(),
              },
            ]),
            summary: `oracle ${reading.oracleId} for ${pair} feed is ${reading.feedAgeMs}ms old (max ${policy.maxOracleFeedAgeMs}ms)`,
          });
        }
      }
    }
  }

  // Reference-price deviation (when the policy pins references).
  if (policy.maxOracleReferenceDeviationBasisPoints !== undefined) {
    for (const reference of policy.referenceOraclePrices ?? []) {
      for (const reading of oracles.filter((o) => o.pair === reference.pair)) {
        const deviation = rationalDeviationBps(reading.observedPrice, reference.price);
        if (rationalExceedsInteger(deviation, policy.maxOracleReferenceDeviationBasisPoints)) {
          signals.push({
            family: "oracle_manipulation",
            code: "oracle_reference_deviation_exceeds_threshold",
            severity: "high",
            method: "threshold_breach",
            corroborations: 0,
            evidence: baseEvidence(context, [reading.observationId], [
              {
                label: "reference_price_deviation_bps",
                unit: "rational",
                observed: deviation,
              expected: `${policy.maxOracleReferenceDeviationBasisPoints}/1`,
              },
            ]),
            summary: `oracle ${reading.oracleId} for ${reference.pair} deviates ${deviation} bps from the policy reference ${reference.price} (max ${policy.maxOracleReferenceDeviationBasisPoints} bps)`,
          });
        }
      }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 7 — bridge compromise
// ---------------------------------------------------------------------------

/** Detect bridge compromise: halted/degraded status, validator churn, sub-quorum. */
export function detectBridgeCompromise(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { write, policy, bundle, at } = context;
  const bridges = bundle.bridges ?? [];

  const relevantBridges =
    bridgeHops(write).length > 0
      ? bridges
      : bridges; // health intel applies to any observed bridge on the route

  for (const bridge of relevantBridges) {
    if (bridge.status === "halted") {
      signals.push({
        family: "bridge_compromise",
        code: "bridge_halted",
        severity: "critical",
        method: "behavioral_pattern",
        corroborations: 0,
        evidence: baseEvidence(context, [bridge.observationId, `venue:${bridge.bridgeId}`], [
          {
            label: "bridge_status",
            unit: "count",
            observed: "0",
            expected: "2",
          },
        ]),
        summary: `bridge ${bridge.bridgeId} is observed HALTED`,
      });
    } else if (bridge.status === "degraded") {
      signals.push({
        family: "bridge_compromise",
        code: "bridge_degraded",
        severity: "high",
        method: "behavioral_pattern",
        corroborations: 0,
        evidence: baseEvidence(context, [bridge.observationId, `venue:${bridge.bridgeId}`], [
          {
            label: "bridge_status",
            unit: "count",
            observed: "1",
            expected: "2",
          },
        ]),
        summary: `bridge ${bridge.bridgeId} is observed DEGRADED`,
      });
    }

    if (
      bridge.validatorSetChangedAt !== undefined &&
      policy.bridgeValidatorChangeWindowMs !== undefined &&
      at - bridge.validatorSetChangedAt < policy.bridgeValidatorChangeWindowMs
    ) {
      signals.push({
        family: "bridge_compromise",
        code: "bridge_validator_set_recently_changed",
        severity: "high",
        method: "threshold_breach",
        corroborations: bridge.status === "healthy" ? 0 : 1,
        evidence: baseEvidence(context, [bridge.observationId], [
          {
            label: "validator_set_change_age_ms",
            unit: "milliseconds",
            observed: (at - bridge.validatorSetChangedAt).toString(),
            expected: policy.bridgeValidatorChangeWindowMs.toString(),
          },
        ]),
        summary: `bridge ${bridge.bridgeId} validator set changed ${at - bridge.validatorSetChangedAt}ms ago (suspicion window ${policy.bridgeValidatorChangeWindowMs}ms)`,
      });
    }

    if (bridge.attestationQuorum !== undefined && policy.minBridgeAttestationQuorum !== undefined) {
      const observed = parseRational(bridge.attestationQuorum);
      const minimum = parseRational(policy.minBridgeAttestationQuorum);
      if (observed.numerator * minimum.denominator < minimum.numerator * observed.denominator) {
        signals.push({
          family: "bridge_compromise",
          code: "bridge_attestation_quorum_below_minimum",
          severity: "critical",
          method: "threshold_breach",
          corroborations: 0,
          evidence: baseEvidence(context, [bridge.observationId], [
            {
              label: "attestation_quorum",
              unit: "rational",
              observed: bridge.attestationQuorum,
              expected: policy.minBridgeAttestationQuorum,
            },
          ]),
          summary: `bridge ${bridge.bridgeId} attestation quorum ${bridge.attestationQuorum} is below the policy minimum ${policy.minBridgeAttestationQuorum}`,
        });
      }
    }
  }

  // Policy demands bridge health for bridge hops; absence is weak evidence.
  if (policy.requireBridgeHealthForBridgeHops) {
    for (const venue of bridgeHops(write)) {
      const hasHealth = bridges.some((bridge) => bridge.bridgeId === venue);
      if (!hasHealth) {
        signals.push({
          family: "bridge_compromise",
          code: "bridge_hop_without_health_observation",
          severity: "medium",
          method: "registry_absence",
          corroborations: 0,
          evidence: baseEvidence(context, [`bridge:${venue}`], [
            {
              label: "bridge_health_coverage",
              unit: "count",
              observed: "0",
              expected: "1",
            },
          ]),
          summary: `route crosses bridge hop ${venue} with no bridge health observation in the bundle (coverage required by policy)`,
        });
      }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 8 — MEV/sandwich exposure
// ---------------------------------------------------------------------------

/**
 * Detect MEV/sandwich exposure from the P4-W2-002 quote disclosures:
 * over-limit slippage, visible-in-mempool swaps with sandwich-profitable
 * slippage, high price impact, expired quotes. Consumes the REAL
 * best-execution typed inputs (SlippageDisclosure,
 * LiquidityImpactDisclosure) — no parallel quote vocabulary.
 */
export function detectMevSandwichExposure(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { policy, bundle, at } = context;
  const slippage = bundle.quoteSlippage;
  const liquidity = bundle.quoteLiquidityImpact;
  const mempool = bundle.mempool;

  if (slippage?.limitBasisPoints !== undefined && policy.maxSlippageBasisPoints !== undefined) {
    if (slippage.limitBasisPoints > policy.maxSlippageBasisPoints) {
      signals.push({
        family: "mev_sandwich_exposure",
        code: "slippage_limit_above_policy_max",
        severity: "medium",
        method: "threshold_breach",
        corroborations: 0,
        evidence: baseEvidence(context, ["quote:slippage"], [
          {
            label: "slippage_limit_bps",
            unit: "basis_points",
            observed: slippage.limitBasisPoints.toString(),
            expected: policy.maxSlippageBasisPoints.toString(),
          },
        ]),
        summary: `declared slippage limit ${slippage.limitBasisPoints} bps exceeds the policy max ${policy.maxSlippageBasisPoints} bps`,
      });
    }
  }

  if (
    slippage?.limitBasisPoints !== undefined &&
    policy.sandwichSensitiveSlippageBasisPoints !== undefined &&
    slippage.limitBasisPoints >= policy.sandwichSensitiveSlippageBasisPoints
  ) {
    if (mempool?.writeVisible === true) {
      signals.push({
        family: "mev_sandwich_exposure",
        code: "visible_swap_with_sandwich_profitable_slippage",
        severity: "critical",
        method: "threshold_breach",
        corroborations: (mempool.competingTransactions ?? 0) > 0 ? 1 : 0,
        evidence: baseEvidence(context, ["quote:slippage", mempool.observationId], [
          {
            label: "sandwich_surface_bps",
            unit: "basis_points",
            observed: slippage.limitBasisPoints.toString(),
            expected: (policy.sandwichSensitiveSlippageBasisPoints - 1).toString(),
          },
        ]),
        summary: `swap visible in public mempool with ${slippage.limitBasisPoints} bps slippage (sensitive threshold ${policy.sandwichSensitiveSlippageBasisPoints} bps)${(mempool.competingTransactions ?? 0) > 0 ? ` and ${mempool.competingTransactions} competing transactions` : ""}`,
      });
    }
  }

  if (
    liquidity?.priceImpactBasisPoints !== undefined &&
    policy.maxPriceImpactBasisPoints !== undefined &&
    liquidity.priceImpactBasisPoints > policy.maxPriceImpactBasisPoints
  ) {
    signals.push({
      family: "mev_sandwich_exposure",
      code: "price_impact_above_policy_max",
      severity: "high",
      method: "threshold_breach",
      corroborations: mempool?.writeVisible === true ? 1 : 0,
      evidence: baseEvidence(context, ["quote:liquidity_impact", ...(mempool === undefined ? [] : [mempool.observationId])], [
        {
          label: "price_impact_bps",
          unit: "basis_points",
          observed: liquidity.priceImpactBasisPoints.toString(),
          expected: policy.maxPriceImpactBasisPoints.toString(),
        },
      ]),
      summary: `declared price impact ${liquidity.priceImpactBasisPoints} bps exceeds the policy max ${policy.maxPriceImpactBasisPoints} bps`,
    });
  }

  if (bundle.quoteValidUntil !== undefined && bundle.quoteValidUntil <= at) {
    signals.push({
      family: "mev_sandwich_exposure",
      code: "quote_expired_at_evaluation",
      severity: "medium",
      method: "threshold_breach",
      corroborations: 0,
      evidence: baseEvidence(context, ["quote:validity"], [
        {
          label: "quote_validity_ms",
          unit: "milliseconds",
          observed: bundle.quoteValidUntil.toString(),
          expected: (at + 1).toString(),
        },
      ]),
      summary: `execution quote expired at ${bundle.quoteValidUntil} (evaluation instant ${at})`,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 9 — destination/chain confusion
// ---------------------------------------------------------------------------

/** Detect destination/chain confusion: hop-chain mismatch, cross-chain address reuse, wrong chain. */
export function detectDestinationChainConfusion(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { write, policy, bundle } = context;

  for (const hopChain of hopChains(write)) {
    if (hopChain !== write.chain) {
      signals.push({
        family: "destination_chain_confusion",
        code: "route_hop_chain_mismatch",
        severity: "critical",
        method: "structural_mismatch",
        corroborations: 0,
        evidence: baseEvidence(context, [`route:${write.route.routeId}`], [
          {
            label: "hop_chain_matches_write_chain",
            unit: "boolean",
            observed: "false",
            expected: "true",
          },
        ]),
        summary: `route hop executes on ${hopChain} while the write targets ${write.chain} — one write, one chain`,
      });
    }
  }

  if (policy.expectedChain !== undefined && write.chain !== policy.expectedChain) {
    signals.push({
      family: "destination_chain_confusion",
      code: "write_chain_differs_from_expected",
      severity: "high",
      method: "structural_mismatch",
      corroborations: 0,
      evidence: baseEvidence(context, [`chain:${write.chain}`], [
        {
          label: "write_chain",
          unit: "count",
          observed: "1",
          expected: "1",
        },
      ]),
      summary: `write executes on ${write.chain} but the policy expects ${policy.expectedChain}`,
    });
  }

  const destination = write.transfer?.to;
  if (destination !== undefined) {
    for (const intel of bundle.addresses ?? []) {
      if (intel.address !== destination) {
        continue;
      }
      const activeOnWriteChain = intel.chainsActiveOn.includes(write.chain);
      if (!activeOnWriteChain) {
        signals.push({
          family: "destination_chain_confusion",
          code: "destination_address_active_on_other_chains",
          severity: "high",
          method: "behavioral_pattern",
          corroborations: intel.chainsActiveOn.length > 1 ? 1 : 0,
          evidence: baseEvidence(context, [intel.observationId], [
            {
              label: "destination_active_on_write_chain",
              unit: "boolean",
              observed: "false",
              expected: "true",
            },
          ]),
          summary: `destination ${destination} is observed active on ${intel.chainsActiveOn.join(", ")} but not on the write chain ${write.chain}`,
        });
      }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 10 — replay/signature-domain issues
// ---------------------------------------------------------------------------

/**
 * Detect replay/signature-domain issues: previously observed payload
 * digests, domain/chain mismatches, and nonce reuse.
 */
export function detectReplaySignatureDomain(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { write, bundle } = context;
  const domain = bundle.domain;
  if (domain === undefined) {
    return signals;
  }

  if (domain.digestPreviouslyObserved) {
    signals.push({
      family: "replay_signature_domain",
      code: "payload_digest_previously_observed",
      severity: "critical",
      method: "exact_identity_match",
      corroborations: 0,
      evidence: baseEvidence(context, [domain.observationId], [
        {
          label: "digest_reuse",
          unit: "count",
          observed: "1",
          expected: "0",
        },
      ]),
      summary: `payload digest ${domain.payloadDigest} was previously observed under domain ${domain.domainRef} — replay risk`,
    });
  }

  if (domain.domainChain !== undefined && domain.domainChain !== write.chain) {
    signals.push({
      family: "replay_signature_domain",
      code: "signature_domain_chain_mismatch",
      severity: "high",
      method: "structural_mismatch",
      corroborations: 0,
      evidence: baseEvidence(context, [domain.observationId], [
        {
          label: "domain_chain_matches_write_chain",
          unit: "boolean",
          observed: "false",
          expected: "true",
        },
      ]),
      summary: `signing domain is bound to ${domain.domainChain} while the write executes on ${write.chain}`,
    });
  }

  if (
    write.nonce !== undefined &&
    domain.nonceLastUsedAt !== undefined &&
    domain.nonceLastUsedAt > 0
  ) {
    signals.push({
      family: "replay_signature_domain",
      code: "nonce_previously_used",
      severity: "high",
      method: "exact_identity_match",
      corroborations: 0,
      evidence: baseEvidence(context, [domain.observationId], [
        {
          label: "nonce_last_used_ms",
          unit: "milliseconds",
          observed: domain.nonceLastUsedAt.toString(),
          expected: "0",
        },
      ]),
      summary: `write nonce '${write.nonce}' was already used (last use at ${domain.nonceLastUsedAt})`,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 11 — unexpected balance/state deltas
// ---------------------------------------------------------------------------

/**
 * Detect unexpected balance/state deltas: simulated deltas for holders/
 * assets outside the intent, and approvals observed that the write never
 * requested.
 */
export function detectUnexpectedBalanceDelta(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { write, simulation } = context;
  if (simulation === undefined) {
    return signals;
  }

  const intentHolders = new Set<string>();
  if (write.transfer !== undefined) {
    intentHolders.add(write.transfer.from);
    intentHolders.add(write.transfer.to);
  }
  for (const approval of write.approvals) {
    intentHolders.add(approval.owner);
  }
  const intentAssetsList = intentAssets(context);

  for (const delta of simulation.balanceDeltas) {
    const inIntent =
      intentHolders.has(delta.holder) &&
      intentAssetsList.some((asset) => sameAsset(asset, delta.asset));
    if (!inIntent) {
      signals.push({
        family: "unexpected_balance_delta",
        code: "delta_outside_intent",
        severity: "high",
        method: "threshold_breach",
        corroborations: 0,
        evidence: baseEvidence(context, [`${simulation.simulationId}:delta:${delta.holder}`], [
          {
            label: "delta_minor_units",
            unit: "minor_units",
            observed: delta.amount.minorUnits,
            expected: "0",
          },
        ]),
        summary: `simulation observed a ${delta.direction} of ${delta.amount.minorUnits} ${delta.amount.currency} for holder ${delta.holder} on ${delta.asset.assetId} — outside the intent's legs`,
      });
    }
  }

  for (const observed of simulation.approvals) {
    const requested = write.approvals.some(
      (approval) =>
        approval.owner === observed.owner &&
        approval.spender === observed.spender &&
        sameAsset(approval.asset, observed.asset),
    );
    if (!requested) {
      signals.push({
        family: "unexpected_balance_delta",
        code: "approval_state_change_outside_intent",
        severity: "critical",
        method: "threshold_breach",
        corroborations: 0,
        evidence: baseEvidence(
          context,
          [`${simulation.simulationId}:approval:${observed.spender}`],
          [
            {
              label: "unexpected_allowance_minor_units",
              unit: "minor_units",
              observed: observed.allowance.minorUnits,
              expected: "0",
            },
          ],
        ),
        summary: `simulation observed an allowance of ${observed.allowance.minorUnits} ${observed.allowance.currency} from ${observed.owner} to spender ${observed.spender} that the write never requested`,
      });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Family 12 — stale/materially changed simulations
// ---------------------------------------------------------------------------

/** Detect stale or materially changed simulations (wrong write, old age, lagging block). */
export function detectStaleChangedSimulation(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { write, simulation, policy, bundle, at } = context;

  // Corroborating staleness: the whole observation bundle is too old —
  // checked REGARDLESS of simulation presence (stale intelligence taints
  // every downstream evaluation, with or without a simulation).
  if (policy.maxObservationAgeMs !== undefined && at - bundle.observedAt > policy.maxObservationAgeMs) {
    signals.push({
      family: "stale_changed_simulation",
      code: "observation_bundle_stale",
      severity: "medium",
      method: "threshold_breach",
      corroborations: 1,
      evidence: baseEvidence(context, [`bundle:${bundle.bundleId}:age`], [
        {
          label: "bundle_age_ms",
          unit: "milliseconds",
          observed: (at - bundle.observedAt).toString(),
          expected: policy.maxObservationAgeMs.toString(),
        },
      ]),
      summary: `threat observation bundle ${bundle.bundleId} is ${at - bundle.observedAt}ms old (max ${policy.maxObservationAgeMs}ms)`,
    });
  }

  if (simulation === undefined) {
    return signals;
  }

  if (simulation.writeId !== write.writeId) {
    signals.push({
      family: "stale_changed_simulation",
      code: "simulation_bound_to_different_write",
      severity: "critical",
      method: "exact_identity_match",
      corroborations: 0,
      evidence: baseEvidence(context, [`${simulation.simulationId}:write-binding`], [
        {
          label: "simulation_write_binding",
          unit: "count",
          observed: "1",
          expected: "1",
        },
      ]),
      summary: `simulation ${simulation.simulationId} is bound to write '${simulation.writeId}', not this write '${write.writeId}'`,
    });
  }

  if (policy.maxSimulationAgeMs !== undefined && at - simulation.observedAt > policy.maxSimulationAgeMs) {
    signals.push({
      family: "stale_changed_simulation",
      code: "simulation_older_than_policy_max_age",
      severity: "high",
      method: "threshold_breach",
      corroborations: 0,
      evidence: baseEvidence(context, [`${simulation.simulationId}:age`], [
        {
          label: "simulation_age_ms",
          unit: "milliseconds",
          observed: (at - simulation.observedAt).toString(),
          expected: policy.maxSimulationAgeMs.toString(),
        },
      ]),
      summary: `simulation ${simulation.simulationId} is ${at - simulation.observedAt}ms old (max ${policy.maxSimulationAgeMs}ms)`,
    });
  }

  const blockNumber = parseBlockNumber(simulation.blockRef);
  const finality = bundle.finality;
  if (
    blockNumber !== undefined &&
    finality !== undefined &&
    policy.maxSimulationLagBlocks !== undefined &&
    finality.headBlock - blockNumber > policy.maxSimulationLagBlocks
  ) {
    signals.push({
      family: "stale_changed_simulation",
      code: "simulation_block_lags_head",
      severity: "high",
      method: "threshold_breach",
      corroborations: 0,
      evidence: baseEvidence(
        context,
        [`${simulation.simulationId}:block`, finality.observationId],
        [
          {
            label: "simulation_block_lag",
            unit: "blocks",
            observed: (finality.headBlock - blockNumber).toString(),
            expected: policy.maxSimulationLagBlocks.toString(),
          },
        ],
      ),
      summary: `simulation ran against block ${blockNumber}; the observed head is ${finality.headBlock} (max lag ${policy.maxSimulationLagBlocks} blocks)`,
    });
  }

  return signals;
}

function parseBlockNumber(blockRef: string | undefined): number | undefined {
  if (blockRef === undefined) {
    return undefined;
  }
  const match = /(\d+)$/.exec(blockRef);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

// ---------------------------------------------------------------------------
// Family 13 — finality/reorg anomalies
// ---------------------------------------------------------------------------

/** Detect finality/reorg anomalies: reorg depth, head→safe gap, stale finality. */
export function detectFinalityReorgAnomaly(context: DetectionContext): readonly RawSignal[] {
  const signals: RawSignal[] = [];
  const { write, policy, bundle, at } = context;
  const finality = bundle.finality;
  if (finality === undefined) {
    return signals;
  }
  // Finality intel for a different chain cannot judge this write's chain.
  if (finality.chain !== write.chain) {
    return signals;
  }

  if (
    finality.lastReorgDepthBlocks !== undefined &&
    policy.maxReorgDepthBlocks !== undefined &&
    finality.lastReorgDepthBlocks > policy.maxReorgDepthBlocks
  ) {
    signals.push({
      family: "finality_reorg_anomaly",
      code: "reorg_depth_exceeds_threshold",
      severity: "critical",
      method: "threshold_breach",
      corroborations: 0,
      evidence: baseEvidence(context, [finality.observationId], [
        {
          label: "reorg_depth_blocks",
          unit: "blocks",
          observed: finality.lastReorgDepthBlocks.toString(),
          expected: policy.maxReorgDepthBlocks.toString(),
        },
      ]),
      summary: `chain ${finality.chain} observed a reorg of depth ${finality.lastReorgDepthBlocks} blocks (max ${policy.maxReorgDepthBlocks})`,
    });
  }

  if (
    policy.maxFinalityLagBlocks !== undefined &&
    finality.headBlock - finality.safeBlock > policy.maxFinalityLagBlocks
  ) {
    signals.push({
      family: "finality_reorg_anomaly",
      code: "finality_lag_exceeds_threshold",
      severity: "high",
      method: "threshold_breach",
      corroborations: 0,
      evidence: baseEvidence(context, [finality.observationId], [
        {
          label: "finality_lag_blocks",
          unit: "blocks",
          observed: (finality.headBlock - finality.safeBlock).toString(),
          expected: policy.maxFinalityLagBlocks.toString(),
        },
      ]),
      summary: `chain ${finality.chain} head ${finality.headBlock} is ${finality.headBlock - finality.safeBlock} blocks ahead of safe head ${finality.safeBlock} (max ${policy.maxFinalityLagBlocks})`,
    });
  }

  if (policy.maxObservationAgeMs !== undefined && at - finality.observedAt > policy.maxObservationAgeMs) {
    signals.push({
      family: "finality_reorg_anomaly",
      code: "finality_observation_stale",
      severity: "medium",
      method: "threshold_breach",
      corroborations: 0,
      evidence: baseEvidence(context, [finality.observationId], [
        {
          label: "finality_observation_age_ms",
          unit: "milliseconds",
          observed: (at - finality.observedAt).toString(),
          expected: policy.maxObservationAgeMs.toString(),
        },
      ]),
      summary: `finality observation for ${finality.chain} is ${at - finality.observedAt}ms old (max ${policy.maxObservationAgeMs}ms)`,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// The full family sweep (deterministic order)
// ---------------------------------------------------------------------------

export interface FamilyDetector {
  readonly family: ThreatFamily;
  readonly detect: (context: DetectionContext) => readonly RawSignal[];
}

/** All 13 detectors, in task-packet family order (deterministic). */
export const FAMILY_DETECTORS: readonly FamilyDetector[] = Object.freeze([
  { family: "malicious_approval_permit", detect: detectMaliciousApprovalPermit },
  { family: "unexpected_spender", detect: detectUnexpectedSpender },
  { family: "token_impersonation", detect: detectTokenImpersonation },
  { family: "honeypot_transfer_restriction", detect: detectHoneypotTransferRestriction },
  { family: "proxy_admin_change", detect: detectProxyAdminChange },
  { family: "oracle_manipulation", detect: detectOracleManipulation },
  { family: "bridge_compromise", detect: detectBridgeCompromise },
  { family: "mev_sandwich_exposure", detect: detectMevSandwichExposure },
  { family: "destination_chain_confusion", detect: detectDestinationChainConfusion },
  { family: "replay_signature_domain", detect: detectReplaySignatureDomain },
  { family: "unexpected_balance_delta", detect: detectUnexpectedBalanceDelta },
  { family: "stale_changed_simulation", detect: detectStaleChangedSimulation },
  { family: "finality_reorg_anomaly", detect: detectFinalityReorgAnomaly },
]);

/**
 * Run every family detector over the context (deterministic order, family
 * by family). Returns raw signals; the agent builds/validates them.
 */
export function runAllDetectors(context: DetectionContext): readonly RawSignal[] {
  const raw: RawSignal[] = [];
  for (const detector of FAMILY_DETECTORS) {
    raw.push(...detector.detect(context));
  }
  return raw;
}
