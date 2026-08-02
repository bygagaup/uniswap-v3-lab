import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/errors.js';
import { feesUsd, swapVolumeUsd, tokenPriceUsd } from '../../src/usd.js';

const nonNeg = fc.double({ min: 0, max: 1e12, noNaN: true, noDefaultInfinity: true });
const positive = fc.double({ min: 1e-9, max: 1e9, noNaN: true, noDefaultInfinity: true });

/** Relative comparison — magnitudes span many orders, so absolute epsilons are useless. */
function expectClose(actual: number, expected: number, tolerance = 1e-12) {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance);
}

describe('tokenPriceUsd', () => {
  it('is the product of derivedETH and ethPriceUsd', () => {
    // USDC on the reported pool: derivedETH ~5.208e-4, ethPriceUSD ~1919.90 -> ~$1.
    expect(tokenPriceUsd(0.0005208463177591819, 1919.902633206883)).toBeCloseTo(0.99997, 4);
  });

  it('scales linearly in each factor', () => {
    fc.assert(
      fc.property(positive, positive, positive, (d, e, k) => {
        expectClose(tokenPriceUsd(d * k, e), tokenPriceUsd(d, e) * k, 1e-9);
        expectClose(tokenPriceUsd(d, e * k), tokenPriceUsd(d, e) * k, 1e-9);
      }),
    );
  });

  it('rejects negative or non-finite inputs', () => {
    expect(() => tokenPriceUsd(-1, 1)).toThrow(CoreError);
    expect(() => tokenPriceUsd(1, Number.NaN)).toThrow(CoreError);
    expect(() => tokenPriceUsd(Number.POSITIVE_INFINITY, 1)).toThrow(CoreError);
  });
});

describe('swapVolumeUsd', () => {
  it('averages the two legs, matching the reported USDC/USDT pool', () => {
    // Real inputs from 0x31083a78…: subgraph reported volumeUSD=0, on-chain ~$421,609.
    const eth = 1919.902633206883;
    const p0 = tokenPriceUsd(0.0005208463177591819, eth);
    const p1 = tokenPriceUsd(0.0005208514710889245, eth);
    const usd = swapVolumeUsd({
      volume0: 421498.778314,
      price0Usd: p0,
      volume1: 421737.18102,
      price1Usd: p1,
    });
    expect(usd).toBeCloseTo(421609, 0);
  });

  it('equals a single leg when only that leg has volume', () => {
    // One-sided: (v*p + 0)/2. A USDC leg of $1000 at $1 contributes $500 to the average.
    expect(swapVolumeUsd({ volume0: 1000, price0Usd: 1, volume1: 0, price1Usd: 1 })).toBe(500);
  });

  it('is monotonic non-decreasing in each volume', () => {
    fc.assert(
      fc.property(nonNeg, nonNeg, positive, positive, positive, (v0, v1, p0, p1, extra) => {
        const base = swapVolumeUsd({ volume0: v0, price0Usd: p0, volume1: v1, price1Usd: p1 });
        const more = swapVolumeUsd({
          volume0: v0 + extra,
          price0Usd: p0,
          volume1: v1,
          price1Usd: p1,
        });
        expect(more).toBeGreaterThanOrEqual(base);
      }),
    );
  });

  it('is zero exactly when both legs are zero', () => {
    expect(swapVolumeUsd({ volume0: 0, price0Usd: 5, volume1: 0, price1Usd: 5 })).toBe(0);
  });

  it('rejects negative or non-finite inputs', () => {
    expect(() => swapVolumeUsd({ volume0: -1, price0Usd: 1, volume1: 0, price1Usd: 1 })).toThrow(
      CoreError,
    );
    expect(() =>
      swapVolumeUsd({ volume0: 0, price0Usd: 1, volume1: 1, price1Usd: Number.NaN }),
    ).toThrow(CoreError);
  });
});

describe('feesUsd', () => {
  it('applies the fee tier as parts-per-million', () => {
    expect(feesUsd(1_000_000, 3000)).toBe(3000); // 0.3% of $1,000,000
    expect(feesUsd(421609, 100)).toBeCloseTo(42.1609, 4); // 0.01% tier
  });

  it('is zero when volume is zero', () => {
    expect(feesUsd(0, 3000)).toBe(0);
  });

  it('rejects a non-integer or negative fee tier', () => {
    expect(() => feesUsd(1000, 30.5)).toThrow(CoreError);
    expect(() => feesUsd(1000, -1)).toThrow(CoreError);
    expect(() => feesUsd(-1, 3000)).toThrow(CoreError);
  });
});
