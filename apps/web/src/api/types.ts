/**
 * Shapes returned by the proxy. These mirror the documents in
 * apps/api/src/operations.ts — numeric fields arrive as strings (the subgraph
 * serialises BigInt/BigDecimal that way), and are kept as strings until core
 * turns them into exact quantities or a formatter turns them into display text.
 */
export type ChainSlug =
  | 'ethereum'
  | 'polygon'
  | 'base'
  | 'optimism'
  | 'arbitrum'
  | 'bnb'
  | 'unichain';

export type Capability = 'pools' | 'ticks' | 'feeGrowth' | 'prices' | 'tokens';

export interface ChainDescriptor {
  readonly slug: ChainSlug;
  readonly chainId: number;
  readonly label: string;
  readonly capabilities: readonly Capability[];
}

export interface Token {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  /** The subgraph serialises this as a string ("6"); coerce before use. */
  readonly decimals: number | string;
  /** Token price in ETH (BigDecimal string). Feeds USD reconstruction. */
  readonly derivedETH?: string;
}

export interface PoolDayDatum {
  readonly date: number;
  readonly volumeUSD: string;
  readonly tvlUSD: string;
  readonly feesUSD: string;
  readonly liquidity: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly open: string;
  /** Per-token volumes (BigDecimal strings). Correct even where volumeUSD is 0. */
  readonly volumeToken0?: string;
  readonly volumeToken1?: string;
}

export interface Pool {
  readonly id: string;
  readonly feeTier: string;
  readonly tick: string | null;
  readonly liquidity: string;
  readonly sqrtPrice: string;
  readonly totalValueLockedUSD: string;
  readonly totalValueLockedETH: string;
  readonly totalValueLockedToken0: string;
  readonly totalValueLockedToken1: string;
  readonly token0Price: string;
  readonly token1Price: string;
  readonly token0: Token;
  readonly token1: Token;
  readonly poolDayData?: readonly PoolDayDatum[];
  /**
   * Chain-wide ETH/USD rate, denormalised onto each pool at the query boundary so
   * any component holding a Pool can reconstruct USD without prop-drilling. Comes
   * from the list's `ethPriceUsd`; see lib/usd.ts.
   */
  readonly ethPriceUsd?: string | null;
}

export interface PoolListResult {
  readonly pools: readonly Pool[];
  /**
   * Chain-wide ETH/USD rate (subgraph `Bundle.ethPriceUSD`), surfaced by the
   * proxy's transforms. Null when the deployment has no `Bundle` entity.
   */
  readonly ethPriceUsd?: string | null;
}

export interface TokenListResult {
  readonly tokens: readonly Token[];
}
