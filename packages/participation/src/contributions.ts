/**
 * @payswap/participation — contribution records and attribution (W3-004).
 *
 * PARTICIPATION-ENGINEERING §ContributionRecord: a contribution is evidence
 * that useful participation occurred — actor, role, behavior, affected
 * economic objects, quantity, time, quality/outcome, evidence references,
 * attribution and program version. A ContributionRecord is NOT itself a
 * reward.
 *
 * INV-P02 (attribution is deterministic and auditable): attribution is
 * computed by `attributeContribution`, a PURE function over declared rules
 * evaluated in declared order (first match wins, ties impossible by
 * construction). Every evaluation appends a full decision trace — which rule
 * fired, on what evidence — so attribution is reproducible from the evidence
 * alone: recompute over the same inputs and the identical attribution (value
 * AND trace) is returned.
 *
 * Referrals: `ReferralRegistry` records introducer↔introduced bindings from
 * evidence (one active binding per introduced actor — duplicates are
 * rejected, so introducer attribution is never ambiguous), and
 * `deriveIntroducerContribution` deterministically derives the INTRODUCER_
 * REFERRER-class contribution credited to the introducer from the introduced
 * actor's qualifying contribution.
 */

import {
  asPartyId,
  PaySwapError,
  ValidationError,
  type IdFactory,
  type Money,
  type PartyId,
  type TimestampMs,
} from '@payswap/protocol';
import { assertEvidenceReference, type EvidenceReference } from './evidence.js';
import type { ActorClass } from './goals.js';
import type { ProgramVersionRef } from './programs.js';

declare const ContributionIdBrand: unique symbol;

/** Branded id of one contribution record. */
export type ContributionId = string & { readonly [ContributionIdBrand]: 'ContributionId' };

/** Brand a validated string as a `ContributionId`. */
export function asContributionId(value: string): ContributionId {
  return brandContributionId(value);
}

function brandContributionId(value: string): ContributionId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('ContributionId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new ValidationError('ContributionId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError('ContributionId must not carry surrounding whitespace', { value });
  }
  return value as ContributionId;
}

declare const ReferralBindingIdBrand: unique symbol;

/** Branded id of one referral binding. */
export type ReferralBindingId = string & {
  readonly [ReferralBindingIdBrand]: 'ReferralBindingId';
};

/** Brand a validated string as a `ReferralBindingId`. */
export function asReferralBindingId(value: string): ReferralBindingId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('ReferralBindingId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new ValidationError('ReferralBindingId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError('ReferralBindingId must not carry surrounding whitespace', { value });
  }
  return value as ReferralBindingId;
}

/** Outcome/quality assessment of a contribution. */
export type ContributionOutcome = 'VERIFIED_COMPLETED' | 'OBSERVED' | 'REJECTED';

/** The closed set of outcomes. */
export const CONTRIBUTION_OUTCOMES: readonly ContributionOutcome[] = Object.freeze([
  'VERIFIED_COMPLETED',
  'OBSERVED',
  'REJECTED',
]);

/** Reference to an economic object a contribution affected. */
export interface EconomicObjectRef {
  readonly objectType: string;
  readonly objectId: string;
}

/**
 * Attribution kinds: direct participation evidence, an introducer binding
 * from the referral registry, or a derivation from another contribution.
 */
export type AttributionBasis = 'DIRECT_EVIDENCE' | 'REFERRAL_BINDING' | 'INTRODUCER_DERIVATION';

/** One evaluated attribution rule (audit trace line). */
export interface AttributionTraceLine {
  /** Rule that was evaluated, in declared order. */
  readonly ruleId: string;
  /** Whether this rule matched. */
  readonly matched: boolean;
  /** Human-readable audit note. */
  readonly note: string;
}

/** The deterministic, auditable attribution result (INV-P02). */
export interface Attribution {
  /** Actor the contribution is credited to. */
  readonly attributedActor: PartyId;
  readonly creditedRole: ActorClass;
  readonly basis: AttributionBasis;
  /** Evidence locators the attribution was computed from. */
  readonly evidenceRefs: readonly string[];
  /** Full ordered decision trace — reproducible from evidence. */
  readonly decisionTrace: readonly AttributionTraceLine[];
}

/** Declarative attribution rules, evaluated in declared order. */
export type AttributionRule =
  | { readonly ruleId: string; readonly kind: 'DIRECT_PARTICIPANT' }
  | {
      readonly ruleId: string;
      readonly kind: 'REFERRAL_INTRODUCER';
      /** The referral binding the introducer credit is derived from. */
      readonly binding: ReferralBinding;
    };

/** A referral binding: the introducer introduced `introduced` under `code`. */
export interface ReferralBinding {
  readonly id: ReferralBindingId;
  readonly introducer: PartyId;
  readonly introduced: PartyId;
  readonly code: string;
  readonly boundAt: TimestampMs;
  readonly evidence: readonly EvidenceReference[];
}

/** One contribution record (evidence that useful participation occurred). */
export interface ContributionRecord {
  readonly id: ContributionId;
  readonly actor: PartyId;
  readonly actorRole: ActorClass;
  /** Contribution event/behavior code (must match a program's declared events for rewards). */
  readonly behavior: string;
  readonly affectedObjects: readonly EconomicObjectRef[];
  /** Positive integer quantity of the behavior. */
  readonly quantity: bigint;
  /** Economic value carried by the contribution, when applicable. */
  readonly value?: Money;
  readonly occurredAt: TimestampMs;
  readonly outcome: ContributionOutcome;
  readonly evidence: readonly EvidenceReference[];
  readonly attribution: Attribution;
  readonly programVersion?: ProgramVersionRef;
  /** Counterparty of the underlying economic activity, when applicable. */
  readonly counterparty?: PartyId;
}

/** Unknown contribution in the ledger. */
export class UnknownContributionError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'UNKNOWN_CONTRIBUTION', category: 'NOT_FOUND', message, details });
    this.name = 'UnknownContributionError';
  }
}

/** A contribution id already exists (ids are never reused). */
export class ContributionIdConflictError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'CONTRIBUTION_ID_CONFLICT', category: 'CONFLICT', message, details });
    this.name = 'ContributionIdConflictError';
  }
}

/** A referral binding conflicts with an existing active binding. */
export class DuplicateReferralBindingError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'DUPLICATE_REFERRAL_BINDING', category: 'CONFLICT', message, details });
    this.name = 'DuplicateReferralBindingError';
  }
}

/**
 * Deterministically attribute a contribution (INV-P02): rules are evaluated
 * in declared array order — that order IS the priority — and the first
 * matching rule wins. The trace records every rule evaluated and whether it
 * matched. Pure: same inputs → identical attribution and identical trace.
 */
export function attributeContribution(input: {
  readonly actor: PartyId;
  readonly actorRole: ActorClass;
  readonly evidence: readonly EvidenceReference[];
  readonly rules: readonly AttributionRule[];
}): Attribution {
  if (typeof input.actor !== 'string' || input.actor.length === 0) {
    throw new ValidationError('attribution requires a non-empty actor PartyId');
  }
  if (!Array.isArray(input.evidence)) {
    throw new ValidationError('attribution requires an evidence array');
  }
  if (input.evidence.length === 0) {
    throw new ValidationError(
      'attribution requires at least one evidence reference — unevidenced attribution is not auditable (INV-P02)',
    );
  }
  for (const reference of input.evidence) {
    assertEvidenceReference(reference, 'evidence');
  }
  if (!Array.isArray(input.rules) || input.rules.length === 0) {
    throw new ValidationError('attribution requires at least one declared rule');
  }
  const seenRuleIds = new Set<string>();
  const trace: AttributionTraceLine[] = [];
  for (const rule of input.rules) {
    if (rule === null || typeof rule !== 'object') {
      throw new ValidationError('attribution rules must be AttributionRule objects');
    }
    if (typeof rule.ruleId !== 'string' || rule.ruleId.length === 0) {
      throw new ValidationError('attribution rule ids must be non-empty strings');
    }
    if (seenRuleIds.has(rule.ruleId)) {
      throw new ValidationError('attribution rule ids must be unique', { ruleId: rule.ruleId });
    }
    seenRuleIds.add(rule.ruleId);
    if (rule.kind === 'DIRECT_PARTICIPANT') {
      trace.push({ ruleId: rule.ruleId, matched: true, note: 'direct participation evidence matched' });
      return Object.freeze({
        attributedActor: input.actor,
        creditedRole: input.actorRole,
        basis: 'DIRECT_EVIDENCE',
        evidenceRefs: Object.freeze(input.evidence.map((reference) => reference.locator)),
        decisionTrace: Object.freeze([...trace]),
      });
    }
    if (rule.kind === 'REFERRAL_INTRODUCER') {
      const binding = rule.binding;
      if (binding === null || typeof binding !== 'object') {
        throw new ValidationError('REFERRAL_INTRODUCER rules must carry a binding');
      }
      if (binding.introduced === input.actor) {
        trace.push({
          ruleId: rule.ruleId,
          matched: true,
          note: `introducer ${binding.introducer} credited from binding ${binding.id}`,
        });
        return Object.freeze({
          attributedActor: binding.introducer,
          creditedRole: 'INTRODUCER_REFERRER',
          basis: 'REFERRAL_BINDING',
          evidenceRefs: Object.freeze([
            ...binding.evidence.map((reference: EvidenceReference) => reference.locator),
            ...input.evidence.map((reference: EvidenceReference) => reference.locator),
          ]),
          decisionTrace: Object.freeze([...trace]),
        });
      }
      trace.push({
        ruleId: rule.ruleId,
        matched: false,
        note: `binding ${binding.id} introduces ${binding.introduced}, not the contributing actor`,
      });
    }
  }
  // No rule matched: the contribution is recorded with unattributed marker —
  // deterministic and auditable (empty attribution basis never invents an actor).
  return Object.freeze({
    attributedActor: input.actor,
    creditedRole: input.actorRole,
    basis: 'DIRECT_EVIDENCE',
    evidenceRefs: Object.freeze(input.evidence.map((reference) => reference.locator)),
    decisionTrace: Object.freeze([
      ...trace,
      { ruleId: 'fallback:no_rule_matched', matched: true, note: 'no declared rule matched; direct actor retained' },
    ]),
  });
}

/**
 * Registry of referral bindings. One ACTIVE binding per introduced actor:
 * a second binding for the same introduced actor is rejected, so introducer
 * attribution is never ambiguous (deterministic resolution by construction).
 */
export class ReferralRegistry {
  private readonly _byId = new Map<ReferralBindingId, ReferralBinding>();
  private readonly _byIntroduced = new Map<PartyId, ReferralBinding>();
  private readonly _byCode = new Map<string, ReferralBinding[]>();

  /** Record one binding (evidence-backed, immutable). */
  bind(binding: ReferralBinding): ReferralBinding {
    if (binding === null || typeof binding !== 'object') {
      throw new ValidationError('binding must be a ReferralBinding');
    }
    if (typeof binding.id !== 'string' || binding.id.length === 0) {
      throw new ValidationError('binding.id must be a non-empty string');
    }
    if (this._byId.has(binding.id)) {
      throw new DuplicateReferralBindingError('referral binding id already exists', { id: binding.id });
    }
    const introducer = validatedParty(binding.introducer, 'binding.introducer');
    const introduced = validatedParty(binding.introduced, 'binding.introduced');
    if (introducer === introduced) {
      throw new ValidationError('an actor cannot refer themselves (self-referral binding rejected)');
    }
    if (typeof binding.code !== 'string' || binding.code.length === 0 || binding.code.length > 128) {
      throw new ValidationError('binding.code must be 1..128 characters');
    }
    if (typeof binding.boundAt !== 'bigint') {
      throw new ValidationError('binding.boundAt must be a bigint TimestampMs');
    }
    if (!Array.isArray(binding.evidence) || binding.evidence.length === 0) {
      throw new ValidationError('a referral binding requires at least one evidence reference');
    }
    for (const reference of binding.evidence) {
      assertEvidenceReference(reference, 'binding.evidence');
    }
    const existing = this._byIntroduced.get(introduced);
    if (existing !== undefined) {
      throw new DuplicateReferralBindingError(
        'the introduced actor already has an active referral binding',
        { existingId: existing.id, introducer: existing.introducer },
      );
    }
    const frozen: ReferralBinding = Object.freeze({
      id: binding.id,
      introducer,
      introduced,
      code: binding.code,
      boundAt: binding.boundAt,
      evidence: Object.freeze([...binding.evidence]),
    });
    this._byId.set(frozen.id, frozen);
    this._byIntroduced.set(frozen.introduced, frozen);
    const codeList = this._byCode.get(frozen.code) ?? [];
    codeList.push(frozen);
    this._byCode.set(frozen.code, codeList);
    return frozen;
  }

  /** The active binding for an introduced actor, when one exists. */
  activeBindingFor(introduced: PartyId): ReferralBinding | undefined {
    return this._byIntroduced.get(introduced);
  }

  /** Bindings under one referral code, in binding order. */
  byCode(code: string): readonly ReferralBinding[] {
    return Object.freeze([...(this._byCode.get(code) ?? [])]);
  }

  /** All bindings in binding order. */
  get all(): readonly ReferralBinding[] {
    return Object.freeze([...this._byId.values()]);
  }
}

function validatedParty(value: string, label: string): PartyId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty PartyId`, { label });
  }
  return asPartyId(value);
}

/**
 * Deterministically derive the INTRODUCER_REFERRER contribution credited to
 * the introducer from the introduced actor's qualifying contribution: the
 * derivation is a pure function of the original record plus the binding —
 * the same inputs always produce the same introducer contribution (INV-P02).
 */
export function deriveIntroducerContribution(
  original: ContributionRecord,
  binding: ReferralBinding,
  deps: { readonly ids: IdFactory },
): ContributionRecord {
  if (original === null || typeof original !== 'object') {
    throw new ValidationError('original must be a ContributionRecord');
  }
  if (binding === null || typeof binding !== 'object') {
    throw new ValidationError('binding must be a ReferralBinding');
  }
  if (original.actor !== binding.introduced) {
    throw new ValidationError(
      'the contribution actor must be the actor the binding introduced',
      { actor: original.actor, introduced: binding.introduced },
    );
  }
  const attribution: Attribution = Object.freeze({
    attributedActor: binding.introducer,
    creditedRole: 'INTRODUCER_REFERRER',
    basis: 'INTRODUCER_DERIVATION',
    evidenceRefs: Object.freeze([
      ...binding.evidence.map((reference) => reference.locator),
      ...original.attribution.evidenceRefs,
    ]),
    decisionTrace: Object.freeze([
      {
        ruleId: 'referral:derive-introducer',
        matched: true,
        note: `introducer ${binding.introducer} derived from binding ${binding.id} on contribution ${original.id}`,
      },
    ]),
  });
  return Object.freeze({
    id: asContributionId(deps.ids.mintId('contrib')),
    actor: binding.introducer,
    actorRole: 'INTRODUCER_REFERRER',
    behavior: 'REFERRAL_CREDIT',
    affectedObjects: Object.freeze([...original.affectedObjects]),
    quantity: 1n,
    occurredAt: original.occurredAt,
    outcome: original.outcome,
    evidence: Object.freeze([...binding.evidence, ...original.evidence]),
    attribution,
    ...(original.programVersion !== undefined
      ? { programVersion: original.programVersion }
      : {}),
    ...(original.counterparty !== undefined ? { counterparty: original.counterparty } : {}),
  });
}

/** Record one contribution in the append-only contribution ledger. */
export function recordContribution(
  ledger: ContributionLedger,
  record: ContributionRecord,
): ContributionRecord {
  return ledger.append(record);
}

/**
 * Append-only contribution ledger. Contribution history is immutable
 * (INV-P06: clawbacks never remove contribution history) — there is no
 * update or remove operation.
 */
export class ContributionLedger {
  private readonly _byId = new Map<ContributionId, ContributionRecord>();
  private readonly _order: ContributionRecord[] = [];

  get all(): readonly ContributionRecord[] {
    return Object.freeze([...this._order]);
  }

  get(id: ContributionId): ContributionRecord | undefined {
    return this._byId.get(id);
  }

  /** Contributions by one actor, in record order. */
  byActor(actor: PartyId): readonly ContributionRecord[] {
    return Object.freeze(this._order.filter((record) => record.actor === actor));
  }

  append(record: ContributionRecord): ContributionRecord {
    if (record === null || typeof record !== 'object') {
      throw new ValidationError('record must be a ContributionRecord');
    }
    const id = brandContributionId(record.id);
    if (this._byId.has(id)) {
      throw new ContributionIdConflictError('contribution id already exists (append-only)', { id });
    }
    validatedParty(record.actor, 'record.actor');
    if (typeof record.behavior !== 'string' || record.behavior.length === 0) {
      throw new ValidationError('record.behavior must be a non-empty string');
    }
    if (typeof record.quantity !== 'bigint' || record.quantity <= 0n) {
      throw new ValidationError('record.quantity must be a positive bigint');
    }
    if (typeof record.occurredAt !== 'bigint') {
      throw new ValidationError('record.occurredAt must be a bigint TimestampMs');
    }
    if (!CONTRIBUTION_OUTCOMES.includes(record.outcome)) {
      throw new ValidationError('record.outcome must be a known ContributionOutcome', {
        outcome: record.outcome,
      });
    }
    if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
      throw new ValidationError('a contribution requires at least one evidence reference');
    }
    for (const reference of record.evidence) {
      assertEvidenceReference(reference, 'record.evidence');
    }
    if (record.value !== undefined) {
      if (record.value === null || typeof record.value !== 'object' || typeof record.value.value !== 'bigint') {
        throw new ValidationError('record.value must carry exact bigint value (INV-F01)');
      }
      if (record.value.value <= 0n) {
        throw new ValidationError('record.value must be positive when present');
      }
    }
    if (record.attribution === null || typeof record.attribution !== 'object') {
      throw new ValidationError('record.attribution must be an Attribution');
    }
    const frozen: {
      -readonly [K in keyof ContributionRecord]: ContributionRecord[K];
    } = {
      id,
      actor: record.actor,
      actorRole: record.actorRole,
      behavior: record.behavior,
      affectedObjects: Object.freeze([...record.affectedObjects]),
      quantity: record.quantity,
      occurredAt: record.occurredAt,
      outcome: record.outcome,
      evidence: Object.freeze([...record.evidence]),
      attribution: record.attribution,
    };
    if (record.value !== undefined) frozen.value = record.value;
    if (record.programVersion !== undefined) frozen.programVersion = record.programVersion;
    if (record.counterparty !== undefined) frozen.counterparty = record.counterparty;
    const stored = Object.freeze(frozen);
    this._byId.set(stored.id, stored);
    this._order.push(stored);
    return stored;
  }
}
