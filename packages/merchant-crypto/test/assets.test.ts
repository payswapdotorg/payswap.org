import { describe, expect, it } from 'vitest';
import { ValidationError } from '@payswap/protocol';
import {
  InvalidCryptoAmountError,
  addCryptoAmounts,
  asChainId,
  asCryptoAssetId,
  compareCryptoAmounts,
  defineCryptoAmount,
  defineCryptoAsset,
  equalsCryptoAmount,
  isCryptoAmountPositive,
  subCryptoAmounts,
  type CryptoAsset,
  type CryptoAssetKind,
} from '../src/index.js';

const usdc: CryptoAsset = defineCryptoAsset({
  id: 'asset:usdc',
  displayName: 'USD Coin',
  symbol: 'USDC',
  decimals: 6,
  kind: 'STABLECOIN',
});

const ether: CryptoAsset = defineCryptoAsset({
  id: 'asset:ether',
  displayName: 'Ether',
  symbol: 'ETH',
  decimals: 18,
  kind: 'NATIVE_CRYPTO',
});

describe('defineCryptoAsset', () => {
  it('defines a frozen USDC asset with the declared fields', () => {
    expect(usdc.id).toBe('asset:usdc');
    expect(usdc.displayName).toBe('USD Coin');
    expect(usdc.symbol).toBe('USDC');
    expect(usdc.decimals).toBe(6);
    expect(usdc.kind).toBe('STABLECOIN');
    expect(Object.isFrozen(usdc)).toBe(true);
  });

  it('rejects an empty id', () => {
    expect(() =>
      defineCryptoAsset({
        id: '',
        displayName: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        kind: 'STABLECOIN',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a lowercase symbol', () => {
    expect(() =>
      defineCryptoAsset({
        id: 'asset:usdc',
        displayName: 'USD Coin',
        symbol: 'usdc',
        decimals: 6,
        kind: 'STABLECOIN',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a one-character symbol', () => {
    expect(() =>
      defineCryptoAsset({
        id: 'asset:usdc',
        displayName: 'USD Coin',
        symbol: 'U',
        decimals: 6,
        kind: 'STABLECOIN',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a seventeen-character symbol', () => {
    expect(() =>
      defineCryptoAsset({
        id: 'asset:usdc',
        displayName: 'USD Coin',
        symbol: 'ABCDEFGHIJKLMNOPQ',
        decimals: 6,
        kind: 'STABLECOIN',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects negative decimals', () => {
    expect(() =>
      defineCryptoAsset({
        id: 'asset:usdc',
        displayName: 'USD Coin',
        symbol: 'USDC',
        decimals: -1,
        kind: 'STABLECOIN',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects decimals above eighteen', () => {
    expect(() =>
      defineCryptoAsset({
        id: 'asset:usdc',
        displayName: 'USD Coin',
        symbol: 'USDC',
        decimals: 19,
        kind: 'STABLECOIN',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects non-integer decimals at runtime (INV-F01: no float scale)', () => {
    expect(() =>
      defineCryptoAsset({
        id: 'asset:usdc',
        displayName: 'USD Coin',
        symbol: 'USDC',
        decimals: 2.5 as unknown as number,
        kind: 'STABLECOIN',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty displayName', () => {
    expect(() =>
      defineCryptoAsset({
        id: 'asset:usdc',
        displayName: '',
        symbol: 'USDC',
        decimals: 6,
        kind: 'STABLECOIN',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an undeclared kind', () => {
    expect(() =>
      defineCryptoAsset({
        id: 'asset:fake',
        displayName: 'Fake',
        symbol: 'FAKE',
        decimals: 6,
        kind: 'FAKE' as unknown as CryptoAssetKind,
      }),
    ).toThrow(ValidationError);
  });
});

describe('defineCryptoAmount', () => {
  it('defines a positive amount with decimals copied from the asset', () => {
    const amount = defineCryptoAmount(usdc, 110000000n);
    expect(amount.assetId).toBe('asset:usdc');
    expect(amount.value).toBe(110000000n);
    expect(amount.decimals).toBe(usdc.decimals);
    expect(Object.isFrozen(amount)).toBe(true);
    expect(isCryptoAmountPositive(amount)).toBe(true);
  });

  it('rejects a negative value', () => {
    expect(() => defineCryptoAmount(usdc, -1n)).toThrow(ValidationError);
  });

  it('allows zero (not positive, but well-formed)', () => {
    const zero = defineCryptoAmount(usdc, 0n);
    expect(zero.value).toBe(0n);
    expect(isCryptoAmountPositive(zero)).toBe(false);
  });

  it('always carries the asset decimals exactly', () => {
    const wei = defineCryptoAmount(ether, 1000000000000000000n);
    expect(wei.decimals).toBe(18);
    expect(defineCryptoAmount(usdc, 1n).decimals).toBe(6);
  });

  it('keeps value as bigint — INV-F01 structural assertion', () => {
    expect(typeof defineCryptoAmount(usdc, 42n).value).toBe('bigint');
  });
});

describe('addCryptoAmounts', () => {
  it('sums same-asset amounts into a new frozen amount', () => {
    const a = defineCryptoAmount(usdc, 1n);
    const b = defineCryptoAmount(usdc, 2n);
    const sum = addCryptoAmounts(a, b);
    expect(sum.value).toBe(3n);
    expect(sum.assetId).toBe('asset:usdc');
    expect(sum.decimals).toBe(6);
    expect(Object.isFrozen(sum)).toBe(true);
    expect(a.value).toBe(1n);
    expect(b.value).toBe(2n);
  });

  it('throws InvalidCryptoAmountError when assetIds differ', () => {
    const a = defineCryptoAmount(usdc, 1n);
    const b = defineCryptoAmount(ether, 1n);
    expect(() => addCryptoAmounts(a, b)).toThrow(InvalidCryptoAmountError);
  });

  it('throws InvalidCryptoAmountError when decimals differ for the same id', () => {
    const usdcEighteen = defineCryptoAsset({
      id: 'asset:usdc',
      displayName: 'USD Coin (alternate scale)',
      symbol: 'USDC',
      decimals: 18,
      kind: 'STABLECOIN',
    });
    const a = defineCryptoAmount(usdc, 1n);
    const b = defineCryptoAmount(usdcEighteen, 1n);
    expect(a.assetId).toBe(b.assetId);
    expect(() => addCryptoAmounts(a, b)).toThrow(InvalidCryptoAmountError);
  });
});

describe('subCryptoAmounts', () => {
  it('subtracts same-asset amounts exactly', () => {
    const difference = subCryptoAmounts(defineCryptoAmount(usdc, 5n), defineCryptoAmount(usdc, 3n));
    expect(difference.value).toBe(2n);
    expect(Object.isFrozen(difference)).toBe(true);
  });

  it('throws on underflow instead of going negative', () => {
    expect(() =>
      subCryptoAmounts(defineCryptoAmount(usdc, 3n), defineCryptoAmount(usdc, 5n)),
    ).toThrow(InvalidCryptoAmountError);
    expect(() =>
      subCryptoAmounts(defineCryptoAmount(usdc, 3n), defineCryptoAmount(usdc, 5n)),
    ).toThrow('crypto amount subtraction would go negative');
  });
});

describe('compareCryptoAmounts / equalsCryptoAmount', () => {
  it('orders same-asset amounts (-1 / 0 / +1)', () => {
    const one = defineCryptoAmount(usdc, 1n);
    const two = defineCryptoAmount(usdc, 2n);
    expect(compareCryptoAmounts(one, two)).toBe(-1);
    expect(compareCryptoAmounts(two, one)).toBe(1);
    expect(compareCryptoAmounts(one, defineCryptoAmount(usdc, 1n))).toBe(0);
  });

  it('equalsCryptoAmount is structural, not referential', () => {
    const a = defineCryptoAmount(usdc, 7n);
    const b = defineCryptoAmount(usdc, 7n);
    expect(a).not.toBe(b);
    expect(equalsCryptoAmount(a, b)).toBe(true);
    expect(equalsCryptoAmount(a, defineCryptoAmount(usdc, 8n))).toBe(false);
  });

  it('amounts of different assets are never equal (no throw)', () => {
    expect(equalsCryptoAmount(defineCryptoAmount(usdc, 1n), defineCryptoAmount(ether, 1n))).toBe(
      false,
    );
  });

  it('compareCryptoAmounts throws across assets', () => {
    expect(() =>
      compareCryptoAmounts(defineCryptoAmount(usdc, 1n), defineCryptoAmount(ether, 1n)),
    ).toThrow(InvalidCryptoAmountError);
  });
});

describe('branded ids', () => {
  it('asCryptoAssetId rejects whitespace padding', () => {
    expect(() => asCryptoAssetId(' asset:usdc ')).toThrow(ValidationError);
    expect(() => asCryptoAssetId('\tasset:usdc')).toThrow(ValidationError);
  });

  it('asCryptoAssetId rejects ids longer than 256 characters', () => {
    expect(() => asCryptoAssetId('a'.repeat(257))).toThrow(ValidationError);
    expect(asCryptoAssetId('a'.repeat(256))).toBe('a'.repeat(256));
  });

  it('asChainId validates the same way', () => {
    expect(asChainId('chain:ethereum')).toBe('chain:ethereum');
    expect(() => asChainId(' chain:ethereum')).toThrow(ValidationError);
    expect(() => asChainId('c'.repeat(257))).toThrow(ValidationError);
  });
});
