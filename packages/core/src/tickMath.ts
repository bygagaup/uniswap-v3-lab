/**
 * Exact tick <-> sqrt-price conversion, in BigInt.
 *
 * `getSqrtRatioAtTick` reproduces the pool's own bit-decomposition, including
 * its rounding, because pool and position state is *defined* by that result —
 * a "more accurate" value would disagree with the chain, which is the wrong
 * kind of correct. The constants it multiplies are generated from the formula
 * (see scripts/gen-tick-constants.ts), not transcribed.
 */
import { CoreError } from './errors.js';
import { TICK_CONSTANTS } from './tickMath.constants.js';
import {
  MAX_SQRT_RATIO_VALUE,
  MAX_TICK,
  MIN_SQRT_RATIO_VALUE,
  MIN_TICK,
  type SqrtPriceX96,
  SqrtPriceX96 as SqrtPriceX96Ctor,
  type Tick,
  Tick as TickCtor,
  UINT256_MAX,
} from './units.js';

export { MAX_TICK, MIN_TICK } from './units.js';

export const MIN_SQRT_RATIO: SqrtPriceX96 = SqrtPriceX96Ctor.MIN;
export const MAX_SQRT_RATIO: SqrtPriceX96 = SqrtPriceX96Ctor.MAX;

const Q128 = 1n << 128n;
const Q32 = 1n << 32n;

/**
 * `sqrt(1.0001^tick) * 2^96`.
 *
 * |tick| is decomposed into bits; each set bit multiplies in one Q128 constant.
 * A negative tick uses the table directly (the constants are reciprocals); a
 * positive tick inverts at the end. The final Q128 -> Q96 shift rounds up,
 * matching the pool.
 */
export function getSqrtRatioAtTick(tick: Tick): SqrtPriceX96 {
  const absTick = tick < 0 ? -tick : tick;

  let ratio = (absTick & 1) !== 0 ? (TICK_CONSTANTS[0] as bigint) : Q128;
  for (let i = 1; i < TICK_CONSTANTS.length; i++) {
    if ((absTick & (1 << i)) !== 0) {
      ratio = (ratio * (TICK_CONSTANTS[i] as bigint)) >> 128n;
    }
  }

  if (tick > 0) ratio = UINT256_MAX / ratio;

  // Q128.128 -> Q64.96, rounding up.
  const shifted = ratio >> 32n;
  return SqrtPriceX96Ctor.unchecked(ratio % Q32 === 0n ? shifted : shifted + 1n);
}

/**
 * The largest tick `t` with `getSqrtRatioAtTick(t) <= sqrtP`.
 *
 * A binary search over `getSqrtRatioAtTick`, not a port of the contract's log2
 * approximation. That approximation exists because gas costs money; here 21
 * iterations of obviously-correct code buys a function whose correctness is a
 * one-line consequence of monotonicity, and the round-trip property proves it.
 */
export function getTickAtSqrtRatio(sqrtP: SqrtPriceX96): Tick {
  if (sqrtP < MIN_SQRT_RATIO_VALUE || sqrtP > MAX_SQRT_RATIO_VALUE) {
    throw new CoreError(
      'SQRT_RATIO_OUT_OF_RANGE',
      `sqrtPriceX96 must be in [${MIN_SQRT_RATIO_VALUE}, ${MAX_SQRT_RATIO_VALUE}]`,
      sqrtP.toString(),
    );
  }

  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    // Bias the midpoint upward so `lo = mid` always makes progress.
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (getSqrtRatioAtTick(mid as Tick) <= sqrtP) lo = mid;
    else hi = mid - 1;
  }
  return lo as Tick;
}

/**
 * Snap a tick to an initializable one.
 *
 * `nearest` is for reading a user's intent off a chart; `down`/`up` are for
 * widening a range to the ticks a pool will actually accept.
 */
export function roundTick(
  tick: Tick,
  spacing: number,
  mode: 'nearest' | 'down' | 'up' = 'nearest',
): Tick {
  if (!Number.isInteger(spacing) || spacing <= 0) {
    throw new CoreError('UNKNOWN_FEE_TIER', 'tick spacing must be a positive integer', spacing);
  }

  const q = tick / spacing;
  const raw =
    mode === 'nearest'
      ? Math.round(q) * spacing
      : mode === 'down'
        ? Math.floor(q) * spacing
        : Math.ceil(q) * spacing;

  // Rounding a small negative tick yields -0, which stringifies as "-0" in the
  // UI and survives every === check that would otherwise catch it.
  const snapped = raw === 0 ? 0 : raw;

  // Snapping outward can leave the representable band; clamp back inside it.
  if (snapped < MIN_TICK) return (Math.ceil(MIN_TICK / spacing) * spacing) as Tick;
  if (snapped > MAX_TICK) return (Math.floor(MAX_TICK / spacing) * spacing) as Tick;
  return TickCtor.of(snapped);
}
