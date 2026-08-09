/**
 * Hourly backtest of a position: fees earned, value tracked, return summarised.
 *
 * Preconditions are enforced, not assumed. Candles must be ASCENDING by time —
 * the subgraph returns them newest-first, and the predecessor reversed them in
 * a component where the `i-1` fee delta silently depended on the order. Here a
 * misordered set throws. The first hour has no predecessor, so it earns zero
 * fees and is kept explicitly rather than special-cased across eight
 * expressions.
 */

import { activeBpsForCandle } from './activeLiquidity.js';
import { rawToNumber } from './convert.js';
import { CoreError } from './errors.js';
import { feeGrowthDelta, feesForLiquidity } from './feeGrowth.js';
import { type Position, positionValue } from './position.js';
import {
  HumanPrice as HumanPriceCtor,
  type PriceScale,
  priceAtSqrtRatio,
  priceScale,
  tickAtPrice,
} from './price.js';
import {
  FeeGrowthX128,
  type HumanUsd,
  HumanUsd as HumanUsdCtor,
  type SqrtPriceX96,
  type Tick,
} from './units.js';

export interface HourCandle {
  readonly periodStartUnix: number;
  /** high/low/close as token0Price (token1 per token0), the subgraph's units. */
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly feeGrowthGlobal0X128: string;
  readonly feeGrowthGlobal1X128: string;
}

export interface HourResult {
  readonly timestamp: number;
  readonly price: number;
  readonly activeBps: number;
  readonly fee0: number;
  readonly fee1: number;
  /** In the scale's quote token. Unsuffixed value fields always are. */
  readonly feeValue: number;
  readonly feeUsd: HumanUsd;
  readonly cumulativeFeeValue: number;
  readonly positionValue: number;
  readonly totalValue: number;
}

export interface Tvl {
  readonly usd: HumanUsd;
  readonly token0: number;
  readonly token1: number;
}

export interface BacktestParams {
  readonly scale: PriceScale;
  readonly position: Position;
  readonly candles: readonly HourCandle[];
  readonly tvl: Tvl;
  /** The live price, used to detect which orientation the candles are quoted in. */
  readonly currentSqrtPrice: SqrtPriceX96;
}

function quoteIsToken1(scale: PriceScale): boolean {
  return scale.orientation === 'token1PerToken0';
}

function assertAscending(candles: readonly HourCandle[]): void {
  for (let i = 1; i < candles.length; i++) {
    if (
      (candles[i] as HourCandle).periodStartUnix <= (candles[i - 1] as HourCandle).periodStartUnix
    ) {
      throw new CoreError('CANDLES_NOT_ASCENDING', 'candles must ascend by periodStartUnix', {
        at: i,
      });
    }
  }
}

/**
 * Whether the candle prices are the reciprocal of token1/token0. Subgraph
 * deployments disagree on which orientation poolHourData.close is quoted in, so
 * detect it: compare the last close against the live price both ways. No
 * per-deployment assumption.
 */
function candlesInverted(
  candles: readonly HourCandle[],
  tickScale: PriceScale,
  currentSqrtPrice: SqrtPriceX96,
): boolean {
  const liveT1perT0 = priceAtSqrtRatio(tickScale, currentSqrtPrice);
  const lastClose = Number((candles[candles.length - 1] as HourCandle).close);
  const asIs = Math.abs(lastClose - liveT1perT0);
  const inv = lastClose > 0 ? Math.abs(1 / lastClose - liveT1perT0) : Number.POSITIVE_INFINITY;
  return inv < asIs;
}

export function runBacktest(params: BacktestParams): readonly HourResult[] {
  const { scale, position, candles, tvl } = params;
  if (candles.length === 0) return [];
  assertAscending(candles);

  // Tick conversion always goes through the token1PerToken0 scale, inverting the
  // candle prices first if the deployment quotes them the other way round.
  const tickScale = priceScale(scale.pool, 'token1PerToken0');
  const inverted = candlesInverted(candles, tickScale, params.currentSqrtPrice);
  const toT1perT0 = (p: number): number => (inverted ? 1 / p : p);

  const decimals0 = scale.pool.token0.decimals;
  const decimals1 = scale.pool.token1.decimals;

  const rows: HourResult[] = [];
  let cumulativeFeeValue = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i] as HourCandle;
    const rawClose = Number(candle.close);
    if (!(rawClose > 0)) {
      throw new CoreError('NOT_FINITE', 'candle close price must be positive', candle.close);
    }
    const priceT1perT0 = toT1perT0(rawClose);
    const priceInScale = quoteIsToken1(scale) ? priceT1perT0 : 1 / priceT1perT0;

    const lowTick = tickAtPrice(tickScale, HumanPriceCtor.of(toT1perT0(Number(candle.low))));
    const highTick = tickAtPrice(tickScale, HumanPriceCtor.of(toT1perT0(Number(candle.high))));
    const activeBps = activeBpsForCandle({
      range: position.range,
      candle: { lowTick: lowTick as Tick, highTick: highTick as Tick },
    });

    let fee0 = 0;
    let fee1 = 0;
    if (i > 0) {
      const prev = candles[i - 1] as HourCandle;
      const fees = feesForLiquidity({
        liquidity: position.liquidity,
        delta0: feeGrowthDelta(
          FeeGrowthX128.of(candle.feeGrowthGlobal0X128),
          FeeGrowthX128.of(prev.feeGrowthGlobal0X128),
        ),
        delta1: feeGrowthDelta(
          FeeGrowthX128.of(candle.feeGrowthGlobal1X128),
          FeeGrowthX128.of(prev.feeGrowthGlobal1X128),
        ),
        activeBps,
      });
      fee0 = rawToNumber(fees.amount0, decimals0);
      fee1 = rawToNumber(fees.amount1, decimals1);
    }

    const feeValue = quoteIsToken1(scale) ? fee1 + fee0 * priceT1perT0 : fee0 + fee1 / priceT1perT0;

    // USD multiplier from the pool's TVL snapshot: value the whole reserve in
    // token1, divide the USD figure by it, and price each token from there.
    const reserveInToken1 = tvl.token1 + tvl.token0 * priceT1perT0;
    const usdPerToken1 = reserveInToken1 > 0 ? tvl.usd / reserveInToken1 : 0;
    const usdPerToken0 = usdPerToken1 * priceT1perT0;
    const feeUsd = fee0 * usdPerToken0 + fee1 * usdPerToken1;

    cumulativeFeeValue += feeValue;
    const posValue = positionValue({
      scale,
      position,
      price: HumanPriceCtor.of(priceInScale),
    }).value;

    rows.push({
      timestamp: candle.periodStartUnix,
      price: priceInScale,
      activeBps,
      fee0,
      fee1,
      feeValue,
      feeUsd: HumanUsdCtor.of(feeUsd),
      cumulativeFeeValue,
      positionValue: posValue,
      totalValue: posValue + cumulativeFeeValue,
    });
  }

  return rows;
}

export interface DayResult {
  readonly timestamp: number;
  readonly fee0: number;
  readonly fee1: number;
  readonly feeValue: number;
  readonly feeUsd: HumanUsd;
  readonly avgActiveBps: number;
  readonly positionValue: number;
  readonly cumulativeFeeValue: number;
}

/** Rolls hourly rows up to days (UTC midnight), summing fees and averaging activity. */
export function aggregateDaily(rows: readonly HourResult[]): readonly DayResult[] {
  const byDay = new Map<number, HourResult[]>();
  for (const row of rows) {
    const day = Math.floor(row.timestamp / 86_400) * 86_400;
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = [];
      byDay.set(day, bucket);
    }
    bucket.push(row);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, hours]) => {
      const last = hours[hours.length - 1] as HourResult;
      return {
        timestamp: day,
        fee0: hours.reduce((s, h) => s + h.fee0, 0),
        fee1: hours.reduce((s, h) => s + h.fee1, 0),
        feeValue: hours.reduce((s, h) => s + h.feeValue, 0),
        feeUsd: HumanUsdCtor.of(hours.reduce((s, h) => s + h.feeUsd, 0)),
        avgActiveBps: hours.reduce((s, h) => s + h.activeBps, 0) / hours.length,
        positionValue: last.positionValue,
        cumulativeFeeValue: last.cumulativeFeeValue,
      };
    });
}

export interface BacktestSummary {
  readonly feeValue: number;
  readonly feeUsd: HumanUsd;
  readonly feeRoi: number;
  readonly apr: number;
  readonly assetReturn: number;
  readonly totalReturn: number;
  readonly avgActiveBps: number;
  readonly hours: number;
  readonly fee0: number;
  readonly fee1: number;
}

const YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * Summary indicators. The denominator is the position's value at the start of
 * the window (rows[0].positionValue) — the capital actually at risk — so the
 * ROI is honest about what was deployed rather than a nominal notional.
 */
export function summarize(rows: readonly HourResult[]): BacktestSummary {
  if (rows.length === 0) {
    return {
      feeValue: 0,
      feeUsd: HumanUsdCtor.of(0),
      feeRoi: 0,
      apr: 0,
      assetReturn: 0,
      totalReturn: 0,
      avgActiveBps: 0,
      hours: 0,
      fee0: 0,
      fee1: 0,
    };
  }

  const first = rows[0] as HourResult;
  const last = rows[rows.length - 1] as HourResult;
  const start = first.positionValue;

  const feeValue = last.cumulativeFeeValue;
  const feeUsd = HumanUsdCtor.of(rows.reduce((s, r) => s + r.feeUsd, 0));
  const feeRoi = start > 0 ? feeValue / start : 0;

  const elapsed = last.timestamp - first.timestamp;
  const apr = elapsed > 0 ? feeRoi * (YEAR_SECONDS / elapsed) : 0;

  const assetReturn = start > 0 ? (last.positionValue - start) / start : 0;
  const totalReturn = start > 0 ? (last.positionValue + feeValue - start) / start : 0;

  // The active fraction is only meaningful for hours that earned fees (i ≥ 1).
  const feeHours = rows.slice(1);
  const avgActiveBps =
    feeHours.length > 0 ? feeHours.reduce((s, r) => s + r.activeBps, 0) / feeHours.length : 0;

  return {
    feeValue,
    feeUsd,
    feeRoi,
    apr,
    assetReturn,
    totalReturn,
    avgActiveBps,
    hours: rows.length,
    fee0: rows.reduce((s, r) => s + r.fee0, 0),
    fee1: rows.reduce((s, r) => s + r.fee1, 0),
  };
}
