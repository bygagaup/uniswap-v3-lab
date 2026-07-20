import type { HourCandle } from '@poollab/core';
import { useQuery } from '@tanstack/react-query';
import { graphFetch, shouldRetry } from './client.js';
import type { ChainSlug } from './types.js';

interface HoursResult {
  readonly poolHourDatas: readonly {
    readonly periodStartUnix: number;
    readonly high: string;
    readonly low: string;
    readonly close: string;
    readonly feeGrowthGlobal0X128: string;
    readonly feeGrowthGlobal1X128: string;
  }[];
}

const THIRTY_DAYS = 30 * 24 * 60 * 60;

export function useHours(chain: ChainSlug, pool: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['hours', chain, pool?.toLowerCase() ?? 'none'],
    enabled: Boolean(pool) && enabled,
    retry: shouldRetry,
    queryFn: async (): Promise<readonly HourCandle[]> => {
      const { poolHourDatas } = await graphFetch<HoursResult>(chain, 'poolHourData', {
        pool: (pool as string).toLowerCase(),
        fromdate: Math.floor(Date.now() / 1000) - THIRTY_DAYS,
      });
      // The subgraph returns newest-first; core requires ascending order.
      return poolHourDatas
        .map((h) => ({
          periodStartUnix: Number(h.periodStartUnix),
          high: h.high,
          low: h.low,
          close: h.close,
          feeGrowthGlobal0X128: h.feeGrowthGlobal0X128,
          feeGrowthGlobal1X128: h.feeGrowthGlobal1X128,
        }))
        .sort((a, b) => a.periodStartUnix - b.periodStartUnix);
    },
  });
}
