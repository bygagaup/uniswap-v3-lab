/**
 * USD reconstruction from the subgraph's *untracked* pricing inputs.
 *
 * WHY THIS EXISTS: the fork subgraphs (Polygon, BNB) compute `volumeUSD`/`feesUSD`
 * through Uniswap's `getTrackedAmountUSD`, which is gated by a token whitelist
 * hardcoded in the mapping. That whitelist is not configured for those chains, so
 * even USDC/USDT/WBTC pools report `volumeUSD = 0` while indexing swaps correctly
 * (`txCount`, `volumeToken0/1`, `derivedETH` are all populated). We rebuild the USD
 * figure ourselves from those un-gated fields, matching the subgraph's own formula.
 *
 * BOUNDARY NOTE: the inputs here (`derivedETH`, `ethPriceUsd`, token volumes) are
 * subgraph BigDecimal values — float-domain prices and aggregates, not uint256
 * integers. They are already `number`s by the time they reach core, so this module
 * takes `number`, not the string/bigint the on-chain-quantity constructors take.
 * The BigInt/float boundary in `convert.ts` does not apply to them.
 */
import { CoreError } from './errors.js';
import { type HumanUsd, HumanUsd as HumanUsdCtor } from './units.js';

function finiteNonNegative(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new CoreError('NOT_FINITE', `${what} must be finite`, value);
  }
  if (value < 0) {
    throw new CoreError('NEGATIVE_AMOUNT', `${what} must be >= 0`, value);
  }
  return value;
}

/**
 * A token's USD price: `derivedETH` (token priced in ETH) times the ETH/USD rate
 * from the subgraph's `Bundle`.
 */
export function tokenPriceUsd(derivedEth: number, ethPriceUsd: number): HumanUsd {
  finiteNonNegative(derivedEth, 'derivedETH');
  finiteNonNegative(ethPriceUsd, 'ethPriceUsd');
  return HumanUsdCtor.of(derivedEth * ethPriceUsd);
}

export interface SwapVolumeInput {
  /** token0 volume in human token units (subgraph `volumeToken0`). */
  readonly volume0: number;
  /** token0 USD price, e.g. from {@link tokenPriceUsd}. */
  readonly price0Usd: number;
  /** token1 volume in human token units (subgraph `volumeToken1`). */
  readonly volume1: number;
  /** token1 USD price, e.g. from {@link tokenPriceUsd}. */
  readonly price1Usd: number;
}

/**
 * USD volume from both legs, averaged.
 *
 * A swap's in- and out-amounts denote the same trade value, so summing both sides
 * double-counts. The subgraph's `getTrackedAmountUSD` averages the two whitelisted
 * legs (`/2`) for exactly this reason; we reproduce that. Averaging is also
 * self-correcting when the two `derivedETH` prices disagree slightly.
 */
export function swapVolumeUsd({
  volume0,
  price0Usd,
  volume1,
  price1Usd,
}: SwapVolumeInput): HumanUsd {
  finiteNonNegative(volume0, 'volume0');
  finiteNonNegative(price0Usd, 'price0Usd');
  finiteNonNegative(volume1, 'volume1');
  finiteNonNegative(price1Usd, 'price1Usd');
  return HumanUsdCtor.of((volume0 * price0Usd + volume1 * price1Usd) / 2);
}

/**
 * Fees earned on a USD volume at a given fee tier. `feeTier` is in parts per
 * million (e.g. 3000 = 0.3%), the subgraph's and pool's own encoding.
 */
export function feesUsd(volumeUsd: number, feeTier: number): HumanUsd {
  finiteNonNegative(volumeUsd, 'volumeUsd');
  if (!Number.isInteger(feeTier) || feeTier < 0) {
    throw new CoreError('NOT_FINITE', 'feeTier must be a non-negative integer', feeTier);
  }
  return HumanUsdCtor.of((volumeUsd * feeTier) / 1_000_000);
}
