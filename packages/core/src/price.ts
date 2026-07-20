/**
 * The decimals-and-orientation boundary.
 *
 * The predecessor spread `Math.pow(10, decimal0 - decimal1)` and three different
 * `baseSelected === 1` conventions across a dozen files, each independently
 * deciding whether to invert the price, swap the decimals, or swap array slots.
 * Here that decision is made once, when a `PriceScale` is built, and every other
 * module takes the scale as a parameter.
 */

import { sqrtRatioToRawPrice } from './convert.js';
import { CoreError } from './errors.js';
import type { PoolKey, TokenMeta } from './pool.js';
import { getSqrtRatioAtTick, getTickAtSqrtRatio } from './tickMath.js';
import {
  type HumanPrice,
  HumanPrice as HumanPriceCtor,
  MAX_TICK,
  MIN_TICK,
  type SqrtPriceX96,
  SqrtPriceX96 as SqrtPriceX96Ctor,
  type Tick,
  Tick as TickCtor,
} from './units.js';

/** Which token a price is quoted in. */
export type Orientation = 'token1PerToken0' | 'token0PerToken1';

export interface PriceScale {
  readonly pool: PoolKey;
  readonly orientation: Orientation;
  /** Denominator, e.g. WETH in "USDC per WETH". */
  readonly baseToken: TokenMeta;
  /** Numerator, e.g. USDC in "USDC per WETH". */
  readonly quoteToken: TokenMeta;
  readonly label: string;
}

const LN_10001 = Math.log(1.0001);

export function priceScale(pool: PoolKey, orientation: Orientation): PriceScale {
  const forward = orientation === 'token1PerToken0';
  const baseToken = forward ? pool.token0 : pool.token1;
  const quoteToken = forward ? pool.token1 : pool.token0;
  return {
    pool,
    orientation,
    baseToken,
    quoteToken,
    label: `${quoteToken.symbol} per ${baseToken.symbol}`,
  };
}

export function flip(scale: PriceScale): PriceScale {
  return priceScale(
    scale.pool,
    scale.orientation === 'token1PerToken0' ? 'token0PerToken1' : 'token1PerToken0',
  );
}

/** 10^(decimals0 - decimals1): raw token1/token0 -> human token1/token0. */
function decimalFactor(pool: PoolKey): number {
  return 10 ** (pool.token0.decimals - pool.token1.decimals);
}

function humanFromRaw(scale: PriceScale, rawPrice: number): HumanPrice {
  const forward = rawPrice * decimalFactor(scale.pool);
  const out = scale.orientation === 'token1PerToken0' ? forward : 1 / forward;
  if (!Number.isFinite(out) || out <= 0) {
    throw new CoreError('NOT_FINITE', 'price is not representable as a positive double', {
      rawPrice,
      label: scale.label,
    });
  }
  return out as HumanPrice;
}

function rawFromHuman(scale: PriceScale, price: HumanPrice): number {
  const forward = scale.orientation === 'token1PerToken0' ? price : 1 / price;
  const out = forward / decimalFactor(scale.pool);
  if (!Number.isFinite(out) || out <= 0) {
    throw new CoreError('NOT_FINITE', 'price does not map to a representable raw price', {
      price,
      label: scale.label,
    });
  }
  return out;
}

/** Tick -> human price. Full float precision; display rounding belongs upstack. */
export function priceAtTick(scale: PriceScale, tick: Tick): HumanPrice {
  return humanFromRaw(scale, 1.0001 ** tick);
}

/** sqrtPriceX96 -> human price in this scale. */
export function priceAtSqrtRatio(scale: PriceScale, sqrtP: SqrtPriceX96): HumanPrice {
  return humanFromRaw(scale, sqrtRatioToRawPrice(sqrtP));
}

/**
 * Human price -> tick, rounded to the nearest tick (NOT to tick spacing —
 * snapping to spacing is `roundTick`'s job and is a separate decision).
 */
export function tickAtPrice(scale: PriceScale, price: HumanPrice): Tick {
  const raw = rawFromHuman(scale, price);
  // `Math.round` of a tiny negative (price ≈ 1) yields -0, which stringifies as
  // "-0" and fails an Object.is round-trip against +0. Normalise it away.
  const tick = Math.round(Math.log(raw) / LN_10001) || 0;
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new CoreError('TICK_OUT_OF_RANGE', 'price lies outside the representable tick range', {
      price,
      tick,
      label: scale.label,
    });
  }
  return TickCtor.of(tick);
}

/**
 * Human price -> sqrtPriceX96, snapped to a tick.
 *
 * Use this whenever the result will be compared against, or combined with,
 * chain state: it returns a value the pool could actually hold.
 */
export function sqrtRatioAtPrice(scale: PriceScale, price: HumanPrice): SqrtPriceX96 {
  return getSqrtRatioAtTick(tickAtPrice(scale, price));
}

/**
 * Human price -> sqrtPriceX96 without tick snapping.
 *
 * Relative error ~1e-16, inherited from the float sqrt. Fine for sampling a
 * payoff curve at 200 arbitrary prices; NOT fine for anything reconciled
 * against the chain — use `sqrtRatioAtPrice` there. The two names differ so
 * that a misuse is visible in review rather than buried in a call site.
 */
export function sqrtRatioAtPriceExact(scale: PriceScale, price: HumanPrice): SqrtPriceX96 {
  const raw = rawFromHuman(scale, price);
  const root = Math.sqrt(raw);
  if (!Number.isFinite(root) || root <= 0) {
    throw new CoreError('NOT_FINITE', 'price does not map to a representable sqrt ratio', price);
  }

  // Scale into Q96 by decomposing the double rather than multiplying by 2^96.
  // `root` spans 1e-20 to 1e19, so any fixed-width intermediate throws away the
  // mantissa at one end of that range; splitting off the binary exponent keeps
  // all 53 bits wherever the value sits.
  const exponent = Math.floor(Math.log2(root));
  const mantissa = BigInt(Math.round((root / 2 ** exponent) * 2 ** 52));
  const shift = exponent - 52 + 96;
  const scaled = shift >= 0 ? mantissa << BigInt(shift) : mantissa >> BigInt(-shift);

  return SqrtPriceX96Ctor.of(scaled);
}

/** Round-trips a price through the tick grid — the price a pool can represent. */
export function snapPrice(scale: PriceScale, price: HumanPrice): HumanPrice {
  return priceAtTick(scale, tickAtPrice(scale, price));
}

export { getTickAtSqrtRatio, HumanPriceCtor as HumanPrice };
