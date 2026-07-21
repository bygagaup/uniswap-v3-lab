/**
 * Chain -> subgraph deployment, resolved SERVER-SIDE.
 *
 * IDs are deploy configuration, not bundle constants: swapping a deployment is
 * an env var, not a rebuild, and the client never learns which deployment it is
 * talking to.
 *
 * THE LOAD-BEARING FACT: the ID resolves on the **(chain, operation) pair**,
 * not on chain alone. `feeGrowthGlobal0X128/1X128` are absent from Uniswap's own
 * `PoolHourData` schema — deployments that expose them are patched forks, and
 * those forks in turn tend to lack `ticks` or to reject
 * `pools(orderBy: volumeUSD)`. A sweep of 31 candidates in the Graph registry
 * found no single deployment covering any chain completely:
 *
 *   bnb       F85MNzUG… has feeGrowthGlobal and ticks, but consistently refuses
 *             pools(orderBy: volumeUSD), which is what pool search runs on.
 *   unichain  BCfy6Vw9… has feeGrowthGlobal but no ticks entity at all.
 *   optimism  ACse8kMD… (Messari fork) carries feeGrowthGlobal, so its fees come
 *             from that deployment and pools/ticks from the default one.
 *   arbitrum  no deployment with feeGrowthGlobal found, so backtesting is off.
 *
 * So fees come from one deployment and everything else from another. This is
 * also the real reason the predecessor's predecessor disabled backtesting on
 * Arbitrum — not a product decision, a missing field.
 *
 * Defaults below were verified by `scripts/probe.ts` against the actual
 * operation documents, not a liveness ping. Re-run it before trusting a new ID.
 */
import type { Capability, OpName } from './operations.js';
import { OPERATIONS } from './operations.js';

export type ChainSlug =
  | 'ethereum'
  | 'polygon'
  | 'base'
  | 'optimism'
  | 'arbitrum'
  | 'bnb'
  | 'unichain';

export interface ChainConfig {
  readonly slug: ChainSlug;
  readonly chainId: number;
  readonly label: string;
  readonly defaultSubgraphId: string;
  /** Per-operation overrides, for the split-deployment chains described above. */
  readonly opOverrides?: Partial<Record<OpName, string>>;
}

export interface ChainEnv {
  readonly [key: string]: string | undefined;
}

function envOr(env: ChainEnv, name: string, fallback: string): string {
  const value = env[name];
  // An empty string means "unset", not "remove the default" — otherwise a blank
  // env var would silently take a whole chain offline.
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export function chainConfigs(env: ChainEnv): readonly ChainConfig[] {
  return [
    {
      slug: 'ethereum',
      chainId: 1,
      label: 'Ethereum',
      defaultSubgraphId: envOr(
        env,
        'SUBGRAPH_ID_ETHEREUM',
        '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
      ),
    },
    {
      slug: 'polygon',
      chainId: 137,
      label: 'Polygon',
      defaultSubgraphId: envOr(
        env,
        'SUBGRAPH_ID_POLYGON',
        'EsLGwxyeMMeJuhqWvuLmJEiDKXJ4Z6YsoJreUnyeozco',
      ),
    },
    {
      slug: 'base',
      chainId: 8453,
      label: 'Base',
      defaultSubgraphId: envOr(
        env,
        'SUBGRAPH_ID_BASE',
        'GqzP4Xaehti8KSfQmv3ZctFSjnSUYZ4En5NRsiTbvZpz',
      ),
    },
    {
      slug: 'optimism',
      chainId: 10,
      label: 'Optimism',
      defaultSubgraphId: envOr(
        env,
        'SUBGRAPH_ID_OPTIMISM',
        '49LkWjoVKd3bM9ZrMdFgYkjaCuVj4ExZttQi6XfbcPpG',
      ),
      opOverrides: {
        poolHourData: envOr(
          env,
          'SUBGRAPH_ID_OPTIMISM_FEES',
          'ACse8kMDa7dNfsbhrXThzxnDiUA19WMKWVRdqJhNSpCG',
        ),
      },
    },
    {
      slug: 'arbitrum',
      chainId: 42161,
      label: 'Arbitrum',
      defaultSubgraphId: envOr(
        env,
        'SUBGRAPH_ID_ARBITRUM',
        'Fo8QBLpEGfXHWkGMD3jSM4vVLk4JxvxxQD3v3U4fsrbh',
      ),
    },
    {
      slug: 'bnb',
      chainId: 56,
      label: 'BNB Chain',
      defaultSubgraphId: envOr(
        env,
        'SUBGRAPH_ID_BNB',
        '7XgdLW3bts4HktCYsu9dy8bEnuiNeZuftcuK3Aj4JXYV',
      ),
      opOverrides: {
        poolHourData: envOr(
          env,
          'SUBGRAPH_ID_BNB_FEES',
          'F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2',
        ),
      },
    },
    {
      slug: 'unichain',
      chainId: 130,
      label: 'Unichain',
      defaultSubgraphId: envOr(
        env,
        'SUBGRAPH_ID_UNICHAIN',
        'Eeg7Gq1ofowbpdTHcNYs4FotnHSddkz5iTNiQQVq7Q6K',
      ),
      opOverrides: {
        poolHourData: envOr(
          env,
          'SUBGRAPH_ID_UNICHAIN_FEES',
          'BCfy6Vw9No3weqVq9NhyGo4FkVCJep1ZN9RMJj5S32fX',
        ),
      },
    },
  ];
}

export function chainConfig(env: ChainEnv, slug: string): ChainConfig | null {
  return chainConfigs(env).find((c) => c.slug === slug) ?? null;
}

export function isKnownChain(env: ChainEnv, slug: string): slug is ChainSlug {
  return chainConfig(env, slug) !== null;
}

/** The deployment that serves this operation on this chain. */
export function subgraphIdFor(env: ChainEnv, slug: string, op: OpName): string | null {
  const config = chainConfig(env, slug);
  if (!config) return null;
  return config.opOverrides?.[op] ?? config.defaultSubgraphId ?? null;
}

export function subgraphUrl(
  env: ChainEnv,
  slug: string,
  op: OpName,
  apiKey: string,
): string | null {
  const id = subgraphIdFor(env, slug, op);
  return id ? `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${id}` : null;
}

export interface ChainDescriptor {
  readonly slug: ChainSlug;
  readonly chainId: number;
  readonly label: string;
  readonly capabilities: readonly Capability[];
}

/**
 * What each chain can actually do, derived from which deployments are
 * configured — never from a hardcoded list. The UI greys out backtesting on
 * arbitrum because this says so, not because someone remembered to.
 */
export function describeChains(env: ChainEnv): readonly ChainDescriptor[] {
  return chainConfigs(env).map((config) => {
    const capabilities = new Set<Capability>();
    for (const op of Object.values(OPERATIONS)) {
      if (subgraphIdFor(env, config.slug, op.name)) capabilities.add(op.capability);
    }
    // A chain with no feeGrowth-bearing deployment cannot be backtested, and
    // the override is exactly how we express that it has one.
    if (!config.opOverrides?.poolHourData && !FEE_GROWTH_CHAINS.has(config.slug)) {
      capabilities.delete('feeGrowth');
    }
    return {
      slug: config.slug,
      chainId: config.chainId,
      label: config.label,
      capabilities: [...capabilities].sort(),
    };
  });
}

/**
 * Chains whose *default* deployment carries `feeGrowthGlobal*X128`. Chains not
 * listed here need an explicit `poolHourData` override to support backtesting.
 * Verified by scripts/probe.ts, which asks each deployment for the field.
 */
const FEE_GROWTH_CHAINS: ReadonlySet<ChainSlug> = new Set(['ethereum', 'polygon', 'base']);
