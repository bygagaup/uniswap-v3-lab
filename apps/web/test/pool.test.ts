import { describe, expect, it } from 'vitest';
import { isAddress } from '../src/api/queries.js';
import type { Pool } from '../src/api/types.js';
import { formatFeeTier, formatUsd, pairLabel } from '../src/lib/format.js';
import { currentPrice, poolKeyFromApi } from '../src/lib/pool.js';

// A real USDC/WETH 0.05% snapshot: sqrtPrice puts WETH around a few thousand USDC.
const USDC_WETH: Pool = {
  id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
  feeTier: '500',
  tick: '201040',
  liquidity: '6234480011275152874',
  sqrtPrice: '1837391543579092487269787648958062',
  totalValueLockedUSD: '360231557.35',
  totalValueLockedETH: '193681.08',
  totalValueLockedToken0: '176967203.84',
  totalValueLockedToken1: '98533.39',
  token0Price: '0',
  token1Price: '0',
  token0: { id: `0x${'1'.repeat(40)}`, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  token1: { id: `0x${'2'.repeat(40)}`, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
};

describe('isAddress', () => {
  it('accepts a 20-byte hex address and rejects everything else', () => {
    expect(isAddress(`0x${'a'.repeat(40)}`)).toBe(true);
    expect(isAddress('weth')).toBe(false);
    expect(isAddress('0x123')).toBe(false);
  });
});

describe('poolKeyFromApi', () => {
  it('maps fields and derives tick spacing for the fee tier', () => {
    const key = poolKeyFromApi(USDC_WETH);
    expect(key.feeTier).toBe(500);
    expect(key.tickSpacing).toBe(10);
    expect(key.token0.decimals).toBe(6);
  });
});

describe('currentPrice', () => {
  it('prices WETH in the thousands of USDC, computed by core from sqrtPrice', () => {
    // token0PerToken1 quotes token1 (WETH) in token0 (USDC) units.
    const price = currentPrice(USDC_WETH, 'token0PerToken1');
    expect(price).not.toBeNull();
    expect(price as number).toBeGreaterThan(100);
    expect(price as number).toBeLessThan(100_000);
  });

  it('is the reciprocal in the opposite orientation', () => {
    const a = currentPrice(USDC_WETH, 'token0PerToken1') as number;
    const b = currentPrice(USDC_WETH, 'token1PerToken0') as number;
    expect(Math.abs(a * b - 1)).toBeLessThan(1e-6);
  });

  it('returns null for an unpriceable pool instead of throwing', () => {
    expect(currentPrice({ ...USDC_WETH, sqrtPrice: '0' }, 'token1PerToken0')).toBeNull();
  });
});

describe('formatters', () => {
  it('renders fee tiers as percentages', () => {
    expect(formatFeeTier('500')).toBe('0.05%');
    expect(formatFeeTier('3000')).toBe('0.3%');
    expect(formatFeeTier('100')).toBe('0.01%');
  });

  it('renders compact USD and a readable pair label', () => {
    expect(formatUsd('360231557')).toMatch(/\$36[0-9.]*M/);
    expect(pairLabel(USDC_WETH)).toBe('USDC / WETH');
  });
});
