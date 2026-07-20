/**
 * Builds the strategy model the charts render, entirely from core. Every number
 * here came out of packages/core; this file only arranges them and catches the
 * CoreErrors that a pathological input (a notional too small to represent, a
 * range the pool can't hold) throws, turning them into a message rather than a
 * crash.
 */
import {
  CoreError,
  type CurvePoint,
  type DiffPoint,
  entrySplit,
  getTickAtSqrtRatio,
  type Hedge,
  HumanPrice as HumanPriceCtor,
  impermanentLossCurve,
  type LeveredPoint,
  type LiquidationSegment,
  leveragedCurve,
  liquidationSegments,
  type Orientation,
  type Position,
  type PriceGrid,
  type PriceScale,
  payoffCurve,
  positionFromNotional,
  priceAtTick,
  priceGrid,
  priceScale,
  roundTick,
  SqrtPriceX96,
  type Tick,
  type TickRange,
  tickRange,
} from '@poollab/core';
import type { Pool } from '../api/types.js';
import { poolKeyFromApi } from './pool.js';

export interface StrategyModel {
  readonly scale: PriceScale;
  readonly orientation: Orientation;
  readonly baseSymbol: string;
  readonly quoteSymbol: string;
  readonly entryPrice: number;
  readonly currentTick: Tick;
  readonly currentSqrtPrice: SqrtPriceX96;
  readonly range: TickRange;
  readonly position: Position;
  readonly lowerPrice: number;
  readonly upperPrice: number;
  readonly grid: PriceGrid;
  readonly curves: {
    readonly v3: readonly CurvePoint[];
    readonly v2: readonly CurvePoint[];
    readonly hodl5050: readonly CurvePoint[];
    readonly hodlBase: readonly CurvePoint[];
  };
  readonly il: readonly DiffPoint[];
  readonly split: { readonly amount0: number; readonly amount1: number; readonly ratio0: number };
  readonly notional: number;
  readonly leverage: number;
  readonly hedge: Hedge;
  /** A second comparison range (S2), when both bounds are set. */
  readonly compare: {
    readonly range: TickRange;
    readonly lowerPrice: number;
    readonly upperPrice: number;
    readonly curve: readonly CurvePoint[];
  } | null;
  /** The equity payoff overlay + liquidation bands, present only when levered or hedged. */
  readonly levered: {
    readonly curve: readonly LeveredPoint[];
    readonly segments: readonly LiquidationSegment[];
  } | null;
}

export interface ModelInput {
  readonly notional: number;
  readonly lower?: number | undefined;
  readonly upper?: number | undefined;
  readonly inverted: boolean;
  readonly leverage?: number;
  readonly hedgeSide?: 'none' | 'long' | 'short';
  readonly hedgePct?: number;
  readonly lower2?: number | undefined;
  readonly upper2?: number | undefined;
}

/** ~±15% expressed in ticks, the default half-width when a range isn't set. */
const DEFAULT_HALF_WIDTH = 1400;

/** Maintenance margin below which a levered position is flagged liquidated. */
const MAINTENANCE_MARGIN = 0.0625;

function chooseOrientation(pool: Pool, inverted: boolean): Orientation {
  // Default to the orientation whose price reads ≥ 1 (the volatile token priced
  // in the larger-unit one), then let `inverted` flip it.
  let base: Orientation = 'token1PerToken0';
  try {
    const scale = priceScale(poolKeyFromApi(pool), 'token0PerToken1');
    if (priceAtTick(scale, getTickAtSqrtRatio(SqrtPriceX96.of(pool.sqrtPrice))) >= 1) {
      base = 'token0PerToken1';
    }
  } catch {
    // keep the default
  }
  if (!inverted) return base;
  return base === 'token1PerToken0' ? 'token0PerToken1' : 'token1PerToken0';
}

export type ModelResult = { ok: true; model: StrategyModel } | { ok: false; error: string };

export function buildModel(pool: Pool, rawInput: ModelInput): ModelResult {
  const input = {
    ...rawInput,
    leverage: rawInput.leverage ?? 1,
    hedgeSide: rawInput.hedgeSide ?? ('none' as const),
    hedgePct: rawInput.hedgePct ?? 0.5,
  };
  try {
    const key = poolKeyFromApi(pool);
    const orientation = chooseOrientation(pool, input.inverted);
    const scale = priceScale(key, orientation);
    const spacing = key.tickSpacing;

    const currentSqrtPrice = SqrtPriceX96.of(pool.sqrtPrice);
    const currentTick = getTickAtSqrtRatio(currentSqrtPrice);
    const entryPrice = priceAtTick(scale, currentTick);

    // Ticks map to price monotonically in one orientation and inversely in the
    // other; the range is defined in tick space, so it is orientation-agnostic.
    const lower =
      input.lower ?? roundTick((currentTick - DEFAULT_HALF_WIDTH) as Tick, spacing, 'down');
    const upper =
      input.upper ?? roundTick((currentTick + DEFAULT_HALF_WIDTH) as Tick, spacing, 'up');
    const range = tickRange(lower as Tick, upper as Tick);

    // A second comparison range, only when both bounds are supplied.
    const range2 =
      input.lower2 !== undefined && input.upper2 !== undefined
        ? tickRange(input.lower2 as Tick, input.upper2 as Tick)
        : null;

    const grid = priceGrid({
      scale,
      currentPrice: entryPrice,
      ranges: range2 ? [range, range2] : [range],
    });
    const shared = { scale, notional: input.notional, entryPrice, grid } as const;

    const curves = {
      v3: payoffCurve({ ...shared, strategy: { kind: 'v3', range } }),
      v2: payoffCurve({ ...shared, strategy: { kind: 'v2' } }),
      hodl5050: payoffCurve({ ...shared, strategy: { kind: 'hodl5050' } }),
      hodlBase: payoffCurve({ ...shared, strategy: { kind: 'hodlBase' } }),
    };
    const il = impermanentLossCurve({ scale, range, notional: input.notional, entryPrice, grid });

    const built = entrySplit({
      scale,
      range,
      notional: input.notional,
      entryPrice: HumanPriceCtor.of(entryPrice),
    });
    // The same position the backtest replays — built once, here.
    const position = positionFromNotional({
      scale,
      price: HumanPriceCtor.of(entryPrice),
      range,
      notional: input.notional,
    });

    // Leverage treats `notional` as the LP position size and the equity as
    // notional/leverage — you hold the same position but put down 1/L of it.
    // The hedge is a perp of `hedgePct` of the position.
    const hedge: Hedge = {
      side: input.hedgeSide,
      notional: input.notional * input.hedgePct,
      leverage: 1,
    };
    const levered =
      input.leverage > 1 || hedge.side !== 'none'
        ? (() => {
            const curve = leveragedCurve({
              scale,
              range,
              equity: input.notional / input.leverage,
              leverage: input.leverage,
              entryPrice: HumanPriceCtor.of(entryPrice),
              grid,
              hedge,
            });
            return { curve, segments: liquidationSegments(curve, MAINTENANCE_MARGIN) };
          })()
        : null;

    const compare = range2
      ? {
          range: range2,
          lowerPrice: priceAtTick(scale, range2.lower),
          upperPrice: priceAtTick(scale, range2.upper),
          curve: payoffCurve({ ...shared, strategy: { kind: 'v3', range: range2 } }),
        }
      : null;

    return {
      ok: true,
      model: {
        scale,
        orientation,
        baseSymbol: scale.baseToken.symbol,
        quoteSymbol: scale.quoteToken.symbol,
        entryPrice,
        currentTick,
        currentSqrtPrice,
        range,
        position,
        lowerPrice: priceAtTick(scale, range.lower),
        upperPrice: priceAtTick(scale, range.upper),
        grid,
        curves,
        il,
        split: built,
        notional: input.notional,
        leverage: input.leverage,
        hedge,
        levered,
        compare,
      },
    };
  } catch (error) {
    if (error instanceof CoreError) return { ok: false, error: humanError(error) };
    throw error;
  }
}

function humanError(error: CoreError): string {
  switch (error.code) {
    case 'UNREPRESENTABLE_POSITION':
      return 'This position is too small for the pool to represent. Try a larger size or a narrower range.';
    case 'INVALID_RANGE':
      return 'The lower bound must be below the upper bound.';
    default:
      return error.message;
  }
}
