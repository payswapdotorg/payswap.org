/**
 * @payswap/campaigns — production attribution pipeline (W3-005).
 *
 * INV-P02 (attribution is deterministic and auditable) — enforcement side:
 * the pipeline attributes raw participation events by delegating to
 * @payswap/participation `attributeContribution` (rules evaluated in declared
 * order, first match wins, full decision trace appended per event) and then
 * mints the ContributionRecord through the injected id factory. The whole
 * pipeline is a PURE function of (events, rules, referral bindings, id
 * factory): replaying the same inputs reproduces identical records,
 * identical attribution and identical traces — proven by
 * `replayAttribution` and dedicated tests.
 *
 * Referral attribution chains: `resolveReferralChain` walks the introducer
 * graph upward from any actor (introduced → introducer → introducer's
 * introducer …) with a declared depth bound and cycle guard — deterministic
 * for any binding set. `deriveReferralChainContributions` turns a qualifying
 * contribution into the introducer-credit chain (one
 * INTRODUCER_REFERRER-class contribution per hop, derived via the
 * participation `deriveIntroducerContribution` derivation, which is itself a
 * pure function of record + binding).
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
  attributeContribution,
  deriveIntroducerContribution,
  type Attribution,
  type AttributionRule,
  type ContributionRecord,
  type EconomicObjectRef,
  type EvidenceReference,
  type ReferralBinding,
  type ReferralRegistry,
} from '@payswap/participation';

/** A raw (not yet attributed) participation event. */
export interface RawParticipationEvent {
  readonly actor: PartyId;
  readonly actorRole: ContributionRecord['actorRole'];
  readonly behavior: string;
  readonly affectedObjects: readonly EconomicObjectRef[];
  readonly quantity: bigint;
  readonly value?: ContributionRecord['value'];
  readonly occurredAt: TimestampMs;
  readonly outcome: ContributionRecord['outcome'];
  readonly evidence: readonly EvidenceReference[];
  readonly counterparty?: PartyId;
  /** Program version the event is being processed under, when known. */
  readonly programVersion?: ContributionRecord['programVersion'];
}

/** One pipeline line: the event, the attribution, the minted record. */
export interface AttributionPipelineLine {
  readonly eventId: string;
  readonly attribution: Attribution;
  readonly record: ContributionRecord;
  /**
   * The introducer-credit records derived from this event (one per referral
   * chain hop), in chain order (nearest introducer first).
   */
  readonly derivedIntroducerRecords: readonly ContributionRecord[];
}

/** The full pipeline result (deterministic for the same inputs). */
export interface AttributionPipelineResult {
  readonly lines: readonly AttributionPipelineLine[];
  /** Digest over every line — identical inputs reproduce it (INV-P02/P03). */
  readonly digest: string;
}

/** Pipeline options. */
export interface AttributionPipelineOptions {
  /**
   * Maximum referral-chain depth for introducer derivation (0 = never derive;
   * default 1 = direct introducer only). Depth bounds are deterministic
   * inputs — never ambient.
   */
  readonly maxReferralDepth?: bigint;
  /**
   * When true (default false), the derivation stops at the first chain hop
   * whose binding was recorded AFTER the contributing event (an introducer
   * cannot be credited for participation that predates the binding).
   */
  readonly requireBindingBeforeEvent?: boolean;
}

/** One hop of a resolved referral chain. */
export interface ReferralChainHop {
  /** The actor whose introducer is credited at this hop. */
  readonly introduced: PartyId;
  /** The introducer credited at this hop. */
  readonly introducer: PartyId;
  readonly bindingId: string;
  readonly code: string;
  readonly boundAt: TimestampMs;
}

/** The pipeline needs an id factory and (optionally) the referral registry. */
export interface AttributionPipelineDeps {
  readonly ids: IdFactory;
  readonly referrals?: ReferralRegistry;
}

/** Compute the deterministic digest of one pipeline result (FNV via participation). */
function lineDigest(line: AttributionPipelineLine): string {
  const parts: string[] = [
    line.eventId,
    line.record.id,
    line.attribution.attributedActor,
    line.attribution.creditedRole,
    line.attribution.basis,
    line.attribution.evidenceRefs.join(','),
  ];
  for (const trace of line.attribution.decisionTrace) {
    parts.push(`${trace.ruleId}:${trace.matched ? 1 : 0}`);
  }
  for (const derived of line.derivedIntroducerRecords) {
    parts.push(`${derived.id}>${derived.attribution.attributedActor}`);
  }
  // Stable length-prefixed join (same scheme as participation stableDigest).
  let serialized = '';
  for (const part of parts) {
    serialized += `${part.length}:${part}`;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    hash ^= code;
    hash =
      (hash + ((hash << 1) >>> 0) + ((hash << 4) >>> 0) + ((hash << 7) >>> 0) +
        ((hash << 8) >>> 0) + ((hash << 24) >>> 0)) >>>
      0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Resolve the referral chain upward from an actor: each hop credits the
 * introducer of the previous hop. Deterministic; bounded by `maxDepth`; a
 * cycle in the binding graph terminates the walk (visited-set guard). An
 * introducer is never credited twice on one chain.
 */
export function resolveReferralChain(
  referrals: ReferralRegistry,
  actor: PartyId,
  maxDepth: bigint,
): readonly ReferralChainHop[] {
  if (typeof maxDepth !== 'bigint' || maxDepth < 0n) {
    throw new ValidationError('maxDepth must be a non-negative bigint');
  }
  const hops: ReferralChainHop[] = [];
  const visited = new Set<PartyId>([actor]);
  let current: PartyId = actor;
  while (hops.length < Number(maxDepth)) {
    const binding = referrals.activeBindingFor(current);
    if (binding === undefined) {
      break;
    }
    if (visited.has(binding.introducer)) {
      // Cycle guard: a cyclic binding graph credits nobody twice.
      break;
    }
    visited.add(binding.introducer);
    hops.push({
      introduced: current,
      introducer: binding.introducer,
      bindingId: binding.id,
      code: binding.code,
      boundAt: binding.boundAt,
    });
    current = binding.introducer;
  }
  return Object.freeze(hops);
}

/**
 * Run the production attribution pipeline over raw events: attribute each
 * event through the declared rules (participation `attributeContribution` —
 * deterministic, fully traced), mint the ContributionRecord, then derive the
 * introducer-credit chain per event when a referral registry is supplied.
 * PURE over the given inputs — the same events, rules, bindings and id
 * factory sequence always produce the identical result and digest.
 */
export function runAttributionPipeline(
  events: readonly RawParticipationEvent[],
  rules: readonly AttributionRule[],
  deps: AttributionPipelineDeps,
  options?: AttributionPipelineOptions,
): AttributionPipelineResult {
  if (!Array.isArray(events)) {
    throw new ValidationError('events must be an array of RawParticipationEvent');
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new ValidationError('the attribution pipeline requires at least one declared rule');
  }
  const maxDepth = options?.maxReferralDepth ?? 0n;
  const requireBindingBeforeEvent = options?.requireBindingBeforeEvent ?? false;
  const lines: AttributionPipelineLine[] = [];
  for (const event of events) {
    if (event === null || typeof event !== 'object') {
      throw new ValidationError('events entries must be RawParticipationEvent objects');
    }
    if (typeof event.actor !== 'string' || event.actor.length === 0) {
      throw new ValidationError('event.actor must be a non-empty PartyId');
    }
    if (typeof event.behavior !== 'string' || event.behavior.length === 0) {
      throw new ValidationError('event.behavior must be a non-empty string');
    }
    if (typeof event.quantity !== 'bigint' || event.quantity <= 0n) {
      throw new ValidationError('event.quantity must be a positive bigint');
    }
    if (typeof event.occurredAt !== 'bigint') {
      throw new ValidationError('event.occurredAt must be a bigint TimestampMs');
    }
    if (!Array.isArray(event.evidence) || event.evidence.length === 0) {
      throw new ValidationError(
        'an attribution pipeline event requires at least one evidence reference (INV-P02)',
      );
    }
    const attribution = attributeContribution({
      actor: event.actor,
      actorRole: event.actorRole,
      evidence: event.evidence,
      rules,
    });
    const eventId = deps.ids.mintId('attr');
    const record: {
      -readonly [K in keyof ContributionRecord]: ContributionRecord[K];
    } = {
      id: asContributionId(deps.ids.mintId('contrib')),
      actor: event.actor,
      actorRole: event.actorRole,
      behavior: event.behavior,
      affectedObjects: Object.freeze([...event.affectedObjects]),
      quantity: event.quantity,
      occurredAt: event.occurredAt,
      outcome: event.outcome,
      evidence: Object.freeze([...event.evidence]),
      attribution,
    };
    if (event.value !== undefined) record.value = event.value;
    if (event.counterparty !== undefined) record.counterparty = event.counterparty;
    if (event.programVersion !== undefined) record.programVersion = event.programVersion;

    // Referral attribution chain: derive one introducer credit per hop.
    const derived: ContributionRecord[] = [];
    if (deps.referrals !== undefined && maxDepth > 0n) {
      const hops = resolveReferralChain(deps.referrals, event.actor, maxDepth);
      let source: ContributionRecord = Object.freeze(record);
      for (const hop of hops) {
        if (requireBindingBeforeEvent && hop.boundAt > event.occurredAt) {
          break;
        }
        const binding = deps.referrals.byCode(hop.code).find(
          (candidate) => candidate.id === hop.bindingId,
        );
        if (binding === undefined) {
          break;
        }
        const introducerRecord = deriveIntroducerContribution(source, binding, { ids: deps.ids });
        derived.push(introducerRecord);
        // The next hop derives from the ORIGINAL event's record chain —
        // each introducer credit is derived from the contribution one level
        // down the chain, keeping the derivation pure per hop.
        source = introducerRecord;
      }
    }
    lines.push({
      eventId,
      attribution,
      record: Object.freeze(record),
      derivedIntroducerRecords: Object.freeze(derived),
    });
  }
  let serialized = '';
  for (const line of lines) {
    serialized += `${lineDigest(line).length}:${lineDigest(line)}`;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    hash ^= code;
    hash =
      (hash + ((hash << 1) >>> 0) + ((hash << 4) >>> 0) + ((hash << 7) >>> 0) +
        ((hash << 8) >>> 0) + ((hash << 24) >>> 0)) >>>
      0;
  }
  return Object.freeze({
    lines: Object.freeze(lines),
    digest: `attr1:${hash.toString(16).padStart(8, '0')}`,
  });
}

/**
 * Reproducibility proof (INV-P02/INV-P03): replay the pipeline over the same
 * inputs and compare digests. REPLAY CONTRACT: `deps` must be built exactly
 * like the original run — a fresh id factory over a fresh identically-seeded
 * DeterministicClock, with the same call sequence — which is the standard
 * deterministic-replay discipline of this repository (ids are functions of
 * the injected clock, never of entropy). Under that contract the digest is
 * identical, and `reproducible` proves it.
 */
export function replayAttribution(
  events: readonly RawParticipationEvent[],
  rules: readonly AttributionRule[],
  deps: AttributionPipelineDeps,
  expectedDigest: string,
  options?: AttributionPipelineOptions,
): { readonly reproducible: boolean; readonly digest: string } {
  const replayed = runAttributionPipeline(events, rules, deps, options);
  return { reproducible: replayed.digest === expectedDigest, digest: replayed.digest };
}

/** Convenience: validate a party reference through the protocol vocabulary. */
export function attributionParty(value: string): PartyId {
  return asPartyId(value);
}
