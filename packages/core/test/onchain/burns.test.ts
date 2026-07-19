/**
 * Differential test against real `Burn` events — the M2 exit criterion.
 *
 * A burn is the best oracle we get for the liquidity math: the pool publishes
 * the liquidity removed *and* the token amounts it paid out, computed by its
 * own arithmetic and its own rounding. If `amountsForLiquidity` reproduces
 * those to the wei, the whole path is right — the branch selection, the
 * whitepaper formulas, and the rounding direction.
 *
 * Burn rounds DOWN (the pool keeps the dust). That is not a detail we can fudge:
 * rounding up would be off by one wei on most of these.
 */
import { describe, expect, it } from 'vitest';
import { amountsForLiquidity } from '../../src/liquidityMath.js';
import { getSqrtRatioAtTick } from '../../src/tickMath.js';
import { Liquidity, SqrtPriceX96, type Tick } from '../../src/units.js';
import fixtures from '../fixtures/burns.mainnet.json' with { type: 'json' };

const { burns, fromBlock, toBlock } = fixtures;

describe(`mainnet burns, blocks ${fromBlock}..${toBlock}`, () => {
  it('captured burns across several pools', () => {
    expect(burns.length).toBeGreaterThanOrEqual(10);
    expect(new Set(burns.map((b) => b.pool)).size).toBeGreaterThanOrEqual(3);
  });

  it('captured only burns that actually moved liquidity', () => {
    // Zero-liquidity burns are the fee-collection idiom and prove nothing.
    for (const burn of burns) {
      expect(BigInt(burn.liquidity) > 0n).toBe(true);
    }
  });

  describe.each(burns)(
    '$note burn at block $blockNumber log $logIndex',
    ({ tickLower, tickUpper, liquidity, amount0, amount1, sqrtPriceX96 }) => {
      const args = {
        sqrtPrice: SqrtPriceX96.of(sqrtPriceX96),
        range: {
          sqrtLower: getSqrtRatioAtTick(tickLower as Tick),
          sqrtUpper: getSqrtRatioAtTick(tickUpper as Tick),
        },
        liquidity: Liquidity.of(liquidity),
      };

      it('reproduces both token amounts exactly', () => {
        const computed = amountsForLiquidity({ ...args, rounding: 'down' });
        expect(computed.amount0).toBe(BigInt(amount0));
        expect(computed.amount1).toBe(BigInt(amount1));
      });

      it('would be wrong if it rounded the way a mint does', () => {
        // Pins the rounding direction as a decision rather than a coincidence:
        // for these amounts, rounding up disagrees with the chain.
        const up = amountsForLiquidity({ ...args, rounding: 'up' });
        const down = amountsForLiquidity({ ...args, rounding: 'down' });
        expect(up.amount0 >= down.amount0).toBe(true);
        expect(up.amount1 >= down.amount1).toBe(true);
      });
    },
  );

  it('disagrees with the chain somewhere if rounding is flipped', () => {
    // The per-burn test above is necessarily weak on its own (up == down when
    // the division happens to be exact). Across the whole fixture set, at least
    // one burn must distinguish the two — otherwise these tests would pass with
    // the rounding direction wrong.
    const distinguishing = burns.filter((burn) => {
      const args = {
        sqrtPrice: SqrtPriceX96.of(burn.sqrtPriceX96),
        range: {
          sqrtLower: getSqrtRatioAtTick(burn.tickLower as Tick),
          sqrtUpper: getSqrtRatioAtTick(burn.tickUpper as Tick),
        },
        liquidity: Liquidity.of(burn.liquidity),
      };
      const up = amountsForLiquidity({ ...args, rounding: 'up' });
      const down = amountsForLiquidity({ ...args, rounding: 'down' });
      return up.amount0 !== down.amount0 || up.amount1 !== down.amount1;
    });

    expect(distinguishing.length).toBeGreaterThan(0);
  });

  it('covers in-range and out-of-range positions', () => {
    // A fixture set that only ever exercised one branch would look green while
    // leaving two thirds of the function untested.
    const classify = (burn: (typeof burns)[number]) => {
      const price = BigInt(burn.sqrtPriceX96);
      const lower = getSqrtRatioAtTick(burn.tickLower as Tick);
      const upper = getSqrtRatioAtTick(burn.tickUpper as Tick);
      if (price <= lower) return 'below';
      if (price >= upper) return 'above';
      return 'in';
    };

    const seen = new Set(burns.map(classify));
    expect(seen.has('in')).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});
