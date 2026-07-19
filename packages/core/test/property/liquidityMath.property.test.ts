import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/errors.js';
import {
  amountsForLiquidity,
  isInRange,
  liquidityForAmounts,
  type SqrtRange,
} from '../../src/liquidityMath.js';
import { getSqrtRatioAtTick } from '../../src/tickMath.js';
import {
  type Amounts,
  type Liquidity,
  MAX_TICK,
  MIN_TICK,
  type Raw,
  type SqrtPriceX96,
  type Tick,
} from '../../src/units.js';

/**
 * Ticks are drawn from a band real pools inhabit. The extremes are exercised
 * separately — sampling uniformly over the full ±887272 makes almost every
 * range astronomically wide and the interesting in-range cases never appear.
 */
const REALISTIC = 400_000;
const realisticTick = fc.integer({ min: -REALISTIC, max: REALISTIC });

const anyRange = fc
  .tuple(realisticTick, realisticTick)
  .filter(([a, b]) => a !== b)
  .map(([a, b]): { range: SqrtRange; lower: Tick; upper: Tick } => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return {
      range: {
        sqrtLower: getSqrtRatioAtTick(lo as Tick),
        sqrtUpper: getSqrtRatioAtTick(hi as Tick),
      },
      lower: lo as Tick,
      upper: hi as Tick,
    };
  });

const anyPriceTick = realisticTick.map((t) => getSqrtRatioAtTick(t as Tick));

/** Deposits from dust to a whale position, across 6- and 18-decimal tokens. */
const anyAmount = fc.bigInt({ min: 1n, max: 10n ** 30n }).map((v) => v as Raw);
const anyAmounts = fc
  .tuple(anyAmount, anyAmount)
  .map(([amount0, amount1]): Amounts => ({ amount0, amount1 }));

const anyLiquidity = fc.bigInt({ min: 1n, max: 10n ** 27n }).map((v) => v as Liquidity);

/**
 * A huge deposit into a one-tick range implies an L above uint128, which no
 * pool can hold — `Liquidity.of` rejects it, correctly. Such draws are outside
 * the domain rather than counterexamples, so skip them explicitly instead of
 * narrowing the generators (which would also drop the interesting extremes).
 */
function liquidityOrSkip(args: {
  sqrtPrice: SqrtPriceX96;
  range: SqrtRange;
  amounts: Amounts;
}): Liquidity {
  try {
    return liquidityForAmounts(args);
  } catch (error) {
    if (error instanceof CoreError && error.code === 'NEGATIVE_AMOUNT') {
      fc.pre(false);
    }
    throw error;
  }
}

describe('liquidityForAmounts', () => {
  it('never mints more than the deposit supports', () => {
    // The single most important property here: round-tripping through L and
    // back must never conjure tokens the depositor did not provide.
    fc.assert(
      fc.property(anyRange, anyPriceTick, anyAmounts, ({ range }, sqrtPrice, amounts) => {
        const liquidity = liquidityOrSkip({ sqrtPrice, range, amounts });
        const back = amountsForLiquidity({ sqrtPrice, range, liquidity, rounding: 'down' });
        expect(back.amount0 <= amounts.amount0).toBe(true);
        expect(back.amount1 <= amounts.amount1).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('is homogeneous of degree one in the deposit', () => {
    fc.assert(
      fc.property(
        anyRange,
        anyPriceTick,
        anyAmounts,
        fc.bigInt({ min: 2n, max: 1000n }),
        ({ range }, sqrtPrice, amounts, k) => {
          const single = liquidityOrSkip({ sqrtPrice, range, amounts });
          const scaled = liquidityOrSkip({
            sqrtPrice,
            range,
            amounts: {
              amount0: (amounts.amount0 * k) as Raw,
              amount1: (amounts.amount1 * k) as Raw,
            },
          });
          // Scaling up then down recovers the original, modulo floor division.
          const expected = single * k;
          const drift = scaled > expected ? scaled - expected : expected - scaled;
          expect(drift <= k).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects a degenerate range instead of dividing by zero', () => {
    const sqrtP = getSqrtRatioAtTick(0 as Tick);
    expect(() =>
      liquidityForAmounts({
        sqrtPrice: sqrtP,
        range: { sqrtLower: sqrtP, sqrtUpper: sqrtP },
        amounts: { amount0: 1n as Raw, amount1: 1n as Raw },
      }),
    ).toThrow(CoreError);
  });
});

describe('amountsForLiquidity', () => {
  it('is monotone non-decreasing in liquidity', () => {
    fc.assert(
      fc.property(
        anyRange,
        anyPriceTick,
        anyLiquidity,
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        ({ range }, sqrtPrice, liquidity, bump) => {
          const small = amountsForLiquidity({ sqrtPrice, range, liquidity });
          const large = amountsForLiquidity({
            sqrtPrice,
            range,
            liquidity: (liquidity + bump) as Liquidity,
          });
          expect(large.amount0 >= small.amount0).toBe(true);
          expect(large.amount1 >= small.amount1).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('moves token0 down and token1 up as price rises', () => {
    // This alone catches every 0/1 orientation swap: as the price of token0
    // rises, the position sells token0 and accumulates token1.
    fc.assert(
      fc.property(
        anyRange,
        realisticTick,
        realisticTick,
        anyLiquidity,
        ({ range }, a, b, liquidity) => {
          fc.pre(a !== b);
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const low = amountsForLiquidity({
            sqrtPrice: getSqrtRatioAtTick(lo as Tick),
            range,
            liquidity,
          });
          const high = amountsForLiquidity({
            sqrtPrice: getSqrtRatioAtTick(hi as Tick),
            range,
            liquidity,
          });
          expect(high.amount0 <= low.amount0).toBe(true);
          expect(high.amount1 >= low.amount1).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('holds a single token when the price is outside the range', () => {
    fc.assert(
      fc.property(anyRange, anyPriceTick, anyLiquidity, ({ range }, sqrtPrice, liquidity) => {
        const { amount0, amount1 } = amountsForLiquidity({ sqrtPrice, range, liquidity });
        if (sqrtPrice <= range.sqrtLower) expect(amount1).toBe(0n);
        if (sqrtPrice >= range.sqrtUpper) expect(amount0).toBe(0n);

        if (isInRange(sqrtPrice, range)) {
          // Both sides are genuinely non-zero in exact arithmetic, but a dust
          // position (L=1 across one tick) floors to zero on both — which is
          // correct. Rounding up is where the claim actually bites.
          const up = amountsForLiquidity({ sqrtPrice, range, liquidity, rounding: 'up' });
          expect(up.amount0 > 0n).toBe(true);
          expect(up.amount1 > 0n).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('is continuous across the range boundaries', () => {
    // The predecessor mixed `<` and `<=` between branches, which puts a step
    // discontinuity exactly at the endpoints — where users park their ranges.
    fc.assert(
      fc.property(anyRange, anyLiquidity, ({ range, lower, upper }, liquidity) => {
        const atLower = amountsForLiquidity({ sqrtPrice: range.sqrtLower, range, liquidity });
        const justBelow = amountsForLiquidity({
          sqrtPrice: getSqrtRatioAtTick((lower - 1) as Tick),
          range,
          liquidity,
        });
        const atUpper = amountsForLiquidity({ sqrtPrice: range.sqrtUpper, range, liquidity });
        const justAbove = amountsForLiquidity({
          sqrtPrice: getSqrtRatioAtTick((upper + 1) as Tick),
          range,
          liquidity,
        });

        // One tick apart, so the amounts differ by at most one tick's worth.
        expect(atLower.amount1).toBe(0n);
        expect(justBelow.amount1).toBe(0n);
        expect(atUpper.amount0).toBe(0n);
        expect(justAbove.amount0).toBe(0n);
      }),
      { numRuns: 300 },
    );
  });

  it('rounds up to at least what it rounds down to, and by at most one wei', () => {
    fc.assert(
      fc.property(anyRange, anyPriceTick, anyLiquidity, ({ range }, sqrtPrice, liquidity) => {
        const down = amountsForLiquidity({ sqrtPrice, range, liquidity, rounding: 'down' });
        const up = amountsForLiquidity({ sqrtPrice, range, liquidity, rounding: 'up' });
        expect(up.amount0 >= down.amount0).toBe(true);
        expect(up.amount1 >= down.amount1).toBe(true);
        expect(up.amount0 - down.amount0 <= 1n).toBe(true);
        expect(up.amount1 - down.amount1 <= 1n).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('handles the full tick range without overflow', () => {
    const range: SqrtRange = {
      sqrtLower: getSqrtRatioAtTick(MIN_TICK as Tick),
      sqrtUpper: getSqrtRatioAtTick(MAX_TICK as Tick),
    };
    const result = amountsForLiquidity({
      sqrtPrice: getSqrtRatioAtTick(0 as Tick),
      range,
      liquidity: (10n ** 27n) as Liquidity,
    });
    expect(result.amount0 > 0n).toBe(true);
    expect(result.amount1 > 0n).toBe(true);
  });
});
