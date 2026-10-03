/**
 * @payswap/onchain-threat-intel — the 13 onchain threat families
 * (Work Order P4-W3-003; task packet "Threat families").
 *
 * The family vocabulary is the DETECTION surface of this package. Every
 * family has: a stable machine id, a human description, a default
 * deterministic severity→verdict table (./policy.ts) and a detector
 * (./detectors.ts). Detection is EVIDENCE-GENERATING (a signal with its
 * evidence chain); the deterministic policy — never the agent — decides the
 * verdict.
 *
 * The families (exactly the task packet list, in order):
 *  1. malicious_approval_permit    — malicious approvals/permits;
 *  2. unexpected_spender           — unexpected spenders;
 *  3. token_impersonation          — token impersonation (fake tokens);
 *  4. honeypot_transfer_restriction— honeypot/transfer restrictions;
 *  5. proxy_admin_change           — proxy/admin/implementation changes;
 *  6. oracle_manipulation          — oracle manipulation;
 *  7. bridge_compromise            — bridge compromise;
 *  8. mev_sandwich_exposure        — MEV/sandwich exposure;
 *  9. destination_chain_confusion  — destination/chain confusion;
 * 10. replay_signature_domain      — replay/signature-domain issues;
 * 11. unexpected_balance_delta     — unexpected balance/state deltas;
 * 12. stale_changed_simulation     — stale/materially changed simulations;
 * 13. finality_reorg_anomaly       — finality/reorg anomalies.
 *
 * Deterministic only: pure data, no clock, no randomness.
 */

import { ValidationError } from "@payswap/protocol";

// ---------------------------------------------------------------------------
// Threat families
// ---------------------------------------------------------------------------

/** The 13 onchain threat families of the P4-W3-003 task packet (in order). */
export const THREAT_FAMILIES = [
  "malicious_approval_permit",
  "unexpected_spender",
  "token_impersonation",
  "honeypot_transfer_restriction",
  "proxy_admin_change",
  "oracle_manipulation",
  "bridge_compromise",
  "mev_sandwich_exposure",
  "destination_chain_confusion",
  "replay_signature_domain",
  "unexpected_balance_delta",
  "stale_changed_simulation",
  "finality_reorg_anomaly",
] as const;

export type ThreatFamily = (typeof THREAT_FAMILIES)[number];

export function isThreatFamily(value: unknown): value is ThreatFamily {
  return (
    typeof value === "string" &&
    (THREAT_FAMILIES as readonly unknown[]).includes(value)
  );
}

/**
 * Deterministic family ids (stable, prefixed, safe for signature
 * signal-class patterns and evidence refs).
 */
export function familySignalClass(family: ThreatFamily): string {
  return `onchain_threat.${family}`;
}

/** Human descriptions (provenance-safe; no real-world claims). */
export const THREAT_FAMILY_DESCRIPTIONS: Readonly<
  Record<ThreatFamily, string>
> = Object.freeze({
  malicious_approval_permit:
    "malicious approvals/permits: unlimited or over-cap allowances, drain-pattern spenders, expired permit deadlines",
  unexpected_spender:
    "unexpected spenders: unapproved, newly observed or incident-heavy spender contracts receiving allowance",
  token_impersonation:
    "token impersonation: fake/uncertified tokens mimicking canonical assets by symbol or lookalike contract id",
  honeypot_transfer_restriction:
    "honeypot/transfer restrictions: tokens that accept inbound value but restrict outbound transfers or sells",
  proxy_admin_change:
    "proxy/admin/implementation changes: upgrade/admin authority or implementation drift versus the certified protocol declaration",
  oracle_manipulation:
    "oracle manipulation: price deviation between oracle readings or versus a policy reference, and stale oracle feeds",
  bridge_compromise:
    "bridge compromise: halted/degraded bridges, recent validator-set changes, sub-quorum attestations",
  mev_sandwich_exposure:
    "MEV/sandwich exposure: public-mempool-visible swaps with wide slippage limits, high price impact or expired quotes",
  destination_chain_confusion:
    "destination/chain confusion: route-hop chain mismatch, cross-chain address reuse, wrong-chain execution",
  replay_signature_domain:
    "replay/signature-domain issues: previously observed payload digests, domain/chain mismatches, nonce reuse, expired permits",
  unexpected_balance_delta:
    "unexpected balance/state deltas: observed debits/credits/approvals outside the intent's exact legs",
  stale_changed_simulation:
    "stale/materially changed simulations: simulations bound to a different write, past max age, or simulated against blocks behind head",
  finality_reorg_anomaly:
    "finality/reorg anomalies: reorg depth beyond threshold, settlement assumptions beyond the safe head, stale chain observation",
});

// ---------------------------------------------------------------------------
// Signal severity
// ---------------------------------------------------------------------------

/** Signal severity model (detection severity, NOT the verdict). */
export const THREAT_SEVERITIES = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type ThreatSeverity = (typeof THREAT_SEVERITIES)[number];

export function isThreatSeverity(value: unknown): value is ThreatSeverity {
  return (
    typeof value === "string" &&
    (THREAT_SEVERITIES as readonly unknown[]).includes(value)
  );
}

/** Deterministic total order over severities (info < low < ... < critical). */
export function threatSeverityRank(severity: ThreatSeverity): number {
  switch (severity) {
    case "info":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    case "critical":
      return 4;
  }
}

/**
 * Map a threat severity onto the immune system's advisory severity
 * vocabulary (low/medium/high/critical). `info` maps to `low` (advisories
 * have no info level — an info signal never proposes an advisory anyway).
 */
export function advisorySeverityFor(
  severity: ThreatSeverity,
): "low" | "medium" | "high" | "critical" {
  switch (severity) {
    case "info":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "critical":
      return "critical";
  }
}

/** Assert a well-formed family + severity pair (fail closed). */
export function assertThreatFamilySeverity(
  family: ThreatFamily,
  severity: ThreatSeverity,
): void {
  if (!isThreatFamily(family)) {
    throw new ValidationError(
      `unknown onchain threat family '${String(family)}'`,
    );
  }
  if (!isThreatSeverity(severity)) {
    throw new ValidationError(
      `unknown onchain threat severity '${String(severity)}'`,
    );
  }
}
