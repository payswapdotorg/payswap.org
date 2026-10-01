/**
 * @payswap/payment — payment acceptance policy and merchant settlement
 * destinations (W1-003).
 *
 * FROZEN-ARCHITECTURE §6A: `PaymentAcceptancePolicy` declares what the
 * merchant will accept and under which terms: methods/currencies, recurring
 * support, partial payments, refunds, recourse/protection, customer
 * eligibility, settlement destination, timing, remittance requirements and
 * geography.
 *
 * `MerchantSettlementDestination` describes the external destination where
 * the merchant ultimately receives value (bank account, mobile-money
 * wallet, card settlement, external PSP account, stablecoin wallet,
 * certified smart-contract account). PaySwap does NOT turn this into a
 * custodial PaySwap balance — the destination is an external location, and
 * this type is deliberately incapable of representing custody.
 *
 * `matchesAcceptance` is a deterministic matcher returning an explicit
 * decision with typed rejection reasons — acceptance is never silently
 * inferred.
 */

import { ValidationError, type CurrencyCode } from '@payswap/protocol';
import {
  asPaymentMethodId,
  type PaymentMethod,
  type PaymentMethodId,
  type PaymentMethodKind,
} from './method.js';

declare const MerchantSettlementDestinationIdBrand: unique symbol;

/** Branded id of one merchant settlement destination. */
export type MerchantSettlementDestinationId = string & {
  readonly [MerchantSettlementDestinationIdBrand]: 'MerchantSettlementDestinationId';
};

/** Where the merchant ultimately receives value (all external). */
export type SettlementDestinationKind =
  | 'BANK_ACCOUNT'
  | 'MOBILE_MONEY_WALLET'
  | 'CARD_SETTLEMENT'
  | 'EXTERNAL_PSP_ACCOUNT'
  | 'STABLECOIN_WALLET'
  | 'SMART_CONTRACT_ACCOUNT';

/** How the destination's details came to be known. */
export interface SettlementDestinationProvenance {
  /** e.g. `merchant-onboarding`, `provider-connected-account`. */
  readonly source: string;
  readonly reference: string;
  readonly recordedAt: bigint;
}

/**
 * An EXTERNAL destination/capability where the merchant receives value.
 * INV-C09-adjacent: this can never represent a PaySwap custodial balance —
 * there is no field that could hold one, and the type carries provenance
 * of where the external details were recorded.
 */
export interface MerchantSettlementDestination {
  readonly id: MerchantSettlementDestinationId;
  readonly kind: SettlementDestinationKind;
  readonly currency: CurrencyCode;
  /** Opaque external reference (account id, wallet address…). */
  readonly externalRef: string;
  readonly provenance: SettlementDestinationProvenance;
}

/** Whether/how the merchant accepts recurring charges. */
export interface RecurringAcceptance {
  readonly supported: boolean;
  /** Maximum permitted charge interval in milliseconds, when supported. */
  readonly maxIntervalMs?: bigint;
}

/** Whether partial payments are accepted, and with which minimum. */
export interface PartialPaymentAcceptance {
  readonly supported: boolean;
  /** Minimum fraction of the total, as exact basis points (bigint). */
  readonly minAmountBasisPoints?: bigint;
}

/** Whether refunds are accepted and after how long they are refused. */
export interface RefundAcceptance {
  readonly supported: boolean;
  readonly cutoffMs?: bigint;
}

/** The recourse/protection the merchant extends to payers. */
export type RecoursePolicyKind =
  | 'NONE'
  | 'CHARGEBACK_ONLY'
  | 'MERCHANT_DISPUTE_WINDOW'
  | 'ESCROW_PROTECTED';

/** A customer-eligibility criterion the matcher evaluates deterministically. */
export interface EligibilityCriterion {
  /** Machine key, e.g. `kyc-tier`, `geo`, `risk-class`. */
  readonly key: string;
  /** Required value (string-compared). */
  readonly requires: string;
}

/** Timing constraints on accepted payments. */
export interface AcceptanceTiming {
  /** Payments must complete within this many milliseconds of initiation. */
  readonly maxCompletionMs: bigint;
}

/** What remittance data the merchant requires on every payment. */
export interface RemittanceRequirements {
  readonly requiredDocumentKinds: readonly string[];
}

/** What the merchant accepts, in full (FROZEN §6A). */
export interface PaymentAcceptancePolicy {
  readonly id: string;
  readonly merchantRef: string;
  readonly methods: readonly PaymentMethodKind[];
  readonly methodCatalog: readonly PaymentMethod[];
  readonly currencies: readonly CurrencyCode[];
  readonly recurring: RecurringAcceptance;
  readonly partialPayments: PartialPaymentAcceptance;
  readonly refunds: RefundAcceptance;
  readonly recourse: RecoursePolicyKind;
  readonly customerEligibility: readonly EligibilityCriterion[];
  readonly settlementDestination: MerchantSettlementDestination;
  readonly timing: AcceptanceTiming;
  readonly remittance: RemittanceRequirements;
  /** ISO-3166-style geography where the acceptance applies. */
  readonly geography: readonly string[];
}

/** Typed reason a payment request does not match the acceptance policy. */
export type AcceptanceRejectionReason =
  | 'METHOD_KIND_NOT_ACCEPTED'
  | 'METHOD_NOT_IN_CATALOG'
  | 'CURRENCY_NOT_ACCEPTED'
  | 'RECURRING_NOT_SUPPORTED'
  | 'PARTIAL_PAYMENTS_NOT_SUPPORTED'
  | 'PARTIAL_BELOW_MINIMUM'
  | 'ELIGIBILITY_CRITERION_UNMET'
  | 'GEOGRAPHY_NOT_SERVED'
  | 'COUNTRY_NOT_LISTED';

/** A payment request evaluated against a policy. */
export interface AcceptanceRequest {
  readonly methodId: PaymentMethodId;
  readonly currency: CurrencyCode;
  readonly country?: string;
  readonly recurring?: boolean;
  readonly partial?: boolean;
  /** Partial amount in basis points of the total, when partial. */
  readonly partialBasisPoints?: bigint;
  /** Payer attributes keyed by criterion key, e.g. `{ 'kyc-tier': '2' }`. */
  readonly payerAttributes?: Readonly<Record<string, string>>;
}

/** The explicit acceptance decision (never silently inferred). */
export interface AcceptanceDecision {
  readonly accepted: boolean;
  readonly reasons: readonly AcceptanceRejectionReason[];
  readonly method: PaymentMethod | undefined;
}

const DESTINATION_KINDS: readonly SettlementDestinationKind[] = [
  'BANK_ACCOUNT',
  'MOBILE_MONEY_WALLET',
  'CARD_SETTLEMENT',
  'EXTERNAL_PSP_ACCOUNT',
  'STABLECOIN_WALLET',
  'SMART_CONTRACT_ACCOUNT',
];

const RECOURSE_KINDS: readonly RecoursePolicyKind[] = [
  'NONE',
  'CHARGEBACK_ONLY',
  'MERCHANT_DISPUTE_WINDOW',
  'ESCROW_PROTECTED',
];

/** Brand a validated string as a `MerchantSettlementDestinationId`. */
export function asMerchantSettlementDestinationId(
  value: string,
): MerchantSettlementDestinationId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MerchantSettlementDestinationId must be a non-empty string');
  }
  if (value.length > 256) {
    throw new ValidationError('MerchantSettlementDestinationId exceeds 256 characters');
  }
  return value as MerchantSettlementDestinationId;
}

/** Construct a validated, frozen external settlement destination. */
export function defineSettlementDestination(input: {
  readonly id: string;
  readonly kind: SettlementDestinationKind;
  readonly currency: CurrencyCode;
  readonly externalRef: string;
  readonly provenance: SettlementDestinationProvenance;
}): MerchantSettlementDestination {
  const id = asMerchantSettlementDestinationId(input.id);
  if (!DESTINATION_KINDS.includes(input.kind)) {
    throw new ValidationError(`settlement destination kind is not declared: ${String(input.kind)}`);
  }
  if (typeof input.currency !== 'string' || input.currency.length !== 3) {
    throw new ValidationError('settlement destination currency must be an ISO-style code');
  }
  if (typeof input.externalRef !== 'string' || input.externalRef.length === 0) {
    throw new ValidationError('settlement destination externalRef must be a non-empty string');
  }
  if (input.externalRef.length > 512) {
    throw new ValidationError('settlement destination externalRef exceeds 512 characters');
  }
  const provenance = input.provenance;
  if (
    provenance === null ||
    typeof provenance !== 'object' ||
    typeof provenance.source !== 'string' ||
    provenance.source.length === 0 ||
    typeof provenance.reference !== 'string' ||
    provenance.reference.length === 0 ||
    typeof provenance.recordedAt !== 'bigint'
  ) {
    throw new ValidationError('settlement destination provenance must carry source, reference, recordedAt');
  }
  return Object.freeze({
    id,
    kind: input.kind,
    currency: input.currency,
    externalRef: input.externalRef,
    provenance: Object.freeze({ ...provenance }),
  });
}

/** Construct a validated, frozen acceptance policy. */
export function defineAcceptancePolicy(input: {
  readonly id: string;
  readonly merchantRef: string;
  readonly methods: readonly PaymentMethodKind[];
  readonly methodCatalog: readonly PaymentMethod[];
  readonly currencies: readonly CurrencyCode[];
  readonly recurring: RecurringAcceptance;
  readonly partialPayments: PartialPaymentAcceptance;
  readonly refunds: RefundAcceptance;
  readonly recourse: RecoursePolicyKind;
  readonly customerEligibility: readonly EligibilityCriterion[];
  readonly settlementDestination: MerchantSettlementDestination;
  readonly timing: AcceptanceTiming;
  readonly remittance: RemittanceRequirements;
  readonly geography: readonly string[];
}): PaymentAcceptancePolicy {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    throw new ValidationError('acceptance policy id must be a non-empty string');
  }
  if (typeof input.merchantRef !== 'string' || input.merchantRef.length === 0) {
    throw new ValidationError('acceptance policy merchantRef must be a non-empty string');
  }
  if (!Array.isArray(input.methods) || input.methods.length === 0) {
    throw new ValidationError('an acceptance policy must declare at least one method kind');
  }
  const catalogIds = new Set<string>();
  for (const method of input.methodCatalog) {
    if (method === null || typeof method !== 'object') {
      throw new ValidationError('each catalog entry must be a PaymentMethod');
    }
    if (catalogIds.has(method.id)) {
      throw new ValidationError(`method catalog ids must not repeat: ${method.id}`);
    }
    catalogIds.add(method.id);
    if (!input.methods.includes(method.kind)) {
      throw new ValidationError(
        `method catalog contains a kind not declared as accepted: ${String(method.kind)}`,
      );
    }
  }
  if (!Array.isArray(input.currencies) || input.currencies.length === 0) {
    throw new ValidationError('an acceptance policy must declare at least one currency');
  }
  if (new Set(input.currencies).size !== input.currencies.length) {
    throw new ValidationError('accepted currencies must not repeat');
  }
  if (input.recurring === null || typeof input.recurring !== 'object') {
    throw new ValidationError('recurring acceptance must be a RecurringAcceptance');
  }
  if (
    input.recurring.supported &&
    input.recurring.maxIntervalMs !== undefined &&
    typeof input.recurring.maxIntervalMs !== 'bigint'
  ) {
    throw new ValidationError('recurring maxIntervalMs must be a bigint when present');
  }
  if (input.partialPayments === null || typeof input.partialPayments !== 'object') {
    throw new ValidationError('partial payment acceptance must be a PartialPaymentAcceptance');
  }
  if (
    input.partialPayments.supported &&
    input.partialPayments.minAmountBasisPoints !== undefined &&
    (typeof input.partialPayments.minAmountBasisPoints !== 'bigint' ||
      input.partialPayments.minAmountBasisPoints < 0n)
  ) {
    throw new ValidationError('partial payment minimum must be a non-negative bigint of basis points');
  }
  if (input.refunds === null || typeof input.refunds !== 'object') {
    throw new ValidationError('refund acceptance must be a RefundAcceptance');
  }
  if (!RECOURSE_KINDS.includes(input.recourse)) {
    throw new ValidationError(`recourse kind is not declared: ${String(input.recourse)}`);
  }
  if (!Array.isArray(input.customerEligibility)) {
    throw new ValidationError('customerEligibility must be an array');
  }
  for (const criterion of input.customerEligibility) {
    if (
      criterion === null ||
      typeof criterion !== 'object' ||
      typeof criterion.key !== 'string' ||
      criterion.key.length === 0 ||
      typeof criterion.requires !== 'string'
    ) {
      throw new ValidationError('each eligibility criterion must carry key and requires');
    }
  }
  if (
    input.settlementDestination === null ||
    typeof input.settlementDestination !== 'object'
  ) {
    throw new ValidationError('settlementDestination must be a MerchantSettlementDestination');
  }
  if (
    input.timing === null ||
    typeof input.timing !== 'object' ||
    typeof input.timing.maxCompletionMs !== 'bigint' ||
    input.timing.maxCompletionMs <= 0n
  ) {
    throw new ValidationError('timing.maxCompletionMs must be a positive bigint');
  }
  if (
    input.remittance === null ||
    typeof input.remittance !== 'object' ||
    !Array.isArray(input.remittance.requiredDocumentKinds) ||
    input.remittance.requiredDocumentKinds.some(
      (kind) => typeof kind !== 'string' || kind.length === 0,
    )
  ) {
    throw new ValidationError('remittance requirements must list non-empty document kinds');
  }
  if (!Array.isArray(input.geography) || input.geography.length === 0) {
    throw new ValidationError('an acceptance policy must declare at least one geography');
  }
  for (const country of input.geography) {
    if (typeof country !== 'string' || country.length !== 2 || country !== country.toUpperCase()) {
      throw new ValidationError(`geography entries must be uppercase ISO-style country codes: ${String(country)}`);
    }
  }
  return Object.freeze({
    id: input.id,
    merchantRef: input.merchantRef,
    methods: Object.freeze([...input.methods]),
    methodCatalog: Object.freeze([...input.methodCatalog]),
    currencies: Object.freeze([...input.currencies]),
    recurring: Object.freeze({
      supported: input.recurring.supported,
      ...(input.recurring.maxIntervalMs !== undefined
        ? { maxIntervalMs: input.recurring.maxIntervalMs }
        : {}),
    }),
    partialPayments: Object.freeze({
      supported: input.partialPayments.supported,
      ...(input.partialPayments.minAmountBasisPoints !== undefined
        ? { minAmountBasisPoints: input.partialPayments.minAmountBasisPoints }
        : {}),
    }),
    refunds: Object.freeze({
      supported: input.refunds.supported,
      ...(input.refunds.cutoffMs !== undefined ? { cutoffMs: input.refunds.cutoffMs } : {}),
    }),
    recourse: input.recourse,
    customerEligibility: Object.freeze([...input.customerEligibility]),
    settlementDestination: input.settlementDestination,
    timing: Object.freeze({ maxCompletionMs: input.timing.maxCompletionMs }),
    remittance: Object.freeze({
      requiredDocumentKinds: Object.freeze([...input.remittance.requiredDocumentKinds]),
    }),
    geography: Object.freeze([...input.geography]),
  });
}

/**
 * Deterministically evaluate a payment request against the acceptance
 * policy. Every failure mode is a typed reason on the decision; the method
 * is resolved from the catalog and returned with the decision. Acceptance
 * here is a POLICY statement — it grants no execution authority.
 */
export function matchesAcceptance(
  policy: PaymentAcceptancePolicy,
  request: AcceptanceRequest,
): AcceptanceDecision {
  if (policy === null || typeof policy !== 'object') {
    throw new ValidationError('policy must be a PaymentAcceptancePolicy');
  }
  if (request === null || typeof request !== 'object') {
    throw new ValidationError('request must be an AcceptanceRequest');
  }
  if (typeof request.methodId !== 'string' || request.methodId.length === 0) {
    throw new ValidationError('request.methodId must be a PaymentMethodId');
  }
  const reasons: AcceptanceRejectionReason[] = [];

  const method = policy.methodCatalog.find(
    (candidate) => candidate.id === asPaymentMethodId(request.methodId),
  );
  if (method === undefined) {
    reasons.push('METHOD_NOT_IN_CATALOG');
  } else {
    if (!policy.methods.includes(method.kind)) {
      reasons.push('METHOD_KIND_NOT_ACCEPTED');
    }
  }

  if (!policy.currencies.includes(request.currency)) {
    reasons.push('CURRENCY_NOT_ACCEPTED');
  }

  if (request.recurring === true && !policy.recurring.supported) {
    reasons.push('RECURRING_NOT_SUPPORTED');
  }

  if (request.partial === true) {
    if (!policy.partialPayments.supported) {
      reasons.push('PARTIAL_PAYMENTS_NOT_SUPPORTED');
    } else {
      const minimum = policy.partialPayments.minAmountBasisPoints;
      if (
        minimum !== undefined &&
        request.partialBasisPoints !== undefined &&
        request.partialBasisPoints < minimum
      ) {
        reasons.push('PARTIAL_BELOW_MINIMUM');
      }
    }
  }

  for (const criterion of policy.customerEligibility) {
    const value = request.payerAttributes?.[criterion.key];
    if (value !== undefined && value !== criterion.requires) {
      reasons.push('ELIGIBILITY_CRITERION_UNMET');
    }
  }

  if (request.country !== undefined) {
    if (typeof request.country !== 'string' || request.country.length === 0) {
      reasons.push('COUNTRY_NOT_LISTED');
    } else if (!policy.geography.includes(request.country.toUpperCase())) {
      reasons.push('GEOGRAPHY_NOT_SERVED');
    }
  }

  return Object.freeze({
    accepted: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
    method,
  });
}
