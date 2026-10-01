/**
 * @payswap/protocol — temporal netting (W1-003).
 *
 * FROZEN-ARCHITECTURE §8/§9: obligation → netting set → net position →
 * settlement instruction. Netting is a STRATEGY available before final
 * route selection; it never mutates the gross obligations it consumes.
 *
 * INV-F07: netting never changes gross obligations without preserving
 * derivation. Concretely:
 * - `netPositions` is a PURE function over `(NettingSet, Obligation[])`;
 * - every `NetPosition` carries a `derivation` listing the exact obligation
 *   ids + amounts it was computed from;
 * - `canonicalNetPosition` renders a deterministic byte-identical
 *   serialization, so rebuilding from the same inputs always yields the
 *   same bytes;
 * - the caller's obligation objects are never mutated (frozen outputs,
 *   copy-in copy-out).
 *
 * Netting reduces settlement instructions: `settlementInstructions` emits
 * exactly one instruction per net position (N gross obligations between two
 * counterparties in one currency → 1 instruction, sum preserved).
 *
 * Delay (FROZEN §9) is explicit and never silent: `canDelay` returns a
 * decision object with typed rejection reasons; an obligation may be
 * delayed only while it remains PENDING, the intent deadline remains
 * satisfiable, and the policy allows the delay.
 */

import { add, fromMinorUnits, type CurrencyCode, type Money } from './money.js';
import { PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';
import { InvalidIdentifierError } from './identifiers.js';
import type { IdFactory } from './identifiers.js';
import type { ProtocolClock, TimestampMs } from './clock.js';
import type { Obligation, ObligationId, ObligationState, PartyId } from './obligation.js';

declare const NettingSetIdBrand: unique symbol;

/** Branded id of one netting set. */
export type NettingSetId = string & { readonly [NettingSetIdBrand]: 'NettingSetId' };

declare const SettlementInstructionIdBrand: unique symbol;

/** Branded id of one settlement instruction. */
export type SettlementInstructionId = string & {
  readonly [SettlementInstructionIdBrand]: 'SettlementInstructionId';
};

/** Temporal netting window `[opensAt, closesAt]` (bigint ms). */
export interface NettingWindow {
  readonly opensAt: TimestampMs;
  readonly closesAt: TimestampMs;
}

/**
 * A netting set: the declared grouping of obligations whose gross positions
 * may be netted together within `window`. `obligations` lists the member
 * obligation ids; `netPositions(set, obligations)` requires exactly that
 * membership (no missing members, no extras, no duplicates).
 */
export interface NettingSet {
  readonly id: NettingSetId;
  readonly obligations: readonly ObligationId[];
  readonly window: NettingWindow;
  readonly createdAt: TimestampMs;
}

/**
 * The gross obligation snapshot a net position was computed from.
 * INV-F07: the exact id + amount + state observed at netting time.
 */
export interface GrossObligationSnapshot {
  readonly id: ObligationId;
  readonly debtor: PartyId;
  readonly creditor: PartyId;
  readonly amount: Money;
  readonly state: ObligationState;
}

/**
 * INV-F07 derivation: the netting set identity, its window and the exact
 * ordered gross obligation snapshots the net position was computed from.
 * Rebuilding `netPositions` from the same inputs reproduces this exactly.
 */
export interface NettingDerivation {
  readonly setId: NettingSetId;
  readonly window: NettingWindow;
  readonly gross: readonly GrossObligationSnapshot[];
}

/** One net payable position between a counterparty pair, per currency. */
export interface NetPosition {
  readonly setId: NettingSetId;
  readonly debtor: PartyId;
  readonly creditor: PartyId;
  readonly netAmount: Money;
  readonly derivation: NettingDerivation;
}

/**
 * One settlement instruction: the single executable movement that replaces
 * the netted gross obligations of its net position. Content-derived id
 * `SI:<setId>:<pair>:<currency>` unless an id factory is injected.
 */
export interface SettlementInstruction {
  readonly id: SettlementInstructionId;
  readonly setId: NettingSetId;
  readonly debtor: PartyId;
  readonly creditor: PartyId;
  readonly amount: Money;
  /** INV-F07: the net position (with full gross derivation) this settles. */
  readonly fromNetPosition: NetPosition;
}

/** Policy governing whether/for how long settlement may be delayed (§9). */
export interface DelayPolicy {
  /** Master switch: is the delay/net-later strategy permitted at all? */
  readonly delayAllowed: boolean;
  /** Maximum delay duration in milliseconds (bigint). */
  readonly maxDelayMs: bigint;
  /**
   * Must the delay be backed by an explicit instrument (credit exposure or
   * reserved liquidity)? When true, `canDelay` reports the required backing
   * kind so the caller can never silently borrow (INV-F08).
   */
  readonly requiresExplicitBacking: boolean;
}

/** Typed reason an obligation may not be delayed. */
export type DelayRejectionReason =
  | 'OBLIGATION_NOT_PENDING'
  | 'POLICY_FORBIDS_DELAY'
  | 'WINDOW_ALREADY_CLOSED'
  | 'INTENT_DEADLINE_WOULD_BE_BREACHED'
  | 'EXCEEDS_MAX_DELAY';

/** The explicit delay decision (never silent). */
export interface DelayDecision {
  readonly obligationId: ObligationId;
  readonly canDelay: boolean;
  /** Empty when allowed; every rejection reason is listed. */
  readonly reasons: readonly DelayRejectionReason[];
  /** Proposed settle time when delay is allowed (the window close). */
  readonly delayedUntil?: TimestampMs;
  /** Delay duration in ms when allowed. */
  readonly delayMs?: bigint;
  /** True when the policy demands explicit credit/liquidity backing. */
  readonly requiresExplicitBacking: boolean;
}

/** An obligation id is not a member of the netting set / unknown input. */
export class NettingMembershipError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'NETTING_MEMBERSHIP_MISMATCH', category: 'VALIDATION', message, details });
  }
}

/** A netting set window or member obligation failed netting preconditions. */
export class NettingWindowError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'NETTING_WINDOW_INVALID', category: 'VALIDATION', message, details });
  }
}

const MAX_ID_LENGTH = 256;
const PAIR_SEPARATOR = '>';

/** Brand a validated string as a `NettingSetId`. */
export function asNettingSetId(value: string): NettingSetId {
  return brandSimpleId(value, 'NettingSetId');
}

/** Brand a validated string as a `SettlementInstructionId`. */
export function asSettlementInstructionId(value: string): SettlementInstructionId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError('SettlementInstructionId must be a non-empty string', { value });
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new InvalidIdentifierError(`SettlementInstructionId exceeds ${MAX_ID_LENGTH} characters`, {
      value,
    });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError('SettlementInstructionId must not carry surrounding whitespace', {
      value,
    });
  }
  return value as SettlementInstructionId;
}

function brandSimpleId<TBranded extends string>(value: string, kind: string): TBranded {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError(`${kind} must be a non-empty string`, { kind, value });
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new InvalidIdentifierError(`${kind} exceeds ${MAX_ID_LENGTH} characters`, {
      kind,
      value,
    });
  }
  if (value.includes(PAIR_SEPARATOR)) {
    throw new InvalidIdentifierError(`${kind} must not contain '${PAIR_SEPARATOR}'`, {
      kind,
      value,
    });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError(`${kind} must not carry surrounding whitespace`, {
      kind,
      value,
    });
  }
  return value as TBranded;
}

function validateNettingSet(set: NettingSet): void {
  if (set === null || typeof set !== 'object') {
    throw new ValidationError('set must be a NettingSet object');
  }
  asNettingSetId(set.id);
  if (!Array.isArray(set.obligations) || set.obligations.length === 0) {
    throw new NettingMembershipError('a netting set requires at least one obligation id', {
      setId: set.id,
    });
  }
  const seen = new Set<string>();
  for (const id of set.obligations) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ValidationError('netting set obligation ids must be non-empty strings', {
        setId: set.id,
        obligationId: id,
      });
    }
    if (seen.has(id)) {
      throw new NettingMembershipError('duplicate obligation id in netting set', {
        setId: set.id,
        obligationId: id,
      });
    }
    seen.add(id);
  }
  const window = set.window;
  if (window === null || typeof window !== 'object') {
    throw new ValidationError('set.window must be a NettingWindow');
  }
  if (typeof window.opensAt !== 'bigint' || typeof window.closesAt !== 'bigint') {
    throw new ValidationError('set.window bounds must be bigint TimestampMs');
  }
  if (window.closesAt < window.opensAt) {
    throw new NettingWindowError('netting window closes before it opens', { setId: set.id });
  }
  if (typeof set.createdAt !== 'bigint') {
    throw new ValidationError('set.createdAt must be a bigint TimestampMs');
  }
}

/**
 * Deterministically net the obligations of one set.
 *
 * Grouping: unordered (debtor, creditor) pair × currency, mirroring
 * `deriveObligations`: for pair (low, high), a gross obligation whose debtor
 * is `low` adds to the net; whose debtor is `high` subtracts. Positive net →
 * `low` owes `high`; negative net → `high` owes `low`; zero net → the pair
 * fully offsets and no net position is produced.
 *
 * Ordering is fully deterministic: pair keys lexicographically, then
 * currencies lexicographically. `derivation.gross` carries the member
 * obligations in the set's declared member order with their exact amounts —
 * INV-F07: gross derivation is preserved verbatim and the input obligations
 * are never mutated.
 *
 * Preconditions (all-or-nothing): every member id resolves to exactly one
 * supplied obligation, no extras are supplied, every obligation is PENDING,
 * and every obligation due window closes within (or at) the netting window
 * close — an obligation that could outlive the netting window would change
 * semantics and is rejected.
 */
export function netPositions(
  set: NettingSet,
  obligations: readonly Obligation[],
): readonly NetPosition[] {
  validateNettingSet(set);
  if (!Array.isArray(obligations)) {
    throw new ValidationError('obligations must be an array of Obligation');
  }

  const byId = new Map<string, Obligation>();
  for (const [index, obligation] of obligations.entries()) {
    if (obligation === null || typeof obligation !== 'object') {
      throw new ValidationError(`obligations[${index}] must be an Obligation`);
    }
    const existing = byId.get(obligation.id);
    if (existing !== undefined) {
      throw new NettingMembershipError('duplicate obligation supplied to netting', {
        obligationId: obligation.id,
      });
    }
    byId.set(obligation.id, obligation);
  }

  const members: Obligation[] = [];
  for (const memberId of set.obligations) {
    const obligation = byId.get(memberId);
    if (obligation === undefined) {
      throw new NettingMembershipError('netting set member obligation was not supplied', {
        setId: set.id,
        obligationId: memberId,
      });
    }
    members.push(obligation);
  }
  if (byId.size !== members.length) {
    throw new NettingMembershipError(
      'obligations supplied to netting must match the netting set membership exactly',
      { setId: set.id, supplied: byId.size, members: members.length },
    );
  }
  for (const obligation of members) {
    if (obligation.state !== 'PENDING') {
      throw new NettingWindowError('only PENDING obligations may enter a netting set', {
        setId: set.id,
        obligationId: obligation.id,
        state: obligation.state,
      });
    }
    if (obligation.dueWindow.closesAt > set.window.closesAt) {
      throw new NettingWindowError(
        'obligation due window outlives the netting window',
        {
          setId: set.id,
          obligationId: obligation.id,
          obligationClosesAt: obligation.dueWindow.closesAt.toString(),
          nettingClosesAt: set.window.closesAt.toString(),
        },
      );
    }
    if (typeof obligation.amount.value !== 'bigint') {
      throw new ValidationError('obligation.amount.value must be a bigint (INV-F01)', {
        obligationId: obligation.id,
      });
    }
  }

  // INV-F07: the gross snapshot in the declared member order.
  const gross: readonly GrossObligationSnapshot[] = Object.freeze(
    members.map((obligation) =>
      Object.freeze({
        id: obligation.id,
        debtor: obligation.debtor,
        creditor: obligation.creditor,
        amount: obligation.amount,
        state: obligation.state,
      }),
    ),
  );
  const derivation: NettingDerivation = Object.freeze({
    setId: set.id,
    window: Object.freeze({ opensAt: set.window.opensAt, closesAt: set.window.closesAt }),
    gross,
  });

  interface PairGroup {
    readonly low: PartyId;
    readonly high: PartyId;
    readonly perCurrency: Map<CurrencyCode, bigint>;
  }
  const groups = new Map<string, PairGroup>();
  for (const obligation of members) {
    const low = obligation.debtor < obligation.creditor ? obligation.debtor : obligation.creditor;
    const high = obligation.debtor < obligation.creditor ? obligation.creditor : obligation.debtor;
    const key = `${low}${PAIR_SEPARATOR}${high}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { low, high, perCurrency: new Map<CurrencyCode, bigint>() };
      groups.set(key, group);
    }
    const sign = obligation.debtor === low ? 1n : -1n;
    const current = group.perCurrency.get(obligation.amount.currency) ?? 0n;
    group.perCurrency.set(obligation.amount.currency, current + sign * obligation.amount.value);
  }

  const positions: NetPosition[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    if (group === undefined) continue;
    for (const currency of [...group.perCurrency.keys()].sort()) {
      const net = group.perCurrency.get(currency);
      if (net === undefined || net === 0n) continue;
      positions.push(
        Object.freeze({
          setId: set.id,
          debtor: net > 0n ? group.low : group.high,
          creditor: net > 0n ? group.high : group.low,
          netAmount: fromMinorUnits(currency, net > 0n ? net : -net),
          derivation,
        }),
      );
    }
  }
  return Object.freeze(positions);
}

/**
 * Deterministic canonical serialization of a net position (INV-F07).
 *
 * Field-by-field rendering — never key-insertion-order JSON — so rebuilding
 * from the same inputs yields byte-identical output. `derivation.gross` is
 * rendered in the netting set's declared member order.
 */
export function canonicalNetPosition(position: NetPosition): string {
  const gross = position.derivation.gross
    .map(
      (entry) =>
        `{id:${entry.id}|debtor:${entry.debtor}|creditor:${entry.creditor}|amount:${entry.amount.currency}:${entry.amount.value}|state:${entry.state}}`,
    )
    .join(',');
  return (
    `netPosition|setId:${position.setId}` +
    `|window:[${position.derivation.window.opensAt},${position.derivation.window.closesAt}]` +
    `|gross:[${gross}]` +
    `|debtor:${position.debtor}` +
    `|creditor:${position.creditor}` +
    `|net:${position.netAmount.currency}:${position.netAmount.value}`
  );
}

/**
 * Reduce net positions to settlement instructions: exactly one instruction
 * per net position, sum preserved (the instruction amount equals the net
 * amount, which equals the exact difference of gross flows). Ids are
 * content-derived (`SI:<setId>:<pair>:<currency>`) so replay is
 * deterministic without an id factory; an injected factory overrides.
 */
export function settlementInstructions(
  netPositionsInput: readonly NetPosition[],
  options?: { readonly ids?: IdFactory },
): readonly SettlementInstruction[] {
  if (!Array.isArray(netPositionsInput)) {
    throw new ValidationError('netPositions must be an array of NetPosition');
  }
  const instructions: SettlementInstruction[] = [];
  const minted = new Set<string>();
  for (const position of netPositionsInput) {
    if (position === null || typeof position !== 'object') {
      throw new ValidationError('each net position must be a NetPosition object');
    }
    const low = position.debtor < position.creditor ? position.debtor : position.creditor;
    const high = position.debtor < position.creditor ? position.creditor : position.debtor;
    const id =
      options?.ids !== undefined
        ? asSettlementInstructionId(options.ids.mintId('si'))
        : asSettlementInstructionId(`SI:${position.setId}:${low}${PAIR_SEPARATOR}${high}:${position.netAmount.currency}`);
    if (minted.has(id)) {
      throw new ValidationError('settlement instruction id collision during derivation', { id });
    }
    minted.add(id);
    instructions.push(
      Object.freeze({
        id,
        setId: position.setId,
        debtor: position.debtor,
        creditor: position.creditor,
        amount: position.netAmount,
        fromNetPosition: position,
      }),
    );
  }
  return Object.freeze(instructions);
}

/**
 * Explicit delay decision for one obligation (FROZEN §9, never silent).
 *
 * Delay target is the obligation's own due-window close. Allowed only when:
 * - the obligation is still PENDING;
 * - `policy.delayAllowed` is true;
 * - the window has not already closed at `now`;
 * - settling at the window close still satisfies the intent deadline
 *   (`delayedUntil <= intentDeadline`);
 * - the delay duration `closesAt − now` is within `policy.maxDelayMs`.
 *
 * When `policy.requiresExplicitBacking` is true the decision flags it, so a
 * caller can never treat a delay as free value — backing must come from an
 * explicit `CreditExposure` or reserved liquidity (INV-F08).
 */
export function canDelay(
  obligation: Obligation,
  intentDeadline: TimestampMs,
  policy: DelayPolicy,
  clock: ProtocolClock,
): DelayDecision {
  if (obligation === null || typeof obligation !== 'object') {
    throw new ValidationError('obligation must be an Obligation object');
  }
  if (typeof intentDeadline !== 'bigint') {
    throw new ValidationError('intentDeadline must be a bigint TimestampMs');
  }
  if (policy === null || typeof policy !== 'object') {
    throw new ValidationError('policy must be a DelayPolicy object');
  }
  if (typeof policy.maxDelayMs !== 'bigint' || policy.maxDelayMs < 0n) {
    throw new ValidationError('policy.maxDelayMs must be a non-negative bigint');
  }
  const now = clock.now();

  const reasons: DelayRejectionReason[] = [];
  if (obligation.state !== 'PENDING') {
    reasons.push('OBLIGATION_NOT_PENDING');
  }
  if (!policy.delayAllowed) {
    reasons.push('POLICY_FORBIDS_DELAY');
  }
  const closesAt = obligation.dueWindow.closesAt;
  if (now >= closesAt) {
    reasons.push('WINDOW_ALREADY_CLOSED');
  }
  const delayMs = closesAt - now;
  if (closesAt > intentDeadline) {
    reasons.push('INTENT_DEADLINE_WOULD_BE_BREACHED');
  }
  if (delayMs > policy.maxDelayMs) {
    reasons.push('EXCEEDS_MAX_DELAY');
  }

  if (reasons.length > 0) {
    return Object.freeze({
      obligationId: obligation.id,
      canDelay: false,
      reasons: Object.freeze(reasons),
      requiresExplicitBacking: policy.requiresExplicitBacking,
    });
  }
  return Object.freeze({
    obligationId: obligation.id,
    canDelay: true,
    reasons: Object.freeze([]),
    delayedUntil: closesAt,
    delayMs,
    requiresExplicitBacking: policy.requiresExplicitBacking,
  });
}

/**
 * Sum of gross obligation amounts between exactly two counterparties in one
 * currency (unsigned gross flow per direction, then netted). Exposed for
 * INV-F07 audits: `grossFlow` proves the instruction preserves the exact
 * sum of the gross obligations it replaces.
 */
export function grossFlowBetween(
  obligations: readonly Obligation[],
  a: PartyId,
  b: PartyId,
  currency: CurrencyCode,
): { readonly owedByA: Money; readonly owedByB: Money; readonly net: Money } {
  if (!Array.isArray(obligations)) {
    throw new ValidationError('obligations must be an array of Obligation');
  }
  let owedByA: Money = fromMinorUnits(currency, 0n);
  let owedByB: Money = fromMinorUnits(currency, 0n);
  for (const obligation of obligations) {
    const pairInvolvesA = obligation.debtor === a || obligation.creditor === a;
    const pairInvolvesB = obligation.debtor === b || obligation.creditor === b;
    if (!pairInvolvesA || !pairInvolvesB) continue;
    if (obligation.amount.currency !== currency) continue;
    if (obligation.debtor === a) {
      owedByA = add(owedByA, obligation.amount);
    } else {
      owedByB = add(owedByB, obligation.amount);
    }
  }
  return Object.freeze({ owedByA, owedByB, net: add(owedByA, owedByB) });
}
