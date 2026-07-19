import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/errors.js';
import {
  hodlBasketOf,
  hodlValue,
  impermanentLoss,
  positionFromNotional,
  positionValue,
  sizingQuantum,
  tickRange,
} from '../../src/position.js';
import { type Orientation, type PriceScale, priceAtTick, priceScale } from '../../src/price.js';
import type { HumanPrice, Tick } from '../../src/units.js';
import { DECIMAL_PAIRS, testPool } from '../helpers/pools.js';

/** Ranges and prices around a realistic band, wide enough to hold real value. */
const centre = fc.integer({ min: -200_000, max: 200_000 });
const width = fc.integer({ min: 60, max: 60_000 });

/**
 * Decimals that real pools use. The 0-decimals pairs in DECIMAL_PAIRS are kept
 * for the tick and price tests, where they probe the scaling factor — but for
 * position sizing they are pathological: one unit of L can be worth thousands
 * of quote tokens, so integer quantization, not the math, dominates every
 * result. `sizingQuantum` is the supported way to detect that; the dedicated
 * test below covers it.
 */
const anyDecimals = fc.constantFrom(...DECIMAL_PAIRS.filter(([d0, d1]) => d0 >= 6 && d1 >= 6));
const anyOrientation = fc.constantFrom<Orientation>('token1PerToken0', 'token0PerToken1');
const anyNotional = fc.double({ min: 100, max: 1e7, noNaN: true, noDefaultInfinity: true });

interface Setup {
  scale: PriceScale;
  range: ReturnType<typeof tickRange>;
  entryPrice: HumanPrice;
}

const anySetup = fc
  .tuple(centre, width, anyDecimals, anyOrientation)
  .map(([c, w, [d0, d1], orientation]): Setup => {
    const scale = priceScale(testPool(d0, d1), orientation);
    const range = tickRange((c - w) as Tick, (c + w) as Tick);
    return { scale, range, entryPrice: priceAtTick(scale, c as Tick) };
  });

/** A price offset by `ticks` from entry, staying inside the representable band. */
function priceAt(setup: Setup, tick: number): HumanPrice {
  return priceAtTick(setup.scale, Math.max(-880_000, Math.min(880_000, tick)) as Tick);
}

/**
 * Some draws ask for a notional the pool cannot represent — a wide range where
 * one token's share floors to zero. `positionFromNotional` refuses those rather
 * than returning a position worth a fraction of the request, so they are
 * outside the domain, not counterexamples. Every other failure still propagates.
 */
function positionOrSkip(args: Parameters<typeof positionFromNotional>[0]) {
  try {
    return positionFromNotional(args);
  } catch (error) {
    if (error instanceof CoreError && error.code === 'UNREPRESENTABLE_POSITION') {
      fc.pre(false);
    }
    throw error;
  }
}

describe('positionFromNotional', () => {
  it('produces a position worth the requested notional', () => {
    fc.assert(
      fc.property(anySetup, anyNotional, (setup, notional) => {
        const position = positionOrSkip({ ...setup, price: setup.entryPrice, notional });
        const { value } = positionValue({
          scale: setup.scale,
          position,
          price: setup.entryPrice,
        });
        // The guard inside positionFromNotional enforces exactly this bound —
        // anything worse is refused rather than returned, so a position that
        // exists is a position that hit its target.
        expect(Math.abs(value - notional) / notional).toBeLessThanOrEqual(1e-6);
      }),
      { numRuns: 300 },
    );
  });

  it('scales liquidity linearly with notional', () => {
    fc.assert(
      fc.property(
        anySetup,
        anyNotional,
        fc.double({ min: 2, max: 100, noNaN: true }),
        (setup, notional, k) => {
          const single = positionOrSkip({ ...setup, price: setup.entryPrice, notional });
          const scaled = positionOrSkip({
            ...setup,
            price: setup.entryPrice,
            notional: notional * k,
          });
          const ratio = Number(scaled.liquidity) / Number(single.liquidity);
          const bound = Math.max(1e-9, 2 * sizingQuantum(single));
          expect(Math.abs(ratio - k) / k).toBeLessThan(bound);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('treats leverage as a multiplier on notional', () => {
    fc.assert(
      fc.property(
        anySetup,
        anyNotional,
        fc.double({ min: 1, max: 10, noNaN: true }),
        (setup, notional, leverage) => {
          const levered = positionOrSkip({
            ...setup,
            price: setup.entryPrice,
            notional,
            leverage,
          });
          const plain = positionOrSkip({
            ...setup,
            price: setup.entryPrice,
            notional: notional * leverage,
          });
          const drift =
            Math.abs(Number(levered.liquidity) - Number(plain.liquidity)) / Number(plain.liquidity);
          expect(drift).toBeLessThan(Math.max(1e-9, 2 * sizingQuantum(plain)));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('exposes the integer quantization instead of hiding it', () => {
    const fine = priceScale(testPool(6, 18), 'token0PerToken1');
    const position = positionFromNotional({
      scale: fine,
      range: tickRange(-60_000 as Tick, -50_000 as Tick),
      price: priceAtTick(fine, -55_000 as Tick),
      notional: 10_000,
    });
    // On a real pool one unit of L is a rounding error; callers can confirm it
    // rather than take it on faith.
    expect(sizingQuantum(position)).toBeLessThan(1e-9);
  });

  it('refuses a notional the pool cannot represent, rather than halving it', () => {
    // A regression witness for a real defect found here: at this price one unit
    // of token1 costs ~5e20 token0, so a 100-token0 notional buys a fraction of
    // token1's smallest unit. It floors to zero and the position comes out worth
    // half the request. Silently returning that is exactly the failure mode this
    // core exists to prevent.
    const scale = priceScale(testPool(6, 18), 'token0PerToken1');
    const range = tickRange(-260_000 as Tick, -140_000 as Tick);
    const price = priceAtTick(scale, -200_000 as Tick);

    expect(() => positionFromNotional({ scale, range, price, notional: 100 })).toThrow(
      /UNREPRESENTABLE_POSITION/,
    );

    // The same pool and range accept a notional large enough to represent.
    const viable = positionFromNotional({ scale, range, price, notional: 1e12 });
    expect(positionValue({ scale, position: viable, price }).value).toBeCloseTo(1e12, -6);
  });

  it('rejects a non-positive notional or leverage', () => {
    const scale = priceScale(testPool(6, 18), 'token1PerToken0');
    const range = tickRange(-600 as Tick, 600 as Tick);
    const price = priceAtTick(scale, 0 as Tick);
    expect(() => positionOrSkip({ scale, range, price, notional: 0 })).toThrow(CoreError);
    expect(() => positionOrSkip({ scale, range, price, notional: -1 })).toThrow(CoreError);
    expect(() => positionOrSkip({ scale, range, price, notional: 1, leverage: 0 })).toThrow(
      CoreError,
    );
  });
});

describe('positionValue', () => {
  it('reports a token ratio in [0, 1] that tracks the range', () => {
    fc.assert(
      fc.property(anySetup, fc.integer({ min: -80_000, max: 80_000 }), (setup, offset) => {
        const position = positionOrSkip({
          ...setup,
          price: setup.entryPrice,
          notional: 10_000,
        });
        const price = priceAt(setup, setup.range.lower + offset);
        const v = positionValue({ scale: setup.scale, position, price });

        expect(v.ratio0).toBeGreaterThanOrEqual(0);
        expect(v.ratio0).toBeLessThanOrEqual(1);
        expect(Number.isFinite(v.value)).toBe(true);
        expect(v.value).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it('holds only token0 below the range and only token1 above it', () => {
    fc.assert(
      fc.property(anySetup, (setup) => {
        const position = positionOrSkip({
          ...setup,
          price: setup.entryPrice,
          notional: 10_000,
        });
        // Stand a few ticks clear of the boundary: positionValue takes a *human*
        // price, and converting one back to a sqrt ratio is only good to about a
        // tick, so a one-tick margin is inside the noise.
        const below = positionValue({
          scale: setup.scale,
          position,
          price: priceAt(setup, setup.range.lower - 5),
        });
        const above = positionValue({
          scale: setup.scale,
          position,
          price: priceAt(setup, setup.range.upper + 5),
        });

        expect(below.amount1).toBe(0);
        expect(above.amount0).toBe(0);
        expect(below.inRange).toBe(false);
        expect(above.inRange).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

describe('impermanentLoss', () => {
  it('is exactly zero at the entry price', () => {
    fc.assert(
      fc.property(anySetup, (setup) => {
        const position = positionOrSkip({
          ...setup,
          price: setup.entryPrice,
          notional: 10_000,
        });
        const il = impermanentLoss({
          scale: setup.scale,
          position,
          entryPrice: setup.entryPrice,
          price: setup.entryPrice,
        });
        expect(Math.abs(il)).toBeLessThan(1e-12);
      }),
      { numRuns: 200 },
    );
  });

  it('is never positive — an LP cannot beat holding the same basket', () => {
    // The defining property of impermanent loss. If this ever goes positive,
    // either the valuation or the branch selection is wrong.
    fc.assert(
      fc.property(anySetup, fc.integer({ min: -100_000, max: 100_000 }), (setup, offset) => {
        const position = positionOrSkip({
          ...setup,
          price: setup.entryPrice,
          notional: 10_000,
        });
        const il = impermanentLoss({
          scale: setup.scale,
          position,
          entryPrice: setup.entryPrice,
          price: priceAt(setup, setup.range.lower + offset),
        });
        // A small positive tolerance absorbs float rounding at the entry point.
        expect(il).toBeLessThan(1e-9);
      }),
      { numRuns: 500 },
    );
  });

  it('worsens monotonically as price moves further from entry', () => {
    fc.assert(
      fc.property(anySetup, fc.integer({ min: 100, max: 50_000 }), (setup, step) => {
        const position = positionOrSkip({
          ...setup,
          price: setup.entryPrice,
          notional: 10_000,
        });
        const centreTick = (setup.range.lower + setup.range.upper) / 2;
        const near = impermanentLoss({
          scale: setup.scale,
          position,
          entryPrice: setup.entryPrice,
          price: priceAt(setup, centreTick + step),
        });
        const far = impermanentLoss({
          scale: setup.scale,
          position,
          entryPrice: setup.entryPrice,
          price: priceAt(setup, centreTick + step * 2),
        });
        expect(far).toBeLessThanOrEqual(near + 1e-9);
      }),
      { numRuns: 300 },
    );
  });
});

describe('hodl basket', () => {
  it('is worth the position’s value at entry, by construction', () => {
    fc.assert(
      fc.property(anySetup, anyNotional, (setup, notional) => {
        const position = positionOrSkip({ ...setup, price: setup.entryPrice, notional });
        const basket = hodlBasketOf({
          scale: setup.scale,
          position,
          entryPrice: setup.entryPrice,
        });
        const atEntry = hodlValue({ scale: setup.scale, basket, price: setup.entryPrice });
        const lp = positionValue({ scale: setup.scale, position, price: setup.entryPrice }).value;
        expect(Math.abs(atEntry - lp) / lp).toBeLessThan(1e-12);
      }),
      { numRuns: 200 },
    );
  });

  it('is linear in price — it is just two fixed token balances', () => {
    fc.assert(
      fc.property(anySetup, (setup) => {
        const position = positionOrSkip({
          ...setup,
          price: setup.entryPrice,
          notional: 10_000,
        });
        const basket = hodlBasketOf({
          scale: setup.scale,
          position,
          entryPrice: setup.entryPrice,
        });
        const p1 = priceAt(setup, setup.range.lower);
        const p2 = priceAt(setup, setup.range.upper);
        const mid = ((p1 + p2) / 2) as HumanPrice;

        const v1 = hodlValue({ scale: setup.scale, basket, price: p1 });
        const v2 = hodlValue({ scale: setup.scale, basket, price: p2 });
        const vMid = hodlValue({ scale: setup.scale, basket, price: mid });

        expect(Math.abs(vMid - (v1 + v2) / 2) / Math.max(vMid, 1e-9)).toBeLessThan(1e-9);
      }),
      { numRuns: 200 },
    );
  });
});
