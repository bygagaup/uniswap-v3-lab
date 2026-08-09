/**
 * Backtest against a real 30-day poolHourData window.
 *
 * This is where the fix that motivates the whole project is demonstrated on
 * real data: feeGrowthGlobalX128 here is a 34-digit number, far past
 * Number.MAX_SAFE_INTEGER, and the predecessor's parseInt() turned it into a
 * float that had already lost every low digit. The same values run through the
 * BigInt path produce finite, sane fees and a plausible APR.
 */
import { describe, expect, it } from 'vitest';
import { runBacktest, summarize } from '../../src/backtest.js';
import {
  HumanUsd,
  positionFromNotional,
  priceAtTick,
  priceScale,
  SqrtPriceX96,
  type Tick,
  tickRange,
} from '../../src/index.js';
import { poolKey } from '../../src/pool.js';
import { getTickAtSqrtRatio } from '../../src/tickMath.js';
import fixtures from '../fixtures/hours.mainnet.json' with { type: 'json' };

const { pool, candles } = fixtures;
// The fixture is plain JSON; the USD figure crosses into the branded type here.
const tvl = { ...pool.tvl, usd: HumanUsd.of(pool.tvl.usd) };

const key = poolKey({
  token0: { address: pool.token0.id, symbol: pool.token0.symbol, decimals: pool.token0.decimals },
  token1: { address: pool.token1.id, symbol: pool.token1.symbol, decimals: pool.token1.decimals },
  feeTier: pool.feeTier,
});
const scale = priceScale(key, 'token0PerToken1'); // USDC per WETH
const currentTick = getTickAtSqrtRatio(SqrtPriceX96.of(pool.sqrtPrice));
const entryPrice = priceAtTick(scale, currentTick);
// A ±~5% range around the current tick.
const spacing = key.tickSpacing;
const range = tickRange(
  (Math.floor((currentTick - 500) / spacing) * spacing) as Tick,
  (Math.ceil((currentTick + 500) / spacing) * spacing) as Tick,
);
const position = positionFromNotional({ scale, price: entryPrice, range, notional: 100_000 });
const currentSqrtPrice = SqrtPriceX96.of(pool.sqrtPrice);

describe('backtest on real USDC/WETH hourly data', () => {
  it('the fixture carries fee growth beyond a double’s reach', () => {
    // The premise of the test: these are the values parseInt() would destroy.
    const last = candles[candles.length - 1] as { feeGrowthGlobal0X128: string };
    expect(BigInt(last.feeGrowthGlobal0X128) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('produces finite, non-negative, plausible fees', () => {
    const rows = runBacktest({ scale, position, candles, tvl, currentSqrtPrice });
    expect(rows.length).toBe(candles.length);

    for (const row of rows) {
      expect(Number.isFinite(row.feeValue)).toBe(true);
      expect(Number.isFinite(row.feeUsd)).toBe(true);
      expect(row.feeValue).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(row.positionValue)).toBe(true);
    }

    const s = summarize(rows);
    // A concentrated 30-day position on a top pool earns real fees; the APR is
    // positive and within a sane band (not zero, not absurd).
    expect(s.feeValue).toBeGreaterThan(0);
    expect(s.apr).toBeGreaterThan(0);
    expect(s.apr).toBeLessThan(100); // < 10000% — a very loose sanity ceiling
    expect(s.avgActiveBps).toBeGreaterThanOrEqual(0);
    expect(s.avgActiveBps).toBeLessThanOrEqual(10_000);
  });

  it('the daily rollup preserves the fee total', () => {
    const rows = runBacktest({ scale, position, candles, tvl, currentSqrtPrice });
    const summary = summarize(rows);
    // Reconstruct the total from the hourly feeValue and compare.
    const hourlyTotal = rows.reduce((sum, r) => sum + r.feeValue, 0);
    expect(hourlyTotal).toBeCloseTo(summary.feeValue, 4);
  });

  it('a full-range position earns fewer fees per dollar than the concentrated one', () => {
    // Concentration is the point of V3: the same capital, tighter, captures more
    // fee growth while in range. Compare fee ROI, not absolute fees.
    const wide = positionFromNotional({
      scale,
      price: entryPrice,
      range: tickRange(-880_000 as Tick, 880_000 as Tick),
      notional: 100_000,
    });
    const tight = summarize(runBacktest({ scale, position, candles, tvl, currentSqrtPrice }));
    const full = summarize(runBacktest({ scale, position: wide, candles, tvl, currentSqrtPrice }));
    // Only meaningful if the tight position stayed in range for a good share.
    if (tight.avgActiveBps > 3000) {
      expect(tight.feeRoi).toBeGreaterThan(full.feeRoi);
    }
  });
});
