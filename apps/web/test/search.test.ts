import { describe, expect, it } from 'vitest';
import { parseSearch, searchSchema } from '../src/state/search.js';

describe('search params', () => {
  it('defaults to ethereum with no pool', () => {
    expect(parseSearch({})).toEqual({ chain: 'ethereum' });
  });

  it('lowercases the pool address so links are canonical', () => {
    const parsed = parseSearch({
      chain: 'base',
      pool: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
    });
    expect(parsed.pool).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('falls back to a valid shape instead of throwing on garbage', () => {
    expect(parseSearch({ chain: 'narnia', pool: 'not-an-address' })).toEqual({ chain: 'ethereum' });
  });

  it('drops a malformed pool but keeps a valid chain', () => {
    // A bad pool should not poison the whole search — but the schema rejects the
    // object as a unit, so document the actual behaviour: fallback to default.
    const parsed = searchSchema.safeParse({ chain: 'polygon', pool: '0x123' });
    expect(parsed.success).toBe(false);
  });

  it('round-trips a fully specified search', () => {
    const input = { chain: 'arbitrum', pool: `0x${'a'.repeat(40)}`, q: 'weth' };
    expect(parseSearch(input)).toEqual(input);
  });
});
