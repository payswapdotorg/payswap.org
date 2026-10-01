/**
 * @payswap/payment — PaymentMethodTranslation and material-term
 * reauthorization (W1-003).
 *
 * PAYMENT-OPERATING-PLANE: `PaymentMethodTranslation` records
 *
 *   requested PaymentMethod
 *   → selected capability chain
 *   → actual rail effects
 *   → MerchantSettlementDestination result.
 *
 * The user-facing method may be "Pay with PaySwap" while the actual path is
 * mobile money → FX → bank. The translation makes that visible.
 *
 * Material-term reauthorization is STRUCTURAL: a translation whose material
 * terms (amount, currency, fees, timing, recourse, settlement destination)
 * differ from the terms the payer authorized cannot be executed —
 * `assertTranslationAuthorized` throws `TranslationReauthorizationRequiredError`
 * unless a fresh authorization covering the translated terms is presented.
 * The precondition is typed: `TranslationAuthorization` carries the exact
 * hash of the material terms it covers, and the check is equality.
 */

import { ValidationError, type Money, type TimestampMs } from '@payswap/protocol';
import {
  asPaymentMethodId,
  asRailCapabilityRef,
  type PaymentMethodId,
  type RailCapabilityRef,
} from './method.js';
import type { MerchantSettlementDestination, SettlementDestinationKind } from './acceptance.js';

declare const TranslationIdBrand: unique symbol;

/** Branded id of one payment method translation. */
export type TranslationId = string & { readonly [TranslationIdBrand]: 'TranslationId' };

declare const AuthorizationIdBrand: unique symbol;

/** Branded id of one payer authorization artifact. */
export type AuthorizationId = string & { readonly [AuthorizationIdBrand]: 'AuthorizationId' };

/**
 * One step of the selected capability chain. `capability` is an OPAQUE
 * `RailCapabilityRef` — the connector capability vocabulary belongs to the
 * capability plane (W2-003); the payment plane only records which chain was
 * selected, never re-defines what a capability is.
 */
export interface CapabilityChainStep {
  readonly order: number;
  readonly capability: RailCapabilityRef;
  /** Human-readable role, e.g. `collect`, `fx-convert`, `payout`. */
  readonly role: string;
}

/** One actual effect an executed capability step had on an external rail. */
export interface RailEffectRecord {
  readonly capability: RailCapabilityRef;
  /** External reference at the provider/rail, when known. */
  readonly externalRef?: string;
  readonly recordedAt: TimestampMs;
}

/**
 * How the merchant ultimately received (or will receive) value for this
 * translation — always the EXTERNAL destination; never PaySwap custody.
 */
export interface MerchantSettlementResult {
  readonly destinationId: string;
  readonly destinationKind: SettlementDestinationKind;
  readonly currency: string;
  readonly externalRef: string;
}

/**
 * The material terms of a payment, per PAYMENT-OPERATING-PLANE. A
 * translation that changes ANY of these relative to the authorized terms
 * requires fresh reauthorization.
 */
export interface MaterialTerms {
  readonly amount: Money;
  readonly currency: string;
  /** Total fees presented to the payer, exact. */
  readonly fees: Money;
  /** Completion deadline, in ms from initiation. */
  readonly completionMs: bigint;
  readonly recourse: string;
  readonly settlementDestinationId: string;
}

/** A payer authorization covering EXACTLY one set of material terms. */
export interface TranslationAuthorization {
  readonly id: AuthorizationId;
  readonly methodId: PaymentMethodId;
  /** Canonical hash of the material terms the payer saw and approved. */
  readonly materialTermsHash: string;
  readonly authorizedAt: TimestampMs;
  /** Authorization provenance (approval artifact reference). */
  readonly approvalArtifactRef: string;
}

/** The full translation record. */
export interface PaymentMethodTranslation {
  readonly id: TranslationId;
  readonly requestedMethod: PaymentMethodId;
  readonly selectedCapabilityChain: readonly CapabilityChainStep[];
  readonly actualRailEffects: readonly RailEffectRecord[];
  readonly merchantSettlementResult: MerchantSettlementResult;
  /** The terms this translation actually realizes. */
  readonly materialTerms: MaterialTerms;
}

/** A translation changed material terms without fresh authorization. */
export class TranslationReauthorizationRequiredError extends Error {
  constructor(
    message: string,
    readonly details: {
      readonly translationId: TranslationId;
      readonly authorizedHash: string;
      readonly translatedHash: string;
    },
  ) {
    super(message);
    this.name = 'TranslationReauthorizationRequiredError';
  }
}

/** Brand a validated string as a `TranslationId`. */
export function asTranslationId(value: string): TranslationId {
  return brandId(value, 'TranslationId');
}

/** Brand a validated string as an `AuthorizationId`. */
export function asAuthorizationId(value: string): AuthorizationId {
  return brandId(value, 'AuthorizationId');
}

function brandId<TBranded extends string>(value: string, kind: string): TBranded {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${kind} must be a non-empty string`);
  }
  if (value.length > 256) {
    throw new ValidationError(`${kind} exceeds 256 characters`);
  }
  if (value.trim() !== value) {
    throw new ValidationError(`${kind} must not carry surrounding whitespace`);
  }
  return value as TBranded;
}

/**
 * Deterministic canonical rendering of material terms. Field-by-field —
 * never key-order JSON — so two structurally equal term sets always hash
 * identically.
 */
export function canonicalMaterialTerms(terms: MaterialTerms): string {
  return (
    `materialTerms|amount:${terms.amount.currency}:${terms.amount.value}` +
    `|currency:${terms.currency}` +
    `|fees:${terms.fees.currency}:${terms.fees.value}` +
    `|completionMs:${terms.completionMs}` +
    `|recourse:${terms.recourse}` +
    `|settlementDestinationId:${terms.settlementDestinationId}`
  );
}

/** Deterministic hash of material terms (canonical rendering + FNV-1a 64). */
export function materialTermsHash(terms: MaterialTerms): string {
  const canonical = canonicalMaterialTerms(terms);
  // FNV-1a over the canonical string with 64-bit bigint arithmetic —
  // deterministic, dependency-free, never used for security.
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    hash ^= BigInt(code);
    hash *= 0x100000001b3n;
    hash &= 0xffff_ffff_ffff_ffffn;
  }
  return `mth:${hash.toString(16)}`;
}

/** Construct a validated, frozen material-terms set. */
export function defineMaterialTerms(input: {
  readonly amount: Money;
  readonly currency: string;
  readonly fees: Money;
  readonly completionMs: bigint;
  readonly recourse: string;
  readonly settlementDestinationId: string;
}): MaterialTerms {
  if (input.amount === null || typeof input.amount !== 'object' || typeof input.amount.value !== 'bigint') {
    throw new ValidationError('material terms amount must be exact Money');
  }
  if (input.fees === null || typeof input.fees !== 'object' || typeof input.fees.value !== 'bigint') {
    throw new ValidationError('material terms fees must be exact Money');
  }
  if (typeof input.currency !== 'string' || input.currency.length !== 3) {
    throw new ValidationError('material terms currency must be an ISO-style code');
  }
  if (typeof input.completionMs !== 'bigint' || input.completionMs <= 0n) {
    throw new ValidationError('material terms completionMs must be a positive bigint');
  }
  if (typeof input.recourse !== 'string' || input.recourse.length === 0) {
    throw new ValidationError('material terms recourse must be a non-empty string');
  }
  if (typeof input.settlementDestinationId !== 'string' || input.settlementDestinationId.length === 0) {
    throw new ValidationError('material terms settlementDestinationId must be a non-empty string');
  }
  return Object.freeze({
    amount: input.amount,
    currency: input.currency,
    fees: input.fees,
    completionMs: input.completionMs,
    recourse: input.recourse,
    settlementDestinationId: input.settlementDestinationId,
  });
}

/** Construct a validated, frozen payer authorization. */
export function defineTranslationAuthorization(input: {
  readonly id: string;
  readonly methodId: string;
  readonly materialTermsHash: string;
  readonly authorizedAt: TimestampMs;
  readonly approvalArtifactRef: string;
}): TranslationAuthorization {
  return Object.freeze({
    id: asAuthorizationId(input.id),
    methodId: asPaymentMethodId(input.methodId),
    materialTermsHash: input.materialTermsHash,
    authorizedAt: input.authorizedAt,
    approvalArtifactRef: input.approvalArtifactRef,
  });
}

/** Construct a validated, frozen payment method translation. */
export function defineTranslation(input: {
  readonly id: string;
  readonly requestedMethod: string;
  readonly selectedCapabilityChain: readonly {
    readonly order: number;
    readonly capability: string;
    readonly role: string;
  }[];
  readonly actualRailEffects: readonly {
    readonly capability: string;
    readonly externalRef?: string;
    readonly recordedAt: TimestampMs;
  }[];
  readonly merchantSettlementResult: MerchantSettlementResult;
  readonly materialTerms: MaterialTerms;
}): PaymentMethodTranslation {
  const id = asTranslationId(input.id);
  const requestedMethod = asPaymentMethodId(input.requestedMethod);
  if (!Array.isArray(input.selectedCapabilityChain) || input.selectedCapabilityChain.length === 0) {
    throw new ValidationError('a translation requires at least one selected capability step');
  }
  const chain: CapabilityChainStep[] = [];
  let expectedOrder = 1;
  for (const step of input.selectedCapabilityChain) {
    if (step === null || typeof step !== 'object') {
      throw new ValidationError('each capability step must be a CapabilityChainStep');
    }
    if (step.order !== expectedOrder) {
      throw new ValidationError(`capability chain order must be strictly 1..n; got ${String(step.order)}`);
    }
    expectedOrder += 1;
    if (typeof step.role !== 'string' || step.role.length === 0) {
      throw new ValidationError('capability step role must be a non-empty string');
    }
    chain.push(
      Object.freeze({
        order: step.order,
        capability: asRailCapabilityRef(step.capability),
        role: step.role,
      }),
    );
  }
  const effects: RailEffectRecord[] = [];
  for (const effect of input.actualRailEffects) {
    if (effect === null || typeof effect !== 'object') {
      throw new ValidationError('each rail effect must be a RailEffectRecord');
    }
    if (typeof effect.recordedAt !== 'bigint') {
      throw new ValidationError('rail effect recordedAt must be a bigint TimestampMs');
    }
    effects.push(
      Object.freeze({
        capability: asRailCapabilityRef(effect.capability),
        ...(effect.externalRef !== undefined ? { externalRef: effect.externalRef } : {}),
        recordedAt: effect.recordedAt,
      }),
    );
  }
  const settlement = input.merchantSettlementResult;
  if (
    settlement === null ||
    typeof settlement !== 'object' ||
    typeof settlement.destinationId !== 'string' ||
    settlement.destinationId.length === 0 ||
    typeof settlement.destinationKind !== 'string' ||
    typeof settlement.currency !== 'string' ||
    typeof settlement.externalRef !== 'string'
  ) {
    throw new ValidationError('merchantSettlementResult must be a complete MerchantSettlementResult');
  }
  return Object.freeze({
    id,
    requestedMethod,
    selectedCapabilityChain: Object.freeze(chain),
    actualRailEffects: Object.freeze(effects),
    merchantSettlementResult: Object.freeze({ ...settlement }),
    materialTerms: input.materialTerms,
  });
}

/**
 * Typed precondition: assert that the authorization presented covers the
 * translation's ACTUAL material terms.
 *
 * Reauthorization is required when:
 * - the authorization's `materialTermsHash` differs from the translation's
 *   (amount, currency, fees, timing, recourse or settlement destination
 *   changed), or
 * - the authorization was granted for a different requested method.
 *
 * Throws `TranslationReauthorizationRequiredError` — material-term drift is
 * never silently absorbed.
 */
export function assertTranslationAuthorized(
  translation: PaymentMethodTranslation,
  authorization: TranslationAuthorization,
): void {
  if (translation === null || typeof translation !== 'object') {
    throw new ValidationError('translation must be a PaymentMethodTranslation');
  }
  if (authorization === null || typeof authorization !== 'object') {
    throw new ValidationError('authorization must be a TranslationAuthorization');
  }
  const translatedHash = materialTermsHash(translation.materialTerms);
  if (
    authorization.materialTermsHash !== translatedHash ||
    authorization.methodId !== translation.requestedMethod
  ) {
    throw new TranslationReauthorizationRequiredError(
      'translation changes material terms; fresh payer authorization is required',
      {
        translationId: translation.id,
        authorizedHash: authorization.materialTermsHash,
        translatedHash,
      },
    );
  }
}

/**
 * Deterministic check (non-throwing variant): does the authorization cover
 * the translation's material terms?
 */
export function translationRequiresReauthorization(
  translation: PaymentMethodTranslation,
  authorization: TranslationAuthorization,
): boolean {
  try {
    assertTranslationAuthorized(translation, authorization);
    return false;
  } catch (error) {
    if (error instanceof TranslationReauthorizationRequiredError) {
      return true;
    }
    throw error;
  }
}

/**
 * Derive the merchant settlement result from a settlement destination —
 * the destination stays EXTERNAL, the result records where value went.
 */
export function settlementResultFrom(
  destination: MerchantSettlementDestination,
): MerchantSettlementResult {
  return Object.freeze({
    destinationId: destination.id,
    destinationKind: destination.kind,
    currency: destination.currency,
    externalRef: destination.externalRef,
  });
}
