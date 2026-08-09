/**
 * Payoff curves: what each strategy is worth across a shared band of prices.
 *
 * The PriceGrid is a first-class object every curve samples, so two curves are
 * always defined at the same prices and their pointwise difference (IL) is
 * well-defined. The predecessor recomputed a step per generator and relied on
 * them agreeing, which is why its IL indexed one series into another by
 * position and broke when they drifted.
 *
 * Values are denominated in the scale's quote token, so a payoff and a HODL
 * baseline are directly comparable.
 */
import { CoreError } from './errors.js';
import {
  type Hedge,
  hedgePnl,
  impermanentLoss,
  marginRatio,
  NO_HEDGE,
  type Position,
  positionFromNotional,
  positionValue,
  type TickRange,
  tickRange,
} from './position.js';
import {
  type HumanPrice,
  HumanPrice as HumanPriceCtor,
  type PriceScale,
  priceAtTick,
} from './price.js';
import { MAX_TICK, MIN_TICK, type Tick } from './units.js';

export interface PriceGrid {
  /** Ascending human prices. */
  readonly prices: readonly number[];
  /** The pool's current price, for a marker. May fall between grid points. */
  readonly current: number;
  readonly spacing: 'linear' | 'log';
}

/**
 * A grid spanning the current price and every range, padded so the interesting
 * structure sits inside the frame. Log spacing by default: price is naturally
 * multiplicative, and a linear grid wastes resolution at the low end.
 */
export function priceGrid(args: {
  scale: PriceScale;
  currentPrice: HumanPrice;
  ranges?: readonly TickRange[];
  count?: number;
  padding?: number;
  spacing?: 'linear' | 'log';
}): PriceGrid {
  const count = args.count ?? 200;
  const padding = args.padding ?? 1.15;
  const spacing = args.spacing ?? 'log';

  const anchors: number[] = [args.currentPrice];
  for (const range of args.ranges ?? []) {
    anchors.push(priceAtTick(args.scale, range.lower), priceAtTick(args.scale, range.upper));
  }
  const lo = Math.min(...anchors) / padding;
  const hi = Math.max(...anchors) * padding;

  if (!(lo > 0) || !(hi > lo)) {
    throw new CoreError('NOT_FINITE', 'cannot build a price grid from these anchors', { lo, hi });
  }

  const prices: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    prices.push(spacing === 'log' ? lo * (hi / lo) ** t : lo + (hi - lo) * t);
  }
  return { prices, current: args.currentPrice, spacing };
}

/**
 * Which curve to sample. `v3` and `v2` are strategies — positions actually held
 * in a pool; the `hodl*` variants are baselines, held for comparison and never
 * minted. See CONTEXT.md; both are drawn by the same function on the same grid,
 * which is why one union covers them.
 */
export type CurveKind =
  | { readonly kind: 'v3'; readonly range: TickRange }
  | { readonly kind: 'v2' }
  | { readonly kind: 'hodlBase' }
  | { readonly kind: 'hodlQuote' }
  | { readonly kind: 'hodl5050' };

export interface CurvePoint {
  readonly price: number;
  readonly value: number;
}

/** Full-tick range, so a "V2 unbounded" position is just a full-range V3 one. */
const FULL_RANGE: TickRange = tickRange(MIN_TICK as Tick, MAX_TICK as Tick);

function v3Curve(
  scale: PriceScale,
  range: TickRange,
  notional: number,
  entryPrice: HumanPrice,
  grid: PriceGrid,
): { position: Position; points: CurvePoint[] } {
  const position = positionFromNotional({ scale, price: entryPrice, range, notional });
  const points = grid.prices.map((price) => ({
    price,
    value: positionValue({ scale, position, price: HumanPriceCtor.of(price) }).value,
  }));
  return { position, points };
}

/**
 * The payoff curve for one strategy, sampled on the grid.
 *
 * HODL baselines are closed forms in the quote numeraire: holding the base
 * token is linear in price, holding the quote token is flat, a 50/50 split is
 * their average. V3 and V2 go through the same liquidity math (V2 is a
 * full-range V3), so every curve is mutually consistent by construction.
 */
export function payoffCurve(args: {
  scale: PriceScale;
  curve: CurveKind;
  notional: number;
  entryPrice: HumanPrice;
  grid: PriceGrid;
}): readonly CurvePoint[] {
  const { scale, curve, notional, entryPrice, grid } = args;
  const p0 = entryPrice;

  switch (curve.kind) {
    case 'v3':
      return v3Curve(scale, curve.range, notional, entryPrice, grid).points;
    case 'v2':
      return v3Curve(scale, FULL_RANGE, notional, entryPrice, grid).points;
    case 'hodlBase':
      // All notional in the base token at entry: value = N · P/P0.
      return grid.prices.map((price) => ({ price, value: (notional * price) / p0 }));
    case 'hodlQuote':
      // All notional in the quote token: value never moves with price.
      return grid.prices.map((price) => ({ price, value: notional }));
    case 'hodl5050':
      return grid.prices.map((price) => ({ price, value: (notional / 2) * (1 + price / p0) }));
    default: {
      const exhaustive: never = curve;
      throw new CoreError('NOT_FINITE', 'unknown curve kind', exhaustive);
    }
  }
}

export interface DiffPoint {
  readonly price: number;
  readonly value: number;
}

/**
 * Elementwise (a − b) / b over a shared grid. Throws on any grid mismatch —
 * the curves must have come from the same PriceGrid.
 */
export function relativeDifference(
  a: readonly CurvePoint[],
  b: readonly CurvePoint[],
): readonly DiffPoint[] {
  if (a.length !== b.length) {
    throw new CoreError('GRID_MISMATCH', 'curves have different lengths', {
      a: a.length,
      b: b.length,
    });
  }
  return a.map((point, i) => {
    const other = b[i];
    if (!other || other.price !== point.price) {
      throw new CoreError('GRID_MISMATCH', 'curves are not sampled at the same prices', { i });
    }
    return {
      price: point.price,
      value: other.value === 0 ? 0 : (point.value - other.value) / other.value,
    };
  });
}

/**
 * Impermanent loss of a range position across the grid: LP value against the
 * value of simply holding the entry basket, as a signed fraction ≤ 0.
 */
export function impermanentLossCurve(args: {
  scale: PriceScale;
  range: TickRange;
  notional: number;
  entryPrice: HumanPrice;
  grid: PriceGrid;
}): readonly DiffPoint[] {
  const { scale, range, notional, entryPrice, grid } = args;
  const position = positionFromNotional({ scale, price: entryPrice, range, notional });
  return grid.prices.map((price) => ({
    price,
    value: impermanentLoss({ scale, position, entryPrice, price: HumanPriceCtor.of(price) }),
  }));
}

export interface LeveredPoint {
  readonly price: number;
  /**
   * Equity: the LP position net of debt, plus any hedge PnL. Deliberately not
   * called `value` — a CurvePoint's `value` is gross position value, and the
   * two are plotted on one axis. See CONTEXT.md.
   */
  readonly equity: number;
  /** Health in [0, 1], or null when unlevered (no debt, cannot be liquidated). */
  readonly margin: number | null;
}

/**
 * The equity curve of a leveraged, optionally hedged position.
 *
 * `equity` is the capital committed; `leverage` sizes the LP position to
 * `equity · leverage`, borrowing `equity · (leverage − 1)` in the quote token as
 * a fixed debt. Equity at each price is the LP value minus that debt plus the
 * hedge PnL — so at entry it is exactly `equity`, and it can go to zero
 * (liquidation) as the LP value falls toward the debt.
 */
export function leveragedCurve(args: {
  scale: PriceScale;
  range: TickRange;
  equity: number;
  leverage: number;
  entryPrice: HumanPrice;
  grid: PriceGrid;
  hedge?: Hedge;
}): readonly LeveredPoint[] {
  const { scale, range, equity, leverage, entryPrice, grid } = args;
  const hedge = args.hedge ?? NO_HEDGE;
  if (!(leverage >= 1)) {
    throw new CoreError('NOT_FINITE', 'leverage must be >= 1', leverage);
  }

  const notional = equity * leverage;
  const debt = equity * (leverage - 1);
  const position = positionFromNotional({ scale, price: entryPrice, range, notional });

  return grid.prices.map((price) => {
    const p = HumanPriceCtor.of(price);
    const lpValue = positionValue({ scale, position, price: p }).value;
    const pnl = hedgePnl(hedge, entryPrice, p);
    return {
      price,
      equity: lpValue - debt + pnl,
      margin: marginRatio({ positionValue: lpValue, debt }),
    };
  });
}

export interface LiquidationSegment {
  readonly liquidated: boolean;
  readonly points: readonly LeveredPoint[];
}

/**
 * Splits a levered curve into contiguous runs above and below the maintenance
 * margin, so the chart can shade the liquidated price bands. Replaces the
 * three-way slice() the predecessor did inline in the chart component.
 */
export function liquidationSegments(
  points: readonly LeveredPoint[],
  maintenanceMargin: number,
): readonly LiquidationSegment[] {
  const segments: LiquidationSegment[] = [];
  const isLiquidated = (p: LeveredPoint) => p.margin !== null && p.margin <= maintenanceMargin;

  for (const point of points) {
    const liquidated = isLiquidated(point);
    const last = segments[segments.length - 1];
    if (last && last.liquidated === liquidated) {
      (last.points as LeveredPoint[]).push(point);
    } else {
      segments.push({ liquidated, points: [point] });
    }
  }
  return segments;
}

/** The token split of a range position at entry, for the ratio indicator. */
export function entrySplit(args: {
  scale: PriceScale;
  range: TickRange;
  notional: number;
  entryPrice: HumanPrice;
}): { readonly amount0: number; readonly amount1: number; readonly ratio0: number } {
  const position = positionFromNotional({
    scale: args.scale,
    price: args.entryPrice,
    range: args.range,
    notional: args.notional,
  });
  const value = positionValue({ scale: args.scale, position, price: args.entryPrice });
  return { amount0: value.amount0, amount1: value.amount1, ratio0: value.ratio0 };
}
