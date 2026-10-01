import { describe, expect, it } from 'vitest';
import {
  DeterministicClock,
  GHS,
  InsufficientLiquidityError,
  UnknownLiquidityAssetError,
  USD,
  createIdFactory,
  fromMinorUnits,
} from '../src/index.js';
import {
  InMemoryLiquidityReservationBook,
  asLiquidityAssetId,
  availableLiquidity,
  defineLiquidityAsset,
  forecastLiquidity,
  observeLiquidityPosition,
  reserveLiquidity,
  transitionLiquidityReservation,
  type ExpectedFlow,
  type LiquidityAssetId,
  type LiquidityLedgerState,
  type LiquidityPosition,
} from '../src/liquidity.js';

function usd(minorUnits: bigint) {
  return fromMinorUnits(USD, minorUnits);
}

function ghs(minorUnits: bigint) {
  return fromMinorUnits(GHS, minorUnits);
}

const ASSET_ID: LiquidityAssetId = asLiquidityAssetId('liq:merchant:usd');
const GHS_ASSET_ID: LiquidityAssetId = asLiquidityAssetId('liq:merchant:ghs');

function position(balance: bigint, assetId: LiquidityAssetId = ASSET_ID): LiquidityPosition {
  return observeLiquidityPosition({
    assetId,
    balance: usd(balance),
    asOf: 1_000n,
    provenance: {
      source: 'provider-balance-report',
      observationRef: 'obs-1',
      observedAt: 900n,
    },
  });
}

function state(
  positions: readonly LiquidityPosition[],
  seed = 1_000n,
): LiquidityLedgerState {
  const clock = new DeterministicClock(seed);
  return {
    positions: new Map(positions.map((entry) => [entry.assetId, entry] as const)),
    reservations: new InMemoryLiquidityReservationBook(),
    ids: createIdFactory(clock),
    clock,
  };
}

describe('liquidity assets and positions', () => {
  it('defines validated assets and observes positions with provenance (never custody)', () => {
    const asset = defineLiquidityAsset({
      id: ASSET_ID,
      label: 'Merchant USD settlement account',
      kind: 'SETTLEMENT_ACCOUNT',
      currency: USD,
      venue: 'rail:bank:usd:issuer-x',
    });
    expect(asset.id).toBe(ASSET_ID);
    const observed = position(10_000n);
    expect(observed.provenance.source).toBe('provider-balance-report');
    expect(observed.balance.value).toBe(10_000n);
  });

  it('rejects malformed assets and impossible observations', () => {
    expect(() =>
      defineLiquidityAsset({
        id: 'x',
        label: '',
        kind: 'WALLET',
        currency: USD,
        venue: 'v',
      }),
    ).toThrow(/label/);
    expect(() =>
      observeLiquidityPosition({
        assetId: ASSET_ID,
        balance: usd(-1n),
        asOf: 1_000n,
        provenance: { source: 's', observationRef: 'r', observedAt: 900n },
      }),
    ).toThrow(/negative/);
    expect(() =>
      observeLiquidityPosition({
        assetId: ASSET_ID,
        balance: usd(1n),
        asOf: 1_000n,
        provenance: { source: 's', observationRef: 'r', observedAt: 2_000n },
      }),
    ).toThrow(/after the position asOf/);
  });
});

describe('reserveLiquidity (atomic, INV-F04)', () => {
  it('places a hold within observed availability and reduces availability', () => {
    const ledger = state([position(10_000n)]);
    const first = reserveLiquidity(ledger, {
      assetId: ASSET_ID,
      amount: usd(4_000n),
      refs: { purpose: 'settlement-instruction-backing' },
    });
    expect(first.state).toBe('PENDING');
    expect(first.amount.value).toBe(4_000n);
    const availability = availableLiquidity(ledger, ASSET_ID);
    expect(availability.held.value).toBe(4_000n);
    expect(availability.available.value).toBe(6_000n);

    const second = reserveLiquidity(ledger, {
      assetId: ASSET_ID,
      amount: usd(6_000n),
      refs: { purpose: 'settlement-instruction-backing' },
    });
    expect(second.state).toBe('PENDING');
    expect(availableLiquidity(ledger, ASSET_ID).available.value).toBe(0n);
  });

  it('is atomic: an over-demanding hold throws and leaves the book untouched', () => {
    const ledger = state([position(10_000n)]);
    reserveLiquidity(ledger, {
      assetId: ASSET_ID,
      amount: usd(7_000n),
      refs: { purpose: 'backing' },
    });
    expect(() =>
      reserveLiquidity(ledger, {
        assetId: ASSET_ID,
        amount: usd(4_000n),
        refs: { purpose: 'backing' },
      }),
    ).toThrow(InsufficientLiquidityError);
    expect(ledger.reservations.all.length).toBe(1);
    expect(availableLiquidity(ledger, ASSET_ID).available.value).toBe(3_000n);
  });

  it('unknown assets are rejected; released holds free capacity again', () => {
    const ledger = state([position(10_000n)]);
    expect(() =>
      reserveLiquidity(ledger, {
        assetId: asLiquidityAssetId('liq:unknown'),
        amount: usd(1n),
        refs: { purpose: 'backing' },
      }),
    ).toThrow(UnknownLiquidityAssetError);
    const hold = reserveLiquidity(ledger, {
      assetId: ASSET_ID,
      amount: usd(10_000n),
      refs: { purpose: 'backing' },
    });
    const released = transitionLiquidityReservation(ledger, hold.id, 'RELEASE');
    expect(released.state).toBe('RELEASED');
    expect(availableLiquidity(ledger, ASSET_ID).available.value).toBe(10_000n);
  });

  it('rides the shared W1-002 reservation state machine (terminality is monotonic)', () => {
    const ledger = state([position(10_000n)]);
    const hold = reserveLiquidity(ledger, {
      assetId: ASSET_ID,
      amount: usd(1_000n),
      refs: { purpose: 'backing' },
    });
    const captured = transitionLiquidityReservation(ledger, hold.id, 'ACTIVATE');
    expect(captured.state).toBe('ACTIVE');
    const done = transitionLiquidityReservation(ledger, hold.id, 'CAPTURE');
    expect(done.state).toBe('CAPTURED');
    expect(() => transitionLiquidityReservation(ledger, hold.id, 'RELEASE')).toThrow(
      /terminal/i,
    );
  });
});

describe('forecastLiquidity (deterministic, injected clock)', () => {
  function flow(
    assetId: LiquidityAssetId,
    direction: 'INFLOW' | 'OUTFLOW',
    amount: bigint,
    expectedAt: bigint,
  ): ExpectedFlow {
    return {
      assetId,
      direction,
      amount: usd(amount),
      expectedAt,
      certainty: 'FORECAST',
    };
  }

  it('detects the projected gap with the deepest deficit and its time', () => {
    const clock = new DeterministicClock(1_000n);
    const forecast = forecastLiquidity(
      [position(100n)],
      [
        flow(ASSET_ID, 'OUTFLOW', 500n, 2_000n),
        flow(ASSET_ID, 'INFLOW', 800n, 4_000n),
        flow(ASSET_ID, 'OUTFLOW', 200n, 3_000n),
      ],
      clock,
      10_000n,
    );
    expect(forecast.asOf).toBe(1_000n);
    expect(forecast.horizon).toBe(10_000n);
    expect(forecast.expectedInflows.length).toBe(1);
    expect(forecast.expectedOutflows.length).toBe(2);
    // running: 100 → −400 (t2k) → −600 (t3k) → +200 (t4k); deepest −600 @3k
    expect(forecast.gaps.length).toBe(1);
    expect(forecast.gaps[0]?.assetId).toBe(ASSET_ID);
    expect(forecast.gaps[0]?.shortfall.value).toBe(600n);
    expect(forecast.gaps[0]?.atTime).toBe(3_000n);
  });

  it('reports no gap when flows stay covered; ignores flows beyond the horizon', () => {
    const clock = new DeterministicClock(1_000n);
    const forecast = forecastLiquidity(
      [position(1_000n)],
      [
        flow(ASSET_ID, 'OUTFLOW', 500n, 2_000n),
        flow(ASSET_ID, 'OUTFLOW', 999_999n, 50_000n), // beyond horizon — excluded
      ],
      clock,
      10_000n,
    );
    expect(forecast.gaps.length).toBe(0);
    expect(forecast.expectedOutflows.length).toBe(1);
  });

  it('is deterministic: identical inputs produce byte-identical forecasts', () => {
    const build = () =>
      forecastLiquidity(
        [position(100n)],
        [
          flow(ASSET_ID, 'OUTFLOW', 500n, 2_000n),
          flow(ASSET_ID, 'INFLOW', 800n, 4_000n),
        ],
        new DeterministicClock(1_000n),
        10_000n,
      );
    const render = (input: ReturnType<typeof build>): string =>
      JSON.stringify(input, (key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
    expect(render(build())).toBe(render(build()));
  });

  it('forecasts per-asset in multiple currencies without mixing them', () => {
    const clock = new DeterministicClock(1_000n);
    const ghsAsset = GHS_ASSET_ID;
    const forecast = forecastLiquidity(
      [position(100n), observeLiquidityPosition({
        assetId: ghsAsset,
        balance: ghs(500n),
        asOf: 1_000n,
        provenance: { source: 's', observationRef: 'r', observedAt: 900n },
      })],
      [
        { assetId: ASSET_ID, direction: 'OUTFLOW', amount: usd(300n), expectedAt: 2_000n, certainty: 'CERTAIN' },
        { assetId: ghsAsset, direction: 'OUTFLOW', amount: ghs(900n), expectedAt: 2_000n, certainty: 'CERTAIN' },
      ],
      clock,
      10_000n,
    );
    expect(forecast.gaps.length).toBe(2);
    expect(forecast.gaps.map((gap) => gap.currency).sort()).toEqual([GHS, USD].sort());
  });
});
