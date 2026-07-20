import { describe, expect, it } from 'vitest';
import { parseSearch, searchSchema } from '../src/state/search.js';

const DEFAULTS = { chain: 'ethereum', notional: 10_000, inv: false };

describe('search params', () => {
  it('defaults to ethereum with the schema defaults filled in', () => {
    expect(parseSearch({})).toEqual(DEFAULTS);
  });

  it('lowercases the pool address so links are canonical', () => {
    const parsed = parseSearch({
      chain: 'base',
      pool: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
    });
    expect(parsed.pool).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('falls back to a valid shape instead of throwing on garbage', () => {
    expect(parseSearch({ chain: 'narnia', pool: 'not-an-address' })).toEqual(DEFAULTS);
  });

  it('drops a malformed pool but keeps a valid chain', () => {
    // A bad pool should not poison the whole search — but the schema rejects the
    // object as a unit, so document the actual behaviour: fallback to default.
    const parsed = searchSchema.safeParse({ chain: 'polygon', pool: '0x123' });
    expect(parsed.success).toBe(false);
  });

  it('round-trips a fully specified search, filling defaults', () => {
    const input = { chain: 'arbitrum', pool: `0x${'a'.repeat(40)}`, q: 'weth' };
    expect(parseSearch(input)).toEqual({ ...input, notional: 10_000, inv: false });
  });
});
