/**
 * @payswap/payment — PaymentMethod and PaymentCredentialCapability (W1-003).
 *
 * FROZEN-ARCHITECTURE §6A / PAYMENT-OPERATING-PLANE:
 *
 * - `PaymentMethod` is the user/merchant-facing instrument choice — what the
 *   payer experiences at checkout. It is explicitly NOT a rail capability:
 *   the underlying mechanism that actually moves value belongs to the
 *   capability plane (W2-003 owns the canonical connector capability
 *   vocabulary; this package does NOT redefine it). The distinction is
 *   enforced structurally: `PaymentMethod` is branded, and its capability
 *   references are opaque `RailCapabilityRef` strings that this package can
 *   neither construct nor interpret.
 * - `PaymentCredentialCapability` describes the authorization material
 *   required to execute a method: token, mandate, bank authorization,
 *   mobile-money authorization, smart-account session key, virtual-card
 *   credential or delegated payment credential.
 *
 * Types + deterministic logic only. No rail execution, no fake balances, no
 * floating-point money (INV-F01), no randomness.
 */

import { ValidationError, type CurrencyCode } from '@payswap/protocol';

declare const PaymentMethodIdBrand: unique symbol;

/** Branded id of one payment method definition. */
export type PaymentMethodId = string & { readonly [PaymentMethodIdBrand]: 'PaymentMethodId' };

declare const PaymentCredentialCapabilityIdBrand: unique symbol;

/** Branded id of one credential capability definition. */
export type PaymentCredentialCapabilityId = string & {
  readonly [PaymentCredentialCapabilityIdBrand]: 'PaymentCredentialCapabilityId';
};

/**
 * Opaque reference to a rail/capability descriptor owned by the capability
 * plane. The payment plane can carry and echo it, but never constructs,
 * interprets or validates it — capability truth lives in @payswap/protocol's
 * Value Conversion Graph and the connector packages (W2-003/W3-003).
 */
declare const RailCapabilityRefBrand: unique symbol;

export type RailCapabilityRef = string & {
  readonly [RailCapabilityRefBrand]: 'RailCapabilityRef';
};

/**
 * The FROZEN §6A method kinds. `CHECK_CASH_EXTERNAL` records movements
 * PaySwap did NOT orchestrate (see off-network.ts); its presence here lets a
 * merchant declare "we also accept check/cash" as an acceptance-surface
 * fact without implying PaySwap execution.
 */
export type PaymentMethodKind =
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'ACH_EFT'
  | 'INSTANT_PAYMENT'
  | 'MOBILE_MONEY'
  | 'WALLET'
  | 'STABLECOIN_CRYPTO'
  | 'VIRTUAL_CARD'
  | 'BNPL_CREDIT'
  | 'CHECK_CASH_EXTERNAL';

/** What authorization material a method requires to execute. */
export type PaymentCredentialKind =
  | 'TOKEN'
  | 'MANDATE'
  | 'BANK_AUTHORIZATION'
  | 'MOBILE_MONEY_AUTHORIZATION'
  | 'SMART_ACCOUNT_SESSION_KEY'
  | 'VIRTUAL_CARD_CREDENTIAL'
  | 'DELEGATED_PAYMENT_CREDENTIAL';

/**
 * The credential required to execute a method: a card token, a recurring
 * mandate, a bank account authorization, a mobile-money authorization, a
 * smart-account session key, a virtual-card credential or a delegated
 * payment credential. `scope` describes what the credential authorizes
 * (free-text, provider-agnostic); `railHint` MAY point at the capability
 * the credential is bound to without the payment plane interpreting it.
 */
export interface PaymentCredentialCapability {
  readonly id: PaymentCredentialCapabilityId;
  readonly kind: PaymentCredentialKind;
  /** True when execution is impossible without this credential. */
  readonly required: boolean;
  /** Provider-agnostic description of what the credential authorizes. */
  readonly scope: string;
  /** Optional opaque capability binding; never interpreted here. */
  readonly railHint?: RailCapabilityRef;
}

/**
 * A user/merchant-facing payment instrument (FROZEN §6A). This type is
 * DISTINCT from any rail capability type: it describes the experienced
 * method, never the movement mechanism. `currencies` lists the settlement
 * currencies the method can be presented in; `credentialRequirements`
 * declares the authorization material needed to execute.
 */
export interface PaymentMethod {
  readonly id: PaymentMethodId;
  readonly kind: PaymentMethodKind;
  /** Checkout-facing display name, e.g. `Mobile Money`. */
  readonly displayName: string;
  readonly currencies: readonly CurrencyCode[];
  readonly credentialRequirements: readonly PaymentCredentialCapability[];
  /** Optional opaque capability hint; never interpreted by this plane. */
  readonly railHint?: RailCapabilityRef;
}

const METHOD_KINDS: readonly PaymentMethodKind[] = [
  'CARD',
  'BANK_TRANSFER',
  'ACH_EFT',
  'INSTANT_PAYMENT',
  'MOBILE_MONEY',
  'WALLET',
  'STABLECOIN_CRYPTO',
  'VIRTUAL_CARD',
  'BNPL_CREDIT',
  'CHECK_CASH_EXTERNAL',
];

const CREDENTIAL_KINDS: readonly PaymentCredentialKind[] = [
  'TOKEN',
  'MANDATE',
  'BANK_AUTHORIZATION',
  'MOBILE_MONEY_AUTHORIZATION',
  'SMART_ACCOUNT_SESSION_KEY',
  'VIRTUAL_CARD_CREDENTIAL',
  'DELEGATED_PAYMENT_CREDENTIAL',
];

/** Brand a validated string as a `PaymentMethodId`. */
export function asPaymentMethodId(value: string): PaymentMethodId {
  return brandId(value, 'PaymentMethodId');
}

/** Brand a validated string as a `PaymentCredentialCapabilityId`. */
export function asPaymentCredentialCapabilityId(value: string): PaymentCredentialCapabilityId {
  return brandId(value, 'PaymentCredentialCapabilityId');
}

/** Brand a validated string as an opaque `RailCapabilityRef`. */
export function asRailCapabilityRef(value: string): RailCapabilityRef {
  return brandId(value, 'RailCapabilityRef');
}

function brandId<TBranded extends string>(value: string, kind: string): TBranded {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${kind} must be a non-empty string`, { kind, value });
  }
  if (value.length > 256) {
    throw new ValidationError(`${kind} exceeds 256 characters`, { kind, value });
  }
  if (value.trim() !== value) {
    throw new ValidationError(`${kind} must not carry surrounding whitespace`, { kind, value });
  }
  return value as TBranded;
}

/** Construct a validated, frozen credential capability. */
export function defineCredentialCapability(input: {
  readonly id: string;
  readonly kind: PaymentCredentialKind;
  readonly required: boolean;
  readonly scope: string;
  readonly railHint?: string;
}): PaymentCredentialCapability {
  const id = asPaymentCredentialCapabilityId(input.id);
  if (!CREDENTIAL_KINDS.includes(input.kind)) {
    throw new ValidationError('credential kind is not declared', { kind: input.kind });
  }
  if (typeof input.required !== 'boolean') {
    throw new ValidationError('credential required must be a boolean', { id });
  }
  if (typeof input.scope !== 'string' || input.scope.length === 0) {
    throw new ValidationError('credential scope must be a non-empty string', { id });
  }
  if (input.scope.length > 512) {
    throw new ValidationError('credential scope exceeds 512 characters', { id });
  }
  const capability: PaymentCredentialCapability = Object.freeze({
    id,
    kind: input.kind,
    required: input.required,
    scope: input.scope,
    ...(input.railHint !== undefined ? { railHint: asRailCapabilityRef(input.railHint) } : {}),
  });
  return capability;
}

/**
 * Construct a validated, frozen payment method. `CHECK_CASH_EXTERNAL`
 * methods are accepted but carry an explicit marker in `displayName`
 * conventions — off-network records (off-network.ts) are the authoritative
 * surface for movements PaySwap did not orchestrate.
 */
export function definePaymentMethod(input: {
  readonly id: string;
  readonly kind: PaymentMethodKind;
  readonly displayName: string;
  readonly currencies: readonly CurrencyCode[];
  readonly credentialRequirements: readonly PaymentCredentialCapability[];
  readonly railHint?: string;
}): PaymentMethod {
  const id = asPaymentMethodId(input.id);
  if (!METHOD_KINDS.includes(input.kind)) {
    throw new ValidationError('payment method kind is not declared', { kind: input.kind });
  }
  if (typeof input.displayName !== 'string' || input.displayName.length === 0) {
    throw new ValidationError('payment method displayName must be a non-empty string', { id });
  }
  if (input.displayName.length > 128) {
    throw new ValidationError('payment method displayName exceeds 128 characters', { id });
  }
  if (!Array.isArray(input.currencies) || input.currencies.length === 0) {
    throw new ValidationError('a payment method must declare at least one currency', { id });
  }
  for (const currency of input.currencies) {
    if (typeof currency !== 'string' || currency.length !== 3) {
      throw new ValidationError('payment method currencies must be ISO-style codes', {
        id,
        currency,
      });
    }
  }
  if (new Set(input.currencies).size !== input.currencies.length) {
    throw new ValidationError('payment method currencies must not repeat', { id });
  }
  if (!Array.isArray(input.credentialRequirements)) {
    throw new ValidationError('credentialRequirements must be an array', { id });
  }
  const seen = new Set<string>();
  for (const credential of input.credentialRequirements) {
    if (credential === null || typeof credential !== 'object') {
      throw new ValidationError('each credential requirement must be a PaymentCredentialCapability', {
        id,
      });
    }
    if (seen.has(credential.id)) {
      throw new ValidationError('credential requirement ids must not repeat', {
        id,
        credentialId: credential.id,
      });
    }
    seen.add(credential.id);
  }
  const method: PaymentMethod = Object.freeze({
    id,
    kind: input.kind,
    displayName: input.displayName,
    currencies: Object.freeze([...input.currencies]),
    credentialRequirements: Object.freeze([...input.credentialRequirements]),
    ...(input.railHint !== undefined ? { railHint: asRailCapabilityRef(input.railHint) } : {}),
  });
  return method;
}

/**
 * Deterministically check whether a method can be PRESENTED for a currency:
 * kind validity plus currency membership. This is a presentation check —
 * it says nothing about execution authority (that lives in the capability
 * plane and authorization artifacts).
 */
export function methodSupportsCurrency(
  method: PaymentMethod,
  currency: CurrencyCode,
): boolean {
  return method.currencies.includes(currency);
}

/**
 * Deterministically list the credential kinds required to execute a method
 * (only `required: true` entries), in declared order.
 */
export function requiredCredentialKinds(
  method: PaymentMethod,
): readonly PaymentCredentialKind[] {
  return Object.freeze(
    method.credentialRequirements
      .filter((credential) => credential.required)
      .map((credential) => credential.kind),
  );
}
