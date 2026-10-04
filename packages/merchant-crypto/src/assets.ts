/**
 * @payswap/merchant-crypto — crypto assets and exact amounts (P4-W1-003).
 *
 * CryptoAssetId/ChainId are opaque branded references (the onchain
 * domain/capability kernel owns chain semantics — this package never
 * interprets them). CryptoAmount is exact integer minor-unit arithmetic
 * (INV-F01): value is bigint minor units at the asset's declared decimals;
 * there is no floating-point path anywhere.
 */

import { ValidationError } from '@payswap/protocol';

declare const CryptoAssetIdBrand: unique symbol;

/** Branded id of one crypto asset definition. */
export type CryptoAssetId = string & { readonly [CryptoAssetIdBrand]: 'CryptoAssetId' };

declare const ChainIdBrand: unique symbol;

/** Branded id of one chain/network reference; opaque to this package. */
export type ChainId = string & { readonly [ChainIdBrand]: 'ChainId' };

/** How a crypto asset is issued. */
export type CryptoAssetKind = 'STABLECOIN' | 'NATIVE_CRYPTO' | 'TOKEN';

/**
 * A crypto asset a merchant may accept. `decimals` is minor-unit scale
 * metadata ONLY — it is carried for presentation and cross-checking, never
 * used in arithmetic (all arithmetic is bigint minor units, INV-F01).
 */
export interface CryptoAsset {
  readonly id: CryptoAssetId;
  readonly displayName: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly kind: CryptoAssetKind;
}

/**
 * Exact integer minor-unit amount of one crypto asset (INV-F01). `decimals`
 * is copied from the asset at construction so an amount is always consistent
 * with the asset it is denominated in.
 */
export interface CryptoAmount {
  readonly assetId: CryptoAssetId;
  readonly value: bigint;
  readonly decimals: number;
}

const ASSET_KINDS: readonly CryptoAssetKind[] = ['STABLECOIN', 'NATIVE_CRYPTO', 'TOKEN'];

const CRYPTO_SYMBOL_PATTERN = /^[A-Z0-9]{2,16}$/;

const MIN_ASSET_DECIMALS = 0;
const MAX_ASSET_DECIMALS = 18;

/** Raised when exact crypto amount arithmetic is structurally impossible. */
export class InvalidCryptoAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCryptoAmountError';
  }
}

/** Brand a validated string as a `CryptoAssetId`. */
export function asCryptoAssetId(value: string): CryptoAssetId {
  return brandId(value, 'CryptoAssetId');
}

/** Brand a validated string as a `ChainId`. */
export function asChainId(value: string): ChainId {
  return brandId(value, 'ChainId');
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

/**
 * Construct a validated, frozen crypto asset.
 *
 * `decimals` is scale metadata: it must be an integer between zero and
 * eighteen (inclusive) and is never used in arithmetic.
 */
export function defineCryptoAsset(input: {
  readonly id: string;
  readonly displayName: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly kind: CryptoAssetKind;
}): CryptoAsset {
  const id = asCryptoAssetId(input.id);
  if (typeof input.displayName !== 'string' || input.displayName.length === 0) {
    throw new ValidationError('crypto asset displayName must be a non-empty string', { id });
  }
  if (input.displayName.length > 128) {
    throw new ValidationError('crypto asset displayName exceeds 128 characters', { id });
  }
  if (typeof input.symbol !== 'string' || !CRYPTO_SYMBOL_PATTERN.test(input.symbol)) {
    throw new ValidationError(
      'crypto asset symbol must be two to sixteen uppercase A-Z/0-9 characters',
      { id, symbol: input.symbol },
    );
  }
  if (
    typeof input.decimals !== 'number' ||
    !Number.isInteger(input.decimals) ||
    input.decimals < MIN_ASSET_DECIMALS ||
    input.decimals > MAX_ASSET_DECIMALS
  ) {
    throw new ValidationError(
      `crypto asset decimals must be an integer between ${MIN_ASSET_DECIMALS} and ${MAX_ASSET_DECIMALS}`,
      { id, decimals: input.decimals },
    );
  }
  if (!ASSET_KINDS.includes(input.kind)) {
    throw new ValidationError('crypto asset kind is not declared', { kind: input.kind });
  }
  return Object.freeze({
    id,
    displayName: input.displayName,
    symbol: input.symbol,
    decimals: input.decimals,
    kind: input.kind,
  });
}

function assertWellFormedCryptoAmount(amount: CryptoAmount, label: string): void {
  if (amount === null || typeof amount !== 'object') {
    throw new ValidationError(`${label} must be a CryptoAmount object`, { amount });
  }
  if (typeof amount.assetId !== 'string' || amount.assetId.length === 0) {
    throw new ValidationError(`${label}.assetId must be a non-empty string`, { amount });
  }
  if (typeof amount.value === 'number') {
    throw new ValidationError(
      `${label}.value is a JS number; floating-point crypto amounts are forbidden (INV-F01)`,
      { label },
    );
  }
  if (typeof amount.value !== 'bigint') {
    throw new ValidationError(`${label}.value must be a bigint of integer minor units`, { amount });
  }
  if (typeof amount.decimals !== 'number' || !Number.isInteger(amount.decimals)) {
    throw new ValidationError(`${label}.decimals must be integer scale metadata`, { amount });
  }
}

/**
 * Construct a validated, frozen crypto amount. `decimals` is always copied
 * from the asset so amounts stay consistent with their asset; zero is a
 * valid amount, negative values are not.
 */
export function defineCryptoAmount(asset: CryptoAsset, value: bigint): CryptoAmount {
  if (asset === null || typeof asset !== 'object' || typeof asset.id !== 'string') {
    throw new ValidationError('crypto amount requires a CryptoAsset', { asset });
  }
  if (typeof asset.decimals !== 'number' || !Number.isInteger(asset.decimals)) {
    throw new ValidationError('crypto amount requires integer asset decimals metadata', {
      assetId: asset.id,
    });
  }
  if (typeof value === 'number') {
    throw new ValidationError(
      'crypto amount value is a JS number; use bigint minor units (INV-F01)',
      { assetId: asset.id },
    );
  }
  if (typeof value !== 'bigint') {
    throw new ValidationError('crypto amount value must be a bigint of integer minor units', {
      assetId: asset.id,
    });
  }
  if (value < 0n) {
    throw new ValidationError('crypto amount value must be non-negative', {
      assetId: asset.id,
    });
  }
  return Object.freeze({
    assetId: asset.id,
    value,
    decimals: asset.decimals,
  });
}

function requireSameAsset(a: CryptoAmount, b: CryptoAmount): void {
  if (a.assetId !== b.assetId || a.decimals !== b.decimals) {
    throw new InvalidCryptoAmountError('crypto amount operations require a single asset');
  }
}

/** Exact addition of two same-asset amounts; returns a NEW frozen amount. */
export function addCryptoAmounts(a: CryptoAmount, b: CryptoAmount): CryptoAmount {
  assertWellFormedCryptoAmount(a, 'a');
  assertWellFormedCryptoAmount(b, 'b');
  requireSameAsset(a, b);
  return Object.freeze({
    assetId: a.assetId,
    value: a.value + b.value,
    decimals: a.decimals,
  });
}

/**
 * Exact subtraction of two same-asset amounts; returns a NEW frozen amount.
 * Underflow is an error, never a silent negative.
 */
export function subCryptoAmounts(a: CryptoAmount, b: CryptoAmount): CryptoAmount {
  assertWellFormedCryptoAmount(a, 'a');
  assertWellFormedCryptoAmount(b, 'b');
  requireSameAsset(a, b);
  if (a.value < b.value) {
    throw new InvalidCryptoAmountError('crypto amount subtraction would go negative');
  }
  return Object.freeze({
    assetId: a.assetId,
    value: a.value - b.value,
    decimals: a.decimals,
  });
}

/**
 * Three-way comparison (−1 / 0 / +1) within one asset. Mixing assets
 * (or scale metadata) throws `InvalidCryptoAmountError`.
 */
export function compareCryptoAmounts(a: CryptoAmount, b: CryptoAmount): -1 | 0 | 1 {
  assertWellFormedCryptoAmount(a, 'a');
  assertWellFormedCryptoAmount(b, 'b');
  requireSameAsset(a, b);
  if (a.value < b.value) return -1;
  if (a.value > b.value) return 1;
  return 0;
}

/**
 * Structural equality. Amounts of different assets (or different scale
 * metadata) are simply not equal (false); ordering across assets is
 * undefined and throws in `compareCryptoAmounts`.
 */
export function equalsCryptoAmount(a: CryptoAmount, b: CryptoAmount): boolean {
  return a.assetId === b.assetId && a.decimals === b.decimals && a.value === b.value;
}

/** Whether the amount is strictly greater than zero. */
export function isCryptoAmountPositive(amount: CryptoAmount): boolean {
  return amount.value > 0n;
}
