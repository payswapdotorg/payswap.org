import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  TransitionGuardError,
  ValidationError,
  currencyCode,
  fromMinorUnits,
} from '@payswap/protocol';
import {
  defineMaterialTerms,
  defineTranslation,
} from '@payswap/payment';
import type { ConnectedCapabilityInstance } from '@payswap/connectors';
import {
  RouteFamilyConflationError,
  attachSettlement,
  attachSettlementRoute,
  attachSubmission,
  attachTranslation,
  attemptOutcome,
  abandonMerchantPaymentAttempt,
  beginMerchantPaymentAttempt,
  confirmMerchantPaymentAttemptFailed,
  confirmMerchantPaymentAttemptSucceeded,
  defineCryptoAmount,
  defineCryptoAsset,
  defineCryptoQuote,
  defineMerchantPaymentIntent,
  defineNativeStripeCryptoSettlementRoute,
  reportMerchantPaymentAttemptUnknown,
  resolveMerchantPaymentAttemptUnknown,
  submitMerchantPaymentAttempt,
  type MerchantCryptoSettlementRoute,
  type MerchantPaymentAttempt,
} from '../src/index.js';

const EUR = currencyCode('EUR');

const usdc = defineCryptoAsset({
  id: 'asset:usdc',
  displayName: 'USD Coin',
  symbol: 'USDC',
  decimals: 6,
  kind: 'STABLECOIN',
});

const quote = defineCryptoQuote({
  id: 'quote:usdc:eur:001',
  assetId: 'asset:usdc',
  chainId: 'chain.ethereum',
  fiatAmount: fromMinorUnits(EUR, 10000n),
  cryptoAmount: defineCryptoAmount(usdc, 110000000n),
  ratio: { numerator: 10000n, denominator: 110000000n },
  fees: fromMinorUnits(EUR, 150n),
  quotedAt: 1000n,
  validUntil: 61000n,
  sourceRef: 'source:fx-desk:a1',
});

const otherQuote = defineCryptoQuote({
  id: 'quote:usdc:eur:002',
  assetId: 'asset:usdc',
  chainId: 'chain.ethereum',
  fiatAmount: fromMinorUnits(EUR, 10000n),
  cryptoAmount: defineCryptoAmount(usdc, 110000000n),
  ratio: { numerator: 10000n, denominator: 110000000n },
  fees: fromMinorUnits(EUR, 150n),
  quotedAt: 1000n,
  validUntil: 61000n,
  sourceRef: 'source:fx-desk:a1',
});

const intent = defineMerchantPaymentIntent({
  id: 'intent-1',
  merchantRef: 'merchant-1',
  acceptancePolicyId: 'ap-1',
  cryptoAcceptancePolicyId: 'mcap-1',
  amount: fromMinorUnits(EUR, 10000n),
  createdAt: 1000n,
  expiresAt: 61000n,
});

function beginAttempt(): MerchantPaymentAttempt {
  return beginMerchantPaymentAttempt({
    id: 'attempt-1',
    intent,
    quote,
    now: 2000n,
  });
}

function submitAttempt(attempt: MerchantPaymentAttempt = beginAttempt()): MerchantPaymentAttempt {
  return submitMerchantPaymentAttempt(attempt, quote, 60000n);
}

function confirmedAttempt(): MerchantPaymentAttempt {
  return confirmMerchantPaymentAttemptSucceeded(submitAttempt(), {
    evidenceIds: ['ev-submit-1'],
    now: 60100n,
  });
}

const connectedInstance: ConnectedCapabilityInstance = {
  instanceId: 'inst-1',
  capabilityId: 'cap-1',
  implementationId: 'impl-1',
  providerName: 'stripe',
  providerVersion: '1.0.0',
  accountRef: 'acct-1',
  tenantRef: 'tenant-1',
  authorization: { status: 'ACTIVE' },
  credentialScope: { credentialRef: 'cred-1', credentialKind: 'API_KEY' },
  geography: { countries: ['US'] },
  currencies: ['USD'],
  permissionState: { granted: [], requested: [], missing: [] },
  eligibility: { eligible: true, reasons: [] },
  configuration: {},
};

const nativeRoute = defineNativeStripeCryptoSettlementRoute(
  {
    connectedInstanceId: 'inst-1',
    stripeAccountRef: 'acct-1',
    settlementCurrency: 'USD',
    supportedAssets: ['asset:usdc'],
    evidenceRefs: ['obs-1'],
  },
  connectedInstance,
);

const translation = defineTranslation({
  id: 'tr-1',
  requestedMethod: 'pm:stablecoin-crypto',
  selectedCapabilityChain: [{ order: 1, capability: 'cap.stripe.crypto', role: 'collect' }],
  actualRailEffects: [],
  merchantSettlementResult: {
    destinationId: 'dest-1',
    destinationKind: 'STABLECOIN_WALLET',
    currency: 'EUR',
    externalRef: 'wallet:0xabc',
  },
  materialTerms: defineMaterialTerms({
    amount: fromMinorUnits(EUR, 10000n),
    currency: 'EUR',
    fees: fromMinorUnits(EUR, 150n),
    completionMs: 3600000n,
    recourse: 'MERCHANT_DISPUTE_WINDOW',
    settlementDestinationId: 'dest-1',
  }),
});

describe('beginMerchantPaymentAttempt', () => {
  it('begins a PENDING attempt with an immutable quoted-amount snapshot', () => {
    const attempt = beginAttempt();
    expect(attempt.id).toBe('attempt-1');
    expect(attempt.intentId).toBe('intent-1');
    expect(attempt.assetId).toBe(quote.assetId);
    expect(attempt.chainId).toBe(quote.chainId);
    expect(attempt.quoteId).toBe(quote.id);
    expect(attempt.quotedCryptoAmount).toBe(quote.cryptoAmount);
    expect(attempt.quotedCryptoAmount.value).toBe(110000000n);
    expect(attempt.state).toBe('PENDING');
    expect(attempt.settlementAttemptIds).toEqual([]);
    expect(attempt.evidenceIds).toEqual([]);
    expect(attempt.createdAt).toBe(2000n);
    expect(attempt.updatedAt).toBe(2000n);
    expect(Object.isFrozen(attempt)).toBe(true);
  });

  it('rejects an expired quote — a fresh quote is required', () => {
    expect(() =>
      beginMerchantPaymentAttempt({ id: 'attempt-x', intent, quote, now: 61000n }),
    ).toThrow(ValidationError);
    expect(() =>
      beginMerchantPaymentAttempt({ id: 'attempt-x', intent, quote, now: 61000n }),
    ).toThrow(/quote is expired/);
  });
});

describe('submitMerchantPaymentAttempt', () => {
  it('submits a PENDING attempt while the quote is unexpired', () => {
    const pending = beginAttempt();
    const submitted = submitMerchantPaymentAttempt(pending, quote, 60000n);
    expect(submitted.state).toBe('SUBMITTED');
    expect(submitted.updatedAt).toBe(60000n);
    expect(pending.state).toBe('PENDING');
    expect(Object.isFrozen(submitted)).toBe(true);
  });

  it('refuses submission at the expiry boundary (guard throws)', () => {
    expect(() => submitMerchantPaymentAttempt(beginAttempt(), quote, 61000n)).toThrow(
      TransitionGuardError,
    );
  });

  it('rejects a quote that is not the attempt quote', () => {
    expect(() => submitMerchantPaymentAttempt(beginAttempt(), otherQuote, 60000n)).toThrow(
      ValidationError,
    );
  });
});

describe('attachSubmission', () => {
  it('attaches the external tx ref only on a SUBMITTED attempt', () => {
    const submitted = attachSubmission(submitAttempt(), {
      externalTxRef: '0xabc123',
      now: 60100n,
    });
    expect(submitted.state).toBe('SUBMITTED');
    expect(submitted.externalTxRef).toBe('0xabc123');
    expect(submitted.updatedAt).toBe(60100n);
    expect(() =>
      attachSubmission(beginAttempt(), { externalTxRef: '0xabc123', now: 60100n }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty external tx ref', () => {
    expect(() =>
      attachSubmission(submitAttempt(), { externalTxRef: '', now: 60100n }),
    ).toThrow(ValidationError);
  });
});

describe('confirmMerchantPaymentAttemptSucceeded', () => {
  it('requires linked evidence (INV-E02)', () => {
    expect(() =>
      confirmMerchantPaymentAttemptSucceeded(submitAttempt(), { evidenceIds: [], now: 60100n }),
    ).toThrow(ValidationError);
    expect(() =>
      confirmMerchantPaymentAttemptSucceeded(submitAttempt(), { evidenceIds: [], now: 60100n }),
    ).toThrow(/INV-E02/);
  });

  it('confirms success, merging evidence in order', () => {
    const submitted = confirmMerchantPaymentAttemptSucceeded(submittedWithEvidence(), {
      evidenceIds: ['ev-confirm-1'],
      externalTxRef: '0xabc123',
      translation,
      now: 60100n,
    });
    expect(submitted.state).toBe('CONFIRMED');
    expect(submitted.evidenceIds).toEqual(['ev-obs-1', 'ev-confirm-1']);
    expect(submitted.externalTxRef).toBe('0xabc123');
    expect(submitted.translation).toBe(translation);
    expect(Object.isFrozen(submitted.evidenceIds)).toBe(true);
  });

  it('is only legal from SUBMITTED — the machine throws otherwise', () => {
    expect(() =>
      confirmMerchantPaymentAttemptSucceeded(beginAttempt(), {
        evidenceIds: ['ev-1'],
        now: 60100n,
      }),
    ).toThrow(IllegalTransitionError);
  });
});

/** A SUBMITTED attempt already carrying one linked evidence id. */
function submittedWithEvidence(): MerchantPaymentAttempt {
  const submitted = submitAttempt();
  return {
    ...submitted,
    evidenceIds: Object.freeze(['ev-obs-1']),
  };
}

describe('confirmMerchantPaymentAttemptFailed', () => {
  it('requires linked evidence (INV-E02)', () => {
    expect(() =>
      confirmMerchantPaymentAttemptFailed(submitAttempt(), { evidenceIds: [], now: 60100n }),
    ).toThrow(ValidationError);
  });

  it('records definitive failure', () => {
    const failed = confirmMerchantPaymentAttemptFailed(submitAttempt(), {
      evidenceIds: ['ev-fail-1'],
      now: 60100n,
    });
    expect(failed.state).toBe('FAILED');
    expect(failed.evidenceIds).toEqual(['ev-fail-1']);
    expect(attemptOutcome(failed)).toBe('FAILED');
  });
});

describe('reportMerchantPaymentAttemptUnknown', () => {
  it('requires evidence — the ambiguity observation itself is evidence', () => {
    expect(() =>
      reportMerchantPaymentAttemptUnknown(submitAttempt(), { evidenceIds: [], now: 60100n }),
    ).toThrow(ValidationError);
    expect(() =>
      reportMerchantPaymentAttemptUnknown(submitAttempt(), { evidenceIds: [], now: 60100n }),
    ).toThrow(/evidence/);
  });

  it('reports UNKNOWN as a first-class non-terminal state', () => {
    const unknown = reportMerchantPaymentAttemptUnknown(submitAttempt(), {
      evidenceIds: ['ev-obs-1'],
      now: 60100n,
    });
    expect(unknown.state).toBe('OUTCOME_UNKNOWN');
    expect(unknown.evidenceIds).toEqual(['ev-obs-1']);
  });
});

describe('resolveMerchantPaymentAttemptUnknown', () => {
  const succeededResolution = {
    resolvedOutcome: 'CONFIRMED_SUCCEEDED' as const,
    resolvedBy: { principalType: 'OPERATOR', principalId: 'op-1' },
    caseId: 'case-1',
    evidenceIds: ['ev-r1', 'ev-r2'],
  };

  function unknownAttempt(): MerchantPaymentAttempt {
    return reportMerchantPaymentAttemptUnknown(submitAttempt(), {
      evidenceIds: ['ev-obs-1'],
      now: 60100n,
    });
  }

  it('resolves CONFIRMED_SUCCEEDED to CONFIRMED and merges both evidence sets', () => {
    const resolved = resolveMerchantPaymentAttemptUnknown(
      unknownAttempt(),
      succeededResolution,
      62000n,
    );
    expect(resolved.state).toBe('CONFIRMED');
    expect(resolved.evidenceIds).toEqual(['ev-obs-1', 'ev-r1', 'ev-r2']);
    expect(resolved.updatedAt).toBe(62000n);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('resolves CONFIRMED_FAILED to FAILED', () => {
    const resolved = resolveMerchantPaymentAttemptUnknown(
      unknownAttempt(),
      { ...succeededResolution, resolvedOutcome: 'CONFIRMED_FAILED' },
      62000n,
    );
    expect(resolved.state).toBe('FAILED');
  });

  it('does not merge the resolution caseId as evidence', () => {
    const resolved = resolveMerchantPaymentAttemptUnknown(
      unknownAttempt(),
      succeededResolution,
      62000n,
    );
    expect(resolved.evidenceIds).not.toContain('case-1');
  });

  it('is only legal from OUTCOME_UNKNOWN — the machine throws otherwise', () => {
    expect(() =>
      resolveMerchantPaymentAttemptUnknown(submitAttempt(), succeededResolution, 62000n),
    ).toThrow(IllegalTransitionError);
  });

  it('rejects a resolution without evidence', () => {
    expect(() =>
      resolveMerchantPaymentAttemptUnknown(
        unknownAttempt(),
        { ...succeededResolution, evidenceIds: [] },
        62000n,
      ),
    ).toThrow(ValidationError);
  });
});

describe('abandonMerchantPaymentAttempt', () => {
  it('abandons a PENDING attempt', () => {
    const abandoned = abandonMerchantPaymentAttempt(beginAttempt(), 3000n);
    expect(abandoned.state).toBe('ABANDONED');
    expect(abandoned.updatedAt).toBe(3000n);
  });

  it('is only legal from PENDING', () => {
    expect(() => abandonMerchantPaymentAttempt(submitAttempt(), 60100n)).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('attachSettlement', () => {
  it('attaches the branded settlement mapping on a CONFIRMED attempt', () => {
    const settled = attachSettlement(confirmedAttempt(), {
      settlementInstructionId: 'SI:set-1:1:EUR',
      settlementAttemptIds: ['sa-1', 'sa-2'],
      now: 60200n,
    });
    expect(settled.state).toBe('CONFIRMED');
    expect(settled.settlementInstructionId).toBe('SI:set-1:1:EUR');
    expect(settled.settlementAttemptIds).toEqual(['sa-1', 'sa-2']);
    expect(Object.isFrozen(settled.settlementAttemptIds)).toBe(true);
    expect(Object.isFrozen(settled)).toBe(true);
  });

  it('is only legal on a CONFIRMED attempt', () => {
    expect(() =>
      attachSettlement(submitAttempt(), {
        settlementInstructionId: 'SI:set-1:1:EUR',
        settlementAttemptIds: ['sa-1'],
        now: 60200n,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects empty settlement attempt ids', () => {
    expect(() =>
      attachSettlement(confirmedAttempt(), {
        settlementInstructionId: 'SI:set-1:1:EUR',
        settlementAttemptIds: [],
        now: 60200n,
      }),
    ).toThrow(ValidationError);
  });
});

describe('attachSettlementRoute', () => {
  it('attaches a discriminated native route on a SUBMITTED attempt', () => {
    const routed = attachSettlementRoute(submitAttempt(), nativeRoute, 60100n);
    expect(routed.state).toBe('SUBMITTED');
    expect(routed.settlementRoute).toBe(nativeRoute);
    expect(routed.updatedAt).toBe(60100n);
  });

  it('propagates RouteFamilyConflationError for a conflated hand-built route', () => {
    const conflated = {
      ...nativeRoute,
      conversionChain: ['cap.fx.swap'],
    } as unknown as MerchantCryptoSettlementRoute;
    expect(() => attachSettlementRoute(submitAttempt(), conflated, 60100n)).toThrow(
      RouteFamilyConflationError,
    );
  });

  it('is only legal on SUBMITTED or CONFIRMED attempts', () => {
    expect(() => attachSettlementRoute(beginAttempt(), nativeRoute, 60100n)).toThrow(
      ValidationError,
    );
    const routed = attachSettlementRoute(confirmedAttempt(), nativeRoute, 60200n);
    expect(routed.state).toBe('CONFIRMED');
  });
});

describe('attachTranslation', () => {
  it('attaches the canonical translation on a SUBMITTED attempt', () => {
    const translated = attachTranslation(submitAttempt(), translation, 60100n);
    expect(translated.state).toBe('SUBMITTED');
    expect(translated.translation).toBe(translation);
    expect(Object.isFrozen(translated)).toBe(true);
  });

  it('is only legal on SUBMITTED or CONFIRMED attempts', () => {
    expect(() => attachTranslation(beginAttempt(), translation, 60100n)).toThrow(ValidationError);
  });
});

describe('attemptOutcome', () => {
  it('maps every state onto the ExternalOutcome definiteness dimension', () => {
    expect(attemptOutcome(confirmedAttempt())).toBe('SUCCEEDED');
    expect(
      attemptOutcome(
        confirmMerchantPaymentAttemptFailed(submitAttempt(), { evidenceIds: ['ev-1'], now: 60100n }),
      ),
    ).toBe('FAILED');
    expect(
      attemptOutcome(
        reportMerchantPaymentAttemptUnknown(submitAttempt(), {
          evidenceIds: ['ev-1'],
          now: 60100n,
        }),
      ),
    ).toBe('OUTCOME_UNKNOWN');
    expect(attemptOutcome(beginAttempt())).toBe('PENDING');
    expect(attemptOutcome(submitAttempt())).toBe('PENDING');
    expect(attemptOutcome(abandonMerchantPaymentAttempt(beginAttempt(), 3000n))).toBe('PENDING');
  });
});

describe('UNKNOWN is never FAILED (INV-X01)', () => {
  it('throws on CONFIRM_FAILED from OUTCOME_UNKNOWN — only RESOLVE_* can exit UNKNOWN', () => {
    const unknown = reportMerchantPaymentAttemptUnknown(submitAttempt(), {
      evidenceIds: ['ev-obs-1'],
      now: 60100n,
    });
    expect(() =>
      confirmMerchantPaymentAttemptFailed(unknown, { evidenceIds: ['ev-1'], now: 60200n }),
    ).toThrow(IllegalTransitionError);
    expect(() =>
      confirmMerchantPaymentAttemptSucceeded(unknown, { evidenceIds: ['ev-1'], now: 60200n }),
    ).toThrow(IllegalTransitionError);
    expect(attemptOutcome(unknown)).toBe('OUTCOME_UNKNOWN');
    expect(attemptOutcome(unknown)).not.toBe('FAILED');
  });
});
