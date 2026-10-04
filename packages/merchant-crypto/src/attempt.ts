/**
 * @payswap/merchant-crypto — merchant payment attempt (P4-W1-003).
 * One attempt to pay a merchant payment intent with a specific crypto asset
 * on a specific chain under an exact quote. Maps onto the canonical
 * PaymentMethodTranslation (requested STABLECOIN_CRYPTO method → selected
 * capability chain → actual rail effects → merchant settlement result) and
 * the settlement plane's SettlementAttempt/ExternalOutcome/
 * UnknownOutcomeResolution vocabulary — it never re-implements them. UNKNOWN
 * is first-class (INV-X01); leaving UNKNOWN requires a reconciliation
 * resolution with evidence (INV-X03); evidence is mandatory for definitive
 * outcomes (INV-E02).
 */

import { ValidationError, asSettlementInstructionId, defineStateMachine } from '@payswap/protocol';
import type { SettlementInstructionId, StateMachine, TimestampMs } from '@payswap/protocol';
import type { PaymentMethodTranslation } from '@payswap/payment';
import type { UnknownOutcomeResolution } from '@payswap/settlement';
import type { ChainId, CryptoAmount, CryptoAssetId } from './assets.js';
import type { CryptoQuote, QuoteId } from './quotes.js';
import { assertRouteFamilyDiscriminated } from './settlement.js';
import type { MerchantCryptoSettlementRoute } from './settlement.js';
import type { MerchantPaymentIntent, MerchantPaymentIntentId } from './intent.js';

declare const MerchantPaymentAttemptIdBrand: unique symbol;

/** Branded id of one merchant payment attempt. */
export type MerchantPaymentAttemptId = string & {
  readonly [MerchantPaymentAttemptIdBrand]: 'MerchantPaymentAttemptId';
};

/** Lifecycle states of a merchant payment attempt. */
export type MerchantPaymentAttemptState =
  | 'PENDING'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'ABANDONED';

/** Events the merchant payment attempt state machine declares. */
export type MerchantPaymentAttemptEvent =
  | 'SUBMIT'
  | 'CONFIRM_SUCCEEDED'
  | 'CONFIRM_FAILED'
  | 'REPORT_UNKNOWN'
  | 'RESOLVE_SUCCEEDED'
  | 'RESOLVE_FAILED'
  | 'ABANDON';

/** Guard context: injected clock reading plus the quote's validity boundary. */
export interface MerchantPaymentAttemptMachineContext {
  readonly now: TimestampMs;
  readonly quoteValidUntil: TimestampMs;
}

/**
 * The deterministic merchant payment attempt lifecycle machine.
 *
 * SUBMIT is guarded to `now < quoteValidUntil` — the quote must be unexpired
 * at submission. OUTCOME_UNKNOWN is a first-class NON-TERMINAL state
 * (INV-X01) whose ONLY exits are the reconciliation resolutions
 * RESOLVE_SUCCEEDED / RESOLVE_FAILED (INV-X03): no confirmation event is
 * declared from OUTCOME_UNKNOWN, so an ambiguous attempt can never be
 * silently marked FAILED. Terminal states are monotonic (INV-X04).
 */
export const merchantPaymentAttemptStateMachine: StateMachine<
  MerchantPaymentAttemptState,
  MerchantPaymentAttemptEvent,
  MerchantPaymentAttemptMachineContext
> = defineStateMachine<MerchantPaymentAttemptState, MerchantPaymentAttemptEvent, MerchantPaymentAttemptMachineContext>({
  name: 'merchant-payment-attempt',
  initial: 'PENDING',
  states: ['PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'OUTCOME_UNKNOWN', 'ABANDONED'],
  events: [
    'SUBMIT',
    'CONFIRM_SUCCEEDED',
    'CONFIRM_FAILED',
    'REPORT_UNKNOWN',
    'RESOLVE_SUCCEEDED',
    'RESOLVE_FAILED',
    'ABANDON',
  ],
  transitions: [
    {
      from: 'PENDING',
      on: 'SUBMIT',
      to: 'SUBMITTED',
      guard: (context) => context.now < context.quoteValidUntil,
      description: 'the quote must be unexpired at submission',
    },
    { from: 'PENDING', on: 'ABANDON', to: 'ABANDONED', description: 'abandoned before submission' },
    {
      from: 'SUBMITTED',
      on: 'CONFIRM_SUCCEEDED',
      to: 'CONFIRMED',
      description: 'definitive success observed with evidence (INV-E02)',
    },
    {
      from: 'SUBMITTED',
      on: 'CONFIRM_FAILED',
      to: 'FAILED',
      description: 'definitive failure observed with evidence (INV-E02)',
    },
    {
      from: 'SUBMITTED',
      on: 'REPORT_UNKNOWN',
      to: 'OUTCOME_UNKNOWN',
      description: 'the outcome is ambiguous — UNKNOWN is first-class, never FAILED (INV-X01)',
    },
    {
      from: 'OUTCOME_UNKNOWN',
      on: 'RESOLVE_SUCCEEDED',
      to: 'CONFIRMED',
      description: 'reconciliation resolved the ambiguity as success (INV-X03)',
    },
    {
      from: 'OUTCOME_UNKNOWN',
      on: 'RESOLVE_FAILED',
      to: 'FAILED',
      description: 'reconciliation resolved the ambiguity as failure (INV-X03)',
    },
  ],
  terminalStates: ['CONFIRMED', 'FAILED', 'ABANDONED'],
});

/** One attempt to pay an intent with a specific asset/chain under an exact quote. */
export interface MerchantPaymentAttempt {
  readonly id: MerchantPaymentAttemptId;
  readonly intentId: MerchantPaymentIntentId;
  readonly assetId: CryptoAssetId;
  readonly chainId: ChainId;
  readonly quoteId: QuoteId;
  /** Immutable snapshot of the quoted crypto amount (exact minor units). */
  readonly quotedCryptoAmount: CryptoAmount;
  readonly state: MerchantPaymentAttemptState;
  readonly externalTxRef?: string;
  readonly translation?: PaymentMethodTranslation;
  readonly settlementRoute?: MerchantCryptoSettlementRoute;
  /**
   * Mapping onto the protocol settlement plane: the branded id of the
   * SettlementInstruction this attempt's settlement leg executes under.
   */
  readonly settlementInstructionId?: SettlementInstructionId;
  /** Ids of the SettlementAttempt records executing the settlement leg. */
  readonly settlementAttemptIds: readonly string[];
  /** Linked evidence node ids (the evidence graph owns the nodes — INV-E02). */
  readonly evidenceIds: readonly string[];
  readonly createdAt: TimestampMs;
  readonly updatedAt: TimestampMs;
}

/** Brand a validated string as a `MerchantPaymentAttemptId`. */
export function asMerchantPaymentAttemptId(value: string): MerchantPaymentAttemptId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MerchantPaymentAttemptId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new ValidationError('MerchantPaymentAttemptId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError('MerchantPaymentAttemptId must not carry surrounding whitespace', {
      value,
    });
  }
  return value as MerchantPaymentAttemptId;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function requireAttempt(attempt: MerchantPaymentAttempt): void {
  if (attempt === null || typeof attempt !== 'object' || !isNonEmptyString(attempt.id)) {
    throw new ValidationError('attempt must be a MerchantPaymentAttempt');
  }
}

function requireNow(now: TimestampMs): void {
  if (typeof now !== 'bigint') {
    throw new ValidationError('now must be a bigint TimestampMs');
  }
}

/** INV-E02 gate: a definitive (or ambiguity-reporting) outcome needs evidence. */
function requireEvidenceIds(evidenceIds: readonly string[], message: string): void {
  if (
    !Array.isArray(evidenceIds) ||
    evidenceIds.length === 0 ||
    !evidenceIds.every((id) => isNonEmptyString(id))
  ) {
    throw new ValidationError(message);
  }
}

/** Union of evidence ids preserving order: existing first, then new. */
function mergeEvidence(existing: readonly string[], incoming: readonly string[]): string[] {
  const merged = [...existing];
  for (const id of incoming) {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  }
  return merged;
}

/**
 * Begin a merchant payment attempt: bind an intent to one exact quote (the
 * quote must be unexpired — `now < quote.validUntil` — otherwise a fresh
 * quote is required), snapshot the quoted crypto amount immutably and start
 * in the PENDING state with empty settlement/evidence linkage.
 */
export function beginMerchantPaymentAttempt(input: {
  readonly id: string;
  readonly intent: MerchantPaymentIntent;
  readonly quote: CryptoQuote;
  readonly now: TimestampMs;
}): MerchantPaymentAttempt {
  const id = asMerchantPaymentAttemptId(input.id);
  const intent = input.intent;
  if (intent === null || typeof intent !== 'object' || !isNonEmptyString(intent.id)) {
    throw new ValidationError('an attempt requires a MerchantPaymentIntent', { id });
  }
  const quote = input.quote;
  if (quote === null || typeof quote !== 'object' || !isNonEmptyString(quote.id)) {
    throw new ValidationError('an attempt requires a CryptoQuote', { id });
  }
  requireNow(input.now);
  if (input.now >= quote.validUntil) {
    throw new ValidationError('the quote is expired; a fresh quote is required', {
      id,
      quoteId: quote.id,
      validUntil: quote.validUntil,
      now: input.now,
    });
  }
  return Object.freeze({
    id,
    intentId: intent.id,
    assetId: quote.assetId,
    chainId: quote.chainId,
    quoteId: quote.id,
    quotedCryptoAmount: quote.cryptoAmount,
    state: 'PENDING',
    settlementAttemptIds: Object.freeze([]),
    evidenceIds: Object.freeze([]),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

/**
 * Submit a PENDING attempt: the quote must be the SAME quote the attempt was
 * begun under (id, asset and chain must match) and must be unexpired at
 * submission — the machine's SUBMIT guard enforces `now < quoteValidUntil`
 * (the attempt record deliberately carries no validity boundary of its own;
 * the quote is the authority). Returns a NEW frozen record; records are
 * never mutated in place.
 */
export function submitMerchantPaymentAttempt(
  attempt: MerchantPaymentAttempt,
  quote: CryptoQuote,
  now: TimestampMs,
): MerchantPaymentAttempt {
  requireAttempt(attempt);
  requireNow(now);
  if (quote === null || typeof quote !== 'object' || !isNonEmptyString(quote.id)) {
    throw new ValidationError('submitting an attempt requires a CryptoQuote', {
      attemptId: attempt.id,
    });
  }
  if (quote.id !== attempt.quoteId) {
    throw new ValidationError('the quote must be the exact quote this attempt was begun under', {
      attemptId: attempt.id,
      attemptQuoteId: attempt.quoteId,
      quoteId: quote.id,
    });
  }
  if (quote.assetId !== attempt.assetId || quote.chainId !== attempt.chainId) {
    throw new ValidationError('the quote must match the attempt asset and chain', {
      attemptId: attempt.id,
    });
  }
  const record = merchantPaymentAttemptStateMachine.transition(attempt.state, 'SUBMIT', {
    now,
    quoteValidUntil: quote.validUntil,
  });
  return Object.freeze({ ...attempt, state: record.to, updatedAt: now });
}

/**
 * Attach the external transaction reference observed after submission. Only
 * legal on a SUBMITTED attempt; `externalTxRef` must be a non-empty string
 * when present. Returns a NEW frozen record.
 */
export function attachSubmission(
  attempt: MerchantPaymentAttempt,
  input: { readonly externalTxRef?: string; readonly now: TimestampMs },
): MerchantPaymentAttempt {
  requireAttempt(attempt);
  requireNow(input.now);
  if (attempt.state !== 'SUBMITTED') {
    throw new ValidationError('an external tx ref can only be attached to a SUBMITTED attempt', {
      attemptId: attempt.id,
      state: attempt.state,
    });
  }
  const externalTxRef =
    input.externalTxRef !== undefined ? input.externalTxRef : attempt.externalTxRef;
  if (externalTxRef !== undefined && !isNonEmptyString(externalTxRef)) {
    throw new ValidationError('externalTxRef must be a non-empty string when present', {
      attemptId: attempt.id,
    });
  }
  return Object.freeze({
    ...attempt,
    ...(externalTxRef !== undefined ? { externalTxRef } : {}),
    updatedAt: input.now,
  });
}

/**
 * Record definitive SUCCESS. Only legal from SUBMITTED (the machine's
 * CONFIRM_SUCCEEDED transition enforces it); evidence ids are MANDATORY
 * (INV-E02: recording a definitive outcome requires linked evidence) and are
 * merged with the existing linkage (existing order first, then new).
 * Optionally attaches the external tx ref and the canonical
 * PaymentMethodTranslation. Returns a NEW frozen record.
 */
export function confirmMerchantPaymentAttemptSucceeded(
  attempt: MerchantPaymentAttempt,
  input: {
    readonly evidenceIds: readonly string[];
    readonly externalTxRef?: string;
    readonly translation?: PaymentMethodTranslation;
    readonly now: TimestampMs;
  },
): MerchantPaymentAttempt {
  requireAttempt(attempt);
  requireNow(input.now);
  requireEvidenceIds(
    input.evidenceIds,
    'INV-E02: recording a definitive outcome requires linked evidence',
  );
  if (input.externalTxRef !== undefined && !isNonEmptyString(input.externalTxRef)) {
    throw new ValidationError('externalTxRef must be a non-empty string when present', {
      attemptId: attempt.id,
    });
  }
  if (
    input.translation !== undefined &&
    (input.translation === null ||
      typeof input.translation !== 'object' ||
      !isNonEmptyString(input.translation.id))
  ) {
    throw new ValidationError('translation must be a PaymentMethodTranslation when present', {
      attemptId: attempt.id,
    });
  }
  const record = merchantPaymentAttemptStateMachine.transition(attempt.state, 'CONFIRM_SUCCEEDED');
  const externalTxRef =
    input.externalTxRef !== undefined ? input.externalTxRef : attempt.externalTxRef;
  const translation = input.translation !== undefined ? input.translation : attempt.translation;
  return Object.freeze({
    ...attempt,
    state: record.to,
    evidenceIds: Object.freeze(mergeEvidence(attempt.evidenceIds, input.evidenceIds)),
    ...(externalTxRef !== undefined ? { externalTxRef } : {}),
    ...(translation !== undefined ? { translation } : {}),
    updatedAt: input.now,
  });
}

/**
 * Record definitive FAILURE. Only legal from SUBMITTED; evidence ids are
 * MANDATORY (INV-E02). Returns a NEW frozen record.
 */
export function confirmMerchantPaymentAttemptFailed(
  attempt: MerchantPaymentAttempt,
  input: { readonly evidenceIds: readonly string[]; readonly now: TimestampMs },
): MerchantPaymentAttempt {
  requireAttempt(attempt);
  requireNow(input.now);
  requireEvidenceIds(
    input.evidenceIds,
    'INV-E02: recording a definitive outcome requires linked evidence',
  );
  const record = merchantPaymentAttemptStateMachine.transition(attempt.state, 'CONFIRM_FAILED');
  return Object.freeze({
    ...attempt,
    state: record.to,
    evidenceIds: Object.freeze(mergeEvidence(attempt.evidenceIds, input.evidenceIds)),
    updatedAt: input.now,
  });
}

/**
 * Report the outcome as UNKNOWN. Only legal from SUBMITTED; evidence ids
 * are MANDATORY — the ambiguity observation itself is evidence (the
 * settlement plane's law). UNKNOWN is first-class, never FAILED (INV-X01).
 * Returns a NEW frozen record.
 */
export function reportMerchantPaymentAttemptUnknown(
  attempt: MerchantPaymentAttempt,
  input: { readonly evidenceIds: readonly string[]; readonly now: TimestampMs },
): MerchantPaymentAttempt {
  requireAttempt(attempt);
  requireNow(input.now);
  requireEvidenceIds(
    input.evidenceIds,
    'INV-E02: reporting an unknown outcome requires linked evidence — the ambiguity observation itself is evidence',
  );
  const record = merchantPaymentAttemptStateMachine.transition(attempt.state, 'REPORT_UNKNOWN');
  return Object.freeze({
    ...attempt,
    state: record.to,
    evidenceIds: Object.freeze(mergeEvidence(attempt.evidenceIds, input.evidenceIds)),
    updatedAt: input.now,
  });
}

/**
 * Resolve an OUTCOME_UNKNOWN attempt through a reconciliation resolution
 * (INV-X03 — the ONLY exit from ambiguity). The resolution type is the
 * settlement plane's own `UnknownOutcomeResolution`, reused verbatim:
 * `resolvedOutcome` selects RESOLVE_SUCCEEDED / RESOLVE_FAILED; the
 * resolution's evidence ids are mandatory and merged into the attempt's
 * linkage (the resolution `caseId` is NOT evidence and is never merged).
 * Returns a NEW frozen record.
 */
export function resolveMerchantPaymentAttemptUnknown(
  attempt: MerchantPaymentAttempt,
  resolution: UnknownOutcomeResolution,
  now: TimestampMs,
): MerchantPaymentAttempt {
  requireAttempt(attempt);
  requireNow(now);
  if (
    resolution === null ||
    typeof resolution !== 'object' ||
    (resolution.resolvedOutcome !== 'CONFIRMED_SUCCEEDED' &&
      resolution.resolvedOutcome !== 'CONFIRMED_FAILED')
  ) {
    throw new ValidationError(
      'resolution must be an UnknownOutcomeResolution with a declared resolvedOutcome',
      { attemptId: attempt.id },
    );
  }
  requireEvidenceIds(
    resolution.evidenceIds,
    'a reconciliation resolution requires non-empty evidence ids (INV-X03)',
  );
  const event =
    resolution.resolvedOutcome === 'CONFIRMED_SUCCEEDED' ? 'RESOLVE_SUCCEEDED' : 'RESOLVE_FAILED';
  const record = merchantPaymentAttemptStateMachine.transition(attempt.state, event);
  return Object.freeze({
    ...attempt,
    state: record.to,
    evidenceIds: Object.freeze(mergeEvidence(attempt.evidenceIds, resolution.evidenceIds)),
    updatedAt: now,
  });
}

/**
 * Abandon a PENDING attempt (never one already submitted — the machine's
 * ABANDON transition is only declared from PENDING). Returns a NEW frozen
 * record.
 */
export function abandonMerchantPaymentAttempt(
  attempt: MerchantPaymentAttempt,
  now: TimestampMs,
): MerchantPaymentAttempt {
  requireAttempt(attempt);
  requireNow(now);
  const record = merchantPaymentAttemptStateMachine.transition(attempt.state, 'ABANDON');
  return Object.freeze({ ...attempt, state: record.to, updatedAt: now });
}

/**
 * Attach the settlement mapping onto the protocol settlement plane: the
 * branded `SettlementInstructionId` plus the ids of the
 * `SettlementAttempt` records executing this attempt's settlement leg
 * (non-empty strings). Only legal on a CONFIRMED attempt — settlement
 * linkage exists once the payment outcome is definitive. Returns a NEW
 * frozen record.
 */
export function attachSettlement(
  attempt: MerchantPaymentAttempt,
  input: {
    readonly settlementInstructionId: string;
    readonly settlementAttemptIds: readonly string[];
    readonly now: TimestampMs;
  },
): MerchantPaymentAttempt {
  requireAttempt(attempt);
  requireNow(input.now);
  if (attempt.state !== 'CONFIRMED') {
    throw new ValidationError('settlement can only be attached to a CONFIRMED attempt', {
      attemptId: attempt.id,
      state: attempt.state,
    });
  }
  const settlementInstructionId = asSettlementInstructionId(input.settlementInstructionId);
  if (
    !Array.isArray(input.settlementAttemptIds) ||
    input.settlementAttemptIds.length === 0 ||
    !input.settlementAttemptIds.every((id) => isNonEmptyString(id))
  ) {
    throw new ValidationError('settlementAttemptIds must be non-empty strings', {
      attemptId: attempt.id,
    });
  }
  return Object.freeze({
    ...attempt,
    settlementInstructionId,
    settlementAttemptIds: Object.freeze([...input.settlementAttemptIds]),
    updatedAt: input.now,
  });
}

/**
 * Attach the settlement route this attempt settles through. The route is
 * discrimination-checked FIRST (`assertRouteFamilyDiscriminated` — a
 * conflated route throws `RouteFamilyConflationError`); only legal on a
 * SUBMITTED or CONFIRMED attempt. Returns a NEW frozen record.
 */
export function attachSettlementRoute(
  attempt: MerchantPaymentAttempt,
  route: MerchantCryptoSettlementRoute,
  now: TimestampMs,
): MerchantPaymentAttempt {
  requireAttempt(attempt);
  requireNow(now);
  if (attempt.state !== 'SUBMITTED' && attempt.state !== 'CONFIRMED') {
    throw new ValidationError(
      'a settlement route can only be attached to a SUBMITTED or CONFIRMED attempt',
      { attemptId: attempt.id, state: attempt.state },
    );
  }
  assertRouteFamilyDiscriminated(route);
  return Object.freeze({ ...attempt, settlementRoute: route, updatedAt: now });
}

/**
 * Attach the canonical PaymentMethodTranslation realizing this attempt
 * (requested STABLECOIN_CRYPTO method → selected capability chain → actual
 * rail effects → merchant settlement result). Only legal on a SUBMITTED or
 * CONFIRMED attempt. Returns a NEW frozen record.
 */
export function attachTranslation(
  attempt: MerchantPaymentAttempt,
  translation: PaymentMethodTranslation,
  now: TimestampMs,
): MerchantPaymentAttempt {
  requireAttempt(attempt);
  requireNow(now);
  if (attempt.state !== 'SUBMITTED' && attempt.state !== 'CONFIRMED') {
    throw new ValidationError(
      'a translation can only be attached to a SUBMITTED or CONFIRMED attempt',
      { attemptId: attempt.id, state: attempt.state },
    );
  }
  if (
    translation === null ||
    typeof translation !== 'object' ||
    !isNonEmptyString(translation.id)
  ) {
    throw new ValidationError('translation must be a PaymentMethodTranslation', {
      attemptId: attempt.id,
    });
  }
  return Object.freeze({ ...attempt, translation, updatedAt: now });
}

/**
 * The attempt's outcome on the settlement plane's `ExternalOutcome`
 * definiteness dimension: CONFIRMED maps to SUCCEEDED, FAILED to FAILED,
 * OUTCOME_UNKNOWN to OUTCOME_UNKNOWN (strictly — an ambiguous attempt is
 * never reported as FAILED, INV-X01), and the not-yet-definitive states
 * (PENDING, SUBMITTED, ABANDONED) map to PENDING.
 */
export function attemptOutcome(
  attempt: MerchantPaymentAttempt,
): 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN' {
  requireAttempt(attempt);
  switch (attempt.state) {
    case 'CONFIRMED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'OUTCOME_UNKNOWN':
      return 'OUTCOME_UNKNOWN';
    default:
      return 'PENDING';
  }
}
