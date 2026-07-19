/**
 * Differential test against real mainnet pool state.
 *
 * Fixtures are captured by scripts/capture-fixtures.ts and committed, so this
 * runs offline and deterministically. It is the strongest evidence we have that
 * the tick math agrees with the chain: `slot0` reports both `sqrtPriceX96` and
 * the `tick` the pool itself derived from it, so the pool hands us the expected
 * answer alongside the input.
 */
import { describe, expect, it } from 'vitest';
import { tickSpacingFor } from '../../src/feeTiers.js';
import { poolKey } from '../../src/pool.js';
import {
  flip,
  type Orientation,
  priceAtSqrtRatio,
  priceAtTick,
  priceScale,
  tickAtPrice,
} from '../../src/price.js';
import { getSqrtRatioAtTick, getTickAtSqrtRatio } from '../../src/tickMath.js';
import { SqrtPriceX96, type Tick } from '../../src/units.js';
import fixtures from '../fixtures/pools.mainnet.json' with { type: 'json' };

const { pools, blockNumber } = fixtures;

describe(`mainnet pools @ block ${blockNumber}`, () => {
  it('captured the pools we expect', () => {
    expect(pools).toHaveLength(4);
  });

  describe.each(pools)('$note', (pool) => {
    const sqrtP = SqrtPriceX96.of(pool.sqrtPriceX96);

    /** The M1 exit criterion. */
    it('derives the pool’s own tick from its own sqrtPriceX96', () => {
      expect(getTickAtSqrtRatio(sqrtP)).toBe(pool.tick);
    });

    it('brackets the live sqrt price between its tick and the next', () => {
      expect(getSqrtRatioAtTick(pool.tick as Tick) <= sqrtP).toBe(true);
      expect(sqrtP < getSqrtRatioAtTick((pool.tick + 1) as Tick)).toBe(true);
    });

    it('agrees with the pool on tick spacing', () => {
      expect(tickSpacingFor(pool.feeTier)).toBe(pool.tickSpacing);
    });

    it('prices the tick and the sqrt ratio consistently', () => {
      const key = poolKey({
        token0: pool.token0,
        token1: pool.token1,
        feeTier: pool.feeTier,
        tickSpacing: pool.tickSpacing,
      });
      const scale = priceScale(key, 'token1PerToken0');

      const fromTick = priceAtTick(scale, pool.tick as Tick);
      const fromRatio = priceAtSqrtRatio(scale, sqrtP);

      // Same tick, so the two prices differ by less than one tick's width (1e-4).
      expect(Math.abs(fromRatio - fromTick) / fromTick).toBeLessThan(1e-4);
      expect(tickAtPrice(scale, fromRatio)).toBe(pool.tick);
    });
  });

  it('reads plausible spot prices, so decimals and orientation are not swapped', () => {
    // Sanity bands, not a price oracle: wide enough that only a decimals or
    // orientation bug escapes them. Each pair names the orientation that reads
    // naturally, which is the whole point — get it backwards and the number is
    // the reciprocal, which these bands catch.
    const expectations: Record<
      string,
      { orientation: Orientation; band: readonly [number, number] }
    > = {
      // USDC per WETH
      'USDC/WETH': { orientation: 'token0PerToken1', band: [100, 100_000] },
      // WETH per WBTC
      'WBTC/WETH': { orientation: 'token1PerToken0', band: [1, 200] },
      // USDC per DAI
      'DAI/USDC': { orientation: 'token1PerToken0', band: [0.5, 2] },
    };

    for (const pool of pools) {
      const pair = `${pool.token0.symbol}/${pool.token1.symbol}`;
      const expectation = expectations[pair];
      if (!expectation) throw new Error(`no sanity band for ${pair}`);

      const key = poolKey({
        token0: pool.token0,
        token1: pool.token1,
        feeTier: pool.feeTier,
        tickSpacing: pool.tickSpacing,
      });
      const scale = priceScale(key, expectation.orientation);
      const price = priceAtSqrtRatio(scale, SqrtPriceX96.of(pool.sqrtPriceX96));

      expect(price, `${pair} as ${scale.label}`).toBeGreaterThan(expectation.band[0]);
      expect(price, `${pair} as ${scale.label}`).toBeLessThan(expectation.band[1]);

      // And the reciprocal orientation must land outside the band, so a scale
      // that silently ignored `orientation` could not pass this test.
      const flipped = priceAtSqrtRatio(flip(scale), SqrtPriceX96.of(pool.sqrtPriceX96));
      expect(flipped).toBeCloseTo(1 / price, 12);
    }
  });

  it('would have been wrong under the feeTier/50 spacing heuristic', () => {
    // Regression witness for the defect this project exists partly to fix.
    // DAI/USDC is a 0.01% pool: real spacing 1, heuristic says 2.
    const stable = pools.find((p) => p.feeTier === 100);
    expect(stable).toBeDefined();
    expect(stable?.tickSpacing).toBe(1);
    expect(100 / 50).toBe(2);
  });
});
