/**
 * The allowlist of GraphQL operations.
 *
 * The client sends `{chain, op, variables}` — never query text. An open GraphQL
 * proxy on our own Graph key is a free faucet for anyone who opens the Network
 * tab. Naming the operation also lets us give each one a meaningful cache TTL,
 * which is impossible with an opaque query string.
 *
 * Variables are validated and clamped here, on the edge. `first` is never taken
 * from the client — it is a constant inside each document — and addresses are
 * lowercased, because mixed-case ones both fragment the cache and miss in the
 * subgraph, which stores them lowercased.
 */
import { z } from 'zod';

export type Capability = 'pools' | 'ticks' | 'feeGrowth' | 'prices' | 'tokens';

/** Lowercased so that the same pool never occupies two cache entries. */
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte hex address')
  .transform((s) => s.toLowerCase());

const NINETY_DAYS = 90 * 24 * 60 * 60;

/**
 * Pool selection thresholds and ordering.
 *
 * ORDER BY VOLUME, NOT TVL. The subgraph derives TVL through `derivedETH`, so a
 * token with a manipulated price reports an astronomical figure and floats to
 * the top of any TVL sort. On real data the entire Base top-8 was counterfeit
 * pools showing $1–3.5B TVL against $0–1700 of daily volume; Arbitrum had one
 * claiming 9.9e18.
 *
 * No TVL floor or ceiling fixes this — genuine Base pools are an order of
 * magnitude smaller than mainnet's, so any single threshold either lets fakes
 * through or cuts real pools out. Volume does fix it: inflating TVL is free,
 * while volume requires real trades and real gas.
 *
 * It is also the more meaningful sort for this application, which models fee
 * income. Fees are paid by volume. A pool with a billion in "liquidity" and no
 * trading earns nothing and has nothing to simulate.
 */
const MIN_TVL = 10_000;
const MIN_VOLUME = 100_000;
const POOL_ORDER = 'orderBy: volumeUSD, orderDirection: desc';

/**
 * `totalValueLockedToken0/1` feed the backtest's USD conversion factor. They
 * describe the pool's *current* state, so they belong on the pool, not nested
 * inside every hourly record — the predecessor shipped the same three values
 * 700+ times per backtest.
 */
const POOL_FIELDS = `{
  id
  feeTier
  tick
  liquidity
  sqrtPrice
  totalValueLockedUSD
  totalValueLockedETH
  totalValueLockedToken0
  totalValueLockedToken1
  token0Price
  token1Price
  token0 { id symbol name decimals }
  token1 { id symbol name decimals }
  poolDayData(orderBy: date, orderDirection: desc, first: 1) {
    date volumeUSD tvlUSD feesUSD liquidity high low volumeToken0 volumeToken1 close open
  }
}`;

export interface CachePolicy {
  /** Edge freshness, seconds. */
  readonly ttl: number;
  /** How long a stale copy may still be served while revalidating. */
  readonly swr: number;
}

/**
 * Declared explicitly rather than derived from the registry: `Operation.name`
 * is typed as `OpName`, so `keyof typeof OPERATIONS` would reference itself.
 * Spelling out the union also makes the allowlist readable at a glance, which
 * is the point of having one.
 */
export type OpName =
  | 'poolById'
  | 'poolsByIds'
  | 'poolsByToken'
  | 'poolsByTokens'
  | 'topPoolsByVolume'
  | 'poolCurrentPrices'
  | 'poolDayData'
  | 'poolHourData'
  | 'ticksByPool'
  | 'tokensBySymbol';

export interface Operation<Schema extends z.ZodType = z.ZodType> {
  readonly name: OpName;
  readonly document: string;
  readonly variables: Schema;
  readonly cache: CachePolicy;
  readonly capability: Capability;
  /** Edge-side reshaping, so the cached artifact is what the client consumes. */
  readonly transform?: (data: unknown) => unknown;
}

/**
 * Merges the aliased pool lists a token search returns, and de-duplicates.
 * Doing it here halves the payload and means the cache holds the finished
 * answer rather than raw pieces every client must reassemble identically.
 */
function mergePoolLists(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;

  const byId = new Map<string, Record<string, unknown>>();
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const pool of value) {
      const id = (pool as { id?: unknown })?.id;
      if (typeof id === 'string' && !byId.has(id)) byId.set(id, pool as Record<string, unknown>);
    }
  }

  const pools = [...byId.values()].sort(
    (a, b) => Number(b.totalValueLockedUSD ?? 0) - Number(a.totalValueLockedUSD ?? 0),
  );
  return { pools };
}

export const OPERATIONS: Readonly<Record<OpName, Operation>> = {
  poolById: {
    name: 'poolById',
    capability: 'pools',
    cache: { ttl: 60, swr: 300 },
    variables: z.object({ id: address }),
    document: `query PoolById($id: ID!) { pools(where: { id: $id }) ${POOL_FIELDS} }`,
  },

  poolsByIds: {
    name: 'poolsByIds',
    capability: 'pools',
    cache: { ttl: 60, swr: 300 },
    variables: z.object({ ids: z.array(address).min(1).max(50) }),
    document: `query PoolsByIds($ids: [Bytes!]!) { pools(where: { id_in: $ids }, ${POOL_ORDER}) ${POOL_FIELDS} }`,
  },

  poolsByToken: {
    name: 'poolsByToken',
    capability: 'pools',
    cache: { ttl: 300, swr: 900 },
    variables: z.object({ token: address }),
    transform: mergePoolLists,
    document: `query PoolsByToken($token: ID!) {
      asToken1: pools(where: { token1: $token, totalValueLockedUSD_gt: ${MIN_TVL} }, ${POOL_ORDER}, first: 50) ${POOL_FIELDS}
      asToken0: pools(where: { token0: $token, totalValueLockedUSD_gt: ${MIN_TVL} }, ${POOL_ORDER}, first: 50) ${POOL_FIELDS}
      asPool: pools(where: { id: $token }) ${POOL_FIELDS}
    }`,
  },

  poolsByTokens: {
    name: 'poolsByTokens',
    capability: 'pools',
    cache: { ttl: 300, swr: 900 },
    variables: z.object({ tokens: z.array(address).min(1).max(25) }),
    transform: mergePoolLists,
    document: `query PoolsByTokens($tokens: [Bytes!]!) {
      asToken1: pools(where: { token1_in: $tokens, totalValueLockedUSD_gt: ${MIN_TVL} }, ${POOL_ORDER}, first: 50) ${POOL_FIELDS}
      asToken0: pools(where: { token0_in: $tokens, totalValueLockedUSD_gt: ${MIN_TVL} }, ${POOL_ORDER}, first: 50) ${POOL_FIELDS}
    }`,
  },

  topPoolsByVolume: {
    name: 'topPoolsByVolume',
    capability: 'pools',
    cache: { ttl: 300, swr: 900 },
    variables: z.object({}),
    document: `query TopPoolsByVolume {
      pools(first: 50, where: { totalValueLockedUSD_gt: ${MIN_TVL}, volumeUSD_gt: ${MIN_VOLUME} }, ${POOL_ORDER}) ${POOL_FIELDS}
    }`,
  },

  poolCurrentPrices: {
    name: 'poolCurrentPrices',
    capability: 'prices',
    // Backs the manual refresh button, so it gets the shortest TTL here.
    cache: { ttl: 15, swr: 60 },
    variables: z.object({ pool: address }),
    document: `query PoolCurrentPrices($pool: ID!) {
      pools(first: 1, where: { id: $pool }) {
        tick
        sqrtPrice
        token0Price
        token1Price
        token0 { id symbol decimals }
        token1 { id symbol decimals }
      }
    }`,
  },

  poolDayData: {
    name: 'poolDayData',
    capability: 'prices',
    cache: { ttl: 300, swr: 900 },
    variables: z.object({ pool: address }),
    document: `query PoolDayData($pool: ID!) {
      poolDayDatas(first: 90, orderBy: date, orderDirection: desc, where: { pool: $pool }) {
        date volumeUSD tvlUSD feesUSD liquidity high low volumeToken0 volumeToken1 close open txCount
      }
    }`,
  },

  poolHourData: {
    name: 'poolHourData',
    capability: 'feeGrowth',
    // The heaviest query here (up to 1000 rows) and the basis of the backtest.
    // Hourly bars close on the hour, so five minutes is invisible on a 30-day
    // window and saves the gateway budget that makes this the rate-limited one.
    cache: { ttl: 300, swr: 1800 },
    variables: z.object({
      pool: address,
      // Clamped, not trusted: a client asking for epoch 0 would request the
      // pool's entire history on our gateway budget.
      fromdate: z
        .number()
        .int()
        .transform((v) => {
          const now = Math.floor(Date.now() / 1000);
          return Math.min(Math.max(v, now - NINETY_DAYS), now);
        }),
    }),
    document: `query PoolHourData($pool: ID!, $fromdate: Int!) {
      poolHourDatas(
        where: { pool: $pool, periodStartUnix_gt: $fromdate, close_gt: 0 }
        orderBy: periodStartUnix
        orderDirection: desc
        first: 1000
      ) {
        periodStartUnix
        high
        low
        close
        feeGrowthGlobal0X128
        feeGrowthGlobal1X128
        pool { id }
      }
    }`,
  },

  ticksByPool: {
    name: 'ticksByPool',
    capability: 'ticks',
    cache: { ttl: 60, swr: 300 },
    variables: z.object({ pool: address }),
    document: `query TicksByPool($pool: ID!) {
      ticks(first: 1000, where: { pool: $pool }, orderBy: tickIdx) {
        tickIdx
        liquidityGross
        liquidityNet
        price0
        price1
      }
      pools(first: 1, where: { id: $pool }) {
        tick
        liquidity
        sqrtPrice
        feeTier
        token0 { decimals symbol }
        token1 { decimals symbol }
      }
    }`,
  },

  tokensBySymbol: {
    name: 'tokensBySymbol',
    capability: 'tokens',
    cache: { ttl: 300, swr: 900 },
    variables: z.object({ symbol: z.string().min(1).max(32) }),
    document: `query TokensBySymbol($symbol: String!) {
      tokens(
        first: 50
        where: { symbol_contains_nocase: $symbol, totalValueLocked_gt: 0 }
        orderBy: totalValueLockedUSD
        orderDirection: desc
      ) {
        id symbol name decimals
      }
    }`,
  },
};

export function isKnownOperation(op: string): op is OpName {
  return Object.hasOwn(OPERATIONS, op);
}

/**
 * Operations heavy enough to warrant their own rate limit: they return up to
 * 1000 rows and cost real gateway budget.
 */
export const HEAVY_OPERATIONS: ReadonlySet<OpName> = new Set(['poolHourData', 'ticksByPool']);
