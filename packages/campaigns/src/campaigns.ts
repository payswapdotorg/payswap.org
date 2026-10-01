/**
 * @payswap/campaigns — production ParticipationCampaign (W3-005).
 *
 * A production campaign operationalizes an IMMUTABLE IncentiveProgram version
 * (W3-004, consumed — never modified) against one ParticipationGoal: it owns
 * an enrollment window, an append-only chain of campaign epochs, and a
 * per-campaign funding cap that is ENFORCED AT ACCRUAL TIME on top of the
 * program-version budget headroom (INV-P01 defense in depth).
 *
 * Campaign epochs (INV-P07 discipline mirrored from ProgramVersionRegistry):
 * - every epoch pins (program version + specDigest, funding cap, target
 *   curve, tolerance band, cap policy, status) and opens a STRICTLY LATER
 *   effective epoch than its predecessor;
 * - a status-only change (pause/resume/close) carries the incentive
 *   parameters forward unchanged;
 * - ANY incentive change (funding cap, curve digest, band, cap policy)
 *   requires the epoch to reference a NEW program version —
 *   `IncentiveEpochViolationError` otherwise. Curve changes and cap
 *   adjustments therefore always create new program versions (INV-P07).
 *
 * Cap enforcement at accrual (W3-005 acceptance): an accrual that would
 * exceed the campaign funding cap is REJECTED (`CampaignCapExceededError`
 * under the REJECT policy) or DEFERRED with an explicit, evidence-carrying
 * `DeferredCapRecord` (under the DEFER policy) — never silently dropped and
 * never finalized unfunded. Program-level policies (budget headroom,
 * per-actor caps, concentration limits) are enforced by
 * @payswap/participation `accrueReward` and propagate loudly.
 *
 * Deterministic by construction: ids/times come exclusively from the
 * injected protocol factories; the campaign committed total is a pure
 * projection over the reward book + provenance journal.
 */

import {
  add,
  compare,
  fromMinorUnits,
  PaySwapError,
  ValidationError,
  type IdFactory,
  type Money,
  type ObligationBook,
  type ProtocolClock,
  type TimestampMs,
} from '@payswap/protocol';
import {
  accrueReward,
  computeRewardAmount,
  expireReward,
  finalizeReward,
  runAntiGamingChecks,
  type AntiGamingContext,
  type AntiGamingReport,
  type ContributionLedger,
  type ContributionRecord,
  type IdentityLink,
  type IncentiveBudgetLedger,
  type IncentiveProgramVersion,
  type ParticipationGoalId,
  type ProgramVersionRef,
  type ProgramVersionRegistry,
  type ReferralBinding,
  type RewardAccrual,
  type RewardAccrualId,
  type RewardBook,
  type RewardServiceDeps,
} from '@payswap/participation';
import {
  defineTargetBand,
  defineTargetCurve,
  resolveCurvePoint,
  targetCurveDigest,
  type CurvePoint,
  type TargetBand,
  type TargetCurveSpec,
} from './target-curves.js';

declare const CampaignIdBrand: unique symbol;

/** Branded id of one participation campaign. */
export type CampaignId = string & { readonly [CampaignIdBrand]: 'CampaignId' };

/** Brand a validated string as a `CampaignId`. */
export function asCampaignId(value: string): CampaignId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('CampaignId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new ValidationError('CampaignId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError('CampaignId must not carry surrounding whitespace', { value });
  }
  return value as CampaignId;
}

/** Campaign epoch status (append-only transitions, never rewritten). */
export type CampaignEpochStatus = 'ACTIVE' | 'PAUSED' | 'CLOSED';

/** What happens when an accrual would exceed the campaign funding cap. */
export type CampaignCapPolicy = 'DEFER' | 'REJECT';

/** One immutable campaign epoch — the unit of campaign change (INV-P07). */
export interface CampaignEpoch {
  readonly epoch: bigint;
  readonly effectiveFrom: TimestampMs;
  readonly status: CampaignEpochStatus;
  /** The immutable program version this epoch operationalizes. */
  readonly programVersion: ProgramVersionRef;
  /** Pinned program spec digest — integrity-checked against the registry. */
  readonly programSpecDigest: string;
  /** Per-campaign funding cap (≤ the program version budget total). */
  readonly fundingCap: Money;
  readonly capPolicy: CampaignCapPolicy;
  readonly curve: TargetCurveSpec;
  readonly curveDigest: string;
  readonly band: TargetBand;
  /** Epoch this epoch supersedes (absent on epoch 1). */
  readonly supersedesEpoch?: bigint;
}

/** A production participation campaign over an immutable program version. */
export interface ParticipationCampaign {
  readonly id: CampaignId;
  readonly goalId: ParticipationGoalId;
  /** Enrollment window: only contributions inside it qualify. */
  readonly enrollment: { readonly opensAt: TimestampMs; readonly closesAt: TimestampMs };
  /** Append-only epoch chain — campaign history is never rewritten. */
  readonly epochs: readonly CampaignEpoch[];
}

/** Input shape for opening a campaign (epoch 1 is minted from it). */
export interface CampaignSpec {
  readonly campaignId?: CampaignId;
  readonly goalId: ParticipationGoalId;
  readonly enrollment: { readonly opensAt: TimestampMs; readonly closesAt: TimestampMs };
  readonly effectiveFrom: TimestampMs;
  readonly programVersion: ProgramVersionRef;
  readonly fundingCap: Money;
  readonly capPolicy?: CampaignCapPolicy;
  readonly curve: TargetCurveSpec;
  readonly band?: TargetBand;
  readonly status?: CampaignEpochStatus;
}

/** Input shape for revising a campaign (a NEW epoch, INV-P07 discipline). */
export interface CampaignRevision {
  readonly effectiveFrom: TimestampMs;
  readonly status: CampaignEpochStatus;
  /** Must exist in the program registry; a NEW version for incentive changes. */
  readonly programVersion: ProgramVersionRef;
  /** Carry-forward when absent; a changed value requires a new program version. */
  readonly fundingCap?: Money;
  readonly curve?: TargetCurveSpec;
  readonly band?: TargetBand;
  readonly capPolicy?: CampaignCapPolicy;
}

/** No campaign registered under the given id. */
export class UnknownCampaignError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'UNKNOWN_CAMPAIGN', category: 'NOT_FOUND', message, details });
    this.name = 'UnknownCampaignError';
  }
}

/** A revision would not open a strictly later effective epoch. */
export class CampaignEpochViolationError extends ValidationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.name = 'CampaignEpochViolationError';
  }
}

/**
 * INV-P07: an incentive parameter (cap, curve, band, cap policy) changed
 * without referencing a NEW program version — incentive changes create new
 * versions/effective epochs.
 */
export class IncentiveEpochViolationError extends ValidationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.name = 'IncentiveEpochViolationError';
  }
}

/** The campaign refused the contribution for window/status reasons. */
export class CampaignNotAcceptingError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'CAMPAIGN_NOT_ACCEPTING', category: 'POLICY_BLOCKED', message, details });
    this.name = 'CampaignNotAcceptingError';
  }
}

/** The accrual would exceed the campaign funding cap (REJECT policy). */
export class CampaignCapExceededError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'CAMPAIGN_CAP_EXCEEDED', category: 'POLICY_BLOCKED', message, details });
    this.name = 'CampaignCapExceededError';
  }
}

/** The same contribution was already processed under this campaign. */
export class DuplicateCampaignContributionError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'DUPLICATE_CAMPAIGN_CONTRIBUTION', category: 'CONFLICT', message, details });
    this.name = 'DuplicateCampaignContributionError';
  }
}

/** The accrual does not belong to the given campaign. */
export class UnknownCampaignRewardError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'UNKNOWN_CAMPAIGN_REWARD', category: 'NOT_FOUND', message, details });
    this.name = 'UnknownCampaignRewardError';
  }
}

/** The reward has an unresolved deferral and cannot progress/finalize. */
export class DeferralOpenError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'DEFERRAL_OPEN', category: 'POLICY_BLOCKED', message, details });
    this.name = 'DeferralOpenError';
  }
}

/** The reward was suppressed with an evidence record and cannot progress. */
export class SuppressedRewardError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'SUPPRESSED_REWARD', category: 'POLICY_BLOCKED', message, details });
    this.name = 'SuppressedRewardError';
  }
}

/**
 * INV-P01: a production campaign may only operate on a program version with
 * an ESTABLISHED budget state (funded reservation or explicitly contingent)
 * — a campaign with no budget declaration cannot promise anything.
 */
export class CampaignBudgetRequiredError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'CAMPAIGN_BUDGET_REQUIRED', category: 'POLICY_BLOCKED', message, details });
    this.name = 'CampaignBudgetRequiredError';
  }
}

/** A reward deferred because anti-gaming checks flagged it (not blocked). */
export interface RewardDeferralRecord {
  readonly id: string;
  readonly kind: 'ANTI_GAMING_FLAG';
  readonly campaignId: CampaignId;
  readonly epoch: bigint;
  readonly accrualId: RewardAccrualId;
  readonly contributionId: string;
  /** The anti-gaming report that caused the deferral (full evidence). */
  readonly report: AntiGamingReport;
  readonly reason: string;
  readonly at: TimestampMs;
}

/** The resolution of one deferral (append-only evidence of the review). */
export interface DeferralResolution {
  readonly deferralId: string;
  readonly accrualId: RewardAccrualId;
  /** Fresh PASS report supplied at resolution (INV-P04 re-checked). */
  readonly report: AntiGamingReport;
  readonly note: string;
  readonly evidenceRefs: readonly string[];
  readonly at: TimestampMs;
}

/** A reward suppression — always evidence-carrying, never silent. */
export interface RewardSuppressionRecord {
  readonly id: string;
  readonly kind: 'ANTI_GAMING_BLOCK' | 'OPERATOR_EMERGENCY';
  readonly campaignId?: CampaignId;
  readonly accrualId?: RewardAccrualId;
  readonly contributionId?: string;
  /** The anti-gaming report that caused the suppression, when anti-gaming. */
  readonly report?: AntiGamingReport;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly at: TimestampMs;
}

/** An accrual deferred because the campaign funding cap would be exceeded. */
export interface DeferredCapRecord {
  readonly id: string;
  readonly kind: 'CAMPAIGN_CAP';
  readonly campaignId: CampaignId;
  readonly epoch: bigint;
  /** Frozen copy of the contribution — deferred accruals are reprocessable. */
  readonly contribution: ContributionRecord;
  readonly programVersion: ProgramVersionRef;
  readonly computedAmount: Money;
  readonly curvePoint: CurvePoint;
  readonly reason: string;
  readonly at: TimestampMs;
}

/** The resolution of one cap deferral (accrual finally made). */
export interface DeferredCapResolution {
  readonly deferredCapId: string;
  readonly accrualId: RewardAccrualId;
  readonly at: TimestampMs;
}

/** Provenance entry appended for every campaign reward accrual (W3-005 §7). */
export interface CampaignProvenanceEntry {
  readonly accrualId: RewardAccrualId;
  readonly campaignId: CampaignId;
  readonly epoch: bigint;
  readonly programVersion: ProgramVersionRef;
  readonly programSpecDigest: string;
  readonly contributionId: string;
  readonly curvePoint: CurvePoint;
  /** Anti-gaming report evaluated at accrual time (PASS or FLAG). */
  readonly report: AntiGamingReport;
  /** True when the accrual exists but finalization is deferred (FLAG). */
  readonly deferred: boolean;
  readonly at: TimestampMs;
}

/** The deterministic result of processing one contribution. */
export type CampaignAccrualOutcome =
  | {
      readonly disposition: 'ACCRUED';
      readonly accrual: RewardAccrual;
      readonly curvePoint: CurvePoint;
      readonly antiGaming: AntiGamingReport;
      readonly provenance: CampaignProvenanceEntry;
    }
  | {
      readonly disposition: 'DEFERRED';
      readonly accrual: RewardAccrual;
      readonly curvePoint: CurvePoint;
      readonly antiGaming: AntiGamingReport;
      readonly deferral: RewardDeferralRecord;
      readonly provenance: CampaignProvenanceEntry;
    }
  | {
      readonly disposition: 'DEFERRED_CAP';
      readonly deferred: DeferredCapRecord;
      readonly curvePoint: CurvePoint;
      readonly antiGaming: AntiGamingReport;
    }
  | {
      readonly disposition: 'SUPPRESSED';
      readonly suppression: RewardSuppressionRecord;
      readonly curvePoint: CurvePoint;
      readonly antiGaming: AntiGamingReport;
    };

/** Everything the campaign engine needs, injected (no ambient dependencies). */
export interface CampaignEngineDeps extends RewardServiceDeps {
  readonly ids: IdFactory;
  readonly clock: ProtocolClock;
  readonly rewards: RewardBook;
  readonly budgets: IncentiveBudgetLedger;
  readonly obligations: ObligationBook;
  /** Append-only program version history (consumed, never modified). */
  readonly programs: ProgramVersionRegistry;
  /** Campaign-scoped contribution ledger (append-only). */
  readonly ledger: ContributionLedger;
}

/** Anti-gaming context inputs the caller supplies (deterministic inputs). */
export interface CampaignAntiGamingInputs {
  readonly identityLinks: readonly IdentityLink[];
  readonly declaredSurfaces: readonly ArtificialActivitySurfaceInput[];
  /** Observed participation feeding the target curve at contribution time. */
  readonly observedParticipation: bigint;
  /** Referral binding in scope, when the contribution is a referral credit. */
  readonly referralBinding?: ReferralBinding;
}

/** Declared anti-gaming surface (mirrors participation's input shape). */
export interface ArtificialActivitySurfaceInput {
  readonly surface: string;
  readonly fabricableBehaviors: readonly string[];
  readonly requiresVerifiedOutcome: boolean;
  readonly note: string;
}

/**
 * The production campaign engine: append-only campaign epochs over immutable
 * program versions, cap enforcement at accrual, anti-gaming-driven deferral
 * and suppression, and a queryable provenance journal for every reward.
 */
export class CampaignEngine {
  private readonly _campaigns = new Map<CampaignId, ParticipationCampaign>();
  private readonly _processed = new Map<CampaignId, Set<string>>();
  private readonly _provenance = new Map<RewardAccrualId, CampaignProvenanceEntry>();
  private readonly _provenanceOrder: CampaignProvenanceEntry[] = [];
  private readonly _deferrals: RewardDeferralRecord[] = [];
  private readonly _deferralResolutions = new Map<string, DeferralResolution>();
  private readonly _suppressions: RewardSuppressionRecord[] = [];
  private readonly _deferredCaps: DeferredCapRecord[] = [];
  private readonly _deferredCapResolutions = new Map<string, DeferredCapResolution>();

  constructor(private readonly deps: CampaignEngineDeps) {}

  /** The campaign-scoped contribution ledger (append-only history). */
  get ledger(): ContributionLedger {
    return this.deps.ledger;
  }

  /** The injected id factory (deterministic derivations, e.g. referral credits). */
  get ids(): IdFactory {
    return this.deps.ids;
  }

  /** The injected protocol clock. */
  get clock(): ProtocolClock {
    return this.deps.clock;
  }

  /** Open a new campaign (epoch 1) over an immutable program version. */
  openCampaign(spec: CampaignSpec): ParticipationCampaign {
    if (spec === null || typeof spec !== 'object') {
      throw new ValidationError('spec must be a CampaignSpec object');
    }
    if (typeof spec.goalId !== 'string' || spec.goalId.length === 0) {
      throw new ValidationError('spec.goalId must be a ParticipationGoalId');
    }
    if (
      spec.enrollment === null ||
      typeof spec.enrollment !== 'object' ||
      typeof spec.enrollment.opensAt !== 'bigint' ||
      typeof spec.enrollment.closesAt !== 'bigint' ||
      spec.enrollment.closesAt <= spec.enrollment.opensAt
    ) {
      throw new ValidationError('spec.enrollment must be a window that closes after it opens');
    }
    if (typeof spec.effectiveFrom !== 'bigint' || spec.effectiveFrom < 0n) {
      throw new ValidationError('spec.effectiveFrom must be a non-negative bigint TimestampMs');
    }
    const status = spec.status ?? 'ACTIVE';
    if (status !== 'ACTIVE' && status !== 'PAUSED' && status !== 'CLOSED') {
      throw new ValidationError('spec.status must be ACTIVE, PAUSED or CLOSED');
    }
    const capPolicy = spec.capPolicy ?? 'DEFER';
    if (capPolicy !== 'DEFER' && capPolicy !== 'REJECT') {
      throw new ValidationError('spec.capPolicy must be DEFER or REJECT');
    }
    const curve = defineTargetCurve(spec.curve);
    const band = spec.band === undefined ? defineTargetBand({ toleranceBps: 500n }) : defineTargetBand(spec.band);
    const program = this._resolveProgram(spec.programVersion);
    this._validateCap(program, spec.fundingCap);
    this._assertBudgetDeclared(program);
    const campaignId = spec.campaignId ?? asCampaignId(this.deps.ids.mintId('camp'));
    if (this._campaigns.has(campaignId)) {
      throw new ValidationError('campaign id already registered', { campaignId });
    }
    const epoch: CampaignEpoch = Object.freeze({
      epoch: 1n,
      effectiveFrom: spec.effectiveFrom,
      status,
      programVersion: Object.freeze({ ...spec.programVersion }),
      programSpecDigest: program.specDigest,
      fundingCap: spec.fundingCap,
      capPolicy,
      curve,
      curveDigest: targetCurveDigest(curve),
      band,
    });
    const campaign: ParticipationCampaign = Object.freeze({
      id: campaignId,
      goalId: spec.goalId,
      enrollment: Object.freeze({ ...spec.enrollment }),
      epochs: Object.freeze([epoch]),
    });
    this._campaigns.set(campaignId, campaign);
    this._processed.set(campaignId, new Set<string>());
    return campaign;
  }

  /** The latest epoch of a campaign. */
  currentEpoch(campaignId: CampaignId): CampaignEpoch {
    return this._campaign(campaignId).epochs[this._epochCount(campaignId) - 1] as CampaignEpoch;
  }

  /** The epoch effective at a given time (latest whose effectiveFrom <= at). */
  epochAt(campaignId: CampaignId, at: TimestampMs): CampaignEpoch {
    const campaign = this._campaign(campaignId);
    let found: CampaignEpoch | undefined;
    for (const epoch of campaign.epochs) {
      if (epoch.effectiveFrom <= at) {
        found = epoch;
      }
    }
    if (found === undefined) {
      throw new CampaignNotAcceptingError('no campaign epoch is effective at the given time', {
        campaignId,
        at: at.toString(),
        firstEpochFrom: campaign.epochs[0]?.effectiveFrom.toString(),
      });
    }
    return found;
  }

  /** One campaign (frozen). */
  campaign(campaignId: CampaignId): ParticipationCampaign {
    return this._campaign(campaignId);
  }

  /** All campaigns in registration order. */
  get all(): readonly ParticipationCampaign[] {
    return Object.freeze([...this._campaigns.values()]);
  }

  /** Pause a campaign — a NEW epoch carrying the incentive parameters forward. */
  pauseCampaign(campaignId: CampaignId, effectiveFrom: TimestampMs): ParticipationCampaign {
    return this._statusChange(campaignId, effectiveFrom, 'PAUSED');
  }

  /** Resume a paused campaign — a NEW epoch (INV-P07 append-only). */
  resumeCampaign(campaignId: CampaignId, effectiveFrom: TimestampMs): ParticipationCampaign {
    return this._statusChange(campaignId, effectiveFrom, 'ACTIVE');
  }

  /** Close a campaign — terminal epoch (no further epochs may be appended). */
  closeCampaign(campaignId: CampaignId, effectiveFrom: TimestampMs): ParticipationCampaign {
    return this._statusChange(campaignId, effectiveFrom, 'CLOSED');
  }

  /**
   * Revise a campaign — a NEW epoch. Incentive changes (funding cap, curve,
   * band, cap policy) require the epoch to reference a NEW program version
   * (INV-P07: incentive changes create new versions/effective epochs).
   */
  reviseCampaign(campaignId: CampaignId, revision: CampaignRevision): ParticipationCampaign {
    const campaign = this._campaign(campaignId);
    const current = this.currentEpoch(campaignId);
    if (current.status === 'CLOSED') {
      throw new CampaignEpochViolationError('a CLOSED campaign cannot be revised');
    }
    if (typeof revision.effectiveFrom !== 'bigint' || revision.effectiveFrom <= current.effectiveFrom) {
      throw new CampaignEpochViolationError(
        'a campaign revision must open a strictly later effective epoch (INV-P07)',
        {
          campaignId,
          currentEpoch: current.epoch.toString(),
          currentEffectiveFrom: current.effectiveFrom.toString(),
          proposedEffectiveFrom: revision.effectiveFrom.toString(),
        },
      );
    }
    const program = this._resolveProgram(revision.programVersion);
    const fundingCap = revision.fundingCap ?? current.fundingCap;
    const curve = revision.curve === undefined ? current.curve : defineTargetCurve(revision.curve);
    const band = revision.band === undefined ? current.band : defineTargetBand(revision.band);
    const capPolicy = revision.capPolicy ?? current.capPolicy;
    const curveDigest = targetCurveDigest(curve);

    const sameProgramVersion =
      revision.programVersion.programId === current.programVersion.programId &&
      revision.programVersion.version === current.programVersion.version;
    if (sameProgramVersion) {
      const incentiveUnchanged =
        fundingCap.value === current.fundingCap.value &&
        fundingCap.currency === current.fundingCap.currency &&
        curveDigest === current.curveDigest &&
        band.toleranceBps === current.band.toleranceBps &&
        capPolicy === current.capPolicy;
      if (!incentiveUnchanged) {
        throw new IncentiveEpochViolationError(
          'changing a campaign funding cap, curve, band or cap policy requires a NEW program version (INV-P07: incentive changes create new versions/effective epochs)',
          {
            campaignId,
            programVersion: `${revision.programVersion.programId}@${revision.programVersion.version}`,
            capChanged: fundingCap.value !== current.fundingCap.value,
            curveChanged: curveDigest !== current.curveDigest,
            bandChanged: band.toleranceBps !== current.band.toleranceBps,
            capPolicyChanged: capPolicy !== current.capPolicy,
          },
        );
      }
    } else {
      if (revision.programVersion.programId !== current.programVersion.programId) {
        throw new ValidationError('a campaign revision must stay on the same incentive program', {
          currentProgram: current.programVersion.programId,
          proposedProgram: revision.programVersion.programId,
        });
      }
      if (revision.programVersion.version <= current.programVersion.version) {
        throw new CampaignEpochViolationError(
          'a campaign revision must reference a LATER program version than the current epoch',
          {
            current: current.programVersion.version.toString(),
            proposed: revision.programVersion.version.toString(),
          },
        );
      }
    }
    this._validateCap(program, fundingCap);
    this._assertBudgetDeclared(program);

    const epoch: CampaignEpoch = Object.freeze({
      epoch: current.epoch + 1n,
      effectiveFrom: revision.effectiveFrom,
      status: revision.status,
      programVersion: Object.freeze({ ...revision.programVersion }),
      programSpecDigest: program.specDigest,
      fundingCap,
      capPolicy,
      curve,
      curveDigest,
      band,
      supersedesEpoch: current.epoch,
    });
    const revised: ParticipationCampaign = Object.freeze({
      ...campaign,
      epochs: Object.freeze([...campaign.epochs, epoch]),
    });
    this._campaigns.set(campaignId, revised);
    return revised;
  }

  /**
   * Process one attributed contribution under the campaign: window/status
   * gates, curve point, anti-gaming checks, campaign cap enforcement, then
   * the participation accrual machinery. Every non-accrual outcome is an
   * explicit evidence record — nothing is silently dropped.
   */
  processContribution(
    campaignId: CampaignId,
    contribution: ContributionRecord,
    inputs: CampaignAntiGamingInputs,
  ): CampaignAccrualOutcome {
    const campaign = this._campaign(campaignId);
    if (
      contribution.occurredAt < campaign.enrollment.opensAt ||
      contribution.occurredAt > campaign.enrollment.closesAt
    ) {
      throw new CampaignNotAcceptingError(
        'the contribution occurred outside the campaign enrollment window',
        {
          campaignId,
          opensAt: campaign.enrollment.opensAt.toString(),
          closesAt: campaign.enrollment.closesAt.toString(),
          occurredAt: contribution.occurredAt.toString(),
        },
      );
    }
    const processed = this._processed.get(campaignId);
    if (processed === undefined) {
      throw new UnknownCampaignError('no campaign registered under the given id', { campaignId });
    }
    if (processed.has(contribution.id)) {
      throw new DuplicateCampaignContributionError(
        'this contribution was already processed under the campaign (one reward per contribution)',
        { campaignId, contributionId: contribution.id },
      );
    }
    const epoch = this.epochAt(campaignId, contribution.occurredAt);
    if (epoch.status === 'PAUSED') {
      throw new CampaignNotAcceptingError('the campaign is PAUSED at the contribution time', {
        campaignId,
        epoch: epoch.epoch.toString(),
      });
    }
    if (epoch.status === 'CLOSED') {
      throw new CampaignNotAcceptingError('the campaign is CLOSED at the contribution time', {
        campaignId,
        epoch: epoch.epoch.toString(),
      });
    }
    const program = this._resolvePinnedProgram(epoch);

    // Anti-gaming history EXCLUDES the contribution under review (the check
    // itself counts it as +1). The append is idempotent: a reprocessed
    // deferred contribution is already in the ledger and is never appended
    // twice (append-only ids are never reused).
    const alreadyRecorded = this.deps.ledger.get(contribution.id) !== undefined;
    const history = alreadyRecorded
      ? this.deps.ledger.byActor(contribution.actor).filter((record) => record.id !== contribution.id)
      : this.deps.ledger.byActor(contribution.actor);
    if (!alreadyRecorded) {
      this.deps.ledger.append(contribution);
    }
    processed.add(contribution.id);

    const curvePoint = resolveCurvePoint(
      epoch.curve,
      { at: contribution.occurredAt, observedParticipation: inputs.observedParticipation },
      epoch.band,
    );
    const antiGamingContext: AntiGamingContext = {
      contribution,
      history,
      identityLinks: inputs.identityLinks,
      declaredSurfaces: inputs.declaredSurfaces,
      now: this.deps.clock.now(),
      ...(inputs.referralBinding !== undefined ? { referralBinding: inputs.referralBinding } : {}),
    };
    const report = runAntiGamingChecks(program.antiGamingPolicy, antiGamingContext);

    if (report.verdict === 'BLOCK') {
      const suppression: RewardSuppressionRecord = Object.freeze({
        id: this.deps.ids.mintId('supp'),
        kind: 'ANTI_GAMING_BLOCK',
        campaignId,
        contributionId: contribution.id,
        report,
        reason: `anti-gaming BLOCK: ${report.findings.map((finding) => finding.code).join(',')}`,
        evidenceRefs: Object.freeze(
          report.findings.flatMap((finding) => [...finding.evidenceRefs]),
        ),
        at: this.deps.clock.now(),
      });
      return Object.freeze({
        disposition: 'SUPPRESSED',
        suppression: this._recordSuppression(suppression),
        curvePoint,
        antiGaming: report,
      });
    }

    // Pre-compute the deterministic amount for the campaign cap check —
    // accrueReward recomputes the identical amount (INV-P03).
    const { amount } = computeRewardAmount(program, contribution, curvePoint.emissionLevel);
    const committed = this.campaignCommitted(campaignId);
    if (compare(add(committed, amount), epoch.fundingCap) > 0) {
      if (epoch.capPolicy === 'REJECT') {
        throw new CampaignCapExceededError(
          'this accrual would exceed the campaign funding cap (REJECT policy)',
          {
            campaignId,
            epoch: epoch.epoch.toString(),
            cap: epoch.fundingCap.value.toString(),
            committed: committed.value.toString(),
            attempted: amount.value.toString(),
          },
        );
      }
      const deferred: DeferredCapRecord = Object.freeze({
        id: this.deps.ids.mintId('defcap'),
        kind: 'CAMPAIGN_CAP',
        campaignId,
        epoch: epoch.epoch,
        contribution: contribution,
        programVersion: Object.freeze({ ...epoch.programVersion }),
        computedAmount: amount,
        curvePoint,
        reason:
          'campaign funding cap would be exceeded — accrual deferred (never silently dropped, never finalized unfunded)',
        at: this.deps.clock.now(),
      });
      this._deferredCaps.push(deferred);
      return Object.freeze({
        disposition: 'DEFERRED_CAP',
        deferred,
        curvePoint,
        antiGaming: report,
      });
    }

    const accrual = accrueReward(
      {
        ids: this.deps.ids,
        clock: this.deps.clock,
        rewards: this.deps.rewards,
        budgets: this.deps.budgets,
        obligations: this.deps.obligations,
      },
      program,
      contribution,
      curvePoint.emissionLevel,
    );

    const entry: CampaignProvenanceEntry = Object.freeze({
      accrualId: accrual.id,
      campaignId,
      epoch: epoch.epoch,
      programVersion: Object.freeze({ ...epoch.programVersion }),
      programSpecDigest: program.specDigest,
      contributionId: contribution.id,
      curvePoint,
      report,
      deferred: report.verdict === 'FLAG',
      at: this.deps.clock.now(),
    });
    this._provenance.set(entry.accrualId, entry);
    this._provenanceOrder.push(entry);

    if (report.verdict === 'FLAG') {
      const deferral: RewardDeferralRecord = Object.freeze({
        id: this.deps.ids.mintId('defr'),
        kind: 'ANTI_GAMING_FLAG',
        campaignId,
        epoch: epoch.epoch,
        accrualId: accrual.id,
        contributionId: contribution.id,
        report,
        reason: `anti-gaming FLAG: ${report.findings.map((finding) => finding.code).join(',')}`,
        at: this.deps.clock.now(),
      });
      this._deferrals.push(deferral);
      return Object.freeze({
        disposition: 'DEFERRED',
        accrual,
        curvePoint,
        antiGaming: report,
        deferral,
        provenance: entry,
      });
    }
    return Object.freeze({
      disposition: 'ACCRUED',
      accrual,
      curvePoint,
      antiGaming: report,
      provenance: entry,
    });
  }

  /**
   * Reprocess one cap-deferred accrual under the CURRENT campaign epoch
   * (after a cap adjustment produced a new epoch + new program version).
   * Re-runs the full pipeline; returns the outcome and records the resolution
   * when the accrual finally happens.
   */
  reprocessDeferredCap(
    deferredCapId: string,
    inputs: CampaignAntiGamingInputs,
  ): CampaignAccrualOutcome {
    const deferred = this._deferredCaps.find((record) => record.id === deferredCapId);
    if (deferred === undefined) {
      throw new UnknownCampaignRewardError('no deferred cap record under the given id', {
        deferredCapId,
      });
    }
    if (this._deferredCapResolutions.has(deferredCapId)) {
      throw new DuplicateCampaignContributionError(
        'this deferred cap record was already reprocessed',
        { deferredCapId },
      );
    }
    // The processed-set already holds the contribution id from the first
    // attempt — remove it so the reprocess is not treated as a duplicate.
    const processed = this._processed.get(deferred.campaignId);
    if (processed !== undefined) {
      processed.delete(deferred.contribution.id);
    }
    const outcome = this.processContribution(deferred.campaignId, deferred.contribution, inputs);
    if (outcome.disposition === 'ACCRUED' || outcome.disposition === 'DEFERRED') {
      this._deferredCapResolutions.set(
        deferredCapId,
        Object.freeze({
          deferredCapId,
          accrualId: outcome.accrual.id,
          at: this.deps.clock.now(),
        }),
      );
    }
    return outcome;
  }

  /**
   * Finalize one campaign reward: refuses suppressed rewards and rewards with
   * an unresolved deferral, then delegates to the participation finalizer
   * (INV-P04 PASS report + INV-P01 funded budget enforced there).
   */
  finalizeCampaignReward(
    campaignId: CampaignId,
    accrualId: RewardAccrualId,
    antiGaming: AntiGamingReport,
  ): RewardAccrual {
    this._assertCampaignReward(campaignId, accrualId);
    const suppression = this._suppressions.find(
      (record) => record.accrualId === accrualId,
    );
    if (suppression !== undefined) {
      throw new SuppressedRewardError('a suppressed reward cannot be finalized', {
        accrualId,
        suppressionId: suppression.id,
        reason: suppression.reason,
      });
    }
    const open = this._deferrals.find(
      (record) => record.accrualId === accrualId && !this._deferralResolutions.has(record.id),
    );
    if (open !== undefined) {
      throw new DeferralOpenError(
        'the reward has an unresolved anti-gaming deferral and cannot be finalized — resolve the deferral with a fresh PASS report first',
        { accrualId, deferralId: open.id, reason: open.reason },
      );
    }
    const entry = this._provenance.get(accrualId);
    const program =
      entry === undefined
        ? this._resolvePinnedProgram(this.currentEpoch(campaignId))
        : this._resolvePinnedProgramForVersion(entry.programVersion, entry.programSpecDigest);
    return finalizeReward(
      {
        ids: this.deps.ids,
        clock: this.deps.clock,
        rewards: this.deps.rewards,
        budgets: this.deps.budgets,
        obligations: this.deps.obligations,
      },
      program,
      accrualId,
      antiGaming,
    );
  }

  /**
   * Resolve one anti-gaming deferral with a fresh PASS report (append-only
   * resolution evidence). Non-PASS reports leave the deferral open.
   */
  resolveDeferral(
    campaignId: CampaignId,
    accrualId: RewardAccrualId,
    resolution: { readonly note: string; readonly evidenceRefs: readonly string[]; readonly report: AntiGamingReport },
  ): DeferralResolution {
    this._assertCampaignReward(campaignId, accrualId);
    const deferral = this._deferrals.find((record) => record.accrualId === accrualId);
    if (deferral === undefined) {
      throw new DeferralOpenError('no deferral exists for this accrual', { accrualId });
    }
    if (this._deferralResolutions.has(deferral.id)) {
      throw new DeferralOpenError('this deferral is already resolved', { deferralId: deferral.id });
    }
    if (resolution.report.verdict !== 'PASS') {
      throw new DeferralOpenError(
        'a deferral can only be resolved with a fresh PASS anti-gaming report (INV-P04)',
        { verdict: resolution.report.verdict },
      );
    }
    if (typeof resolution.note !== 'string' || resolution.note.length === 0) {
      throw new ValidationError('resolution.note must be a non-empty string');
    }
    if (!Array.isArray(resolution.evidenceRefs) || resolution.evidenceRefs.length === 0) {
      throw new ValidationError('resolution.evidenceRefs must be a non-empty array');
    }
    const resolved: DeferralResolution = Object.freeze({
      deferralId: deferral.id,
      accrualId,
      report: resolution.report,
      note: resolution.note,
      evidenceRefs: Object.freeze([...resolution.evidenceRefs]),
      at: this.deps.clock.now(),
    });
    this._deferralResolutions.set(deferral.id, resolved);
    return resolved;
  }

  /**
   * Operator emergency suppression of one campaign reward: the accrual is
   * expired through the participation machinery and an evidence-carrying
   * suppression record is appended. Never silent.
   */
  emergencySuppressReward(
    campaignId: CampaignId,
    accrualId: RewardAccrualId,
    suppression: { readonly reason: string; readonly evidenceRefs: readonly string[] },
  ): RewardSuppressionRecord {
    this._assertCampaignReward(campaignId, accrualId);
    if (typeof suppression.reason !== 'string' || suppression.reason.length === 0) {
      throw new ValidationError('suppression.reason must be a non-empty string');
    }
    if (!Array.isArray(suppression.evidenceRefs) || suppression.evidenceRefs.length === 0) {
      throw new ValidationError(
        'emergency suppression requires at least one evidence reference (never silent)',
      );
    }
    const entry = this._provenance.get(accrualId);
    const program =
      entry === undefined
        ? this._resolvePinnedProgram(this.currentEpoch(campaignId))
        : this._resolvePinnedProgramForVersion(entry.programVersion, entry.programSpecDigest);
    // EXPIRE the accrual through the participation machine — a suppressed
    // reward releases its budget commitment and never becomes final.
    expireReward(
      {
        ids: this.deps.ids,
        clock: this.deps.clock,
        rewards: this.deps.rewards,
        budgets: this.deps.budgets,
        obligations: this.deps.obligations,
      },
      program,
      accrualId,
    );
    const record: RewardSuppressionRecord = Object.freeze({
      id: this.deps.ids.mintId('supp'),
      kind: 'OPERATOR_EMERGENCY',
      campaignId,
      accrualId,
      ...(entry !== undefined ? { contributionId: entry.contributionId } : {}),
      reason: suppression.reason,
      evidenceRefs: Object.freeze([...suppression.evidenceRefs]),
      at: this.deps.clock.now(),
    });
    return this._recordSuppression(record);
  }

  /** The provenance entry of one campaign reward (queryable, W3-005 §7). */
  provenanceOf(accrualId: RewardAccrualId): CampaignProvenanceEntry | undefined {
    return this._provenance.get(accrualId);
  }

  /** All provenance entries in accrual order. */
  get provenance(): readonly CampaignProvenanceEntry[] {
    return Object.freeze([...this._provenanceOrder]);
  }

  /** All deferrals (append order). */
  get deferrals(): readonly RewardDeferralRecord[] {
    return Object.freeze([...this._deferrals]);
  }

  /** The resolution of one deferral, when resolved. */
  deferralResolution(deferralId: string): DeferralResolution | undefined {
    return this._deferralResolutions.get(deferralId);
  }

  /** All suppression records (append order). */
  get suppressions(): readonly RewardSuppressionRecord[] {
    return Object.freeze([...this._suppressions]);
  }

  /** All cap-deferred accrual records (append order). */
  get deferredCaps(): readonly DeferredCapRecord[] {
    return Object.freeze([...this._deferredCaps]);
  }

  /** The resolution of one cap deferral, when reprocessed into an accrual. */
  deferredCapResolution(deferredCapId: string): DeferredCapResolution | undefined {
    return this._deferredCapResolutions.get(deferredCapId);
  }

  /**
   * The campaign committed total: a PURE projection — the sum of accrual
   * amounts this campaign produced that are not EXPIRED or CLAWED_BACK.
   * Cap headroom is restored automatically when accruals leave the promise
   * set (expiry/suppression), mirroring the budget ledger discipline.
   */
  campaignCommitted(campaignId: CampaignId): Money {
    const cap = this.currentEpoch(campaignId).fundingCap;
    let total = 0n;
    for (const entry of this._provenanceOrder) {
      if (entry.campaignId !== campaignId) {
        continue;
      }
      const accrual = this.deps.rewards.get(entry.accrualId);
      if (accrual === undefined) {
        continue;
      }
      if (accrual.state === 'EXPIRED' || accrual.state === 'CLAWED_BACK') {
        continue;
      }
      total += accrual.amount.value;
    }
    return fromMinorUnits(cap.currency, total);
  }

  /** Rewards produced by one campaign, in accrual order. */
  campaignRewards(campaignId: CampaignId): readonly RewardAccrual[] {
    this._campaign(campaignId);
    return Object.freeze(
      this._provenanceOrder
        .filter((entry) => entry.campaignId === campaignId)
        .flatMap((entry) => {
          const accrual = this.deps.rewards.get(entry.accrualId);
          return accrual === undefined ? [] : [accrual];
        }),
    );
  }

  private _statusChange(
    campaignId: CampaignId,
    effectiveFrom: TimestampMs,
    status: CampaignEpochStatus,
  ): ParticipationCampaign {
    const campaign = this._campaign(campaignId);
    const current = this.currentEpoch(campaignId);
    if (current.status === 'CLOSED') {
      throw new CampaignEpochViolationError('a CLOSED campaign cannot change status');
    }
    if (typeof effectiveFrom !== 'bigint' || effectiveFrom <= current.effectiveFrom) {
      throw new CampaignEpochViolationError(
        'a campaign status change must open a strictly later effective epoch (INV-P07)',
        { campaignId, currentEffectiveFrom: current.effectiveFrom.toString(), proposed: effectiveFrom.toString() },
      );
    }
    const epoch: CampaignEpoch = Object.freeze({
      epoch: current.epoch + 1n,
      effectiveFrom,
      status,
      programVersion: current.programVersion,
      programSpecDigest: current.programSpecDigest,
      fundingCap: current.fundingCap,
      capPolicy: current.capPolicy,
      curve: current.curve,
      curveDigest: current.curveDigest,
      band: current.band,
      supersedesEpoch: current.epoch,
    });
    const revised: ParticipationCampaign = Object.freeze({
      ...campaign,
      epochs: Object.freeze([...campaign.epochs, epoch]),
    });
    this._campaigns.set(campaignId, revised);
    return revised;
  }

  private _campaign(campaignId: CampaignId): ParticipationCampaign {
    const campaign = this._campaigns.get(campaignId);
    if (campaign === undefined) {
      throw new UnknownCampaignError('no campaign registered under the given id', { campaignId });
    }
    return campaign;
  }

  private _epochCount(campaignId: CampaignId): number {
    return this._campaign(campaignId).epochs.length;
  }

  private _resolveProgram(ref: ProgramVersionRef): IncentiveProgramVersion {
    if (ref === null || typeof ref !== 'object') {
      throw new ValidationError('programVersion must be a ProgramVersionRef');
    }
    return this.deps.programs.version(ref.programId, ref.version);
  }

  private _resolvePinnedProgram(epoch: CampaignEpoch): IncentiveProgramVersion {
    const program = this._resolveProgram(epoch.programVersion);
    if (program.specDigest !== epoch.programSpecDigest) {
      throw new ValidationError(
        'the pinned program spec digest no longer matches the registry version — refusing to operate on a mutated program (history is immutable)',
        { programId: epoch.programVersion.programId, version: epoch.programVersion.version.toString() },
      );
    }
    return program;
  }

  private _resolvePinnedProgramForVersion(
    ref: ProgramVersionRef,
    pinnedDigest: string,
  ): IncentiveProgramVersion {
    const program = this._resolveProgram(ref);
    if (program.specDigest !== pinnedDigest) {
      throw new ValidationError('pinned program spec digest mismatch', {
        programId: ref.programId,
        version: ref.version.toString(),
      });
    }
    return program;
  }

  private _validateCap(program: IncentiveProgramVersion, fundingCap: Money): void {
    if (fundingCap === null || typeof fundingCap !== 'object' || typeof fundingCap.value !== 'bigint') {
      throw new ValidationError('fundingCap must carry exact bigint value (INV-F01)');
    }
    if (fundingCap.value < 0n) {
      throw new ValidationError('fundingCap must be non-negative');
    }
    if (fundingCap.currency !== program.budget.totalAmount.currency) {
      throw new ValidationError('fundingCap currency differs from the program budget currency', {
        cap: fundingCap.currency,
        budget: program.budget.totalAmount.currency,
      });
    }
    if (fundingCap.value > program.budget.totalAmount.value) {
      throw new ValidationError(
        'the campaign funding cap cannot exceed the program version budget total (the campaign can never promise beyond its program)',
        {
          cap: fundingCap.value.toString(),
          budget: program.budget.totalAmount.value.toString(),
        },
      );
    }
  }

  private _assertBudgetDeclared(program: IncentiveProgramVersion): void {
    try {
      this.deps.budgets.get(program.programId, program.version);
    } catch {
      throw new CampaignBudgetRequiredError(
        'the program version has no established budget state — a production campaign requires a funded reservation or an explicitly contingent budget before it can operate (INV-P01)',
        { programId: program.programId, version: program.version.toString() },
      );
    }
  }

  private _assertCampaignReward(campaignId: CampaignId, accrualId: RewardAccrualId): void {
    this._campaign(campaignId);
    const entry = this._provenance.get(accrualId);
    if (entry === undefined || entry.campaignId !== campaignId) {
      throw new UnknownCampaignRewardError('the reward accrual does not belong to this campaign', {
        campaignId,
        accrualId,
      });
    }
  }

  private _recordSuppression(record: RewardSuppressionRecord): RewardSuppressionRecord {
    this._suppressions.push(record);
    return record;
  }
}
