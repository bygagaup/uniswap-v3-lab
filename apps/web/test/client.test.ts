import { afterEach, describe, expect, it, vi } from 'vitest';
import { graphFetch, SubgraphError, shouldRetry } from '../src/api/client.js';

function mockFetch(impl: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(impl(typeof input === 'string' ? input : input.toString())),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('graphFetch', () => {
  it('sends canonicalised variables in the query string', async () => {
    let seen = '';
    mockFetch((url) => {
      seen = url;
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    await graphFetch('ethereum', 'poolById', { b: 2, a: 1 });
    // Keys sorted, so the cache key is stable regardless of insertion order.
    expect(seen).toContain(encodeURIComponent('{"a":1,"b":2}'));
    expect(seen).toBe(`/api/graph/ethereum/poolById?v=${encodeURIComponent('{"a":1,"b":2}')}`);
  });

  it('returns the data payload on success', async () => {
    mockFetch(() => new Response(JSON.stringify({ data: { pools: [] } }), { status: 200 }));
    expect(await graphFetch('base', 'topPoolsByVolume')).toEqual({ pools: [] });
  });

  it('throws a SubgraphError carrying the proxy error code', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'UPSTREAM_GRAPHQL', message: 'dead', retryable: false },
          }),
          { status: 502 },
        ),
    );
    await expect(graphFetch('ethereum', 'poolById', { id: 'x' })).rejects.toMatchObject({
      code: 'UPSTREAM_GRAPHQL',
      retryable: false,
      status: 502,
    });
  });

  it('treats a network failure as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    await expect(graphFetch('ethereum', 'poolById')).rejects.toMatchObject({
      code: 'NETWORK',
      retryable: true,
    });
  });

  it('rejects a 200 with no data field rather than returning undefined', async () => {
    mockFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    await expect(graphFetch('ethereum', 'poolById')).rejects.toBeInstanceOf(SubgraphError);
  });
});

describe('shouldRetry', () => {
  it('stops immediately on a non-retryable SubgraphError', () => {
    const err = new SubgraphError({ code: 'BAD', message: 'x', retryable: false, status: 400 });
    expect(shouldRetry(0, err)).toBe(false);
  });

  it('retries a retryable error up to twice', () => {
    const err = new SubgraphError({ code: 'X', message: 'x', retryable: true, status: 502 });
    expect(shouldRetry(0, err)).toBe(true);
    expect(shouldRetry(1, err)).toBe(true);
    expect(shouldRetry(2, err)).toBe(false);
  });
});
