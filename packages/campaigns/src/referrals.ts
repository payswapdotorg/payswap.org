/**
 * @payswap/campaigns — referral surfaces (W3-005).
 *
 * Referral links/codes ARE contribution records: a code use is recorded as
 * the introduced actor's REFERRAL_SIGNUP contribution (attributed through
 * the participation attribution machinery with the binding evidence), and
 * the introducer credit is DERIVED as an INTRODUCER_REFERRER-class
 * contribution via participation `deriveIntroducerContribution` (pure
 * function of record + binding, INV-P02).
 *
 * Wash/collusion signals are CONSUMED from @payswap/participation
 * anti-gaming (`runAntiGamingChecks`, executed by the campaign engine with
 * the referral binding in scope):
 * - SELF_REFERRAL / SYBIL_IDENTITY_CLUSTER / WASH_TRANSACTION_PATTERN are
 *   BLOCK verdicts → the referral reward is SUPPRESSED with an
 *   evidence-carrying suppression record (never silently dropped);
 * - VELOCITY_LIMIT_EXCEEDED / COUNTERPARTY_DIVERSITY_BELOW_MIN /
 *   RAW_ARTIFICIAL_ACTIVITY are FLAG verdicts → the referral reward is
 *   DEFERRED: the accrual exists but finalization is blocked until a fresh
 *   PASS report resolves the deferral.
 * Both paths have dedicated tests (W3-005 acceptance).
 */

import {
  asPartyId,
  ValidationError,
  type IdFactory,
  type PartyId,
  type TimestampMs,
} from '@payswap/protocol';
import {
  asContributionId,
  asReferralBindingId,
  attributeContribution,
  deriveIntroducerContribution,
  type AttributionRule,
  type ContributionLedger,
  type ContributionRecord,
  type EconomicObjectRef,
  type EvidenceReference,
  type ReferralBinding,
  type ReferralRegistry,
} from '@payswap/participation';
import {
  type CampaignAccrualOutcome,
  type CampaignAntiGamingInputs,
  type CampaignEngine,
  type CampaignId,
} from './campaigns.js';

/** A referral surface was used inconsistently with its registry. */
export class ReferralSurfaceError extends ValidationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.name = 'ReferralSurfaceError';
  }
}

/** The outcome of processing one referral credit. */
export interface ReferralRewardOutcome {
  /** Which referral signal disposition fired (mirrors the campaign outcome). */
  readonly disposition: CampaignAccrualOutcome['disposition'];
  /** The introducer-credit contribution record (evidence of the referral). */
  readonly introducerContribution: ContributionRecord;
  /** The underlying campaign outcome (accrual/deferral/suppression evidence). */
  readonly outcome: CampaignAccrualOutcome;
  /** The referral the credit was derived from. */
  readonly referral: {
    readonly introducer: PartyId;
    readonly introduced: PartyId;
    readonly bindingId: string;
    readonly code: string;
  };
}

/**
 * A referral surface: deterministic code minting, evidence-backed binding
 * through the participation ReferralRegistry (self-referrals and duplicate
 * bindings are rejected loudly there), and signup contribution records.
 */
export class ReferralSurface {
  constructor(
    private readonly deps: {
      readonly ids: IdFactory;
      readonly referrals: ReferralRegistry;
      readonly ledger?: ContributionLedger;
    },
  ) {}

  /** The underlying referral registry. */
  get registry(): ReferralRegistry {
    return this.deps.referrals;
  }

  /** Mint one deterministic referral code for an introducer. */
  mintCode(introducer: PartyId): string {
    const party = asPartyId(introducer);
    return `ref-${party.replace(/[^A-Za-z0-9._-]/g, '.')}-${this.deps.ids.mintId('code')}`;
  }

  /**
   * Bind an introduced actor to an introducer under a code (evidence-backed).
   * Self-referrals and second bindings for the same introduced actor are
   * rejected by the participation registry — loudly, never silently.
   */
  bind(input: {
    readonly introducer: PartyId;
    readonly introduced: PartyId;
    readonly code: string;
    readonly boundAt: TimestampMs;
    readonly evidence: readonly EvidenceReference[];
  }): ReferralBinding {
    return this.deps.referrals.bind({
      id: asReferralBindingId(this.deps.ids.mintId('rbind')),
      introducer: input.introducer,
      introduced: input.introduced,
      code: input.code,
      boundAt: input.boundAt,
      evidence: input.evidence,
    });
  }

  /**
   * Record a referral link/code USE as the introduced actor's signup
   * contribution (behavior REFERRAL_SIGNUP), attributed with the binding
   * evidence in the decision trace. Appended to the ledger when one is
   * attached to the surface.
   */
  recordSignup(
    binding: ReferralBinding,
    event: {
      readonly occurredAt: TimestampMs;
      readonly affectedObjects?: readonly EconomicObjectRef[];
      readonly outcome?: ContributionRecord['outcome'];
    },
  ): ContributionRecord {
    if (binding === null || typeof binding !== 'object') {
      throw new ReferralSurfaceError('binding must be a ReferralBinding');
    }
    if (typeof event.occurredAt !== 'bigint') {
      throw new ValidationError('signup event requires a bigint occurredAt');
    }
    const evidence: readonly EvidenceReference[] = Object.freeze([...binding.evidence]);
    const attribution = attributeContribution({
      actor: binding.introduced,
      actorRole: 'RECIPIENT_BENEFICIARY',
      evidence,
      rules: [
        {
          ruleId: `referral:signup:${binding.id}`,
          kind: 'DIRECT_PARTICIPANT',
        },
      ] satisfies readonly AttributionRule[],
    });
    const record: {
      -readonly [K in keyof ContributionRecord]: ContributionRecord[K];
    } = {
      id: asContributionId(this.deps.ids.mintId('contrib')),
      actor: binding.introduced,
      actorRole: 'RECIPIENT_BENEFICIARY',
      behavior: 'REFERRAL_SIGNUP',
      affectedObjects: Object.freeze([
        ...(event.affectedObjects ?? [{ objectType: 'referral_binding', objectId: binding.id }]),
      ]),
      quantity: 1n,
      occurredAt: event.occurredAt,
      outcome: event.outcome ?? 'OBSERVED',
      evidence,
      attribution,
    };
    const frozen = Object.freeze(record);
    if (this.deps.ledger !== undefined) {
      return this.deps.ledger.append(frozen);
    }
    return frozen;
  }
}

/**
 * Process one referral credit under a campaign: derive the introducer
 * contribution from the introduced actor's qualifying contribution, then run
 * the campaign pipeline with the referral binding in anti-gaming scope.
 * The wash/collusion signals decide the disposition:
 * - BLOCK (self-referral, Sybil cluster, wash pattern) → SUPPRESSED;
 * - FLAG (velocity, diversity, raw activity) → DEFERRED (finalization
 *   blocked until a fresh PASS report resolves the deferral);
 * - PASS → ACCRUED (subject to campaign caps, as usual).
 */
export function processReferralCredit(
  engine: CampaignEngine,
  campaignId: CampaignId,
  original: ContributionRecord,
  binding: ReferralBinding,
  inputs: Omit<CampaignAntiGamingInputs, 'referralBinding'>,
): ReferralRewardOutcome {
  if (engine === null || typeof engine !== 'object') {
    throw new ValidationError('engine must be a CampaignEngine');
  }
  if (original === null || typeof original !== 'object') {
    throw new ValidationError('original must be a ContributionRecord');
  }
  if (binding === null || typeof binding !== 'object') {
    throw new ValidationError('binding must be a ReferralBinding');
  }
  if (original.actor !== binding.introduced) {
    throw new ReferralSurfaceError(
      'a referral credit can only be derived from a contribution by the introduced actor',
      { actor: original.actor, introduced: binding.introduced },
    );
  }
  const introducerContribution = deriveIntroducerContribution(original, binding, {
    ids: engine.ids,
  });
  const outcome = engine.processContribution(campaignId, introducerContribution, {
    ...inputs,
    referralBinding: binding,
  });
  return Object.freeze({
    disposition: outcome.disposition,
    introducerContribution,
    outcome,
    referral: Object.freeze({
      introducer: binding.introducer,
      introduced: binding.introduced,
      bindingId: binding.id,
      code: binding.code,
    }),
  });
}
