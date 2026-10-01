/**
 * @payswap/protocol — collateral records (W1-003).
 *
 * Collateral backs explicit credit (INV-F08): a `CreditLine` may reference
 * `CollateralRecord`s, and every `CreditExposure` restates the collateral
 * that secures it. Collateral is described value with provenance — it is
 * never a PaySwap custodial balance, and an appraisal is an observation,
 * not a fact of possession.
 */

import type { Money } from './money.js';
import { ValidationError } from './errors.js';
import { InvalidIdentifierError } from './identifiers.js';
import type { PartyId } from './obligation.js';
import type { TimestampMs } from './clock.js';

declare const CollateralIdBrand: unique symbol;

/** Branded id of one collateral record. */
export type CollateralId = string & { readonly [CollateralIdBrand]: 'CollateralId' };

/** Declared kinds of collateral. */
export type CollateralKind =
  | 'CASH_DEPOSIT'
  | 'SECURITY'
  | 'GUARANTEE'
  | 'LETTER_OF_CREDIT'
  | 'REAL_ASSET'
  | 'OTHER';

/** How the collateral's existence/value came to be known. */
export interface CollateralProvenance {
  /** Source descriptor, e.g. `custodian-statement`, `guarantor-attestation`. */
  readonly source: string;
  /** Reference to the underlying record at the source. */
  readonly reference: string;
  readonly recordedAt: TimestampMs;
}

/** One described piece of collateral with appraisal and provenance. */
export interface CollateralRecord {
  readonly id: CollateralId;
  readonly kind: CollateralKind;
  /** The party pledging the collateral. */
  readonly owner: PartyId;
  readonly description: string;
  /** Appraised value in the record's currency (exact). */
  readonly appraisedValue: Money;
  readonly appraisedAsOf: TimestampMs;
  readonly provenance: CollateralProvenance;
}

const KINDS: readonly CollateralKind[] = [
  'CASH_DEPOSIT',
  'SECURITY',
  'GUARANTEE',
  'LETTER_OF_CREDIT',
  'REAL_ASSET',
  'OTHER',
];

/** Brand a validated string as a `CollateralId`. */
export function asCollateralId(value: string): CollateralId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError('CollateralId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new InvalidIdentifierError('CollateralId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError('CollateralId must not carry surrounding whitespace', {
      value,
    });
  }
  return value as CollateralId;
}

/** Construct a validated, frozen collateral record. */
export function defineCollateral(input: {
  readonly id: string;
  readonly kind: CollateralKind;
  readonly owner: PartyId;
  readonly description: string;
  readonly appraisedValue: Money;
  readonly appraisedAsOf: TimestampMs;
  readonly provenance: CollateralProvenance;
}): CollateralRecord {
  const id = asCollateralId(input.id);
  if (typeof input.kind !== 'string' || !KINDS.includes(input.kind)) {
    throw new ValidationError('collateral kind is not a declared kind', { id, kind: input.kind });
  }
  if (typeof input.owner !== 'string' || input.owner.length === 0) {
    throw new ValidationError('collateral owner must be a PartyId', { id });
  }
  if (typeof input.description !== 'string' || input.description.length === 0) {
    throw new ValidationError('collateral description must be a non-empty string', { id });
  }
  if (input.description.length > 512) {
    throw new ValidationError('collateral description exceeds 512 characters', { id });
  }
  const value = input.appraisedValue;
  if (value === null || typeof value !== 'object') {
    throw new ValidationError('appraisedValue must be a Money object', { id });
  }
  if (typeof value.value === 'number') {
    throw new ValidationError('appraisedValue.value is a JS number — forbidden (INV-F01)', { id });
  }
  if (typeof value.value !== 'bigint' || value.value <= 0n) {
    throw new ValidationError('appraisedValue must be a positive bigint amount', { id });
  }
  if (typeof input.appraisedAsOf !== 'bigint') {
    throw new ValidationError('appraisedAsOf must be a bigint TimestampMs', { id });
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
    throw new ValidationError(
      'collateral provenance must carry source, reference and recordedAt',
      { id },
    );
  }
  return Object.freeze({
    id,
    kind: input.kind,
    owner: input.owner,
    description: input.description,
    appraisedValue: value,
    appraisedAsOf: input.appraisedAsOf,
    provenance: Object.freeze({ ...provenance }),
  });
}
