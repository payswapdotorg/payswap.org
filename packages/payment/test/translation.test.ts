import { describe, expect, it } from 'vitest';
import { GHS, fromMinorUnits } from '@payswap/protocol';
import { defineSettlementDestination } from '../src/acceptance.js';
import {
  TranslationReauthorizationRequiredError,
  asTranslationId,
  assertTranslationAuthorized,
  canonicalMaterialTerms,
  defineMaterialTerms,
  defineTranslation,
  defineTranslationAuthorization,
  materialTermsHash,
  settlementResultFrom,
  translationRequiresReauthorization,
  type MaterialTerms,
  type PaymentMethodTranslation,
  type TranslationAuthorization,
} from '../src/translation.js';

function terms(overrides?: Partial<MaterialTerms>): MaterialTerms {
  return defineMaterialTerms({
    amount: fromMinorUnits(GHS, 10_000n),
    currency: 'GHS',
    fees: fromMinorUnits(GHS, 150n),
    completionMs: 3_600_000n,
    recourse: 'MERCHANT_DISPUTE_WINDOW',
    settlementDestinationId: 'dest:merchant-gh',
    ...overrides,
  });
}

function translation(overrides?: Partial<MaterialTerms>): PaymentMethodTranslation {
  const materialTerms = terms(overrides);
  return defineTranslation({
    id: 'tr:1',
    requestedMethod: 'pm:mobile-money',
    selectedCapabilityChain: [
      { order: 1, capability: 'rail:mobile-money:gh', role: 'collect' },
      { order: 2, capability: 'rail:fx:ghs-usd', role: 'fx-convert' },
      { order: 3, capability: 'rail:bank:payout', role: 'payout' },
    ],
    actualRailEffects: [
      { capability: 'rail:mobile-money:gh', externalRef: 'momo-txn-9', recordedAt: 2_000n },
    ],
    merchantSettlementResult: {
      destinationId: 'dest:merchant-gh',
      destinationKind: 'MOBILE_MONEY_WALLET',
      currency: 'GHS',
      externalRef: 'momo:0244xxxxxxx',
    },
    materialTerms,
  });
}

function authorizationFor(hash: string, method = 'pm:mobile-money'): TranslationAuthorization {
  return defineTranslationAuthorization({
    id: 'auth:1',
    methodId: method,
    materialTermsHash: hash,
    authorizedAt: 1_500n,
    approvalArtifactRef: 'approval:artifact:42',
  });
}

describe('defineTranslation', () => {
  it('records requested method → capability chain → rail effects → settlement result', () => {
    const record = translation();
    expect(record.requestedMethod).toBe('pm:mobile-money');
    expect(record.selectedCapabilityChain.length).toBe(3);
    expect(record.selectedCapabilityChain[0]?.role).toBe('collect');
    expect(record.selectedCapabilityChain[2]?.capability).toBe('rail:bank:payout');
    expect(record.actualRailEffects[0]?.externalRef).toBe('momo-txn-9');
    expect(record.merchantSettlementResult.destinationKind).toBe('MOBILE_MONEY_WALLET');
  });

  it('validates chain order and rejects malformed records', () => {
    expect(() =>
      defineTranslation({
        id: 'tr:x',
        requestedMethod: 'pm:mobile-money',
        selectedCapabilityChain: [
          { order: 2, capability: 'rail:a', role: 'collect' },
          { order: 1, capability: 'rail:b', role: 'payout' },
        ],
        actualRailEffects: [],
        merchantSettlementResult: {
          destinationId: 'd',
          destinationKind: 'BANK_ACCOUNT',
          currency: 'GHS',
          externalRef: 'x',
        },
        materialTerms: terms(),
      }),
    ).toThrow(/order/);
    expect(() =>
      defineTranslation({
        id: 'tr:x',
        requestedMethod: 'pm:mobile-money',
        selectedCapabilityChain: [],
        actualRailEffects: [],
        merchantSettlementResult: {
          destinationId: 'd',
          destinationKind: 'BANK_ACCOUNT',
          currency: 'GHS',
          externalRef: 'x',
        },
        materialTerms: terms(),
      }),
    ).toThrow(/at least one/);
  });
});

describe('material terms hashing (deterministic)', () => {
  it('hashes identical terms identically and different terms differently', () => {
    expect(materialTermsHash(terms())).toBe(materialTermsHash(terms()));
    expect(materialTermsHash(terms())).not.toBe(materialTermsHash(terms({ fees: fromMinorUnits(GHS, 200n) })));
    expect(materialTermsHash(terms())).not.toBe(
      materialTermsHash(terms({ completionMs: 7_200_000n })),
    );
    expect(canonicalMaterialTerms(terms())).toBe(canonicalMaterialTerms(terms()));
  });

  it('every material dimension participates in the hash', () => {
    const base = materialTermsHash(terms());
    const variants: readonly (readonly [string, MaterialTerms])[] = [
      ['amount', terms({ amount: fromMinorUnits(GHS, 10_001n) })],
      ['fees', terms({ fees: fromMinorUnits(GHS, 151n) })],
      ['timing', terms({ completionMs: 3_600_001n })],
      ['recourse', terms({ recourse: 'NONE' })],
      ['destination', terms({ settlementDestinationId: 'dest:other' })],
    ];
    for (const [label, variant] of variants) {
      expect(materialTermsHash(variant), `dimension ${label} must change the hash`).not.toBe(base);
    }
  });
});

describe('material-term reauthorization (typed precondition)', () => {
  it('passes when the authorization covers exactly the translated terms', () => {
    const record = translation();
    const authorization = authorizationFor(materialTermsHash(record.materialTerms));
    expect(() => assertTranslationAuthorized(record, authorization)).not.toThrow();
    expect(translationRequiresReauthorization(record, authorization)).toBe(false);
  });

  it('throws TranslationReauthorizationRequiredError when ANY material term changed', () => {
    const authorized = authorizationFor(materialTermsHash(terms()));
    // the translation drifts: fees rose after capability selection
    const drifted = translation({ fees: fromMinorUnits(GHS, 400n) });
    expect(() => assertTranslationAuthorized(drifted, authorized)).toThrow(
      TranslationReauthorizationRequiredError,
    );
    expect(translationRequiresReauthorization(drifted, authorized)).toBe(true);
    try {
      assertTranslationAuthorized(drifted, authorized);
      expect.unreachable('must have thrown');
    } catch (error) {
      if (!(error instanceof TranslationReauthorizationRequiredError)) throw error;
      expect(error.details.translationId).toBe(asTranslationId('tr:1'));
      expect(error.details.authorizedHash).not.toBe(error.details.translatedHash);
    }
  });

  it('reauthorization on the drifted terms passes — fresh authorization resolves it', () => {
    const drifted = translation({ completionMs: 60_000n });
    const stale = authorizationFor(materialTermsHash(terms()));
    expect(translationRequiresReauthorization(drifted, stale)).toBe(true);
    const fresh = authorizationFor(materialTermsHash(drifted.materialTerms));
    expect(translationRequiresReauthorization(drifted, fresh)).toBe(false);
  });

  it('an authorization for a different method never covers the translation', () => {
    const record = translation();
    const wrongMethod = authorizationFor(materialTermsHash(record.materialTerms), 'pm:bank');
    expect(translationRequiresReauthorization(record, wrongMethod)).toBe(true);
  });
});

describe('settlementResultFrom', () => {
  it('derives the external settlement result from a destination', () => {
    const result = settlementResultFrom(
      defineSettlementDestination({
        id: 'dest:merchant-gh',
        kind: 'MOBILE_MONEY_WALLET',
        currency: GHS,
        externalRef: 'momo:0244xxxxxxx',
        provenance: { source: 's', reference: 'r', recordedAt: 1n },
      }),
    );
    expect(result.destinationId).toBe('dest:merchant-gh');
    expect(result.currency).toBe(GHS);
  });
});
