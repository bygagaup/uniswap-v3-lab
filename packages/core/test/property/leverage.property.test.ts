import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { leveragedCurve, liquidationSegments, priceGrid } from '../../src/payoff.js';
import { type Hedge, hedgePnl, marginRatio, NO_HEDGE, tickRange } from '../../src/position.js';
import { type Orientation, type PriceScale, priceAtTick, priceScale } from '../../src/price.js';
import type { HumanPrice, Tick } from '../../src/units.js';
import { DECIMAL_PAIRS, testPool } from '../helpers/pools.js';

const centre = fc.integer({ min: -120_000, max: 120_000 });
const width = fc.integer({ min: 1200, max: 30_000 });
const anyDecimals = fc.constantFrom(...DECIMAL_PAIRS.filter(([d0, d1]) => d0 >= 6 && d1 >= 6));
const anyOrientation = fc.constantFrom<Orientation>('token1PerToken0', 'token0PerToken1');

interface Setup {
  scale: PriceScale;
  range: ReturnType<typeof tickRange>;
  entryPrice: HumanPrice;
}
const anySetup = fc
  .tuple(centre, width, anyDecimals, anyOrientation)
  .map(([c, w, [d0, d1], o]): Setup => {
    const scale = priceScale(testPool(d0, d1), o);
    return {
      scale,
      range: tickRange((c - w) as Tick, (c + w) as Tick),
      entryPrice: priceAtTick(scale, c as Tick),
    };
  })
  .filter((s) => s.entryPrice >= 1e-6 && s.entryPrice <= 1e6);

describe('hedgePnl', () => {
  it('is zero with no hedge and at the entry price', () => {
    fc.assert(
      fc.property(anySetup, (s) => {
        expect(hedgePnl(NO_HEDGE, s.entryPrice, s.entryPrice)).toBe(0);
        const h: Hedge = { side: 'short', notional: 1000, leverage: 2 };
        expect(hedgePnl(h, s.entryPrice, s.entryPrice)).toBeCloseTo(0, 9);
      }),
    );
  });

  it('a short profits when price falls, a long when it rises', () => {
    const entry = 100 as HumanPrice;
    const down = 90 as HumanPrice;
    const up = 110 as HumanPrice;
    const short: Hedge = { side: 'short', notional: 1000, leverage: 1 };
    const long: Hedge = { side: 'long', notional: 1000, leverage: 1 };
    expect(hedgePnl(short, entry, down)).toBeCloseTo(100, 6); // +10% of 1000
    expect(hedgePnl(short, entry, up)).toBeCloseTo(-100, 6);
    expect(hedgePnl(long, entry, down)).toBeCloseTo(-100, 6);
    expect(hedgePnl(long, entry, up)).toBeCloseTo(100, 6);
  });

  it('scales with leverage', () => {
    const entry = 100 as HumanPrice;
    const p = 110 as HumanPrice;
    const base = hedgePnl({ side: 'long', notional: 1000, leverage: 1 }, entry, p);
    const levered = hedgePnl({ side: 'long', notional: 1000, leverage: 3 }, entry, p);
    expect(levered).toBeCloseTo(base * 3, 6);
  });
});

describe('marginRatio', () => {
  it('is null exactly when there is no debt', () => {
    expect(marginRatio({ positionValue: 1000, debt: 0 })).toBeNull();
    expect(marginRatio({ positionValue: 1000, debt: 500 })).not.toBeNull();
  });

  it('falls to zero as the position value approaches the debt', () => {
    expect(marginRatio({ positionValue: 1000, debt: 500 })).toBeCloseTo(0.5, 9);
    expect(marginRatio({ positionValue: 500, debt: 500 })).toBeCloseTo(0, 9);
    expect(marginRatio({ positionValue: 0, debt: 500 })).toBe(0);
  });
});

describe('leveragedCurve', () => {
  it('equals the committed equity exactly at the entry price', () => {
    fc.assert(
      fc.property(anySetup, fc.double({ min: 1, max: 10, noNaN: true }), (s, lev) => {
        // A grid whose middle node IS the entry price, so we read equity there
        // directly rather than at a nearby node (leverage amplifies any gap).
        const grid = {
          prices: [s.entryPrice * 0.9, s.entryPrice, s.entryPrice * 1.1],
          current: s.entryPrice,
          spacing: 'linear' as const,
        };
        const curve = leveragedCurve({
          scale: s.scale,
          range: s.range,
          equity: 10_000,
          leverage: lev,
          entryPrice: s.entryPrice,
          grid,
        });
        const atEntry = curve[1] as { equity: number };
        // Bounded by the position's integer sizing granularity, not an epsilon.
        expect(Math.abs(atEntry.equity - 10_000) / 10_000).toBeLessThan(1e-4);
      }),
      { numRuns: 150 },
    );
  });

  it('unlevered margin is null everywhere; levered margin is a number', () => {
    fc.assert(
      fc.property(anySetup, (s) => {
        const grid = priceGrid({ scale: s.scale, currentPrice: s.entryPrice, ranges: [s.range] });
        const flat = leveragedCurve({
          scale: s.scale,
          range: s.range,
          equity: 10_000,
          leverage: 1,
          entryPrice: s.entryPrice,
          grid,
        });
        for (const p of flat) expect(p.margin).toBeNull();
        const lev = leveragedCurve({
          scale: s.scale,
          range: s.range,
          equity: 10_000,
          leverage: 3,
          entryPrice: s.entryPrice,
          grid,
        });
        for (const p of lev) expect(typeof p.margin === 'number').toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('is steeper than the unlevered curve away from entry', () => {
    // Leverage amplifies both gains and losses: the levered equity range spans
    // wider than the unlevered one across the same grid.
    fc.assert(
      fc.property(anySetup, (s) => {
        const grid = priceGrid({ scale: s.scale, currentPrice: s.entryPrice, ranges: [s.range] });
        const spread = (lev: number) => {
          const c = leveragedCurve({
            scale: s.scale,
            range: s.range,
            equity: 10_000,
            leverage: lev,
            entryPrice: s.entryPrice,
            grid,
          });
          const vals = c.map((p) => p.equity);
          return Math.max(...vals) - Math.min(...vals);
        };
        expect(spread(3)).toBeGreaterThan(spread(1) - 1e-6);
      }),
      { numRuns: 100 },
    );
  });
});

describe('liquidationSegments', () => {
  it('partitions the curve; concatenating the segments recovers it', () => {
    fc.assert(
      fc.property(anySetup, fc.double({ min: 2, max: 8, noNaN: true }), (s, lev) => {
        const grid = priceGrid({ scale: s.scale, currentPrice: s.entryPrice, ranges: [s.range] });
        const curve = leveragedCurve({
          scale: s.scale,
          range: s.range,
          equity: 10_000,
          leverage: lev,
          entryPrice: s.entryPrice,
          grid,
        });
        const segs = liquidationSegments(curve, 0.0625);
        const flat = segs.flatMap((seg) => seg.points);
        expect(flat).toHaveLength(curve.length);
        expect(flat.map((p) => p.price)).toEqual(curve.map((p) => p.price));
        // Adjacent segments alternate liquidated/safe.
        for (let i = 1; i < segs.length; i++) {
          expect((segs[i] as { liquidated: boolean }).liquidated).not.toBe(
            (segs[i - 1] as { liquidated: boolean }).liquidated,
          );
        }
      }),
      { numRuns: 150 },
    );
  });

  it('an unlevered curve is never liquidated', () => {
    fc.assert(
      fc.property(anySetup, (s) => {
        const grid = priceGrid({ scale: s.scale, currentPrice: s.entryPrice, ranges: [s.range] });
        const curve = leveragedCurve({
          scale: s.scale,
          range: s.range,
          equity: 10_000,
          leverage: 1,
          entryPrice: s.entryPrice,
          grid,
        });
        const segs = liquidationSegments(curve, 0.0625);
        expect(segs.every((seg) => !seg.liquidated)).toBe(true);
      }),
      { numRuns: 80 },
    );
  });
});
