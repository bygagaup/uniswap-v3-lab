/**
 * Adapts a proxy Pool into the core domain's PoolKey / PriceScale.
 *
 * This is the boundary where API strings become core value objects. All the
 * arithmetic stays in core — this file only maps field names and hands core the
 * strings it expects (it never parses a price into a float itself).
 */
import {
  CoreError,
  type HumanPrice,
  type Orientation,
  type PoolKey,
  poolKey,
  priceAtSqrtRatio,
  priceScale,
  SqrtPriceX96,
} from '@poollab/core';
import type { Pool } from '../api/types.js';

export function poolKeyFromApi(pool: Pool): PoolKey {
  return poolKey({
    token0: {
      address: pool.token0.id,
      symbol: pool.token0.symbol,
      // The subgraph serialises `decimals` as a string ("6"); core wants a
      // number and rightly refuses a string. Normalise at the boundary.
      decimals: Number(pool.token0.decimals),
    },
    token1: {
      address: pool.token1.id,
      symbol: pool.token1.symbol,
      decimals: Number(pool.token1.decimals),
    },
    feeTier: Number(pool.feeTier),
  });
}

/**
 * The pool's current price in the given orientation, computed from sqrtPrice by
 * core. Returns null when the pool has no representable price (a fresh pool with
 * sqrtPrice 0), rather than letting a CoreError escape into render.
 */
export function currentPrice(pool: Pool, orientation: Orientation): HumanPrice | null {
  try {
    const scale = priceScale(poolKeyFromApi(pool), orientation);
    return priceAtSqrtRatio(scale, SqrtPriceX96.of(pool.sqrtPrice));
  } catch (error) {
    if (error instanceof CoreError) return null;
    throw error;
  }
}
