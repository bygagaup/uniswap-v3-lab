/**
 * TanStack Query hooks over the proxy. Query keys are structured so the cache
 * mirrors the (chain, op, variables) the proxy itself keys on.
 */
import { useQuery } from '@tanstack/react-query';
import { graphFetch, shouldRetry } from './client.js';
import type { ChainDescriptor, ChainSlug, Pool, PoolListResult, TokenListResult } from './types.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: string): boolean {
  return ADDRESS.test(value.trim());
}

export const queryKeys = {
  chains: ['chains'] as const,
  topPools: (chain: ChainSlug) => ['topPools', chain] as const,
  pool: (chain: ChainSlug, id: string) => ['pool', chain, id.toLowerCase()] as const,
  search: (chain: ChainSlug, query: string) => ['search', chain, query.toLowerCase()] as const,
};

export function useChains() {
  return useQuery({
    queryKey: queryKeys.chains,
    queryFn: async () => {
      const res = await fetch('/api/meta/chains', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`/api/meta/chains returned ${res.status}`);
      const body = (await res.json()) as { chains: ChainDescriptor[] };
      return body.chains;
    },
    staleTime: 60 * 60 * 1000,
  });
}

export function useTopPools(chain: ChainSlug) {
  return useQuery({
    queryKey: queryKeys.topPools(chain),
    queryFn: () => graphFetch<PoolListResult>(chain, 'topPoolsByVolume'),
    retry: shouldRetry,
    select: (data) => data.pools,
  });
}

export function usePool(chain: ChainSlug, id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.pool(chain, id) : ['pool', chain, 'none'],
    enabled: Boolean(id),
    retry: shouldRetry,
    queryFn: async () => {
      const { pools } = await graphFetch<PoolListResult>(chain, 'poolById', {
        id: (id as string).toLowerCase(),
      });
      return pools[0] ?? null;
    },
  });
}

/**
 * Pool search. An address is looked up directly as a pool or token; free text
 * is resolved through matching token symbols, then to their pools — the same
 * two-step the predecessor used, but with the aliased-list merge done on the
 * edge rather than here.
 */
export function useSearch(chain: ChainSlug, rawQuery: string) {
  const query = rawQuery.trim();

  return useQuery({
    queryKey: queryKeys.search(chain, query),
    enabled: query.length >= 2,
    retry: shouldRetry,
    queryFn: async (): Promise<readonly Pool[]> => {
      if (isAddress(query)) {
        const { pools } = await graphFetch<PoolListResult>(chain, 'poolsByToken', {
          token: query.toLowerCase(),
        });
        return pools;
      }

      const { tokens } = await graphFetch<TokenListResult>(chain, 'tokensBySymbol', {
        symbol: query,
      });
      if (tokens.length === 0) return [];

      const { pools } = await graphFetch<PoolListResult>(chain, 'poolsByTokens', {
        tokens: tokens.slice(0, 25).map((t) => t.id),
      });
      return pools;
    },
  });
}
