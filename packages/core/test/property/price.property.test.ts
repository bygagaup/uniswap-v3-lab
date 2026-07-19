import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/errors.js';
import {
  flip,
  type Orientation,
  priceAtSqrtRatio,
  priceAtTick,
  priceScale,
  snapPrice,
  sqrtRatioAtPrice,
  sqrtRatioAtPriceExact,
  tickAtPrice,
} from '../../src/price.js';
import { getSqrtRatioAtTick, getTickAtSqrtRatio } from '../../src/tickMath.js';
import { type HumanPrice, MAX_TICK, MIN_TICK, type Tick } from '../../src/units.js';
import { DECIMAL_PAIRS, testPool } from '../helpers/pools.js';

const anyTick = fc.integer({ min: MIN_TICK, max: MAX_TICK }).map((t) => t as Tick);
const anyDecimals = fc.constantFrom(...DECIMAL_PAIRS);
const anyOrientation = fc.constantFrom<Orientation>('token1PerToken0', 'token0PerToken1');

function scaleFor([d0, d1]: readonly [number, number], orientation: Orientation) {
  return priceScale(testPool(d0, d1), orientation);
}

/** Relative comparison — these values span 1e-57 to 1e57, so absolute epsilons are useless. */
function expectClose(actual: number, expected: number, tolerance = 1e-12) {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance);
}

describe('priceScale orientation', () => {
  it('flip is an involution', () => {
    fc.assert(
      fc.property(anyDecimals, anyOrientation, (d, o) => {
        const s = scaleFor(d, o);
        expect(flip(flip(s))).toEqual(s);
      }),
    );
  });

  it('flipping the scale reciprocates the price', () => {
    fc.assert(
      fc.property(anyTick, anyDecimals, anyOrientation, (t, d, o) => {
        const s = scaleFor(d, o);
        expectClose(priceAtTick(flip(s), t), 1 / priceAtTick(s, t), 1e-14);
      }),
    );
  });

  it('names the quote and base tokens the way the label reads', () => {
    const s = priceScale(testPool(6, 18), 'token1PerToken0');
    expect(s.label).toBe(`${s.quoteToken.symbol} per ${s.baseToken.symbol}`);
    expect(s.baseToken).toBe(s.pool.token0);
    expect(s.quoteToken).toBe(s.pool.token1);
  });
});

describe('tick <-> price', () => {
  it('round-trips every tick, for every decimal pair and orientation', () => {
    fc.assert(
      fc.property(anyTick, anyDecimals, anyOrientation, (t, d, o) => {
        const s = scaleFor(d, o);
        expect(tickAtPrice(s, priceAtTick(s, t))).toBe(t);
      }),
    );
  });

  it('is monotonic in the forward orientation and antitonic in the flipped one', () => {
    fc.assert(
      fc.property(anyTick, anyTick, anyDecimals, (a, b, d) => {
        fc.pre(a !== b);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const fwd = scaleFor(d, 'token1PerToken0');
        const rev = scaleFor(d, 'token0PerToken1');
        expect(priceAtTick(fwd, lo)).toBeLessThan(priceAtTick(fwd, hi));
        expect(priceAtTick(rev, lo)).toBeGreaterThan(priceAtTick(rev, hi));
      }),
    );
  });

  it('snapPrice is idempotent', () => {
    fc.assert(
      fc.property(anyTick, anyDecimals, anyOrientation, (t, d, o) => {
        const s = scaleFor(d, o);
        const once = snapPrice(s, priceAtTick(s, t));
        expect(snapPrice(s, once)).toBe(once);
      }),
    );
  });

  it('rejects a price outside the tick range instead of clamping to it', () => {
    const s = scaleFor([18, 18], 'token1PerToken0');
    expect(() => tickAtPrice(s, 1e300 as HumanPrice)).toThrow(CoreError);
    expect(() => tickAtPrice(s, 1e-300 as HumanPrice)).toThrow(CoreError);
  });
});

describe('price <-> sqrt ratio', () => {
  it('agrees with priceAtTick when the ratio came from that tick', () => {
    fc.assert(
      fc.property(anyTick, anyDecimals, anyOrientation, (t, d, o) => {
        const s = scaleFor(d, o);
        expectClose(priceAtSqrtRatio(s, getSqrtRatioAtTick(t)), priceAtTick(s, t), 1e-9);
      }),
    );
  });

  it('sqrtRatioAtPrice lands on the tick grid', () => {
    fc.assert(
      fc.property(anyTick, anyDecimals, anyOrientation, (t, d, o) => {
        const s = scaleFor(d, o);
        const sqrtP = sqrtRatioAtPrice(s, priceAtTick(s, t));
        expect(sqrtP).toBe(getSqrtRatioAtTick(t));
      }),
    );
  });

  it('sqrtRatioAtPriceExact stays within one tick of the snapped value', () => {
    // It skips the grid, so it may fall anywhere inside the tick it belongs to —
    // but never further. This is the bound that makes it safe for curve sampling.
    fc.assert(
      fc.property(
        fc.integer({ min: MIN_TICK / 2, max: MAX_TICK / 2 }).map((t) => t as Tick),
        anyDecimals,
        anyOrientation,
        (t, d, o) => {
          const s = scaleFor(d, o);
          const price = priceAtTick(s, t);
          const approxTick = getTickAtSqrtRatio(sqrtRatioAtPriceExact(s, price));
          expect(Math.abs(approxTick - t)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});
