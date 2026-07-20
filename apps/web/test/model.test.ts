import { describe, expect, it } from 'vitest';
import type { Pool } from '../src/api/types.js';
import { buildModel } from '../src/lib/model.js';

const USDC_WETH: Pool = {
  id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
  feeTier: '500',
  tick: '201040',
  liquidity: '6234480011275152874',
  sqrtPrice: '1818683766062243495981968953406197',
  totalValueLockedUSD: '360231557.35',
  totalValueLockedETH: '193681.08',
  totalValueLockedToken0: '176967203.84',
  totalValueLockedToken1: '98533.39',
  token0Price: '0',
  token1Price: '0',
  token0: { id: `0x${'1'.repeat(40)}`, symbol: 'USDC', name: 'USD Coin', decimals: '6' },
  token1: { id: `0x${'2'.repeat(40)}`, symbol: 'WETH', name: 'Wrapped Ether', decimals: '18' },
};

describe('buildModel', () => {
  it('defaults a sensible range around the current tick and prices WETH readably', () => {
    const result = buildModel(USDC_WETH, { notional: 10_000, inverted: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.model;

    // Auto-orientation picks the readable direction: WETH priced in USDC.
    expect(m.baseSymbol).toBe('WETH');
    expect(m.quoteSymbol).toBe('USDC');
    expect(m.entryPrice).toBeGreaterThan(100);
    expect(m.entryPrice).toBeLessThan(100_000);

    // Default range brackets the current price. In this orientation ticks map
    // to price inversely, so the boundary prices can be either way round —
    // check the min/max, which is what the UI shows.
    expect(Math.min(m.lowerPrice, m.upperPrice)).toBeLessThan(m.entryPrice);
    expect(Math.max(m.lowerPrice, m.upperPrice)).toBeGreaterThan(m.entryPrice);
  });

  it('produces curves that all share the grid', () => {
    const result = buildModel(USDC_WETH, { notional: 10_000, inverted: false });
    if (!result.ok) throw new Error(result.error);
    const m = result.model;
    const n = m.grid.prices.length;
    expect(m.curves.v3).toHaveLength(n);
    expect(m.curves.v2).toHaveLength(n);
    expect(m.curves.hodl5050).toHaveLength(n);
    expect(m.il).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect((m.curves.v3[i] as { price: number }).price).toBe(m.grid.prices[i]);
    }
  });

  it('inverts the orientation on request', () => {
    const normal = buildModel(USDC_WETH, { notional: 10_000, inverted: false });
    const flipped = buildModel(USDC_WETH, { notional: 10_000, inverted: true });
    if (!normal.ok || !flipped.ok) throw new Error('build failed');
    expect(flipped.model.baseSymbol).toBe(normal.model.quoteSymbol);
    expect(flipped.model.entryPrice).toBeCloseTo(1 / normal.model.entryPrice, 10);
  });

  it('honours an explicit tick range from the URL', () => {
    const result = buildModel(USDC_WETH, {
      notional: 10_000,
      lower: 200_000,
      upper: 202_000,
      inverted: false,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.model.range.lower).toBe(200_000);
    expect(result.model.range.upper).toBe(202_000);
  });

  it('reports an unrepresentable position as an error, not a crash', () => {
    // A tiny notional over a wide range on a coarse-decimal quote: one side
    // floors to zero, which core refuses.
    const coarse: Pool = {
      ...USDC_WETH,
      token1: { ...USDC_WETH.token1, decimals: '0' },
    };
    const result = buildModel(coarse, {
      notional: 1,
      lower: -260_000,
      upper: -140_000,
      inverted: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe('leverage & hedge', () => {
  it('has no levered overlay unlevered and unhedged', () => {
    const r = buildModel(USDC_WETH, { notional: 10_000, inverted: false });
    if (!r.ok) throw new Error(r.error);
    expect(r.model.levered).toBeNull();
    expect(r.model.leverage).toBe(1);
  });

  it('produces a levered equity overlay with margins when leveraged', () => {
    const r = buildModel(USDC_WETH, { notional: 10_000, inverted: false, leverage: 3 });
    if (!r.ok) throw new Error(r.error);
    expect(r.model.levered).not.toBeNull();
    // Every point carries a numeric margin once there is debt.
    for (const p of r.model.levered?.curve ?? []) expect(typeof p.margin).toBe('number');
    // Equity at entry is notional / leverage.
    const near = (r.model.levered?.curve ?? []).reduce((a, b) =>
      Math.abs(b.price - r.model.entryPrice) < Math.abs(a.price - r.model.entryPrice) ? b : a,
    );
    expect(near.value).toBeGreaterThan(2000);
    expect(near.value).toBeLessThan(4500);
  });

  it('a hedge alone (no leverage) still produces an overlay', () => {
    const r = buildModel(USDC_WETH, { notional: 10_000, inverted: false, hedgeSide: 'short' });
    if (!r.ok) throw new Error(r.error);
    expect(r.model.levered).not.toBeNull();
    expect(r.model.hedge.side).toBe('short');
  });
});

describe('comparison range (S2)', () => {
  it('has no compare overlay without a second range', () => {
    const r = buildModel(USDC_WETH, { notional: 10_000, inverted: false });
    if (!r.ok) throw new Error(r.error);
    expect(r.model.compare).toBeNull();
  });

  it('builds a second V3 curve on the shared grid when S2 is set', () => {
    const r = buildModel(USDC_WETH, {
      notional: 10_000,
      inverted: false,
      lower: 200_000,
      upper: 202_000,
      lower2: 199_000,
      upper2: 203_000,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.model.compare).not.toBeNull();
    expect(r.model.compare?.range.lower).toBe(199_000);
    expect(r.model.compare?.range.upper).toBe(203_000);
    // Same grid as the primary curves, so the two are directly comparable.
    expect(r.model.compare?.curve).toHaveLength(r.model.grid.prices.length);
  });
});
