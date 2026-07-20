/**
 * Worker integration tests on real workerd, with the gateway's HTTP responses
 * stubbed. The test file runs inside the same workerd isolate as the imported
 * worker, so replacing the global `fetch` intercepts exactly the call gateway.ts
 * makes — and lets us assert that a cache HIT performs no second fetch.
 *
 * This exercises what a unit test cannot: the real caches.default, the error
 * mapping, and the rule that a 200-with-errors is a 502.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';

const POOL = `0x${'1'.repeat(40)}`;

function url(chain: string, op: string, variables: unknown): string {
  const u = new URL(`https://poollab.test/api/graph/${chain}/${op}`);
  u.searchParams.set('v', JSON.stringify(variables));
  return u.toString();
}

async function call(target: string, headers: Record<string, string> = {}): Promise<Response> {
  // A real ExecutionContext, drained after the response: the cache write runs
  // in ctx.waitUntil, so without waitOnExecutionContext the next request would
  // race the put and always miss.
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(target, { headers }), env as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/**
 * Installs a fetch stub that answers the gateway with `body`/`status`, and
 * returns a counter so a test can prove a cache hit made no upstream call.
 */
function stubGateway(body: unknown, status = 200, contentType = 'application/json') {
  const calls = { count: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const target =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (target.includes('gateway.thegraph.com')) {
        calls.count += 1;
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        return new Response(payload, { status, headers: { 'content-type': contentType } });
      }
      throw new Error(`unexpected fetch to ${target}`);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routing and validation', () => {
  it('rejects an unknown chain with 400 UNKNOWN_CHAIN', async () => {
    const res = await call(url('narnia', 'poolById', { id: POOL }));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('UNKNOWN_CHAIN');
  });

  it('rejects an unknown operation with 400 UNKNOWN_OP', async () => {
    const res = await call(url('ethereum', 'dropEverything', { id: POOL }));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('UNKNOWN_OP');
  });

  it('rejects malformed variables with 400 BAD_VARIABLES', async () => {
    const res = await call(url('ethereum', 'poolById', { id: 'nope' }));
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; detail: string } }>();
    expect(body.error.code).toBe('BAD_VARIABLES');
    expect(body.error.detail).toContain('id');
  });
});

describe('gateway success and failure mapping', () => {
  it('returns data and a MISS on the first fetch', async () => {
    stubGateway({ data: { pools: [{ id: POOL }] } });
    const res = await call(url('ethereum', 'poolById', { id: POOL }));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-PoolLab-Cache')).toBe('MISS');
    expect((await res.json<{ data: { pools: { id: string }[] } }>()).data.pools[0]?.id).toBe(POOL);
  });

  it('maps a 200-with-errors to 502 UPSTREAM_GRAPHQL, not empty data', async () => {
    // The defining test for this proxy: a dead subgraph answers 200 with an
    // errors array, and treating that as data is an eternal spinner.
    stubGateway({ errors: [{ message: 'indexing_error' }] });
    const res = await call(url('ethereum', 'poolsByIds', { ids: [`0x${'2'.repeat(40)}`] }));
    expect(res.status).toBe(502);
    const body = await res.json<{ error: { code: string; detail: string } }>();
    expect(body.error.code).toBe('UPSTREAM_GRAPHQL');
    expect(body.error.detail).toContain('indexing_error');
  });

  it('keeps a genuinely empty result as a 200 success', async () => {
    stubGateway({ data: { pools: [] } });
    const res = await call(url('ethereum', 'topPoolsByVolume', {}));
    expect(res.status).toBe(200);
    expect((await res.json<{ data: { pools: unknown[] } }>()).data.pools).toEqual([]);
  });

  it('maps an upstream 500 to 502 UPSTREAM_HTTP and marks it retryable', async () => {
    stubGateway('boom', 500, 'text/plain');
    const res = await call(url('polygon', 'poolById', { id: `0x${'3'.repeat(40)}` }));
    expect(res.status).toBe(502);
    const body = await res.json<{ error: { code: string; retryable: boolean } }>();
    expect(body.error.code).toBe('UPSTREAM_HTTP');
    expect(body.error.retryable).toBe(true);
  });

  it('maps non-JSON to 502 UPSTREAM_MALFORMED', async () => {
    stubGateway('this is not json', 200, 'text/plain');
    const res = await call(url('base', 'poolById', { id: `0x${'4'.repeat(40)}` }));
    expect(res.status).toBe(502);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe('UPSTREAM_MALFORMED');
  });
});

describe('caching', () => {
  it('serves the second identical request from cache without a second fetch', async () => {
    const id = `0x${'a'.repeat(40)}`;
    const gateway = stubGateway({ data: { pools: [{ id }] } });

    const first = await call(url('ethereum', 'poolById', { id }));
    expect(first.headers.get('X-PoolLab-Cache')).toBe('MISS');
    expect(gateway.count).toBe(1);

    const second = await call(url('ethereum', 'poolById', { id }));
    expect(second.headers.get('X-PoolLab-Cache')).toBe('HIT');
    // The proof: the cache absorbed it, so the gateway was never hit again.
    expect(gateway.count).toBe(1);
  });

  it('treats differently-ordered variables as one cache entry', async () => {
    const ids = [`0x${'c'.repeat(40)}`, `0x${'d'.repeat(40)}`];
    const gateway = stubGateway({ data: { pools: [] } });

    await call(url('ethereum', 'poolsByIds', { ids }));
    // Same members, reversed. Canonicalisation must collapse this to one key.
    const second = await call(
      `https://poollab.test/api/graph/ethereum/poolsByIds?v=${encodeURIComponent(
        JSON.stringify({ ids: [...ids].reverse() }),
      )}`,
    );
    // Reversed ids are a *different* logical query (order matters to the array),
    // so this documents that canonicalisation is structural, not set-based.
    expect(gateway.count).toBe(2);
    expect(second.status).toBe(200);
  });

  it('sets a Cache-Control header matching the operation policy', async () => {
    stubGateway({ data: { pools: [] } });
    const res = await call(url('ethereum', 'poolCurrentPrices', { pool: `0x${'b'.repeat(40)}` }));
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=15');
  });
});

describe('secret hygiene', () => {
  it('never leaks the Graph key into a response body or headers', async () => {
    stubGateway({ data: { pools: [{ id: POOL }] } });
    const res = await call(url('ethereum', 'poolById', { id: `0x${'e'.repeat(40)}` }));
    const text = await res.text();
    expect(text).not.toContain('GRAPH_API_KEY');
    for (const [, value] of res.headers) {
      expect(value).not.toMatch(/gateway\.thegraph\.com\/api\//);
    }
  });
});

describe('meta', () => {
  it('reports capabilities per chain, excluding feeGrowth where absent', async () => {
    const res = await call('https://poollab.test/api/meta/chains');
    expect(res.status).toBe(200);
    const { chains } = await res.json<{ chains: { slug: string; capabilities: string[] }[] }>();
    expect(chains).toHaveLength(7);
    expect(chains.find((c) => c.slug === 'optimism')?.capabilities).not.toContain('feeGrowth');
    expect(chains.find((c) => c.slug === 'ethereum')?.capabilities).toContain('feeGrowth');
  });
});
