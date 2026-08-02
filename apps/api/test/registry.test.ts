/**
 * Registry-shape tests: pure, no network. These guard the invariants that make
 * the allowlist and the (chain, op) routing trustworthy.
 */
import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  type ChainConfig,
  type ChainSlug,
  chainCapabilities,
  chainConfigs,
  describeChains,
  subgraphIdFor,
} from '../src/chains.js';
import { HEAVY_OPERATIONS, isKnownOperation, OPERATIONS, type OpName } from '../src/operations.js';

const NO_ENV: Record<string, string | undefined> = {};
const opNames = Object.keys(OPERATIONS) as OpName[];

describe('operation registry', () => {
  it.each(opNames)('%s has a parseable document, a schema and a cache policy', (op) => {
    const operation = OPERATIONS[op];
    expect(() => parse(operation.document)).not.toThrow();
    expect(operation.variables).toBeDefined();
    expect(operation.cache.ttl).toBeGreaterThan(0);
    expect(operation.cache.swr).toBeGreaterThanOrEqual(operation.cache.ttl);
    expect(operation.name).toBe(op);
  });

  it('never embeds a client-supplied `first` — it is always a literal', () => {
    for (const op of opNames) {
      const doc = OPERATIONS[op].document;
      // `first:` must be followed by digits, never by a `$variable`.
      const matches = doc.match(/first:\s*\$?\w+/g) ?? [];
      for (const m of matches) expect(m).toMatch(/first:\s*\d+/);
    }
  });

  it('lowercases addresses so the cache cannot fragment on case', () => {
    const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    const parsed = OPERATIONS.poolById.variables.parse({ id: mixed });
    expect((parsed as { id: string }).id).toBe(mixed.toLowerCase());
  });

  it('clamps poolHourData fromdate into the last 90 days', () => {
    const now = Math.floor(Date.now() / 1000);
    const ancient = OPERATIONS.poolHourData.variables.parse({
      pool: `0x${'1'.repeat(40)}`,
      fromdate: 0,
    });
    const future = OPERATIONS.poolHourData.variables.parse({
      pool: `0x${'1'.repeat(40)}`,
      fromdate: now + 1_000_000,
    });
    expect((ancient as { fromdate: number }).fromdate).toBeGreaterThanOrEqual(
      now - 90 * 86_400 - 5,
    );
    expect((future as { fromdate: number }).fromdate).toBeLessThanOrEqual(now);
  });

  it('rejects malformed addresses', () => {
    expect(OPERATIONS.poolById.variables.safeParse({ id: 'not-an-address' }).success).toBe(false);
    expect(OPERATIONS.poolById.variables.safeParse({ id: '0x123' }).success).toBe(false);
  });

  it('knows only its own operations', () => {
    expect(isKnownOperation('poolById')).toBe(true);
    expect(isKnownOperation('dropTable')).toBe(false);
  });

  it('marks the 1000-row operations as heavy', () => {
    expect(HEAVY_OPERATIONS.has('poolHourData')).toBe(true);
    expect(HEAVY_OPERATIONS.has('ticksByPool')).toBe(true);
    expect(HEAVY_OPERATIONS.has('poolById')).toBe(false);
  });
});

/**
 * The edge reshapes responses so the cached artifact is what the client consumes.
 * `bundles` is the carrier for the chain-wide ETH/USD rate that USD reconstruction
 * runs on (see packages/core/src/usd.ts), and it travels *beside* the pool lists in
 * the document — which is exactly what makes it easy to get wrong.
 */
describe('response transforms', () => {
  const BUNDLE = { bundles: [{ ethPriceUSD: '1919.902633206883' }] };

  it('surfaces ethPriceUsd on every operation whose document asks for bundles', () => {
    // Requesting `bundles` without a transform would ship the raw array to the
    // client, and every consumer would have to reassemble it identically.
    for (const op of opNames) {
      if (!OPERATIONS[op].document.includes('bundles(')) continue;
      const { transform } = OPERATIONS[op];
      expect(transform, `${op} requests bundles but has no transform`).toBeDefined();
      const out = transform?.({ pools: [], ...BUNDLE }) as { ethPriceUsd?: unknown };
      expect(out.ethPriceUsd, op).toBe('1919.902633206883');
    }
  });

  it('flattens { pools, bundles } into { pools, ethPriceUsd }', () => {
    const out = OPERATIONS.poolById.transform?.({ pools: [{ id: '0xa' }], ...BUNDLE });
    expect(out).toEqual({ pools: [{ id: '0xa' }], ethPriceUsd: '1919.902633206883' });
  });

  it('reports ethPriceUsd as null on a deployment with no Bundle entity', () => {
    // Null, never 0 or "": a missing rate must stay distinguishable from a real
    // one, or reconstruction silently values every pool at zero dollars.
    for (const data of [{ pools: [] }, { pools: [], bundles: [] }]) {
      const out = OPERATIONS.poolById.transform?.(data) as { ethPriceUsd: unknown };
      expect(out.ethPriceUsd).toBeNull();
    }
  });

  it('never mistakes the bundles row for a pool when merging aliased lists', () => {
    // The merge walks every array-valued key, and `bundles` sits beside the pool
    // lists. Today an id-less bundle is also caught by the `typeof id` guard — but
    // `Bundle.id` exists in the schema (it is always "1"), so the day someone
    // selects it, dropping the key check would put a phantom pool with id "1" into
    // every search result. That is the shape asserted here.
    const merged = OPERATIONS.poolsByToken.transform?.({
      asToken1: [{ id: '0xa', totalValueLockedUSD: '10' }],
      asToken0: [{ id: '0xb', totalValueLockedUSD: '30' }],
      asPool: [],
      bundles: [{ id: '1', ethPriceUSD: '1919.902633206883' }],
    }) as { pools: { id: string }[]; ethPriceUsd: string };

    expect(merged.pools.map((p) => p.id)).toEqual(['0xb', '0xa']);
    expect(merged.ethPriceUsd).toBe('1919.902633206883');
  });

  it('de-duplicates a pool returned by more than one aliased list', () => {
    const merged = OPERATIONS.poolsByTokens.transform?.({
      asToken1: [{ id: '0xa', totalValueLockedUSD: '10' }],
      asToken0: [{ id: '0xa', totalValueLockedUSD: '10' }],
      ...BUNDLE,
    }) as { pools: { id: string }[] };
    expect(merged.pools).toHaveLength(1);
  });
});

describe('chain routing', () => {
  it('routes fees and ticks to DIFFERENT deployments on the split chains', () => {
    // The whole point of per-(chain, op) resolution. If these ever coincide,
    // one of the two datasets is silently missing.
    for (const chain of ['optimism', 'arbitrum', 'bnb', 'unichain'] as ChainSlug[]) {
      const fees = subgraphIdFor(NO_ENV, chain, 'poolHourData');
      const ticks = subgraphIdFor(NO_ENV, chain, 'ticksByPool');
      expect(fees).toBeTruthy();
      expect(ticks).toBeTruthy();
      expect(fees).not.toBe(ticks);
    }
  });

  it('routes fees and ticks to the SAME deployment where one suffices', () => {
    for (const chain of ['ethereum', 'polygon', 'base'] as ChainSlug[]) {
      expect(subgraphIdFor(NO_ENV, chain, 'poolHourData')).toBe(
        subgraphIdFor(NO_ENV, chain, 'ticksByPool'),
      );
    }
  });

  it('lets an env override replace a default without a rebuild', () => {
    const overridden = subgraphIdFor({ SUBGRAPH_ID_ETHEREUM: 'CUSTOM_ID' }, 'ethereum', 'poolById');
    expect(overridden).toBe('CUSTOM_ID');
  });

  it('treats a blank env var as "unset", not "remove the default"', () => {
    const blank = subgraphIdFor({ SUBGRAPH_ID_ETHEREUM: '   ' }, 'ethereum', 'poolById');
    expect(blank).toBe(subgraphIdFor(NO_ENV, 'ethereum', 'poolById'));
  });

  it('configures all seven chains', () => {
    expect(chainConfigs(NO_ENV)).toHaveLength(7);
  });

  it('grants feeGrowth to every chain — each now has a deployment carrying it', () => {
    const caps = new Map(describeChains(NO_ENV).map((d) => [d.slug, new Set(d.capabilities)]));
    for (const config of chainConfigs(NO_ENV)) {
      expect(
        caps.get(config.slug)?.has('feeGrowth'),
        `${config.slug} should support backtest`,
      ).toBe(true);
    }
  });

  it('withholds feeGrowth from a chain whose deployment does not carry it', () => {
    // The rule that greys the backtest out, exercised against a synthetic config
    // because no configured chain is in this state any more. `feeGrowthGlobal*`
    // is absent from Uniswap's own schema, so a chain on a stock deployment with
    // no fees override must NOT advertise backtesting — it would 502 on the first
    // poolHourData call instead of arriving disabled.
    const arbitrum = chainConfigs(NO_ENV).find((c) => c.slug === 'arbitrum');
    expect(arbitrum).toBeDefined();
    const { opOverrides: _fees, ...stock } = arbitrum as ChainConfig;
    expect(chainCapabilities(stock)).not.toContain('feeGrowth');
    // Everything else still resolves off the default deployment.
    expect(chainCapabilities(stock)).toContain('pools');
    expect(chainCapabilities(stock)).toContain('ticks');
  });
});
