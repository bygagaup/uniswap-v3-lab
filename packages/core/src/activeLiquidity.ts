/**
 * How much of an hour a position spent earning fees.
 *
 * Measured in TICK space, i.e. log-price: price movement is approximately
 * uniform in log-price, and tick width is exactly what the pool charges fees
 * against, so the fraction of a candle's tick span that overlaps the range is
 * the fraction of the hour the position was active. Returned in basis points
 * (an integer 0–10000) so the fee math downstream stays exact.
 */
import type { TickRange } from './position.js';
import type { Tick } from './units.js';

export function activeBpsForCandle(args: {
  range: TickRange;
  candle: { lowTick: Tick; highTick: Tick };
}): number {
  const { range, candle } = args;
  const low = Math.min(candle.lowTick, candle.highTick);
  const high = Math.max(candle.lowTick, candle.highTick);

  // A flat hour has no span to apportion. The predecessor returned "fully
  // active" unconditionally here — wrong when the flat price is out of range,
  // which is exactly the case in an illiquid pool. Active iff the price is in.
  if (high === low) {
    return low >= range.lower && low < range.upper ? 10_000 : 0;
  }

  const overlap = Math.min(high, range.upper) - Math.max(low, range.lower);
  if (overlap <= 0) return 0;

  const bps = Math.round((overlap / (high - low)) * 10_000);
  return Math.max(0, Math.min(10_000, bps));
}
