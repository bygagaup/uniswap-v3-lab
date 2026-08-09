/**
 * A concentrated-liquidity position: what it holds, what it is worth, and how
 * that compares to simply holding the tokens.
 *
 * Values are denominated in the scale's quote token — "USDC per WETH" means a
 * value in USDC. Amounts and liquidity stay exact (BigInt) right up to the
 * point a number becomes a chart coordinate, which is where `convert.ts` runs.
 */
import { rawToNumber } from './convert.js';
import { CoreError } from './errors.js';
import {
  amountsForLiquidity,
  assertRange,
  isInRange,
  liquidityForAmounts,
  type SqrtRange,
} from './liquidityMath.js';
import type { PoolKey } from './pool.js';
import { type PriceScale, sqrtRatioAtPriceExact } from './price.js';
import { getSqrtRatioAtTick } from './tickMath.js';
import {
  type Amounts,
  type HumanPrice,
  type Liquidity,
  Liquidity as LiquidityCtor,
  type Raw,
  Raw as RawCtor,
  type Tick,
} from './units.js';

/** A price range, always stored as ticks, always lower < upper. */
export interface TickRange {
  readonly lower: Tick;
  readonly upper: Tick;
}

export function tickRange(a: Tick, b: Tick): TickRange {
  if (a === b) {
    throw new CoreError('INVALID_RANGE', 'range endpoints coincide', { a, b });
  }
  return a < b ? { lower: a, upper: b } : { lower: b, upper: a };
}

export function sqrtRangeOf(range: TickRange): SqrtRange {
  return {
    sqrtLower: getSqrtRatioAtTick(range.lower),
    sqrtUpper: getSqrtRatioAtTick(range.upper),
  };
}

export interface Position {
  readonly pool: PoolKey;
  readonly range: TickRange;
  readonly liquidity: Liquidity;
}

export interface PositionValue {
  /** Human units of each token the position currently holds. */
  readonly amount0: number;
  readonly amount1: number;
  /** Total, denominated in the scale's quote token. */
  readonly value: number;
  readonly inRange: boolean;
  /** Share of `value` sitting in token0, in [0, 1]. */
  readonly ratio0: number;
}

/** Is the quote token of this scale token1? (i.e. prices read "token1 per token0") */
function quoteIsToken1(scale: PriceScale): boolean {
  return scale.orientation === 'token1PerToken0';
}

/**
 * Value a pair of human amounts in the scale's quote token.
 *
 * The base token is worth `price` each; the quote token is worth one of itself.
 * Every valuation in this module funnels through here, so the orientation is
 * applied in exactly one place.
 */
function valueInQuote(
  scale: PriceScale,
  amount0: number,
  amount1: number,
  price: HumanPrice,
): number {
  return quoteIsToken1(scale) ? amount1 + amount0 * price : amount0 + amount1 * price;
}

function humanAmounts(scale: PriceScale, amounts: Amounts): { amount0: number; amount1: number } {
  return {
    amount0: rawToNumber(amounts.amount0, scale.pool.token0.decimals),
    amount1: rawToNumber(amounts.amount1, scale.pool.token1.decimals),
  };
}

/** Reference liquidity for sizing. Large enough that both amounts stay well clear of flooring. */
const SIZING_LIQUIDITY = 10n ** 24n;

/**
 * Build a position worth `notional` quote tokens at `price`.
 *
 * `notional` is the size of the LP position itself, before any leverage — see
 * "Notional" in CONTEXT.md. Financing is not a liquidity-math question: a
 * caller running leverage sizes the notional to `equity · leverage` and tracks
 * the debt separately, which is what `leveragedCurve` does.
 *
 * Value is linear in liquidity, so this values a reference L once and scales.
 */
export function positionFromNotional(args: {
  scale: PriceScale;
  price: HumanPrice;
  range: TickRange;
  notional: number;
}): Position {
  const { scale, price, range, notional } = args;

  if (!Number.isFinite(notional) || notional <= 0) {
    throw new CoreError('NEGATIVE_AMOUNT', 'notional must be a positive, finite amount', notional);
  }

  const sqrtRange = sqrtRangeOf(range);
  assertRange(sqrtRange);

  const sqrtPrice = sqrtRatioAtPriceExact(scale, price);
  const reference = amountsForLiquidity({
    sqrtPrice,
    range: sqrtRange,
    liquidity: LiquidityCtor.of(SIZING_LIQUIDITY),
    rounding: 'down',
  });

  const { amount0, amount1 } = humanAmounts(scale, reference);
  const referenceValue = valueInQuote(scale, amount0, amount1, price);
  if (!(referenceValue > 0) || !Number.isFinite(referenceValue)) {
    throw new CoreError('NOT_FINITE', 'range is too narrow to size a position against', {
      range,
      price,
      label: scale.label,
    });
  }

  const scaled = (Number(SIZING_LIQUIDITY) * notional) / referenceValue;
  if (!Number.isFinite(scaled) || scaled < 1) {
    throw new CoreError('NOT_FINITE', 'notional does not resolve to representable liquidity', {
      notional,
    });
  }

  // Round to nearest, not down. There is no "never over-mint" constraint here —
  // we are sizing to a target value, not spending a fixed deposit — so flooring
  // would just bias every position small. Liquidity is a uint128 integer, so
  // sizing is exact only to within one unit of L; see `sizingQuantum`.
  const position: Position = {
    pool: scale.pool,
    range,
    liquidity: LiquidityCtor.of(BigInt(Math.round(scaled))),
  };

  // Verify rather than assume. When the target is small relative to a token's
  // smallest unit, one side of the position floors to zero and the position is
  // worth a fraction of what was asked — a wide range on an 18-decimal token
  // priced at 1e20 against a 6-decimal one will do it. Returning that quietly
  // is precisely the class of silent wrongness this core exists to avoid.
  const target = notional;
  const achieved = positionValue({ scale, position, price }).value;
  if (Math.abs(achieved - target) / target > 1e-6) {
    throw new CoreError(
      'UNREPRESENTABLE_POSITION',
      'notional is too small for this pool and range to represent — one side of the position rounds to zero',
      { target, achieved, liquidity: position.liquidity.toString(), label: scale.label },
    );
  }

  return position;
}

/**
 * Relative precision of a sized position: one unit of L as a fraction of the
 * whole. Liquidity is an integer, so a position can only be sized to within
 * this much of its target.
 *
 * On real pools it is around 1e-15 and can be ignored. It becomes visible only
 * when a token has very few decimals, where one unit of L is worth a great deal
 * — surface it rather than let a caller believe the sizing was exact.
 */
export function sizingQuantum(position: Position): number {
  return position.liquidity > 0n ? 1 / Number(position.liquidity) : Number.POSITIVE_INFINITY;
}

/** What the position holds, and what it is worth, at a given price. */
export function positionValue(args: {
  scale: PriceScale;
  position: Position;
  price: HumanPrice;
}): PositionValue {
  const { scale, position, price } = args;
  const sqrtRange = sqrtRangeOf(position.range);
  const sqrtPrice = sqrtRatioAtPriceExact(scale, price);

  const { amount0, amount1 } = humanAmounts(
    scale,
    amountsForLiquidity({
      sqrtPrice,
      range: sqrtRange,
      liquidity: position.liquidity,
      rounding: 'down',
    }),
  );

  const value = valueInQuote(scale, amount0, amount1, price);
  const value0 = quoteIsToken1(scale) ? amount0 * price : amount0;

  return {
    amount0,
    amount1,
    value,
    inRange: isInRange(sqrtPrice, sqrtRange),
    ratio0: value > 0 ? value0 / value : 0,
  };
}

/** The token amounts a position was opened with, held unchanged. */
export interface HodlBasket {
  readonly amount0: number;
  readonly amount1: number;
}

export function hodlBasketOf(args: {
  scale: PriceScale;
  position: Position;
  entryPrice: HumanPrice;
}): HodlBasket {
  const { amount0, amount1 } = positionValue({
    scale: args.scale,
    position: args.position,
    price: args.entryPrice,
  });
  return { amount0, amount1 };
}

/** What the entry basket is worth at some other price. */
export function hodlValue(args: {
  scale: PriceScale;
  basket: HodlBasket;
  price: HumanPrice;
}): number {
  return valueInQuote(args.scale, args.basket.amount0, args.basket.amount1, args.price);
}

/**
 * Impermanent loss as a signed fraction: `(lp - hodl) / hodl`.
 *
 * Always <= 0, and exactly 0 at the entry price. It is a *relative* measure, so
 * it is independent of position size — which is why it is reported separately
 * from the payoff curve rather than derived from it by subtraction.
 */
export function impermanentLoss(args: {
  scale: PriceScale;
  position: Position;
  entryPrice: HumanPrice;
  price: HumanPrice;
}): number {
  const { scale, position, entryPrice, price } = args;

  const basket = hodlBasketOf({ scale, position, entryPrice });
  const hodl = hodlValue({ scale, basket, price });
  if (!(hodl > 0)) {
    throw new CoreError('NOT_FINITE', 'hodl basket has no value to compare against', {
      entryPrice,
      price,
    });
  }

  const lp = positionValue({ scale, position, price }).value;
  return (lp - hodl) / hodl;
}

/**
 * A directional perp overlay, in the scale's quote token.
 *
 * A short flattens an LP's upside and offsets its downside IL; a long amplifies.
 * `notional` is the size of the hedge before leverage, on the same footing as
 * an LP position's notional, so the exposure it carries is `notional · leverage`.
 */
export interface Hedge {
  readonly side: 'long' | 'short' | 'none';
  readonly notional: number;
  readonly leverage: number;
}

export const NO_HEDGE: Hedge = { side: 'none', notional: 0, leverage: 1 };

/** Hedge PnL in quote terms at `price`, relative to `entryPrice`. */
export function hedgePnl(hedge: Hedge, entryPrice: HumanPrice, price: HumanPrice): number {
  if (hedge.side === 'none' || hedge.notional <= 0) return 0;
  const move = (price - entryPrice) / entryPrice;
  const exposure = hedge.notional * hedge.leverage;
  return hedge.side === 'long' ? exposure * move : -exposure * move;
}

/**
 * Health of a leveraged position: equity as a fraction of the position value,
 * where equity is the position value net of the fixed debt taken on to lever it.
 *
 * Returns `null` when there is no debt (leverage 1) — the position cannot be
 * liquidated, so its margin is unbounded rather than a made-up number. The
 * predecessor stuffed the string "∞" into a numeric field and then compared it
 * with `>=`; this keeps the type honest.
 */
export function marginRatio(args: { positionValue: number; debt: number }): number | null {
  if (args.debt <= 0) return null;
  if (args.positionValue <= 0) return 0;
  return (args.positionValue - args.debt) / args.positionValue;
}

/** The deposit a position implies at a given price — what a mint would cost. */
export function depositFor(args: {
  scale: PriceScale;
  position: Position;
  price: HumanPrice;
}): Amounts {
  return amountsForLiquidity({
    sqrtPrice: sqrtRatioAtPriceExact(args.scale, args.price),
    range: sqrtRangeOf(args.position.range),
    liquidity: args.position.liquidity,
    // Minting rounds against the depositor.
    rounding: 'up',
  });
}

/** Largest position the given deposit supports at `price`. */
export function positionFromDeposit(args: {
  scale: PriceScale;
  price: HumanPrice;
  range: TickRange;
  amount0: Raw;
  amount1: Raw;
}): Position {
  const sqrtRange = sqrtRangeOf(args.range);
  assertRange(sqrtRange);

  return {
    pool: args.scale.pool,
    range: args.range,
    liquidity: liquidityForAmounts({
      sqrtPrice: sqrtRatioAtPriceExact(args.scale, args.price),
      range: sqrtRange,
      amounts: { amount0: args.amount0 ?? RawCtor.ZERO, amount1: args.amount1 ?? RawCtor.ZERO },
    }),
  };
}
