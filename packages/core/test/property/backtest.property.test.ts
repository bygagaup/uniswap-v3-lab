import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { aggregateDaily, type HourCandle, runBacktest, summarize } from '../../src/backtest.js';
import { CoreError } from '../../src/errors.js';
import { positionFromNotional, tickRange } from '../../src/position.js';
import { priceAtTick, priceScale } from '../../src/price.js';
import { getSqrtRatioAtTick } from '../../src/tickMath.js';
import type { Tick } from '../../src/units.js';
import { testPool } from '../helpers/pools.js';

const pool = testPool(6, 18); // USDC / WETH geometry
// Display in USDC-per-WETH (readable), but candle prices are token1PerToken0.
const scale = priceScale(pool, 'token0PerToken1');
const candleScale = priceScale(pool, 'token1PerToken0');
const CENTER = 201_000 as Tick; // where real USDC/WETH sits
const entryPrice = priceAtTick(scale, CENTER);
const range = tickRange(200_000 as Tick, 202_000 as Tick);
const position = positionFromNotional({ scale, price: entryPrice, range, notional: 100_000 });

const Q128 = 1n << 128n;

/**
 * A synthetic hour: candle prices in token1PerToken0 (the subgraph's units), and
 * fee growth that only ever increases — the realistic monotone case.
 */
function makeCandles(count: number, increment: bigint, flat: boolean): HourCandle[] {
  const candles: HourCandle[] = [];
  let fg0 = 1000n * Q128;
  let fg1 = 2000n * Q128;
  for (let i = 0; i < count; i++) {
    fg0 += increment;
    fg1 += increment * 2n;
    const wobble = flat ? 0 : (i % 5) - 2;
    const lowP = priceAtTick(candleScale, (CENTER - 500 + wobble * 100) as Tick);
    const highP = priceAtTick(candleScale, (CENTER + 500 + wobble * 100) as Tick);
    candles.push({
      periodStartUnix: 1_700_000_000 + i * 3600,
      close: priceAtTick(candleScale, CENTER).toString(),
      low: Math.min(lowP, highP).toString(),
      high: Math.max(lowP, highP).toString(),
      feeGrowthGlobal0X128: fg0.toString(),
      feeGrowthGlobal1X128: fg1.toString(),
    });
  }
  return candles;
}

const currentSqrt = getSqrtRatioAtTick(CENTER);
const tvl = { usd: 1_000_000, token0: 500_000, token1: 260 };

describe('runBacktest', () => {
  it('the first hour earns zero fees and is kept', () => {
    const rows = runBacktest({
      scale,
      position,
      candles: makeCandles(24, Q128 / 1000n, false),
      tvl,
      currentSqrtPrice: currentSqrt,
    });
    expect(rows).toHaveLength(24);
    expect((rows[0] as { fee0: number }).fee0).toBe(0);
    expect((rows[0] as { fee1: number }).fee1).toBe(0);
    expect((rows[0] as { cumulativeFeeValue: number }).cumulativeFeeValue).toBe(0);
  });

  it('accrues non-negative, monotonically cumulative fees', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 200 }), fc.bigInt({ min: 1n, max: Q128 }), (n, inc) => {
        const rows = runBacktest({
          scale,
          position,
          candles: makeCandles(n, inc, false),
          tvl,
          currentSqrtPrice: currentSqrt,
        });
        let prev = -1;
        for (const row of rows) {
          expect(row.feeValue).toBeGreaterThanOrEqual(0);
          expect(row.cumulativeFeeValue).toBeGreaterThanOrEqual(prev);
          prev = row.cumulativeFeeValue;
        }
      }),
      { numRuns: 150 },
    );
  });

  it('doubling the fee-growth increment doubles total fees', () => {
    const base = summarize(
      runBacktest({
        scale,
        position,
        candles: makeCandles(48, Q128 / 500n, false),
        tvl,
        currentSqrtPrice: currentSqrt,
      }),
    );
    const doubled = summarize(
      runBacktest({
        scale,
        position,
        candles: makeCandles(48, Q128 / 250n, false),
        tvl,
        currentSqrtPrice: currentSqrt,
      }),
    );
    expect(doubled.feeValue / base.feeValue).toBeCloseTo(2, 3);
  });

  it('throws on descending candles rather than trusting the order', () => {
    const ascending = makeCandles(5, Q128 / 1000n, false);
    const descending = [...ascending].reverse();
    expect(() =>
      runBacktest({ scale, position, candles: descending, tvl, currentSqrtPrice: currentSqrt }),
    ).toThrow(CoreError);
  });

  it('a full-range position is active every hour', () => {
    const wide = positionFromNotional({
      scale,
      price: entryPrice,
      range: tickRange(-880_000 as Tick, 880_000 as Tick),
      notional: 100_000,
    });
    const rows = runBacktest({
      scale,
      position: wide,
      candles: makeCandles(12, Q128 / 1000n, false),
      tvl,
      currentSqrtPrice: currentSqrt,
    });
    for (const row of rows.slice(1)) expect(row.activeBps).toBe(10_000);
  });
});

describe('summarize', () => {
  it('is internally consistent: fee total equals the last cumulative', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 120 }), (n) => {
        const rows = runBacktest({
          scale,
          position,
          candles: makeCandles(n, Q128 / 800n, false),
          tvl,
          currentSqrtPrice: currentSqrt,
        });
        const s = summarize(rows);
        expect(s.feeValue).toBeCloseTo(
          (rows[rows.length - 1] as { cumulativeFeeValue: number }).cumulativeFeeValue,
          6,
        );
        expect(s.hours).toBe(n);
      }),
      { numRuns: 100 },
    );
  });

  it('zero fee growth yields zero fee ROI', () => {
    const rows = runBacktest({
      scale,
      position,
      candles: makeCandles(24, 0n, false),
      tvl,
      currentSqrtPrice: currentSqrt,
    });
    const s = summarize(rows);
    expect(s.feeValue).toBe(0);
    expect(s.feeRoi).toBe(0);
    expect(s.apr).toBe(0);
  });

  it('APR annualises the fee ROI by elapsed time', () => {
    const rows = runBacktest({
      scale,
      position,
      candles: makeCandles(24 * 30, Q128 / 1000n, false),
      tvl,
      currentSqrtPrice: currentSqrt,
    });
    const s = summarize(rows);
    // 30 days of data → APR ≈ feeRoi × (365 / ~30).
    const first = rows[0] as { timestamp: number };
    const last = rows[rows.length - 1] as { timestamp: number };
    const elapsedDays = (last.timestamp - first.timestamp) / 86_400;
    expect(s.apr).toBeCloseTo(s.feeRoi * (365 / elapsedDays), 4);
  });
});

describe('aggregateDaily', () => {
  it('preserves the total fee value across the daily rollup', () => {
    const rows = runBacktest({
      scale,
      position,
      candles: makeCandles(24 * 7, Q128 / 700n, false),
      tvl,
      currentSqrtPrice: currentSqrt,
    });
    const days = aggregateDaily(rows);
    const dailyTotal = days.reduce((s, d) => s + d.feeValue, 0);
    expect(dailyTotal).toBeCloseTo(summarize(rows).feeValue, 4);
  });

  it('buckets 168 hours into 7 or 8 UTC days', () => {
    const rows = runBacktest({
      scale,
      position,
      candles: makeCandles(24 * 7, Q128 / 700n, false),
      tvl,
      currentSqrtPrice: currentSqrt,
    });
    const days = aggregateDaily(rows);
    expect(days.length).toBeGreaterThanOrEqual(7);
    expect(days.length).toBeLessThanOrEqual(8);
  });
});
