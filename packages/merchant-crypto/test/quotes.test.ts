import { describe, expect, it } from 'vitest';
import { ValidationError, currencyCode, fromMinorUnits } from '@payswap/protocol';
import { materialTermsHash } from '@payswap/payment';
import type { MaterialTerms } from '@payswap/payment';
import {
  InvalidCryptoQuoteError,
  canonicalCryptoQuote,
  cryptoQuoteHash,
  defineCryptoAmount,
  defineCryptoAsset,
  defineCryptoQuote,
  isQuoteExpired,
  materialTermsFromQuote,
  quoteValidityWindow,
  type CryptoQuote,
} from '../src/index.js';

const usdc = defineCryptoAsset({
  id: 'asset:usdc',
  displayName: 'USD Coin',
  symbol: 'USDC',
  decimals: 6,
  kind: 'STABLECOIN',
});

type QuoteInput = Parameters<typeof defineCryptoQuote>[0];

function baseQuoteInput(overrides: Partial<QuoteInput> = {}): QuoteInput {
  return {
    id: 'quote:usdc:eur:001',
    assetId: 'asset:usdc',
    chainId: 'chain:ethereum',
    fiatAmount: fromMinorUnits(currencyCode('EUR'), 10000n),
    cryptoAmount: defineCryptoAmount(usdc, 110000000n),
    ratio: { numerator: 10000n, denominator: 110000000n },
    fees: fromMinorUnits(currencyCode('EUR'), 50n),
    quotedAt: 1000n,
    validUntil: 61000n,
    sourceRef: 'source:fx-desk:a1',
    ...overrides,
  };
}

describe('defineCryptoQuote (INV-F01 exactness)', () => {
  it('accepts an exactly cross-multiplied quote and freezes it', () => {
    const quote = defineCryptoQuote(baseQuoteInput());
    expect(quote.id).toBe('quote:usdc:eur:001');
    expect(quote.assetId).toBe('asset:usdc');
    expect(quote.chainId).toBe('chain:ethereum');
    expect(quote.fiatAmount.value).toBe(10000n);
    expect(quote.fiatAmount.currency).toBe('EUR');
    expect(quote.cryptoAmount.value).toBe(110000000n);
    expect(quote.cryptoAmount.decimals).toBe(6);
    expect(quote.ratio.numerator).toBe(10000n);
    expect(quote.ratio.denominator).toBe(110000000n);
    expect(quote.fees.value).toBe(50n);
    expect(quote.quotedAt).toBe(1000n);
    expect(quote.validUntil).toBe(61000n);
    expect(quote.sourceRef).toBe('source:fx-desk:a1');
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.ratio)).toBe(true);
  });

  it('rejects an inexact ratio with InvalidCryptoQuoteError', () => {
    // 10000 * 110000000 !== 111000000 * 10000 — silent dust is forbidden.
    expect(() =>
      defineCryptoQuote(baseQuoteInput({ cryptoAmount: defineCryptoAmount(usdc, 111000000n) })),
    ).toThrow(InvalidCryptoQuoteError);
    expect(() =>
      defineCryptoQuote(baseQuoteInput({ cryptoAmount: defineCryptoAmount(usdc, 111000000n) })),
    ).toThrow('quote ratio is inconsistent with the quoted amounts');
  });

  it('rejects non-positive ratio terms', () => {
    expect(() =>
      defineCryptoQuote(baseQuoteInput({ ratio: { numerator: 0n, denominator: 110000000n } })),
    ).toThrow(ValidationError);
    expect(() =>
      defineCryptoQuote(baseQuoteInput({ ratio: { numerator: 10000n, denominator: 0n } })),
    ).toThrow(ValidationError);
    expect(() =>
      defineCryptoQuote(baseQuoteInput({ ratio: { numerator: -1n, denominator: 110000000n } })),
    ).toThrow(ValidationError);
    expect(() =>
      defineCryptoQuote(baseQuoteInput({ ratio: { numerator: 10000n, denominator: -5n } })),
    ).toThrow(ValidationError);
  });

  it('rejects quotedAt >= validUntil', () => {
    expect(() => defineCryptoQuote(baseQuoteInput({ quotedAt: 61000n }))).toThrow(ValidationError);
    expect(() => defineCryptoQuote(baseQuoteInput({ quotedAt: 62000n }))).toThrow(ValidationError);
  });

  it('rejects fees in a different currency than the fiat amount', () => {
    expect(() =>
      defineCryptoQuote(
        baseQuoteInput({ fees: fromMinorUnits(currencyCode('USD'), 50n) }),
      ),
    ).toThrow(ValidationError);
  });

  it('rejects a 2-character fiat currency with ValidationError (ISO-style shape)', () => {
    // Both monies carry the malformed 'EU' code, so only the 3-character
    // fiat-currency shape check can reject this input (the fees-share
    // equality would pass and the ratio stays exactly cross-multiplied).
    const malformed = baseQuoteInput({
      fiatAmount: { currency: 'EU', value: 10000n } as unknown as QuoteInput['fiatAmount'],
      fees: { currency: 'EU', value: 50n } as unknown as QuoteInput['fees'],
    });
    expect(() => defineCryptoQuote(malformed)).toThrow(ValidationError);
    expect(() => defineCryptoQuote(malformed)).toThrow(
      /fiat currency must be an ISO-style code/,
    );
  });

  it('allows zero fees but rejects negative fees', () => {
    const zeroFee = defineCryptoQuote(
      baseQuoteInput({ fees: fromMinorUnits(currencyCode('EUR'), 0n) }),
    );
    expect(zeroFee.fees.value).toBe(0n);
    expect(() =>
      defineCryptoQuote(baseQuoteInput({ fees: fromMinorUnits(currencyCode('EUR'), -50n) })),
    ).toThrow(ValidationError);
  });
});

describe('isQuoteExpired (expiry at the boundary)', () => {
  const quote = defineCryptoQuote(baseQuoteInput());

  it('is usable up to validUntil - 1n', () => {
    expect(isQuoteExpired(quote, quote.validUntil - 1n)).toBe(false);
    expect(isQuoteExpired(quote, 0n)).toBe(false);
  });

  it('expires AT validUntil and after', () => {
    expect(isQuoteExpired(quote, quote.validUntil)).toBe(true);
    expect(isQuoteExpired(quote, quote.validUntil + 1n)).toBe(true);
  });
});

describe('canonicalCryptoQuote', () => {
  it('renders structurally equal quotes identically', () => {
    const a = defineCryptoQuote(baseQuoteInput());
    const b = defineCryptoQuote(baseQuoteInput());
    expect(canonicalCryptoQuote(a)).toBe(canonicalCryptoQuote(b));
  });

  it('renders the documented field-by-field shape', () => {
    const canonical = canonicalCryptoQuote(defineCryptoQuote(baseQuoteInput()));
    expect(canonical).toBe(
      'cryptoQuote|id:quote:usdc:eur:001' +
        '|asset:asset:usdc' +
        '|chain:chain:ethereum' +
        '|fiat:EUR:10000' +
        '|crypto:asset:usdc:110000000' +
        '|ratio:10000/110000000' +
        '|fees:EUR:50' +
        '|quotedAt:1000' +
        '|validUntil:61000' +
        '|source:source:fx-desk:a1',
    );
  });

  it('changes when any single field changes', () => {
    const base = canonicalCryptoQuote(defineCryptoQuote(baseQuoteInput()));

    const otherSource = canonicalCryptoQuote(
      defineCryptoQuote(baseQuoteInput({ sourceRef: 'source:fx-desk:b2' })),
    );
    expect(otherSource).not.toBe(base);

    const otherChain = canonicalCryptoQuote(
      defineCryptoQuote(baseQuoteInput({ chainId: 'chain:base' })),
    );
    expect(otherChain).not.toBe(base);

    const otherFees = canonicalCryptoQuote(
      defineCryptoQuote(baseQuoteInput({ fees: fromMinorUnits(currencyCode('EUR'), 75n) })),
    );
    expect(otherFees).not.toBe(base);

    // Pure rendering check: a differing crypto value must change the string.
    const quote = defineCryptoQuote(baseQuoteInput());
    const variant: CryptoQuote = {
      ...quote,
      cryptoAmount: defineCryptoAmount(usdc, 220000000n),
    };
    expect(canonicalCryptoQuote(variant)).not.toBe(base);
  });
});

describe('cryptoQuoteHash', () => {
  it('is deterministic for equal quotes', () => {
    const a = defineCryptoQuote(baseQuoteInput());
    const b = defineCryptoQuote(baseQuoteInput());
    expect(cryptoQuoteHash(a)).toBe(cryptoQuoteHash(b));
  });

  it('differs when the quoted amounts differ', () => {
    const small = defineCryptoQuote(baseQuoteInput());
    // Twice the fiat for twice the crypto at the same exact ratio.
    const large = defineCryptoQuote(
      baseQuoteInput({
        fiatAmount: fromMinorUnits(currencyCode('EUR'), 20000n),
        cryptoAmount: defineCryptoAmount(usdc, 220000000n),
      }),
    );
    expect(cryptoQuoteHash(small)).not.toBe(cryptoQuoteHash(large));
  });

  it('carries the cqh: prefix', () => {
    expect(cryptoQuoteHash(defineCryptoQuote(baseQuoteInput())).startsWith('cqh:')).toBe(true);
  });
});

describe('quoteValidityWindow', () => {
  it('adds the validity duration to the quote time', () => {
    expect(quoteValidityWindow({ quotedAt: 1000n, validityMs: 60000n })).toBe(61000n);
  });

  it('rejects a non-positive validity window', () => {
    expect(() => quoteValidityWindow({ quotedAt: 1000n, validityMs: 0n })).toThrow(ValidationError);
    expect(() => quoteValidityWindow({ quotedAt: 1000n, validityMs: -1n })).toThrow(ValidationError);
  });
});

describe('materialTermsFromQuote', () => {
  const quote = defineCryptoQuote(baseQuoteInput());

  it('maps the quote onto canonical MaterialTerms', () => {
    const terms = materialTermsFromQuote(quote, {
      completionMs: 900000n,
      recourse: 'merchant-recourse-window',
      settlementDestinationId: 'dest:merchant:main',
    });
    expect(terms.amount).toBe(quote.fiatAmount);
    expect(terms.currency).toBe('EUR');
    expect(terms.fees).toBe(quote.fees);
    expect(terms.completionMs).toBe(900000n);
    expect(terms.recourse).toBe('merchant-recourse-window');
    expect(terms.settlementDestinationId).toBe('dest:merchant:main');
    expect(Object.isFrozen(terms)).toBe(true);
  });

  it('produces terms that hash identically to the canonical payment-plane form', () => {
    const terms = materialTermsFromQuote(quote, {
      completionMs: 900000n,
      recourse: 'merchant-recourse-window',
      settlementDestinationId: 'dest:merchant:main',
    });
    const equivalent: MaterialTerms = {
      amount: quote.fiatAmount,
      currency: quote.fiatAmount.currency,
      fees: quote.fees,
      completionMs: 900000n,
      recourse: 'merchant-recourse-window',
      settlementDestinationId: 'dest:merchant:main',
    };
    expect(materialTermsHash(terms)).toBe(materialTermsHash(equivalent));
  });

  it('rejects a non-positive completionMs', () => {
    expect(() =>
      materialTermsFromQuote(quote, {
        completionMs: 0n,
        recourse: 'merchant-recourse-window',
        settlementDestinationId: 'dest:merchant:main',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty recourse', () => {
    expect(() =>
      materialTermsFromQuote(quote, {
        completionMs: 900000n,
        recourse: '',
        settlementDestinationId: 'dest:merchant:main',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty settlementDestinationId', () => {
    expect(() =>
      materialTermsFromQuote(quote, {
        completionMs: 900000n,
        recourse: 'merchant-recourse-window',
        settlementDestinationId: '',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a quote whose fiat currency is not a 3-character ISO-style code', () => {
    // Direct construction must not bypass the canonical defineMaterialTerms
    // currency guard (a hand-tampered 2-character code is rejected).
    const tampered: CryptoQuote = {
      ...quote,
      fiatAmount: { ...quote.fiatAmount, currency: 'EU' } as unknown as CryptoQuote['fiatAmount'],
    };
    expect(() =>
      materialTermsFromQuote(tampered, {
        completionMs: 900000n,
        recourse: 'merchant-recourse-window',
        settlementDestinationId: 'dest:merchant:main',
      }),
    ).toThrow(ValidationError);
    expect(() =>
      materialTermsFromQuote(tampered, {
        completionMs: 900000n,
        recourse: 'merchant-recourse-window',
        settlementDestinationId: 'dest:merchant:main',
      }),
    ).toThrow('material terms currency must be an ISO-style code');
  });
});
