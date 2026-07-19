import { type PoolKey, poolKey } from '../../src/pool.js';

export function token(symbol: string, decimals: number, nth: number) {
  return {
    address: `0x${String(nth).padStart(40, '0')}`,
    symbol,
    decimals,
  };
}

/** Decimal pairs that actually occur: USDC/WETH, WETH/USDC, WBTC/WETH, stables. */
export const DECIMAL_PAIRS: readonly (readonly [number, number])[] = [
  [6, 18],
  [18, 6],
  [8, 18],
  [18, 18],
  [0, 18],
  [18, 0],
];

export function testPool(decimals0: number, decimals1: number, feeTier = 3000): PoolKey {
  return poolKey({
    token0: token('T0', decimals0, 1),
    token1: token('T1', decimals1, 2),
    feeTier,
  });
}
