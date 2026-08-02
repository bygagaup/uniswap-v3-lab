/**
 * USD figures for a pool's daily record, reconstructed when the subgraph's own
 * `volumeUSD`/`feesUSD` are unreliable.
 *
 * The fork subgraphs (Polygon, BNB) gate `volumeUSD`/`feesUSD` behind a token
 * whitelist that is not configured for the chain, so real pools report `0`. When
 * that happens we recompute from fields the subgraph does populate correctly —
 * `volumeToken0/1`, `token.derivedETH`, and the chain's `ethPriceUSD` — using the
 * core arithmetic. Where the subgraph's value is non-zero (Ethereum et al.) we
 * keep it: it reflects true historical per-swap prices, which our current-price
 * estimate cannot.
 *
 * This is the string→number boundary for those BigDecimal fields, mirroring
 * `lib/pool.ts`. The subgraph serialises them as decimal strings; `Number()` here
 * is not the BigInt→float conversion `convert.ts` guards (those are float-domain
 * prices, not uint256). All arithmetic lives in core.
 */
import { CoreError, feesUsd, swapVolumeUsd, tokenPriceUsd } from '@poollab/core';
import type { Pool, PoolDayDatum } from '../api/types.js';

/** Parses a BigDecimal string to a finite number, or null if absent/unparseable. */
function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reconstructed USD volume for a day, or null when the inputs are missing. Returns
 * the subgraph's `volumeUSD` unchanged whenever it is positive.
 */
function estimateVolumeUsd(
  pool: Pool,
  day: PoolDayDatum,
  ethPriceUsd: string | null | undefined,
): number | null {
  const eth = num(ethPriceUsd ?? undefined);
  const v0 = num(day.volumeToken0);
  const v1 = num(day.volumeToken1);
  const d0 = num(pool.token0.derivedETH);
  const d1 = num(pool.token1.derivedETH);
  if (eth === null || v0 === null || v1 === null || d0 === null || d1 === null) return null;
  try {
    return swapVolumeUsd({
      volume0: v0,
      price0Usd: tokenPriceUsd(d0, eth),
      volume1: v1,
      price1Usd: tokenPriceUsd(d1, eth),
    });
  } catch (error) {
    if (error instanceof CoreError) return null;
    throw error;
  }
}

/**
 * A day's USD volume: the subgraph value if it is positive, otherwise the
 * reconstructed estimate. Null when neither is available.
 */
export function dailyVolumeUsd(
  pool: Pool,
  day: PoolDayDatum,
  ethPriceUsd: string | null | undefined,
): number | null {
  const reported = num(day.volumeUSD);
  if (reported !== null && reported > 0) return reported;
  return estimateVolumeUsd(pool, day, ethPriceUsd);
}

/**
 * A day's USD fees: the subgraph value if positive, otherwise fees implied by the
 * reconstructed volume at the pool's fee tier.
 */
export function dailyFeesUsd(
  pool: Pool,
  day: PoolDayDatum,
  ethPriceUsd: string | null | undefined,
): number | null {
  const reported = num(day.feesUSD);
  if (reported !== null && reported > 0) return reported;
  const volume = estimateVolumeUsd(pool, day, ethPriceUsd);
  if (volume === null) return null;
  try {
    return feesUsd(volume, Number(pool.feeTier));
  } catch (error) {
    if (error instanceof CoreError) return null;
    throw error;
  }
}

/**
 * The ranking key for the top-pools list: a pool's latest-day USD volume by the
 * same rule the list displays, so the sort matches the visible column. Pools with
 * no usable volume sink to the bottom (−1) rather than being dropped.
 */
export function poolVolumeUsdForRanking(
  pool: Pool,
  ethPriceUsd: string | null | undefined,
): number {
  const day = pool.poolDayData?.[0];
  if (!day) return -1;
  return dailyVolumeUsd(pool, day, ethPriceUsd) ?? -1;
}
