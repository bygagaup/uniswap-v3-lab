/**
 * Liquidity distribution across ticks.
 *
 * `liquidityNet` is a signed int128 that the pool adds to the active liquidity
 * as the price crosses a tick upward. Summing it from the low end gives the
 * liquidity in force in each interval; the sum over a complete tick set is
 * exactly zero, and the running sum at the current tick is the pool's active
 * liquidity — which is the M6 exit criterion, checked against real pools.
 *
 * The accumulation is BigInt: individual nets reach 1e25 and cancel, and a
 * double would lose whole tokens to that cancellation. The predecessor used a
 * float here and approximated each bar's width as `1 + feeTier/500000`; this
 * uses the real distance to the next initialized tick.
 */

import { rawToNumber } from './convert.js';
import { CoreError } from './errors.js';
import { amountsForLiquidity } from './liquidityMath.js';
import type { TickRange } from './position.js';
import { type PriceScale, priceAtTick } from './price.js';
import { getSqrtRatioAtTick } from './tickMath.js';
import {
  type Liquidity,
  Liquidity as LiquidityCtor,
  type SqrtPriceX96,
  type Tick,
  Tick as TickCtor,
} from './units.js';

export interface TickDatum {
  readonly tickIdx: number;
  /** Signed int128, as a decimal string; may be negative. */
  readonly liquidityNet: string;
}

export interface DensityBar {
  readonly tickLower: Tick;
  readonly tickUpper: Tick;
  /** Active liquidity across [tickLower, tickUpper). Non-negative. */
  readonly liquidity: Liquidity;
  readonly priceLower: number;
  readonly priceUpper: number;
  /** Human token amounts locked in this interval at the current price. */
  readonly amount0: number;
  readonly amount1: number;
  /** True for the interval that contains the current tick. */
  readonly isActive: boolean;
}

/**
 * Builds the density bars from an ascending tick set and the current price.
 *
 * The token composition of each bar follows from where the current price sits:
 * a bar wholly below it holds only token1 (already bought through), one wholly
 * above holds only token0 (waiting), and the active bar is split — all of which
 * the branch logic in amountsForLiquidity produces for free when handed the
 * bar's own range and the current sqrt price.
 */
export function liquidityDensity(args: {
  scale: PriceScale;
  ticks: readonly TickDatum[];
  currentTick: Tick;
  /** The live sqrt price, for an exact active-bar split. Defaults to the tick's. */
  currentSqrtPrice?: SqrtPriceX96;
}): readonly DensityBar[] {
  const { scale, ticks, currentTick } = args;
  if (ticks.length < 2) return [];

  for (let i = 1; i < ticks.length; i++) {
    if ((ticks[i] as TickDatum).tickIdx <= (ticks[i - 1] as TickDatum).tickIdx) {
      throw new CoreError('CANDLES_NOT_ASCENDING', 'ticks must be strictly ascending by tickIdx', {
        at: i,
      });
    }
  }

  const currentSqrt = args.currentSqrtPrice ?? getSqrtRatioAtTick(currentTick);
  const decimals0 = scale.pool.token0.decimals;
  const decimals1 = scale.pool.token1.decimals;

  const bars: DensityBar[] = [];
  let cumulative = 0n;

  for (let i = 0; i < ticks.length - 1; i++) {
    const here = ticks[i] as TickDatum;
    const next = ticks[i + 1] as TickDatum;
    cumulative += BigInt(here.liquidityNet);

    // A negative running sum means the tick set is inconsistent (missing ticks
    // below the window, or misordered) — better to say so than to draw nonsense.
    if (cumulative < 0n) {
      throw new CoreError('NEGATIVE_AMOUNT', 'cumulative liquidity went negative', {
        at: here.tickIdx,
      });
    }
    if (cumulative === 0n) continue;

    const lower = TickCtor.of(here.tickIdx);
    const upper = TickCtor.of(next.tickIdx);
    const liquidity = LiquidityCtor.of(cumulative);

    const amounts = amountsForLiquidity({
      sqrtPrice: currentSqrt,
      range: { sqrtLower: getSqrtRatioAtTick(lower), sqrtUpper: getSqrtRatioAtTick(upper) },
      liquidity,
      rounding: 'down',
    });

    bars.push({
      tickLower: lower,
      tickUpper: upper,
      liquidity,
      priceLower: priceAtTick(scale, lower),
      priceUpper: priceAtTick(scale, upper),
      amount0: rawToNumber(amounts.amount0, decimals0),
      amount1: rawToNumber(amounts.amount1, decimals1),
      isActive: here.tickIdx <= currentTick && currentTick < next.tickIdx,
    });
  }

  return bars;
}

/**
 * The active liquidity implied at the current tick: the sum of liquidityNet for
 * every tick at or below it. This is the value the pool reports as `liquidity`,
 * and the fixture test pins the two together.
 */
export function activeLiquidityAt(ticks: readonly TickDatum[], currentTick: Tick): Liquidity {
  let sum = 0n;
  for (const tick of ticks) {
    if (tick.tickIdx <= currentTick) sum += BigInt(tick.liquidityNet);
  }
  if (sum < 0n) {
    throw new CoreError('NEGATIVE_AMOUNT', 'active liquidity summed negative', { currentTick });
  }
  return LiquidityCtor.of(sum);
}

/** Sum of liquidityNet over the whole set — zero iff every initialized tick is present. */
export function netSum(ticks: readonly TickDatum[]): bigint {
  let sum = 0n;
  for (const tick of ticks) sum += BigInt(tick.liquidityNet);
  return sum;
}

/**
 * Clips bars to a tick window, trimming the edge bars to the window rather than
 * dropping them, so the zoomed view still shows partial liquidity at the edges.
 */
export function clipDensity(bars: readonly DensityBar[], window: TickRange): readonly DensityBar[] {
  return bars.filter((bar) => bar.tickUpper > window.lower && bar.tickLower < window.upper);
}

/** Share of total liquidity·width sitting inside the window, in [0, 1]. */
export function concentrationIndex(bars: readonly DensityBar[], window: TickRange): number {
  let inside = 0;
  let total = 0;
  for (const bar of bars) {
    const width = bar.tickUpper - bar.tickLower;
    const mass = Number(bar.liquidity) * width;
    total += mass;
    const lo = Math.max(bar.tickLower, window.lower);
    const hi = Math.min(bar.tickUpper, window.upper);
    if (hi > lo) inside += Number(bar.liquidity) * (hi - lo);
  }
  return total > 0 ? inside / total : 0;
}
