import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { activeBpsForCandle } from '../../src/activeLiquidity.js';
import { CoreError } from '../../src/errors.js';
import { feeGrowthDelta, feesForLiquidity, unboundedFees } from '../../src/feeGrowth.js';
import { tickRange } from '../../src/position.js';
import { FeeGrowthX128, type Liquidity, type Tick, UINT256_MAX } from '../../src/units.js';

const anyFeeGrowth = fc.bigInt({ min: 0n, max: UINT256_MAX }).map((v) => FeeGrowthX128.of(v));
const anyLiquidity = fc.bigInt({ min: 1n, max: 10n ** 27n }).map((v) => v as Liquidity);
const TWO256 = 1n << 256n;

describe('feeGrowthDelta', () => {
  it('equals (current − previous) mod 2^256, always non-negative', () => {
    fc.assert(
      fc.property(anyFeeGrowth, anyFeeGrowth, (a, b) => {
        const delta = feeGrowthDelta(a, b);
        expect(delta).toBe((((a - b) % TWO256) + TWO256) % TWO256);
        expect(delta >= 0n).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('handles the wrap case (current < previous) — which happens on real pools', () => {
    // feeGrowthGlobal wraps by design; a naive `current - previous` would go
    // negative here. The wrapped delta is the small positive increment.
    const prev = FeeGrowthX128.of(UINT256_MAX - 5n);
    const curr = FeeGrowthX128.of(10n);
    // (10 - (MAX-5)) mod 2^256 = 10 + 6 = 16
    expect(feeGrowthDelta(curr, prev)).toBe(16n);
  });

  it('is zero when nothing accrued', () => {
    fc.assert(
      fc.property(anyFeeGrowth, (a) => {
        expect(feeGrowthDelta(a, a)).toBe(0n);
      }),
    );
  });
});

describe('feesForLiquidity', () => {
  it('is homogeneous of degree one in liquidity', () => {
    fc.assert(
      fc.property(
        anyLiquidity,
        anyFeeGrowth,
        fc.integer({ min: 0, max: 10_000 }),
        fc.bigInt({ min: 2n, max: 1000n }),
        (l, delta, bps, k) => {
          const single = feesForLiquidity({
            liquidity: l,
            delta0: delta,
            delta1: delta,
            activeBps: bps,
          });
          const scaled = feesForLiquidity({
            liquidity: (l * k) as Liquidity,
            delta0: delta,
            delta1: delta,
            activeBps: bps,
          });
          // Scaling L by k scales the fee by k, up to one unit of floor rounding.
          const drift = scaled.amount0 - single.amount0 * k;
          expect(drift >= 0n && drift <= k).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('scales with the active fraction', () => {
    fc.assert(
      fc.property(anyLiquidity, anyFeeGrowth, (l, delta) => {
        const full = feesForLiquidity({
          liquidity: l,
          delta0: delta,
          delta1: delta,
          activeBps: 10_000,
        });
        const half = feesForLiquidity({
          liquidity: l,
          delta0: delta,
          delta1: delta,
          activeBps: 5_000,
        });
        const none = feesForLiquidity({ liquidity: l, delta0: delta, delta1: delta, activeBps: 0 });
        expect(none.amount0).toBe(0n);
        expect(half.amount0 <= full.amount0).toBe(true);
        // Half is within one unit of exactly half (integer floor).
        expect(full.amount0 / 2n - half.amount0 <= 1n).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('unbounded fees are the full-active case', () => {
    fc.assert(
      fc.property(anyLiquidity, anyFeeGrowth, anyFeeGrowth, (l, d0, d1) => {
        const u = unboundedFees({ liquidity: l, delta0: d0, delta1: d1 });
        const full = feesForLiquidity({ liquidity: l, delta0: d0, delta1: d1, activeBps: 10_000 });
        expect(u.amount0).toBe(full.amount0);
        expect(u.amount1).toBe(full.amount1);
      }),
    );
  });

  it('rejects a fractional or out-of-range activeBps', () => {
    const l = (10n ** 20n) as Liquidity;
    const d = FeeGrowthX128.of(1n << 128n);
    expect(() => feesForLiquidity({ liquidity: l, delta0: d, delta1: d, activeBps: 1.5 })).toThrow(
      CoreError,
    );
    expect(() =>
      feesForLiquidity({ liquidity: l, delta0: d, delta1: d, activeBps: 10_001 }),
    ).toThrow(CoreError);
  });
});

describe('activeBpsForCandle', () => {
  const range = tickRange(-1000 as Tick, 1000 as Tick);

  it('is 10000 when the candle sits inside the range', () => {
    expect(
      activeBpsForCandle({ range, candle: { lowTick: -500 as Tick, highTick: 500 as Tick } }),
    ).toBe(10_000);
  });

  it('is 0 when the candle is entirely outside', () => {
    expect(
      activeBpsForCandle({ range, candle: { lowTick: 2000 as Tick, highTick: 3000 as Tick } }),
    ).toBe(0);
  });

  it('is the overlap fraction for a straddling candle', () => {
    // Candle [0, 2000] overlaps range [-1000, 1000] over [0, 1000] = half.
    expect(
      activeBpsForCandle({ range, candle: { lowTick: 0 as Tick, highTick: 2000 as Tick } }),
    ).toBe(5_000);
  });

  it('treats a flat out-of-range hour as inactive, not fully active', () => {
    // The predecessor's bug: a zero-span candle returned "fully active" even
    // when the price sat outside the range.
    expect(
      activeBpsForCandle({ range, candle: { lowTick: 5000 as Tick, highTick: 5000 as Tick } }),
    ).toBe(0);
    expect(activeBpsForCandle({ range, candle: { lowTick: 0 as Tick, highTick: 0 as Tick } })).toBe(
      10_000,
    );
  });

  it('always returns an integer in [0, 10000]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5000, max: 5000 }),
        fc.integer({ min: -5000, max: 5000 }),
        (a, b) => {
          const bps = activeBpsForCandle({
            range,
            candle: { lowTick: a as Tick, highTick: b as Tick },
          });
          expect(Number.isInteger(bps)).toBe(true);
          expect(bps).toBeGreaterThanOrEqual(0);
          expect(bps).toBeLessThanOrEqual(10_000);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('widening the range never decreases activity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -3000, max: 3000 }),
        fc.integer({ min: -3000, max: 3000 }),
        fc.integer({ min: 100, max: 3000 }),
        (a, b, grow) => {
          const candle = { lowTick: Math.min(a, b) as Tick, highTick: Math.max(a, b) as Tick };
          const narrow = activeBpsForCandle({
            range: tickRange(-1000 as Tick, 1000 as Tick),
            candle,
          });
          const wide = activeBpsForCandle({
            range: tickRange((-1000 - grow) as Tick, (1000 + grow) as Tick),
            candle,
          });
          expect(wide).toBeGreaterThanOrEqual(narrow);
        },
      ),
      { numRuns: 300 },
    );
  });
});
