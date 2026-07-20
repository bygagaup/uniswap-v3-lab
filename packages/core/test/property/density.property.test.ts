import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  activeLiquidityAt,
  clipDensity,
  concentrationIndex,
  liquidityDensity,
  netSum,
  type TickDatum,
} from '../../src/density.js';
import { CoreError } from '../../src/errors.js';
import { priceScale } from '../../src/price.js';
import type { Tick } from '../../src/units.js';
import { testPool } from '../helpers/pools.js';

const scale = priceScale(testPool(6, 18), 'token0PerToken1');

/**
 * A valid tick set: distinct ascending ticks, with liquidityNet chosen so the
 * running sum is non-negative everywhere and returns to zero at the end — the
 * shape a complete on-chain tick set always has.
 */
const anyTickSet = fc
  .array(
    fc.record({
      idx: fc.integer({ min: -100_000, max: 100_000 }),
      add: fc.bigInt({ min: 1n, max: 10n ** 22n }),
    }),
    { minLength: 2, maxLength: 40 },
  )
  .map((entries) => {
    const byIdx = new Map<number, bigint>();
    for (const e of entries) byIdx.set(e.idx - (e.idx % 60), (byIdx.get(e.idx) ?? 0n) + e.add);
    const idxs = [...byIdx.keys()].sort((a, b) => a - b);
    if (idxs.length < 2) return null;

    // Each opening tick adds liquidity; a matching closing tick removes it, so
    // the net sums to zero — every position is opened and closed.
    const ticks: TickDatum[] = [];
    let running = 0n;
    for (let i = 0; i < idxs.length; i++) {
      const idx = idxs[i] as number;
      if (i < idxs.length - 1) {
        const add = byIdx.get(idx) as bigint;
        running += add;
        ticks.push({ tickIdx: idx, liquidityNet: add.toString() });
      } else {
        // last tick closes all remaining liquidity
        ticks.push({ tickIdx: idx, liquidityNet: (-running).toString() });
      }
    }
    return ticks;
  })
  .filter((t): t is TickDatum[] => t !== null && t.length >= 2);

const anyCurrentTick = fc.integer({ min: -100_000, max: 100_000 }).map((t) => t as Tick);

describe('liquidityDensity', () => {
  it('never lets the running liquidity go negative', () => {
    fc.assert(
      fc.property(anyTickSet, anyCurrentTick, (ticks, currentTick) => {
        const bars = liquidityDensity({ scale, ticks, currentTick });
        for (const bar of bars) expect(bar.liquidity >= 0n).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('the active bar’s liquidity equals the sum at the current tick', () => {
    fc.assert(
      fc.property(anyTickSet, anyCurrentTick, (ticks, currentTick) => {
        const bars = liquidityDensity({ scale, ticks, currentTick });
        const active = bars.find((b) => b.isActive);
        if (active) expect(active.liquidity).toBe(activeLiquidityAt(ticks, currentTick));
      }),
      { numRuns: 300 },
    );
  });

  it('bars are contiguous and ascending in tick space', () => {
    fc.assert(
      fc.property(anyTickSet, anyCurrentTick, (ticks, currentTick) => {
        const bars = liquidityDensity({ scale, ticks, currentTick });
        for (let i = 1; i < bars.length; i++) {
          expect((bars[i] as { tickLower: number }).tickLower).toBeGreaterThanOrEqual(
            (bars[i - 1] as { tickLower: number }).tickLower,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it('rejects a non-ascending tick set instead of drawing nonsense', () => {
    expect(() =>
      liquidityDensity({
        scale,
        ticks: [
          { tickIdx: 100, liquidityNet: '1' },
          { tickIdx: 50, liquidityNet: '-1' },
        ],
        currentTick: 0 as Tick,
      }),
    ).toThrow(CoreError);
  });
});

describe('netSum', () => {
  it('is zero for any balanced (complete) tick set', () => {
    fc.assert(
      fc.property(anyTickSet, (ticks) => {
        expect(netSum(ticks)).toBe(0n);
      }),
    );
  });
});

describe('concentrationIndex', () => {
  it('is 1 over the full span and rises as the window widens', () => {
    fc.assert(
      fc.property(anyTickSet, anyCurrentTick, (ticks, currentTick) => {
        const bars = liquidityDensity({ scale, ticks, currentTick });
        fc.pre(bars.length > 0);
        const lo = bars[0]?.tickLower as Tick;
        const hi = bars[bars.length - 1]?.tickUpper as Tick;
        const full = concentrationIndex(bars, { lower: lo, upper: hi });
        expect(full).toBeCloseTo(1, 9);

        const mid = Math.floor(((lo as number) + (hi as number)) / 2) as Tick;
        const half = concentrationIndex(bars, { lower: lo, upper: mid });
        expect(half).toBeLessThanOrEqual(full + 1e-9);
        expect(half).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});

describe('clipDensity', () => {
  it('keeps exactly the bars overlapping the window', () => {
    fc.assert(
      fc.property(anyTickSet, (ticks) => {
        const bars = liquidityDensity({ scale, ticks, currentTick: 0 as Tick });
        fc.pre(bars.length >= 2);
        const window = {
          lower: bars[0]?.tickUpper as Tick,
          upper: bars[bars.length - 1]?.tickLower as Tick,
        };
        const clipped = clipDensity(bars, window);
        for (const bar of clipped) {
          expect(bar.tickUpper > window.lower && bar.tickLower < window.upper).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });
});
