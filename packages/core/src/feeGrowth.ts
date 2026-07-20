/**
 * Fee accrual from feeGrowthGlobal.
 *
 * `feeGrowthGlobal{0,1}X128` is a uint256 in Q128.128 that the pool increments
 * as fees accrue and that WRAPS mod 2^256 by design. The predecessor called
 * `parseInt()` on it — discarding ~205 bits before any arithmetic, and unable
 * to represent the wrap at all. That single line is why this project exists.
 * Here the value is a BigInt end to end and the delta is taken mod 2^256.
 */
import { CoreError } from './errors.js';
import {
  type Amounts,
  FeeGrowthX128 as FeeGrowthCtor,
  type FeeGrowthX128,
  type Liquidity,
  Raw as RawCtor,
} from './units.js';

const Q128 = 1n << 128n;
const TWO256 = 1n << 256n;
const BPS = 10_000n;

/**
 * The fee growth accrued between two snapshots, per unit of liquidity, as a
 * Q128 value. Because feeGrowthGlobal wraps, the difference is taken mod 2^256;
 * `current < previous` is the wrap case and it happens on real pools, so it is
 * handled, not guarded against.
 */
export function feeGrowthDelta(current: FeeGrowthX128, previous: FeeGrowthX128): FeeGrowthX128 {
  return FeeGrowthCtor.of((((current - previous) % TWO256) + TWO256) % TWO256);
}

/**
 * Fees earned by `liquidity` over a period, as raw token amounts.
 *
 * The multiplication happens BEFORE the Q128 shift, so no precision is lost:
 * `(L · Δfg · activeBps) / (2^128 · 10000)`. `activeBps` is an integer in
 * [0, 10000] — keeping the in-range fraction integral means the whole
 * computation stays exact until the final floor division.
 */
export function feesForLiquidity(args: {
  liquidity: Liquidity;
  delta0: FeeGrowthX128;
  delta1: FeeGrowthX128;
  activeBps: number;
}): Amounts {
  const { liquidity, delta0, delta1, activeBps } = args;
  if (!Number.isInteger(activeBps) || activeBps < 0 || activeBps > 10_000) {
    throw new CoreError('NOT_FINITE', 'activeBps must be an integer in [0, 10000]', activeBps);
  }
  const bps = BigInt(activeBps);
  const denom = Q128 * BPS;
  return {
    amount0: RawCtor.of((liquidity * delta0 * bps) / denom),
    amount1: RawCtor.of((liquidity * delta1 * bps) / denom),
  };
}

/**
 * Fee growth per unit of *unbounded* liquidity converted to the amounts a
 * reference full-range position of the given size would earn. Kept alongside
 * the position fees so the backtest can show the concentration multiple.
 */
export function unboundedFees(args: {
  liquidity: Liquidity;
  delta0: FeeGrowthX128;
  delta1: FeeGrowthX128;
}): Amounts {
  // Unbounded liquidity is always in range, so activeBps is a full 10000.
  return feesForLiquidity({ ...args, activeBps: 10_000 });
}
