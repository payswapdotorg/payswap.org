/**
 * @payswap/participation — anti-Sybil / anti-collusion checks (W3-004).
 *
 * PARTICIPATION-ENGINEERING §Anti-gaming threat model: Sybil identities,
 * collusion rings, wash transactions, self-referrals, low-quality volume,
 * artificial churn, reward farming, incentive cannibalization.
 *
 * Controls implemented here (each an EXPLICIT named finding — no single
 * opaque score is ever treated as sufficient Sybil protection):
 * - SELF_REFERRAL (block): an introducer referring themselves;
 * - SYBIL_IDENTITY_CLUSTER (block): contributor/introducer/counterparty
 *   linked through the declared identity-linkage graph (deterministic BFS);
 * - WASH_TRANSACTION_PATTERN (block): the same underlying identity on both
 *   sides of the referenced economic activity;
 * - VELOCITY_LIMIT_EXCEEDED (flag): contributions per actor per window;
 * - COUNTERPARTY_DIVERSITY_BELOW_MIN (flag): distinct-counterparty minimum;
 * - RAW_ARTIFICIAL_ACTIVITY (flag): behavior on a declared experiment gaming
 *   surface (experiments.ts §W3-004) without the verified outcome the
 *   surface requires.
 *
 * INV-P04: these checks MUST run before reward finalization — `rewards.ts`
 * refuses to finalize unless the report verdict is PASS (both FLAG and
 * BLOCK block finalization; the work order requires exactly that).
 */

import { ValidationError, type PartyId, type TimestampMs } from '@payswap/protocol';
import type { ArtificialActivitySurface } from './experiments.js';
import type { AntiGamingPolicySpec } from './programs.js';
import type { ContributionRecord, ReferralBinding } from './contributions.js';

/** Explicit finding codes (never an opaque score). */
export type AntiGamingFindingCode =
  | 'SELF_REFERRAL'
  | 'SYBIL_IDENTITY_CLUSTER'
  | 'WASH_TRANSACTION_PATTERN'
  | 'VELOCITY_LIMIT_EXCEEDED'
  | 'COUNTERPARTY_DIVERSITY_BELOW_MIN'
  | 'RAW_ARTIFICIAL_ACTIVITY';

/** Severity of one finding. BLOCK findings always block finalization. */
export type AntiGamingSeverity = 'FLAG' | 'BLOCK';

/** One explicit, evidence-carrying anti-gaming finding. */
export interface AntiGamingFinding {
  readonly code: AntiGamingFindingCode;
  readonly severity: AntiGamingSeverity;
  readonly detail: string;
  readonly evidenceRefs: readonly string[];
}

/** Verdict of one check run. FLAG and BLOCK both refuse finalization. */
export type AntiGamingVerdict = 'PASS' | 'FLAG' | 'BLOCK';

/** The full report consumed by reward finalization (INV-P04). */
export interface AntiGamingReport {
  readonly verdict: AntiGamingVerdict;
  readonly findings: readonly AntiGamingFinding[];
  /** Every check that ran, in execution order (auditability). */
  readonly checksRun: readonly string[];
}

/** A declared identity link between two parties (a Sybil-cluster edge). */
export interface IdentityLink {
  readonly a: PartyId;
  readonly b: PartyId;
  readonly kind: string;
}

/** Everything the checks reason over (all deterministic inputs). */
export interface AntiGamingContext {
  /** The contribution about to be rewarded. */
  readonly contribution: ContributionRecord;
  /** Prior contribution history (for velocity/diversity), record order. */
  readonly history: readonly ContributionRecord[];
  /** The referral binding in scope, when the contribution is a referral credit. */
  readonly referralBinding?: ReferralBinding;
  /** Declared identity links (Sybil-cluster edges). */
  readonly identityLinks: readonly IdentityLink[];
  /** Anti-gaming surfaces declared by the owning experiment (experiments.ts). */
  readonly declaredSurfaces: readonly ArtificialActivitySurface[];
  /** The injected clock reading (never ambient). */
  readonly now: TimestampMs;
}

/** The checks that were not configured for this run (recorded in checksRun). */
const ALL_CHECK_IDS: readonly string[] = Object.freeze([
  'self_referral',
  'sybil_identity_cluster',
  'wash_transaction_pattern',
  'velocity_limit',
  'counterparty_diversity',
  'raw_artificial_activity',
]);

/** Deterministic undirected reachability over the declared identity links. */
export function identitiesLinked(
  a: PartyId,
  b: PartyId,
  links: readonly IdentityLink[],
): boolean {
  if (a === b) {
    return true;
  }
  const adjacency = new Map<PartyId, Set<PartyId>>();
  for (const link of links) {
    if (link === null || typeof link !== 'object') {
      throw new ValidationError('identity links must be IdentityLink objects');
    }
    let neighborsA = adjacency.get(link.a);
    if (neighborsA === undefined) {
      neighborsA = new Set<PartyId>();
      adjacency.set(link.a, neighborsA);
    }
    neighborsA.add(link.b);
    let neighborsB = adjacency.get(link.b);
    if (neighborsB === undefined) {
      neighborsB = new Set<PartyId>();
      adjacency.set(link.b, neighborsB);
    }
    neighborsB.add(link.a);
  }
  // Deterministic BFS: expand the smaller-id frontier first is unnecessary —
  // plain BFS from `a` over an insertion-ordered adjacency is deterministic
  // for a given link list; we only need a boolean answer here.
  const queue: PartyId[] = [a];
  const visited = new Set<PartyId>([a]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const neighbors = adjacency.get(current);
    if (neighbors === undefined) {
      continue;
    }
    for (const neighbor of neighbors) {
      if (neighbor === b) {
        return true;
      }
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return false;
}

/**
 * Run the anti-gaming checks. Deterministic: same policy + context → same
 * findings in the same order with the same verdict. Checks run in a fixed
 * order and every finding carries its evidence references.
 */
export function runAntiGamingChecks(
  policy: AntiGamingPolicySpec,
  context: AntiGamingContext,
): AntiGamingReport {
  if (policy === null || typeof policy !== 'object') {
    throw new ValidationError('policy must be an AntiGamingPolicySpec');
  }
  if (context === null || typeof context !== 'object') {
    throw new ValidationError('context must be an AntiGamingContext');
  }
  const findings: AntiGamingFinding[] = [];
  const checksRun: string[] = [];
  const contribution = context.contribution;
  const evidence = contribution.evidence.map((reference) => reference.locator);

  // 1) Self-referral: introducer === introduced.
  const binding = context.referralBinding;
  if (binding !== undefined) {
    checksRun.push('self_referral');
    if (binding.introducer === binding.introduced) {
      findings.push({
        code: 'SELF_REFERRAL',
        severity: 'BLOCK',
        detail: `binding ${binding.id} introduces ${binding.introduced} to themselves`,
        evidenceRefs: Object.freeze(binding.evidence.map((reference) => reference.locator)),
      });
    }
  }

  // 2) Sybil identity cluster: contributor linked to introducer/counterparty.
  if (policy.requireIdentityLinkageChecks && context.identityLinks.length > 0) {
    checksRun.push('sybil_identity_cluster');
    const suspiciousParties: PartyId[] = [];
    if (binding !== undefined && identitiesLinked(binding.introducer, binding.introduced, context.identityLinks)) {
      suspiciousParties.push(binding.introducer, binding.introduced);
    }
    if (
      contribution.counterparty !== undefined &&
      identitiesLinked(contribution.actor, contribution.counterparty, context.identityLinks)
    ) {
      suspiciousParties.push(contribution.actor, contribution.counterparty);
    }
    if (suspiciousParties.length > 0) {
      findings.push({
        code: 'SYBIL_IDENTITY_CLUSTER',
        severity: 'BLOCK',
        detail: `identity linkage connects ${[...new Set(suspiciousParties)].join(' and ')}`,
        evidenceRefs: Object.freeze(
          context.identityLinks.map((link) => `${link.a}~${link.b}:${link.kind}`),
        ),
      });
    }
  }

  // 3) Wash transaction pattern: the same identity on both sides of the
  //    referenced economic activity (direct self-dealing).
  checksRun.push('wash_transaction_pattern');
  if (contribution.counterparty !== undefined) {
    const directlySelfDealing =
      contribution.actor === contribution.counterparty ||
      (policy.requireIdentityLinkageChecks &&
        identitiesLinked(contribution.actor, contribution.counterparty, context.identityLinks));
    // A self-dealing link that was NOT already reported as a cluster finding
    // (cluster check only runs when links are declared AND the policy wants it).
    if (contribution.actor === contribution.counterparty) {
      findings.push({
        code: 'WASH_TRANSACTION_PATTERN',
        severity: 'BLOCK',
        detail: `actor ${contribution.actor} is on both sides of the referenced activity`,
        evidenceRefs: Object.freeze(evidence),
      });
    } else if (directlySelfDealing && !policy.requireIdentityLinkageChecks) {
      findings.push({
        code: 'WASH_TRANSACTION_PATTERN',
        severity: 'BLOCK',
        detail: `actor ${contribution.actor} and counterparty ${contribution.counterparty} share an identity`,
        evidenceRefs: Object.freeze(evidence),
      });
    }
  }

  // 4) Velocity: contributions by the actor within the trailing window.
  if (policy.velocity !== undefined) {
    checksRun.push('velocity_limit');
    const windowOpens = context.now - policy.velocity.windowMs;
    const inWindow = context.history.filter(
      (record) =>
        record.actor === contribution.actor &&
        record.occurredAt > windowOpens &&
        record.occurredAt <= context.now,
    );
    // The contribution under review counts toward the limit as well.
    if (BigInt(inWindow.length + 1) > policy.velocity.maxContributions) {
      findings.push({
        code: 'VELOCITY_LIMIT_EXCEEDED',
        severity: 'FLAG',
        detail: `${inWindow.length + 1} contributions by ${contribution.actor} within ${policy.velocity.windowMs}ms exceed the limit of ${policy.velocity.maxContributions}`,
        evidenceRefs: Object.freeze(
          inWindow.map((record) => `${record.id}@${record.occurredAt}`),
        ),
      });
    }
  }

  // 5) Counterparty diversity below the declared minimum.
  if (policy.minCounterpartyDiversity !== undefined) {
    checksRun.push('counterparty_diversity');
    const counterparties = new Set<string>();
    for (const record of context.history) {
      if (record.actor === contribution.actor && record.counterparty !== undefined) {
        counterparties.add(record.counterparty);
      }
    }
    if (contribution.counterparty !== undefined) {
      counterparties.add(contribution.counterparty);
    }
    if (BigInt(counterparties.size) < policy.minCounterpartyDiversity) {
      findings.push({
        code: 'COUNTERPARTY_DIVERSITY_BELOW_MIN',
        severity: 'FLAG',
        detail: `actor ${contribution.actor} traded with ${counterparties.size} distinct counterparties (minimum ${policy.minCounterpartyDiversity})`,
        evidenceRefs: Object.freeze(evidence),
      });
    }
  }

  // 6) Raw artificial activity: behavior on a declared fabricable surface of
  //    the owning experiment without the verified outcome that surface
  //    requires (experiments.ts declares the surfaces; this check consumes
  //    them — W3-004 §2/§7 wiring).
  if (context.declaredSurfaces.length > 0) {
    checksRun.push('raw_artificial_activity');
    for (const surface of context.declaredSurfaces) {
      if (!surface.fabricableBehaviors.includes(contribution.behavior)) {
        continue;
      }
      if (surface.requiresVerifiedOutcome && contribution.outcome !== 'VERIFIED_COMPLETED') {
        findings.push({
          code: 'RAW_ARTIFICIAL_ACTIVITY',
          severity: 'FLAG',
          detail: `behavior ${contribution.behavior} on fabricable surface '${surface.surface}' carries outcome ${contribution.outcome} instead of VERIFIED_COMPLETED`,
          evidenceRefs: Object.freeze(evidence),
        });
      }
    }
  }

  let verdict: AntiGamingVerdict = 'PASS';
  for (const finding of findings) {
    if (finding.severity === 'BLOCK') {
      verdict = 'BLOCK';
      break;
    }
    verdict = 'FLAG';
  }
  return Object.freeze({
    verdict,
    findings: Object.freeze(findings.map((finding) => Object.freeze({ ...finding }))),
    checksRun: Object.freeze([...checksRun]),
  });
}

/** Whether a report authorizes finalization (PASS only — INV-P04). */
export function reportAllowsFinalization(report: AntiGamingReport): boolean {
  return report.verdict === 'PASS';
}

/** All check ids (documentation/audit surface). */
export const ANTI_GAMING_CHECK_IDS: readonly string[] = ALL_CHECK_IDS;
