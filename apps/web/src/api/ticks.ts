import { useQuery } from '@tanstack/react-query';
import { graphFetch, shouldRetry } from './client.js';
import type { ChainSlug } from './types.js';

export interface TickRow {
  readonly tickIdx: string;
  readonly liquidityNet: string;
}

interface TicksResult {
  readonly ticks: readonly TickRow[];
  readonly pools: readonly {
    readonly tick: string | null;
    readonly liquidity: string;
    readonly sqrtPrice: string;
    readonly feeTier: string;
    readonly token0: { decimals: number | string; symbol: string };
    readonly token1: { decimals: number | string; symbol: string };
  }[];
}

export function useTicks(chain: ChainSlug, pool: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['ticks', chain, pool?.toLowerCase() ?? 'none'],
    enabled: Boolean(pool) && enabled,
    retry: shouldRetry,
    queryFn: () =>
      graphFetch<TicksResult>(chain, 'ticksByPool', { pool: (pool as string).toLowerCase() }),
  });
}
