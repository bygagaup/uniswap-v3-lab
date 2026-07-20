/**
 * Density against real pools — the M6 exit criterion.
 *
 * The fixtures hold the COMPLETE initialized-tick set for each pool (netSum is
 * exactly zero, which is the proof nothing was dropped). The running sum of
 * liquidityNet at the current tick must then equal the liquidity the pool
 * reports — the strongest end-to-end check on both the accumulation and the
 * tick ordering, and it is free.
 */
import { describe, expect, it } from 'vitest';
import {
  activeLiquidityAt,
  concentrationIndex,
  liquidityDensity,
  netSum,
} from '../../src/density.js';
import { poolKey } from '../../src/pool.js';
import { priceScale } from '../../src/price.js';
import { Liquidity, SqrtPriceX96, type Tick } from '../../src/units.js';
import fixtures from '../fixtures/ticks.mainnet.json' with { type: 'json' };

describe.each(fixtures.pools)('$note', (entry) => {
  const { pool, ticks } = entry;
  const asToken = (t: { id: string; symbol: string; decimals: number }) => ({
    address: t.id,
    symbol: t.symbol,
    decimals: t.decimals,
  });
  const key = poolKey({
    token0: asToken(pool.token0),
    token1: asToken(pool.token1),
    feeTier: pool.feeTier,
  });
  const scale = priceScale(key, 'token0PerToken1');

  it('captured the complete tick set (netSum is exactly zero)', () => {
    expect(netSum(ticks)).toBe(0n);
  });

  it('sums liquidityNet at the current tick to the pool’s reported liquidity', () => {
    expect(activeLiquidityAt(ticks, pool.tick as Tick)).toBe(Liquidity.of(pool.liquidity));
  });

  it('builds bars whose active bar carries the pool’s liquidity', () => {
    const bars = liquidityDensity({
      scale,
      ticks,
      currentTick: pool.tick as Tick,
      currentSqrtPrice: SqrtPriceX96.of(pool.sqrtPrice),
    });
    const active = bars.find((b) => b.isActive);
    expect(active).toBeDefined();
    expect(active?.liquidity).toBe(Liquidity.of(pool.liquidity));
  });

  it('holds token1 below the price and token0 above it', () => {
    const bars = liquidityDensity({
      scale,
      ticks,
      currentTick: pool.tick as Tick,
      currentSqrtPrice: SqrtPriceX96.of(pool.sqrtPrice),
    });
    for (const bar of bars) {
      if (bar.tickUpper <= pool.tick) {
        // wholly below the current price: already swapped into token1
        expect(bar.amount0).toBe(0);
      }
      if (bar.tickLower >= pool.tick) {
        // wholly above: still token0
        expect(bar.amount1).toBe(0);
      }
    }
  });

  it('reports full concentration over the whole tick span', () => {
    const bars = liquidityDensity({
      scale,
      ticks,
      currentTick: pool.tick as Tick,
      currentSqrtPrice: SqrtPriceX96.of(pool.sqrtPrice),
    });
    const lo = bars[0]?.tickLower ?? (0 as Tick);
    const hi = bars[bars.length - 1]?.tickUpper ?? (0 as Tick);
    expect(concentrationIndex(bars, { lower: lo, upper: hi })).toBeCloseTo(1, 10);
  });
});
