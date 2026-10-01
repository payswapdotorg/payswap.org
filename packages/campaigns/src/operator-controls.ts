/**
 * @payswap/campaigns — operator controls (W3-005).
 *
 * Operators may pause/resume a campaign, adjust its funding cap and
 * emergency-suppress rewards. Every control is:
 * - APPEND-ONLY: pause/resume/close mint new campaign epochs (never rewrite
 *   history); cap adjustments mint a new epoch referencing a NEW program
 *   version (INV-P07);
 * - EVIDENCE-RECORDED: every control action appends a `ControlActionRecord`
 *   to a digest-chained, append-only `OperatorControlLog` — an operator
 *   action without an evidence artifact cannot exist (the API refuses empty
 *   evidence);
 * - BOUNDED: emergency suppression requires a non-empty reason AND at least
 *   one evidence reference, and executes through the campaign engine's
 *   evidence-carrying suppression path (rewards are expired through the
 *   participation machinery — never silently deleted).
 */

import {
  asPartyId,
  ValidationError,
  type Money,
  type PartyId,
  type TimestampMs,
} from '@payswap/protocol';
import {
  asRewardAccrualId,
  ProgramVersionRegistry,
  type ProgramVersionRef,
} from '@payswap/participation';
import { stableDigest } from '@payswap/participation';
import {
  CampaignEngine,
  IncentiveEpochViolationError,
  type CampaignId,
  type ParticipationCampaign,
} from './campaigns.js';

/** The control actions an operator may take. */
export type ControlActionKind =
  | 'PAUSE_CAMPAIGN'
  | 'RESUME_CAMPAIGN'
  | 'CLOSE_CAMPAIGN'
  | 'ADJUST_CAP'
  | 'EMERGENCY_SUPPRESS';

/** One operator control action — an append-only, digest-chained evidence artifact. */
export interface ControlActionRecord {
  readonly id: string;
  readonly kind: ControlActionKind;
  readonly at: TimestampMs;
  /** The operator principal (auditable actor). */
  readonly operator: PartyId;
  /** The campaign the action was taken on. */
  readonly campaignId: CampaignId;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  /** Action payload (new cap, program version, target accrual …). */
  readonly payload: Readonly<Record<string, string>>;
  /** Digest of the previous record — the chain is tamper-evident. */
  readonly prevDigest: string;
  /** Deterministic digest of this record (chains to the next). */
  readonly digest: string;
}

/** A control action was malformed or refused. */
export class OperatorControlError extends ValidationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.name = 'OperatorControlError';
  }
}

/**
 * Append-only, digest-chained operator control log. Records can never be
 * mutated or removed — the chain digest makes any retroactive change
 * detectable (auditability of every control action).
 */
export class OperatorControlLog {
  private readonly _records: ControlActionRecord[] = [];

  constructor(private readonly mintId: (prefix: string) => string, private readonly now: () => TimestampMs) {}

  /** Append one control action (evidence-carrying, digest-chained). */
  append(input: {
    readonly kind: ControlActionKind;
    readonly operator: PartyId;
    readonly campaignId: CampaignId;
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
    readonly payload?: Readonly<Record<string, string>>;
  }): ControlActionRecord {
    if (typeof input.reason !== 'string' || input.reason.length === 0) {
      throw new OperatorControlError('a control action requires a non-empty reason');
    }
    if (input.reason.length > 2048) {
      throw new OperatorControlError('a control action reason exceeds 2048 characters');
    }
    if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) {
      throw new OperatorControlError(
        'a control action requires at least one evidence reference (never unaudited)',
      );
    }
    for (const reference of input.evidenceRefs) {
      if (typeof reference !== 'string' || reference.length === 0) {
        throw new OperatorControlError('evidence references must be non-empty strings');
      }
    }
    const prev = this._records[this._records.length - 1];
    const prevDigest = prev === undefined ? 'genesis' : prev.digest;
    const at = this.now();
    const id = this.mintId('ctrl');
    const payload = input.payload ?? {};
    const digest = stableDigest([
      id,
      input.kind,
      at.toString(),
      input.operator,
      input.campaignId,
      input.reason,
      input.evidenceRefs.join(','),
      ...Object.keys(payload).sort().flatMap((key) => [key, payload[key] ?? '']),
      prevDigest,
    ]);
    const record: ControlActionRecord = Object.freeze({
      id,
      kind: input.kind,
      at,
      operator: asPartyId(input.operator),
      campaignId: input.campaignId,
      reason: input.reason,
      evidenceRefs: Object.freeze([...input.evidenceRefs]),
      payload: Object.freeze({ ...payload }),
      prevDigest,
      digest,
    });
    this._records.push(record);
    return record;
  }

  /** All records in append order (frozen). */
  get all(): readonly ControlActionRecord[] {
    return Object.freeze([...this._records]);
  }

  /** Records for one campaign, in append order. */
  byCampaign(campaignId: CampaignId): readonly ControlActionRecord[] {
    return Object.freeze(this._records.filter((record) => record.campaignId === campaignId));
  }

  /**
   * Verify the digest chain end-to-end (tamper evidence): every record's
   * prevDigest must equal its predecessor's digest and every digest must
   * recompute from the record contents.
   */
  verifyChain(): boolean {
    let prevDigest = 'genesis';
    for (const record of this._records) {
      if (record.prevDigest !== prevDigest) {
        return false;
      }
      const recomputed = stableDigest([
        record.id,
        record.kind,
        record.at.toString(),
        record.operator,
        record.campaignId,
        record.reason,
        record.evidenceRefs.join(','),
        ...Object.keys(record.payload).sort().flatMap((key) => [key, record.payload[key] ?? '']),
        record.prevDigest,
      ]);
      if (recomputed !== record.digest) {
        return false;
      }
      prevDigest = record.digest;
    }
    return true;
  }
}

/** Inputs every control call requires (auditable operator action). */
export interface ControlActionInputs {
  readonly operator: string;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
}

/**
 * The operator control surface over the campaign engine: pause/resume a
 * campaign (append-only epoch transitions), adjust its funding cap (a NEW
 * program version + a NEW campaign epoch — INV-P07), and emergency-suppress
 * rewards (evidence-carrying suppression through the engine). Every action
 * appends a digest-chained evidence record to the control log.
 */
export class CampaignOperator {
  readonly log: OperatorControlLog;

  constructor(
    private readonly engine: CampaignEngine,
    private readonly programs: ProgramVersionRegistry,
    log?: OperatorControlLog,
  ) {
    this.log = log ?? new OperatorControlLog((prefix) => engine.ids.mintId(prefix), () => engine.clock.now());
  }

  /** Pause a campaign — append-only epoch transition + evidence record. */
  pauseCampaign(campaignId: CampaignId, effectiveFrom: TimestampMs, inputs: ControlActionInputs): ControlActionRecord {
    const campaign = this.engine.pauseCampaign(campaignId, effectiveFrom);
    return this.log.append({
      kind: 'PAUSE_CAMPAIGN',
      operator: asPartyId(inputs.operator),
      campaignId,
      reason: inputs.reason,
      evidenceRefs: inputs.evidenceRefs,
      payload: {
        effectiveFrom: effectiveFrom.toString(),
        epoch: this.engine.currentEpoch(campaignId).epoch.toString(),
        epochs: campaign.epochs.length.toString(),
      },
    });
  }

  /** Resume a paused campaign — append-only epoch transition + evidence record. */
  resumeCampaign(campaignId: CampaignId, effectiveFrom: TimestampMs, inputs: ControlActionInputs): ControlActionRecord {
    const campaign = this.engine.resumeCampaign(campaignId, effectiveFrom);
    return this.log.append({
      kind: 'RESUME_CAMPAIGN',
      operator: asPartyId(inputs.operator),
      campaignId,
      reason: inputs.reason,
      evidenceRefs: inputs.evidenceRefs,
      payload: {
        effectiveFrom: effectiveFrom.toString(),
        epoch: this.engine.currentEpoch(campaignId).epoch.toString(),
        epochs: campaign.epochs.length.toString(),
      },
    });
  }

  /** Close a campaign — terminal epoch + evidence record. */
  closeCampaign(campaignId: CampaignId, effectiveFrom: TimestampMs, inputs: ControlActionInputs): ControlActionRecord {
    const campaign = this.engine.closeCampaign(campaignId, effectiveFrom);
    return this.log.append({
      kind: 'CLOSE_CAMPAIGN',
      operator: asPartyId(inputs.operator),
      campaignId,
      reason: inputs.reason,
      evidenceRefs: inputs.evidenceRefs,
      payload: {
        effectiveFrom: effectiveFrom.toString(),
        epochs: campaign.epochs.length.toString(),
      },
    });
  }

  /**
   * Adjust the campaign funding cap. INV-P07: the adjustment must be a NEW
   * program version (a later version of the same program, already registered
   * in the program registry — typically minted via `reviseProgram` with the
   * new budget); the campaign then opens a new epoch referencing it. The
   * evidence record pins both the old and the new cap.
   */
  adjustCap(
    campaignId: CampaignId,
    adjustment: {
      readonly effectiveFrom: TimestampMs;
      /** A LATER version of the SAME program carrying the new budget. */
      readonly programVersion: ProgramVersionRef;
      readonly newCap: Money;
      readonly status?: 'ACTIVE' | 'PAUSED' | 'CLOSED';
    },
    inputs: ControlActionInputs,
  ): { readonly record: ControlActionRecord; readonly campaign: ParticipationCampaign } {
    const current = this.engine.currentEpoch(campaignId);
    const program = this.programs.version(adjustment.programVersion.programId, adjustment.programVersion.version);
    if (
      adjustment.programVersion.programId !== current.programVersion.programId ||
      adjustment.programVersion.version <= current.programVersion.version
    ) {
      throw new IncentiveEpochViolationError(
        'a cap adjustment must reference a LATER version of the SAME incentive program (INV-P07: incentive changes create new versions)',
        {
          current: `${current.programVersion.programId}@${current.programVersion.version}`,
          proposed: `${adjustment.programVersion.programId}@${adjustment.programVersion.version}`,
        },
      );
    }
    if (adjustment.newCap.value > program.budget.totalAmount.value) {
      throw new OperatorControlError(
        'the new campaign cap cannot exceed the new program version budget total',
        { cap: adjustment.newCap.value.toString(), budget: program.budget.totalAmount.value.toString() },
      );
    }
    if (adjustment.newCap.value === current.fundingCap.value && adjustment.newCap.currency === current.fundingCap.currency) {
      throw new OperatorControlError('the requested cap adjustment does not change the cap');
    }
    const campaign = this.engine.reviseCampaign(campaignId, {
      effectiveFrom: adjustment.effectiveFrom,
      status: adjustment.status ?? current.status,
      programVersion: adjustment.programVersion,
      fundingCap: adjustment.newCap,
      curve: current.curve,
      band: current.band,
      capPolicy: current.capPolicy,
    });
    const record = this.log.append({
      kind: 'ADJUST_CAP',
      operator: asPartyId(inputs.operator),
      campaignId,
      reason: inputs.reason,
      evidenceRefs: inputs.evidenceRefs,
      payload: {
        effectiveFrom: adjustment.effectiveFrom.toString(),
        fromProgramVersion: `${current.programVersion.programId}@${current.programVersion.version}`,
        toProgramVersion: `${adjustment.programVersion.programId}@${adjustment.programVersion.version}`,
        fromCap: `${current.fundingCap.currency}:${current.fundingCap.value}`,
        toCap: `${adjustment.newCap.currency}:${adjustment.newCap.value}`,
        epoch: this.engine.currentEpoch(campaignId).epoch.toString(),
      },
    });
    return { record, campaign };
  }

  /**
   * Emergency-suppress one campaign reward: requires a non-empty reason and
   * at least one evidence reference; expires the accrual through the engine
   * (never silent) and appends BOTH a suppression record on the engine and a
   * control action record on the log.
   */
  emergencySuppressReward(
    campaignId: CampaignId,
    accrualId: string,
    inputs: ControlActionInputs,
  ): { readonly control: ControlActionRecord; readonly suppressionId: string } {
    const suppression = this.engine.emergencySuppressReward(
      campaignId,
      asRewardAccrualId(accrualId),
      {
        reason: inputs.reason,
        evidenceRefs: inputs.evidenceRefs,
      },
    );
    const control = this.log.append({
      kind: 'EMERGENCY_SUPPRESS',
      operator: asPartyId(inputs.operator),
      campaignId,
      reason: inputs.reason,
      evidenceRefs: inputs.evidenceRefs,
      payload: {
        accrualId,
        suppressionId: suppression.id,
      },
    });
    return { control, suppressionId: suppression.id };
  }
}
