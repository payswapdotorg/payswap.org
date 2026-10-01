/**
 * @payswap/campaigns — reward provenance inspection (W3-005).
 *
 * Users can inspect WHY a reward was accrued: every campaign reward carries a
 * queryable provenance chain assembling the four evidence pillars —
 * 1. the PROGRAM VERSION the reward was computed under (objective, mechanism,
 *    formula, budget declaration, specDigest);
 * 2. the CONTRIBUTION EVIDENCE (actor, behavior, quantity, outcome, evidence
 *    locators, the full attribution decision trace);
 * 3. the CURVE POINT (target curve digest, evaluated target, observed
 *    participation, emission level — the dynamic-incentive decision);
 * 4. the ANTI-GAMING VERDICT (the report evaluated at accrual time, with
 *    findings and checks run, plus deferral/suppression state).
 *
 * The chain is deterministic and digest-fingerprinted (`provenanceDigest`),
 * so a user can verify that the reward reproduced from evidence + program
 * version (INV-P03) and that nothing was silently altered (INV-E05).
 */

import {
  PaySwapError,
  type Money,
} from '@payswap/protocol';
import {
  asContributionId,
  UnknownBudgetError,
  type AntiGamingReport,
  type ContributionRecord,
  type IncentiveBudgetLedger,
  type IncentiveProgramVersion,
  type ProgramVersionRegistry,
  type RewardAccrual,
  type RewardAccrualId,
  type RewardBook,
} from '@payswap/participation';
import { stableDigest } from '@payswap/participation';
import {
  CampaignEngine,
  type CampaignId,
  type CampaignProvenanceEntry,
} from './campaigns.js';
import type { CurvePoint } from './target-curves.js';

/** No provenance exists for the given reward. */
export class UnknownProvenanceError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'UNKNOWN_REWARD_PROVENANCE', category: 'NOT_FOUND', message, details });
    this.name = 'UnknownProvenanceError';
  }
}

/** The program-version pillar of the provenance chain. */
export interface ProvenanceProgram {
  readonly programId: string;
  readonly version: bigint;
  readonly specDigest: string;
  readonly objective: string;
  readonly sponsor: string;
  readonly mechanism: string;
  readonly formulaKind: string;
  readonly budget: { readonly total: string; readonly funding: string };
  readonly eligibleRole: string;
}

/** The contribution-evidence pillar of the provenance chain. */
export interface ProvenanceContribution {
  readonly id: string;
  readonly actor: string;
  readonly behavior: string;
  readonly quantity: bigint;
  readonly outcome: string;
  readonly evidenceRefs: readonly string[];
  readonly attributionBasis: string;
  readonly attributedActor: string;
  /** The full deterministic attribution decision trace (INV-P02). */
  readonly decisionTrace: readonly { readonly ruleId: string; readonly matched: boolean; readonly note: string }[];
}

/** The anti-gaming pillar of the provenance chain. */
export interface ProvenanceAntiGaming {
  readonly verdict: 'PASS' | 'FLAG' | 'BLOCK';
  readonly findings: readonly { readonly code: string; readonly severity: string; readonly detail: string }[];
  readonly checksRun: readonly string[];
  /** Deferral state: open deferral (not finalizable) or resolved. */
  readonly deferral: 'NONE' | 'OPEN' | 'RESOLVED';
  /** Suppression state: suppressed rewards carry the suppression reason. */
  readonly suppression: 'NONE' | 'SUPPRESSED';
}

/** The funding pillar of the provenance chain (INV-P01 visibility). */
export interface ProvenanceFunding {
  readonly programBudgetFunded: boolean;
  readonly campaignCap: Money;
  readonly campaignCommitted: Money;
}

/** The full queryable provenance chain of one campaign reward. */
export interface RewardProvenance {
  readonly accrualId: RewardAccrualId;
  readonly campaignId: CampaignId;
  readonly campaignEpoch: bigint;
  readonly reward: {
    readonly kind: RewardAccrual['kind'];
    readonly amount: Money;
    readonly state: RewardAccrual['state'];
    readonly createdAt: bigint;
  };
  readonly program: ProvenanceProgram;
  readonly contribution: ProvenanceContribution;
  readonly curvePoint: CurvePoint;
  readonly antiGaming: ProvenanceAntiGaming;
  readonly funding: ProvenanceFunding;
  /** Deterministic fingerprint of the whole chain (INV-P03/INV-E05). */
  readonly provenanceDigest: string;
}

/** Everything provenance inspection needs, injected. */
export interface ProvenanceInspectionDeps {
  readonly engine: CampaignEngine;
  readonly programs: ProgramVersionRegistry;
  readonly rewards: RewardBook;
  /** The incentive budget ledger (funding visibility, INV-P01). */
  readonly budgets: IncentiveBudgetLedger;
}

/** Program version → provenance pillar (pure projection). */
function programPillar(program: IncentiveProgramVersion): ProvenanceProgram {
  return Object.freeze({
    programId: program.programId,
    version: program.version,
    specDigest: program.specDigest,
    objective: program.objective,
    sponsor: program.sponsor,
    mechanism: program.reward.mechanism,
    formulaKind: program.reward.formula.kind,
    budget: Object.freeze({
      total: `${program.budget.totalAmount.currency}:${program.budget.totalAmount.value}`,
      funding: program.budget.funding,
    }),
    eligibleRole: program.eligibleRole,
  });
}

/** Contribution record → provenance pillar (pure projection). */
function contributionPillar(record: ContributionRecord): ProvenanceContribution {
  return Object.freeze({
    id: record.id,
    actor: record.actor,
    behavior: record.behavior,
    quantity: record.quantity,
    outcome: record.outcome,
    evidenceRefs: Object.freeze(record.evidence.map((reference) => reference.locator)),
    attributionBasis: record.attribution.basis,
    attributedActor: record.attribution.attributedActor,
    decisionTrace: Object.freeze(
      record.attribution.decisionTrace.map((line) =>
        Object.freeze({ ruleId: line.ruleId, matched: line.matched, note: line.note }),
      ),
    ),
  });
}

/** Anti-gaming report + engine state → provenance pillar (pure projection). */
function antiGamingPillar(
  report: AntiGamingReport,
  engine: CampaignEngine,
  accrualId: RewardAccrualId,
): ProvenanceAntiGaming {
  const openDeferral = engine.deferrals.find(
    (record) => record.accrualId === accrualId && engine.deferralResolution(record.id) === undefined,
  );
  const resolvedDeferral = engine.deferrals.some(
    (record) => record.accrualId === accrualId && engine.deferralResolution(record.id) !== undefined,
  );
  const suppressed = engine.suppressions.some((record) => record.accrualId === accrualId);
  return Object.freeze({
    verdict: report.verdict,
    findings: Object.freeze(
      report.findings.map((finding) =>
        Object.freeze({ code: finding.code, severity: finding.severity, detail: finding.detail }),
      ),
    ),
    checksRun: Object.freeze([...report.checksRun]),
    deferral: openDeferral !== undefined ? 'OPEN' : resolvedDeferral ? 'RESOLVED' : 'NONE',
    suppression: suppressed ? 'SUPPRESSED' : 'NONE',
  });
}

/** Deterministic fingerprint of a whole provenance chain. */
function provenanceFingerprint(chain: Omit<RewardProvenance, 'provenanceDigest'>): string {
  return stableDigest([
    chain.accrualId,
    chain.campaignId,
    chain.campaignEpoch.toString(),
    chain.reward.kind,
    `${chain.reward.amount.currency}:${chain.reward.amount.value}`,
    chain.reward.state,
    chain.reward.createdAt.toString(),
    chain.program.specDigest,
    chain.program.programId,
    chain.program.version.toString(),
    chain.contribution.id,
    chain.contribution.behavior,
    chain.contribution.quantity.toString(),
    chain.contribution.outcome,
    chain.contribution.evidenceRefs.join(','),
    chain.contribution.attributionBasis,
    chain.curvePoint.digest,
    chain.curvePoint.emissionLevel,
    chain.curvePoint.target.toString(),
    chain.antiGaming.verdict,
    chain.antiGaming.findings.map((finding) => finding.code).join(','),
    chain.antiGaming.deferral,
    chain.antiGaming.suppression,
    `${chain.funding.campaignCap.currency}:${chain.funding.campaignCap.value}`,
    `${chain.funding.campaignCommitted.currency}:${chain.funding.campaignCommitted.value}`,
  ]);
}

/**
 * Inspect the full provenance chain of one campaign reward: WHY it was
 * accrued, under which program version, from which contribution evidence, at
 * which curve point, with which anti-gaming verdict, and under which funding
 * state. Pure over the engine journals + program registry + reward book.
 */
export function inspectRewardProvenance(
  deps: ProvenanceInspectionDeps,
  accrualId: RewardAccrualId,
): RewardProvenance {
  const entry: CampaignProvenanceEntry | undefined = deps.engine.provenanceOf(accrualId);
  if (entry === undefined) {
    throw new UnknownProvenanceError('no provenance exists for the given reward accrual', {
      accrualId,
    });
  }
  const accrual = deps.rewards.get(accrualId);
  if (accrual === undefined) {
    throw new UnknownProvenanceError('the reward accrual no longer exists in the reward book', {
      accrualId,
    });
  }
  const program = deps.programs.version(entry.programVersion.programId, entry.programVersion.version);
  const contribution = deps.engine.ledger.get(asContributionId(entry.contributionId));
  if (contribution === undefined) {
    throw new UnknownProvenanceError(
      'the contribution evidence behind the reward is no longer in the campaign ledger',
      { contributionId: entry.contributionId },
    );
  }
  const programBudgetFunded = (() => {
    try {
      return deps.budgets.isFunded(entry.programVersion);
    } catch (error) {
      if (error instanceof UnknownBudgetError) {
        return false;
      }
      throw error;
    }
  })();
  const chain: Omit<RewardProvenance, 'provenanceDigest'> = {
    accrualId,
    campaignId: entry.campaignId,
    campaignEpoch: entry.epoch,
    reward: Object.freeze({
      kind: accrual.kind,
      amount: accrual.amount,
      state: accrual.state,
      createdAt: accrual.createdAt,
    }),
    program: programPillar(program),
    contribution: contributionPillar(contribution),
    curvePoint: entry.curvePoint,
    antiGaming: antiGamingPillar(entry.report, deps.engine, accrualId),
    funding: Object.freeze({
      programBudgetFunded,
      campaignCap: deps.engine.currentEpoch(entry.campaignId).fundingCap,
      campaignCommitted: deps.engine.campaignCommitted(entry.campaignId),
    }),
  };
  return Object.freeze({
    ...chain,
    provenanceDigest: provenanceFingerprint(chain),
  });
}
