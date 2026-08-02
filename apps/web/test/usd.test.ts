import { describe, expect, it } from 'vitest';
import type { Pool, PoolDayDatum } from '../src/api/types.js';
import { dailyFeesUsd, dailyVolumeUsd, poolVolumeUsdForRanking } from '../src/lib/usd.js';

// The reported pool: USDC/USDT 0.01% on Polygon. The fork subgraph reports
// volumeUSD=0 despite ~$421k of real daily volume (confirmed on-chain).
const USDC_USDT: Pool = {
  id: '0x31083a78e11b18e450fd139f9abea98cd53181b7',
  feeTier: '100',
  tick: '0',
  liquidity: '701567677416593',
  sqrtPrice: '79228162514264337593543950336',
  totalValueLockedUSD: '607196.37',
  totalValueLockedETH: '316.26',
  totalValueLockedToken0: '303000',
  totalValueLockedToken1: '304000',
  token0Price: '1',
  token1Price: '1',
  token0: {
    id: `0x${'a'.repeat(40)}`,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    derivedETH: '0.0005208463177591819',
  },
  token1: {
    id: `0x${'b'.repeat(40)}`,
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    derivedETH: '0.0005208514710889245',
  },
  ethPriceUsd: '1919.902633206883',
};

const brokenDay: PoolDayDatum = {
  date: 1784592000,
  volumeUSD: '0', // the bug
  tvlUSD: '607408.58',
  feesUSD: '0',
  liquidity: '701567677416593',
  high: '1',
  low: '1',
  close: '1',
  open: '1',
  volumeToken0: '421498.778314',
  volumeToken1: '421737.18102',
};

describe('dailyVolumeUsd', () => {
  it('reconstructs ~$421k when the subgraph reports zero', () => {
    const usd = dailyVolumeUsd(USDC_USDT, brokenDay, USDC_USDT.ethPriceUsd);
    expect(usd).not.toBeNull();
    expect(usd as number).toBeCloseTo(421609, 0);
  });

  it('keeps a positive subgraph value unchanged', () => {
    const day = { ...brokenDay, volumeUSD: '123456.78' };
    expect(dailyVolumeUsd(USDC_USDT, day, USDC_USDT.ethPriceUsd)).toBe(123456.78);
  });

  it('returns null when the inputs for reconstruction are missing', () => {
    const noEth = dailyVolumeUsd(USDC_USDT, brokenDay, null);
    expect(noEth).toBeNull();
    // `derivedETH` is optional, and under exactOptionalPropertyTypes "absent" is
    // the omitted key — not the key set to undefined. A deployment that does not
    // expose the field sends no key at all, so that is what we model.
    const { derivedETH: _absent, ...token0 } = USDC_USDT.token0;
    const noDerived: Pool = { ...USDC_USDT, token0 };
    expect(dailyVolumeUsd(noDerived, brokenDay, USDC_USDT.ethPriceUsd)).toBeNull();
  });
});

describe('dailyFeesUsd', () => {
  it('reconstructs fees from the estimated volume at the fee tier', () => {
    // 0.01% of ~$421,609 ≈ $42.16
    const fees = dailyFeesUsd(USDC_USDT, brokenDay, USDC_USDT.ethPriceUsd);
    expect(fees).not.toBeNull();
    expect(fees as number).toBeCloseTo(42.16, 1);
  });
});

describe('poolVolumeUsdForRanking', () => {
  it('ranks by the reconstructed latest-day volume', () => {
    const pool = { ...USDC_USDT, poolDayData: [brokenDay] };
    expect(poolVolumeUsdForRanking(pool, pool.ethPriceUsd)).toBeCloseTo(421609, 0);
  });

  it('sinks pools with no day data to the bottom', () => {
    expect(poolVolumeUsdForRanking(USDC_USDT, USDC_USDT.ethPriceUsd)).toBe(-1);
  });
});
