/**
 * @payswap/merchant-crypto — merchant crypto settlement route families (P4-W1-003).
 * TWO structurally distinct route families, never conflated:
 * NATIVE_STRIPE_CRYPTO (the connected Stripe account settles accepted crypto
 * itself — provider-verified only, INV-C05/INV-C09) and
 * EXTERNAL_PAYSWAP_CONVERSION (PaySwap-orchestrated conversion/off-ramp to an
 * EXTERNAL merchant destination through the capability plane). No type in
 * this module can represent a PaySwap-held or synthesized balance: a Stripe
 * settlement confirmation exists only with provider evidence
 * (SYNTHETIC_STRIPE_BALANCE otherwise).
 */

import { PaySwapError, ValidationError } from '@payswap/protocol';
import type { CurrencyCode, Money, PaySwapErrorDetails } from '@payswap/protocol';
import { asRailCapabilityRef } from '@payswap/payment';
import type { MerchantSettlementDestination, RailCapabilityRef } from '@payswap/payment';
import { assertConnectedInstance } from '@payswap/connectors';
import type { ConnectedCapabilityInstance } from '@payswap/connectors';
import { asCryptoAssetId } from './assets.js';
import type { CryptoAssetId } from './assets.js';

// ---------------------------------------------------------------------------
// Capability-id constants
// ---------------------------------------------------------------------------
// These live HERE (not in capabilities.ts) so capabilities.ts can import them
// without creating a circular settlement ↔ capabilities import edge; the ids
// are part of the settlement-route contract itself.

/** Capability id of the native Stripe crypto settlement capability. */
export const STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID =
  'cap.merchant-crypto.stripe.native-crypto-settlement' as const;

/** Capability id of the PaySwap external conversion settlement capability. */
export const PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID =
  'cap.merchant-crypto.payswap.external-conversion-settlement' as const;

// ---------------------------------------------------------------------------
// Route families
// ---------------------------------------------------------------------------

/** The two settlement route families — structurally distinct, never conflated. */
export type MerchantCryptoSettlementRouteFamily =
  | 'NATIVE_STRIPE_CRYPTO'
  | 'EXTERNAL_PAYSWAP_CONVERSION';

/** Declared route families (frozen). */
export const SETTLEMENT_ROUTE_FAMILIES: readonly MerchantCryptoSettlementRouteFamily[] =
  Object.freeze(['NATIVE_STRIPE_CRYPTO', 'EXTERNAL_PAYSWAP_CONVERSION']);

/**
 * Native Stripe crypto settlement route: the CONNECTED Stripe account settles
 * accepted crypto itself. Provider-verified ONLY — the route cannot be
 * constructed without provider evidence (INV-C05/INV-C09).
 */
export interface NativeStripeCryptoSettlementRoute {
  readonly routeFamily: 'NATIVE_STRIPE_CRYPTO';
  readonly connectedInstanceId: string;
  readonly stripeAccountRef: string;
  readonly settlementCurrency: CurrencyCode;
  readonly supportedAssets: readonly CryptoAssetId[];
  readonly providerVerified: true;
  readonly evidenceRefs: readonly string[];
  readonly capabilityId: string;
}

/**
 * PaySwap external conversion settlement route: accepted crypto is converted
 * through a capability chain and settled to an EXTERNAL merchant destination
 * (never PaySwap custody, INV-C09).
 */
export interface ExternalConversionSettlementRoute {
  readonly routeFamily: 'EXTERNAL_PAYSWAP_CONVERSION';
  readonly destination: MerchantSettlementDestination;
  readonly conversionChain: readonly RailCapabilityRef[];
  readonly capabilityId: string;
}

/** Either settlement route family — discriminated by `routeFamily`. */
export type MerchantCryptoSettlementRoute =
  | NativeStripeCryptoSettlementRoute
  | ExternalConversionSettlementRoute;

/** Raised when a value mixes fields of both route families (anti-conflation). */
export class RouteFamilyConflationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'ROUTE_FAMILY_CONFLATION', category: 'VALIDATION', message, details });
  }
}

/**
 * Raised when a Stripe balance effect would be recorded without provider
 * evidence — a synthetic balance effect (INV-C09-adjacent).
 */
export class SyntheticStripeBalanceError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'SYNTHETIC_STRIPE_BALANCE', category: 'VALIDATION', message, details });
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`, { label });
  }
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function asSettlementCurrencyCode(value: string): CurrencyCode {
  if (typeof value !== 'string' || value.length !== 3) {
    throw new ValidationError('settlement currency must be a 3-character ISO-style code', {
      currency: value,
    });
  }
  return value as CurrencyCode;
}

// ---------------------------------------------------------------------------
// Native Stripe crypto settlement route
// ---------------------------------------------------------------------------

/**
 * Construct a validated, frozen NATIVE_STRIPE_CRYPTO settlement route.
 *
 * The connected instance is asserted FIRST (a ProviderCatalogueEntry throws
 * `ConnectorAuthorityError`, INV-C05); provider evidence is checked
 * immediately after so a synthetic-balance probe fails with
 * `SyntheticStripeBalanceError` rather than a plain validation error.
 * `providerVerified` and `capabilityId` are set by this constructor — the
 * input deliberately cannot supply them.
 */
export function defineNativeStripeCryptoSettlementRoute(
  input: {
    readonly connectedInstanceId: string;
    readonly stripeAccountRef: string;
    readonly settlementCurrency: string;
    readonly supportedAssets: readonly string[];
    readonly evidenceRefs: readonly string[];
  },
  connectedInstance: ConnectedCapabilityInstance,
): NativeStripeCryptoSettlementRoute {
  // INV-C05: only a genuinely connected instance (never a catalogue entry).
  assertConnectedInstance(connectedInstance);

  // Provider evidence FIRST: a native route without evidence would be a
  // synthetic Stripe balance effect.
  if (
    !Array.isArray(input.evidenceRefs) ||
    input.evidenceRefs.length === 0 ||
    !input.evidenceRefs.every((ref) => isNonEmptyString(ref))
  ) {
    throw new SyntheticStripeBalanceError(
      'native Stripe crypto settlement requires non-empty provider evidence refs — without provider evidence the route would describe a synthetic Stripe balance',
      { connectedInstanceId: input.connectedInstanceId },
    );
  }

  if (input.connectedInstanceId !== connectedInstance.instanceId) {
    throw new ValidationError(
      'native settlement route must reference the same connected instance it is derived from',
      {
        routeConnectedInstanceId: input.connectedInstanceId,
        instanceId: connectedInstance.instanceId,
      },
    );
  }

  if (connectedInstance.authorization.status !== 'ACTIVE') {
    throw new ValidationError(
      'native Stripe crypto settlement requires an ACTIVE connected instance authorization',
      { instanceId: connectedInstance.instanceId, status: connectedInstance.authorization.status },
    );
  }

  if (connectedInstance.eligibility.eligible !== true) {
    throw new ValidationError(
      'native Stripe crypto settlement requires an eligible connected instance' +
        (connectedInstance.eligibility.reasons.length > 0
          ? ` (reasons: ${connectedInstance.eligibility.reasons.join(', ')})`
          : ''),
      {
        instanceId: connectedInstance.instanceId,
        reasons: [...connectedInstance.eligibility.reasons],
      },
    );
  }

  const settlementCurrency = asSettlementCurrencyCode(input.settlementCurrency);
  if (!connectedInstance.currencies.includes(settlementCurrency)) {
    throw new ValidationError(
      'settlement currency is not in the connected instance currency scope',
      { settlementCurrency, instanceCurrencies: [...connectedInstance.currencies] },
    );
  }

  const stripeAccountRef = requireNonEmptyString(input.stripeAccountRef, 'stripeAccountRef');
  if (stripeAccountRef.length > 256) {
    throw new ValidationError('stripeAccountRef exceeds 256 characters', { stripeAccountRef });
  }

  if (!Array.isArray(input.supportedAssets) || input.supportedAssets.length === 0) {
    throw new ValidationError(
      'native settlement route must declare at least one supported asset',
      { connectedInstanceId: input.connectedInstanceId },
    );
  }
  const supportedAssets = input.supportedAssets.map((asset) => asCryptoAssetId(asset));
  if (new Set<string>(supportedAssets).size !== supportedAssets.length) {
    throw new ValidationError('supported assets must not repeat', {
      supportedAssets: [...supportedAssets],
    });
  }

  const route: NativeStripeCryptoSettlementRoute = {
    routeFamily: 'NATIVE_STRIPE_CRYPTO',
    connectedInstanceId: input.connectedInstanceId,
    stripeAccountRef,
    settlementCurrency,
    supportedAssets: Object.freeze([...supportedAssets]),
    providerVerified: true,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
    capabilityId: STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID,
  };
  return Object.freeze(route);
}

// ---------------------------------------------------------------------------
// External PaySwap conversion settlement route
// ---------------------------------------------------------------------------

/**
 * Construct a validated, frozen EXTERNAL_PAYSWAP_CONVERSION settlement route.
 *
 * The destination is checked STRUCTURALLY only (shape + non-empty id and
 * fields): it is constructed through the canonical
 * `defineSettlementDestination` upstream in @payswap/payment, so re-deriving
 * its provenance here would duplicate the canonical validation without
 * adding authority. `capabilityId` is set by this constructor.
 */
export function defineExternalConversionSettlementRoute(input: {
  readonly destination: MerchantSettlementDestination;
  readonly conversionChain: readonly string[];
}): ExternalConversionSettlementRoute {
  const destination = input.destination;
  if (destination === null || typeof destination !== 'object') {
    throw new ValidationError(
      'external conversion settlement requires a MerchantSettlementDestination',
    );
  }
  if (!isNonEmptyString(destination.id)) {
    throw new ValidationError('settlement destination id must be a non-empty string');
  }
  if (!isNonEmptyString(destination.kind)) {
    throw new ValidationError('settlement destination kind must be declared');
  }
  if (typeof destination.currency !== 'string' || destination.currency.length !== 3) {
    throw new ValidationError('settlement destination currency must be an ISO-style code');
  }
  if (!isNonEmptyString(destination.externalRef)) {
    throw new ValidationError('settlement destination externalRef must be a non-empty string');
  }
  const provenance = destination.provenance;
  if (
    provenance === null ||
    typeof provenance !== 'object' ||
    !isNonEmptyString(provenance.source) ||
    !isNonEmptyString(provenance.reference) ||
    typeof provenance.recordedAt !== 'bigint'
  ) {
    throw new ValidationError(
      'settlement destination provenance must carry source, reference, recordedAt',
    );
  }

  if (!Array.isArray(input.conversionChain) || input.conversionChain.length === 0) {
    throw new ValidationError(
      'external conversion settlement requires a non-empty conversion capability chain',
    );
  }
  const conversionChain = input.conversionChain.map((ref) => asRailCapabilityRef(ref));
  if (new Set<string>(conversionChain).size !== conversionChain.length) {
    throw new ValidationError('conversion chain capability references must not repeat', {
      conversionChain: [...conversionChain],
    });
  }

  const route: ExternalConversionSettlementRoute = {
    routeFamily: 'EXTERNAL_PAYSWAP_CONVERSION',
    destination,
    conversionChain: Object.freeze(conversionChain),
    capabilityId: PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID,
  };
  return Object.freeze(route);
}

// ---------------------------------------------------------------------------
// Discrimination guards
// ---------------------------------------------------------------------------

/** Whether the route is a native Stripe crypto settlement route. */
export function isNativeStripeCryptoRoute(
  route: MerchantCryptoSettlementRoute,
): route is NativeStripeCryptoSettlementRoute {
  return route.routeFamily === 'NATIVE_STRIPE_CRYPTO';
}

/** Whether the route is a PaySwap external conversion settlement route. */
export function isExternalConversionRoute(
  route: MerchantCryptoSettlementRoute,
): route is ExternalConversionSettlementRoute {
  return route.routeFamily === 'EXTERNAL_PAYSWAP_CONVERSION';
}

/**
 * Runtime anti-conflation guard for routes arriving from untyped sources.
 * `routeFamily` must be one of the two declared families; a route carrying
 * fields of the OTHER family is rejected with `RouteFamilyConflationError`,
 * malformed basics with `ValidationError`.
 */
export function assertRouteFamilyDiscriminated(
  route: unknown,
): asserts route is MerchantCryptoSettlementRoute {
  if (route === null || typeof route !== 'object') {
    throw new ValidationError('settlement route must be an object');
  }
  const record = route as Readonly<Record<string, unknown>>;
  const family = record['routeFamily'];
  if (family === 'NATIVE_STRIPE_CRYPTO') {
    if ('destination' in record || 'conversionChain' in record) {
      throw new RouteFamilyConflationError(
        'a NATIVE_STRIPE_CRYPTO settlement route must not carry EXTERNAL_PAYSWAP_CONVERSION fields (destination/conversionChain)',
        { routeFamily: family },
      );
    }
    if (!isNonEmptyString(record['connectedInstanceId'])) {
      throw new ValidationError('native settlement route requires a non-empty connectedInstanceId');
    }
    if (!isNonEmptyString(record['stripeAccountRef'])) {
      throw new ValidationError('native settlement route requires a non-empty stripeAccountRef');
    }
    if (
      !Array.isArray(record['evidenceRefs']) ||
      record['evidenceRefs'].length === 0 ||
      !record['evidenceRefs'].every((ref) => isNonEmptyString(ref))
    ) {
      throw new ValidationError(
        'native settlement route requires non-empty provider evidenceRefs',
      );
    }
    if (record['providerVerified'] !== true) {
      throw new ValidationError(
        'native settlement route must be provider-verified (providerVerified === true)',
      );
    }
    return;
  }
  if (family === 'EXTERNAL_PAYSWAP_CONVERSION') {
    if (
      'connectedInstanceId' in record ||
      'stripeAccountRef' in record ||
      'settlementCurrency' in record ||
      'supportedAssets' in record ||
      'providerVerified' in record ||
      'evidenceRefs' in record
    ) {
      throw new RouteFamilyConflationError(
        'an EXTERNAL_PAYSWAP_CONVERSION settlement route must not carry NATIVE_STRIPE_CRYPTO fields (connectedInstanceId/stripeAccountRef/settlementCurrency/supportedAssets/providerVerified/evidenceRefs)',
        { routeFamily: family },
      );
    }
    const destination = record['destination'];
    if (destination === null || typeof destination !== 'object') {
      throw new ValidationError('external conversion route requires a settlement destination');
    }
    if (
      !Array.isArray(record['conversionChain']) ||
      record['conversionChain'].length === 0 ||
      !record['conversionChain'].every((ref) => isNonEmptyString(ref))
    ) {
      throw new ValidationError(
        'external conversion route requires a non-empty conversion chain',
      );
    }
    return;
  }
  throw new ValidationError(
    'settlement route routeFamily must be NATIVE_STRIPE_CRYPTO or EXTERNAL_PAYSWAP_CONVERSION',
    { routeFamily: family },
  );
}

// ---------------------------------------------------------------------------
// Stripe settlement confirmation (provider-verified only)
// ---------------------------------------------------------------------------

/**
 * A provider-verified confirmation that the connected Stripe account settled
 * accepted crypto into its own balance. `routeFamily` and
 * `confirmedByProvider` are constructor-set literals; the confirmation
 * carries the lossless provider-state envelope reference (INV-C06) and is
 * impossible without provider evidence.
 */
export interface StripeSettlementConfirmation {
  readonly confirmationId: string;
  readonly routeFamily: 'NATIVE_STRIPE_CRYPTO';
  readonly connectedInstanceId: string;
  readonly stripeBalanceTxRef: string;
  readonly amount: Money;
  readonly providerStateEnvelopeRef: string;
  readonly evidenceIds: readonly string[];
  readonly confirmedByProvider: true;
}

/**
 * Record a provider-verified Stripe settlement confirmation. Shape is
 * validated FIRST and provider evidence LAST, so a malformed confirmation is
 * a `ValidationError` while a well-formed confirmation without evidence is a
 * `SyntheticStripeBalanceError`. `routeFamily` and `confirmedByProvider` are
 * set by this constructor — the input cannot supply them.
 */
export function recordStripeSettlementConfirmation(input: {
  readonly confirmationId: string;
  readonly connectedInstanceId: string;
  readonly stripeBalanceTxRef: string;
  readonly amount: Money;
  readonly providerStateEnvelopeRef: string;
  readonly evidenceIds: readonly string[];
}): StripeSettlementConfirmation {
  const confirmationId = requireNonEmptyString(input.confirmationId, 'confirmationId');
  const connectedInstanceId = requireNonEmptyString(
    input.connectedInstanceId,
    'connectedInstanceId',
  );
  const stripeBalanceTxRef = requireNonEmptyString(
    input.stripeBalanceTxRef,
    'stripeBalanceTxRef',
  );
  const amount = input.amount;
  if (amount === null || typeof amount !== 'object' || typeof amount.value !== 'bigint') {
    throw new ValidationError('stripe settlement confirmation amount must be exact Money', {
      confirmationId,
    });
  }
  if (typeof amount.currency !== 'string' || amount.currency.length === 0) {
    throw new ValidationError('stripe settlement confirmation amount needs a currency', {
      confirmationId,
    });
  }
  if (amount.value <= 0n) {
    throw new ValidationError('stripe settlement confirmation amount must be positive', {
      confirmationId,
    });
  }
  // INV-C06: the lossless provider-state record backing this confirmation.
  const providerStateEnvelopeRef = requireNonEmptyString(
    input.providerStateEnvelopeRef,
    'providerStateEnvelopeRef',
  );
  // Evidence LAST: without provider evidence this would be a synthetic
  // Stripe balance effect.
  if (
    !Array.isArray(input.evidenceIds) ||
    input.evidenceIds.length === 0 ||
    !input.evidenceIds.every((id) => isNonEmptyString(id))
  ) {
    throw new SyntheticStripeBalanceError(
      'Stripe balance effects are provider-verified or UNKNOWN — a confirmation without provider evidence is a synthetic balance effect',
      { confirmationId, connectedInstanceId },
    );
  }
  const confirmation: StripeSettlementConfirmation = {
    confirmationId,
    routeFamily: 'NATIVE_STRIPE_CRYPTO',
    connectedInstanceId,
    stripeBalanceTxRef,
    amount,
    providerStateEnvelopeRef,
    evidenceIds: Object.freeze([...input.evidenceIds]),
    confirmedByProvider: true,
  };
  return Object.freeze(confirmation);
}

/**
 * Structural guard: whether the value is a provider-verified Stripe
 * settlement confirmation (native family, confirmed by provider, carrying
 * provider evidence and all identity refs).
 */
export function isProviderVerifiedStripeSettlement(
  value: unknown,
): value is StripeSettlementConfirmation {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<StripeSettlementConfirmation>;
  return (
    candidate.routeFamily === 'NATIVE_STRIPE_CRYPTO' &&
    candidate.confirmedByProvider === true &&
    Array.isArray(candidate.evidenceIds) &&
    candidate.evidenceIds.length > 0 &&
    isNonEmptyString(candidate.confirmationId) &&
    isNonEmptyString(candidate.connectedInstanceId) &&
    isNonEmptyString(candidate.stripeBalanceTxRef) &&
    isNonEmptyString(candidate.providerStateEnvelopeRef) &&
    candidate.amount !== null &&
    typeof candidate.amount === 'object' &&
    typeof candidate.amount.value === 'bigint'
  );
}
