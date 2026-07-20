import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/errors.js';
import {
  type CurvePoint,
  impermanentLossCurve,
  payoffCurve,
  priceGrid,
  relativeDifference,
} from '../../src/payoff.js';
import { tickRange } from '../../src/position.js';
import { type Orientation, type PriceScale, priceAtTick, priceScale } from '../../src/price.js';
import type { HumanPrice, Tick } from '../../src/units.js';
import { DECIMAL_PAIRS, testPool } from '../helpers/pools.js';

const centre = fc.integer({ min: -180_000, max: 180_000 });
const width = fc.integer({ min: 600, max: 40_000 });
const anyDecimals = fc.constantFrom(...DECIMAL_PAIRS.filter(([d0, d1]) => d0 >= 6 && d1 >= 6));
const anyOrientation = fc.constantFrom<Orientation>('token1PerToken0', 'token0PerToken1');

interface Setup {
  scale: PriceScale;
  range: ReturnType<typeof tickRange>;
  entryPrice: HumanPrice;
}

/**
 * Real pools sit at prices within a few orders of magnitude of 1. A (6,18) pool
 * at tick 0 would price a token at 1e-12 — a legitimate coordinate but not a
 * pool anyone runs; sampling those just tests float behaviour at the extremes
 * of the tick range, which the tick-math suite already pins. Filter the setups
 * to the band the simulator actually targets.
 */
const anySetup = fc
  .tuple(centre, width, anyDecimals, anyOrientation)
  .map(([c, w, [d0, d1], orientation]): Setup => {
    const scale = priceScale(testPool(d0, d1), orientation);
    return {
      scale,
      range: tickRange((c - w) as Tick, (c + w) as Tick),
      entryPrice: priceAtTick(scale, c as Tick),
    };
  })
  .filter((s) => s.entryPrice >= 1e-6 && s.entryPrice <= 1e6);

function grid(setup: Setup) {
  return priceGrid({ scale: setup.scale, currentPrice: setup.entryPrice, ranges: [setup.range] });
}

function values(curve: readonly CurvePoint[]): number[] {
  return curve.map((p) => p.value);
}

describe('priceGrid', () => {
  it('is ascending and spans the ranges', () => {
    fc.assert(
      fc.property(anySetup, (setup) => {
        const g = grid(setup);
        for (let i = 1; i < g.prices.length; i++) {
          expect((g.prices[i] as number) > (g.prices[i - 1] as number)).toBe(true);
        }
        const lo = priceAtTick(setup.scale, setup.range.lower);
        const hi = priceAtTick(setup.scale, setup.range.upper);
        expect(g.prices[0] as number).toBeLessThanOrEqual(Math.min(lo, hi));
        expect(g.prices[g.prices.length - 1] as number).toBeGreaterThanOrEqual(Math.max(lo, hi));
      }),
      { numRuns: 200 },
    );
  });
});

describe('payoffCurve', () => {
  it('HODL baselines are exactly linear or flat', () => {
    fc.assert(
      fc.property(anySetup, (setup) => {
        const g = grid(setup);
        const base = values(
          payoffCurve({ ...setup, strategy: { kind: 'hodlBase' }, notional: 10_000, grid: g }),
        );
        const quote = values(
          payoffCurve({ ...setup, strategy: { kind: 'hodlQuote' }, notional: 10_000, grid: g }),
        );
        const split = values(
          payoffCurve({ ...setup, strategy: { kind: 'hodl5050' }, notional: 10_000, grid: g }),
        );

        for (const v of quote) expect(v).toBeCloseTo(10_000, 6);
        for (let i = 0; i < g.prices.length; i++) {
          expect(split[i] as number).toBeCloseTo(
            ((base[i] as number) + (quote[i] as number)) / 2,
            4,
          );
        }
      }),
      { numRuns: 150 },
    );
  });

  it('V2 equals the closed form N·√(P/P0)', () => {
    // Full-range V3, computed through the liquidity math, must match the
    // textbook constant-product payoff — tying the two representations together.
    fc.assert(
      fc.property(anySetup, (setup) => {
        const g = grid(setup);
        const v2 = payoffCurve({ ...setup, strategy: { kind: 'v2' }, notional: 10_000, grid: g });
        for (const point of v2) {
          const expected = 10_000 * Math.sqrt(point.price / setup.entryPrice);
          expect(Math.abs(point.value - expected) / expected).toBeLessThan(0.02);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('the V3 payoff is monotone non-decreasing in price', () => {
    fc.assert(
      fc.property(anySetup, (setup) => {
        const g = grid(setup);
        const v = values(
          payoffCurve({
            ...setup,
            strategy: { kind: 'v3', range: setup.range },
            notional: 10_000,
            grid: g,
          }),
        );
        for (let i = 1; i < v.length; i++) {
          const prev = v[i - 1] as number;
          // Relative slack: float noise scales with the magnitude of the value.
          expect(v[i] as number).toBeGreaterThanOrEqual(prev - Math.abs(prev) * 1e-6 - 1e-6);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is concave — slope never increases as price rises', () => {
    // A long LP payoff is concave: linear (all base) below the range, concave
    // inside, flat (all quote) above. Slope therefore only decreases with price.
    // A branch-boundary jump — the failure class the predecessor's `<`/`<=`
    // mismatch created — would spike one local slope above its predecessor, so
    // concavity is exactly the invariant that rules it out.
    fc.assert(
      fc.property(anySetup, (setup) => {
        const g = grid(setup);
        const v = values(
          payoffCurve({
            ...setup,
            strategy: { kind: 'v3', range: setup.range },
            notional: 10_000,
            grid: g,
          }),
        );
        let prevSlope = Number.POSITIVE_INFINITY;
        for (let i = 1; i < v.length; i++) {
          const dPrice = (g.prices[i] as number) - (g.prices[i - 1] as number);
          const slope = ((v[i] as number) - (v[i - 1] as number)) / dPrice;
          // The steepest legitimate slope is the base holding, v[0]/price[0].
          const scale = (v[0] as number) / (g.prices[0] as number);
          expect(slope).toBeLessThanOrEqual(prevSlope + scale * 1e-4);
          prevSlope = slope;
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('impermanentLossCurve', () => {
  it('is never positive', () => {
    fc.assert(
      fc.property(anySetup, (setup) => {
        const g = grid(setup);
        const il = impermanentLossCurve({ ...setup, notional: 10_000, grid: g });
        // A small positive tolerance absorbs float rounding near the entry point.
        for (const point of il) expect(point.value).toBeLessThan(1e-6);
      }),
      { numRuns: 200 },
    );
  });

  it('is zero at the entry price', () => {
    fc.assert(
      fc.property(anySetup, (setup) => {
        // A grid centred on entry has entry near its middle; the minimum |IL|
        // point should be essentially zero.
        const g = grid(setup);
        const il = impermanentLossCurve({ ...setup, notional: 10_000, grid: g });
        const closest = il.reduce((a, b) =>
          Math.abs(b.price - setup.entryPrice) < Math.abs(a.price - setup.entryPrice) ? b : a,
        );
        expect(Math.abs(closest.value)).toBeLessThan(1e-3);
      }),
      { numRuns: 150 },
    );
  });
});

describe('relativeDifference', () => {
  it('throws on a grid mismatch rather than silently misaligning', () => {
    const scale = priceScale(testPool(6, 18), 'token1PerToken0');
    const entryPrice = priceAtTick(scale, 0 as Tick);
    const setup = { scale, range: tickRange(-600 as Tick, 600 as Tick), entryPrice };
    const g1 = priceGrid({ scale, currentPrice: entryPrice, count: 50 });
    const g2 = priceGrid({ scale, currentPrice: entryPrice, count: 60 });
    const a = payoffCurve({ ...setup, strategy: { kind: 'v2' }, notional: 1000, grid: g1 });
    const b = payoffCurve({ ...setup, strategy: { kind: 'hodl5050' }, notional: 1000, grid: g2 });
    expect(() => relativeDifference(a, b)).toThrow(CoreError);
  });
});
