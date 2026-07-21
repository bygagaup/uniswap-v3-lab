/**
 * Registry-shape tests: pure, no network. These guard the invariants that make
 * the allowlist and the (chain, op) routing trustworthy.
 */
import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { type ChainSlug, chainConfigs, describeChains, subgraphIdFor } from '../src/chains.js';
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

describe('chain routing', () => {
  it('routes fees and ticks to DIFFERENT deployments on bnb and unichain', () => {
    // The whole point of per-(chain, op) resolution. If these ever coincide,
    // one of the two datasets is silently missing.
    for (const chain of ['bnb', 'unichain'] as ChainSlug[]) {
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

  it('grants feeGrowth exactly to the chains with a backtest deployment', () => {
    const caps = new Map(describeChains(NO_ENV).map((d) => [d.slug, new Set(d.capabilities)]));
    for (const chain of [
      'ethereum',
      'polygon',
      'base',
      'optimism',
      'bnb',
      'unichain',
    ] as ChainSlug[]) {
      expect(caps.get(chain)?.has('feeGrowth'), `${chain} should support backtest`).toBe(true);
    }
    for (const chain of ['arbitrum'] as ChainSlug[]) {
      expect(caps.get(chain)?.has('feeGrowth'), `${chain} should NOT support backtest`).toBe(false);
    }
  });
});
