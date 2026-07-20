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
}

export interface PoolListResult {
  readonly pools: readonly Pool[];
}

export interface TokenListResult {
  readonly tokens: readonly Token[];
}
