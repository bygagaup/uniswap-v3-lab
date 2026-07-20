import { Hono } from 'hono';
import { cacheControl, cacheKeyFor, decodeVariables } from './cache.js';
import { describeChains, isKnownChain, subgraphUrl } from './chains.js';
import { ApiError, errorBody } from './errors.js';
import { queryGateway } from './gateway.js';
import { HEAVY_OPERATIONS, isKnownOperation, OPERATIONS } from './operations.js';
import { enforceRateLimit, isForeignOrigin, type RateLimitBindings } from './rateLimit.js';

export interface Env extends RateLimitBindings {
  /** Graph gateway key. A Worker secret; never leaves this app. */
  readonly GRAPH_API_KEY?: string;
  readonly ENVIRONMENT?: string;
  readonly [key: string]: unknown;
}

type Ctx = { Bindings: Env };

const app = new Hono<Ctx>();

function requestId(c: { req: { raw: Request } }): string {
  const cf = (c.req.raw as Request & { cf?: { ray?: string } }).cf;
  return cf?.ray ?? crypto.randomUUID();
}

app.onError((error, c) => {
  const id = requestId(c);
  const exposeDetail = c.env.ENVIRONMENT !== 'production';

  if (error instanceof ApiError) {
    return c.json(errorBody(error, id, exposeDetail), error.status as 400);
  }

  // Anything unclassified is ours, not the upstream's.
  const wrapped = new ApiError(
    'MISCONFIGURED',
    'The proxy failed unexpectedly',
    error instanceof Error ? error.message : String(error),
  );
  return c.json(errorBody(wrapped, id, exposeDetail), 500);
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'poollab-api',
    // Presence only — the value must never leave the Worker.
    graphKeyConfigured: Boolean(c.env.GRAPH_API_KEY),
  }),
);

/**
 * Capabilities are derived from which deployments are configured, so the UI can
 * grey out backtesting on chains that have no feeGrowth-bearing deployment
 * without hardcoding that list on the client.
 */
app.get('/api/meta/chains', (c) => {
  c.header('Cache-Control', cacheControl({ ttl: 3600, swr: 86_400 }));
  return c.json({ chains: describeChains(c.env as Record<string, string | undefined>) });
});

app.get('/api/graph/:chain/:op', async (c) => {
  const { chain, op } = c.req.param();
  const env = c.env as Record<string, string | undefined>;

  if (!isKnownChain(env, chain)) {
    throw new ApiError('UNKNOWN_CHAIN', `Unknown chain "${chain}"`);
  }
  if (!isKnownOperation(op)) {
    throw new ApiError('UNKNOWN_OP', `Unknown operation "${op}"`);
  }

  const operation = OPERATIONS[op];

  const parsed = operation.variables.safeParse(decodeVariables(c.req.query('v')));
  if (!parsed.success) {
    throw new ApiError(
      'BAD_VARIABLES',
      `Invalid variables for "${op}"`,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  const variables = parsed.data as Record<string, unknown>;

  // Key on the *validated and normalised* variables — addresses are lowercased
  // and dates clamped by now, so equivalent requests share one entry.
  const key = cacheKeyFor(c.req.raw, chain, op, variables);
  const cache = caches.default;

  const hit = await cache.match(key);
  if (hit) {
    const response = new Response(hit.body, hit);
    response.headers.set('X-PoolLab-Cache', 'HIT');
    return response;
  }

  // Only misses are metered: see rateLimit.ts.
  await enforceRateLimit({
    bindings: c.env,
    request: c.req.raw,
    chain,
    heavy: HEAVY_OPERATIONS.has(op),
    foreign: isForeignOrigin(c.req.raw, new URL(c.req.url).origin),
  });

  const apiKey = c.env.GRAPH_API_KEY;
  if (!apiKey) {
    throw new ApiError('MISCONFIGURED', 'The proxy has no Graph API key configured');
  }

  const url = subgraphUrl(env, chain, op, apiKey);
  if (!url) {
    throw new ApiError(
      'NOT_CONFIGURED',
      `No subgraph deployment is configured for ${op} on ${chain}`,
    );
  }

  const data = await queryGateway({ url, operation, variables });

  const response = c.json({ data });
  response.headers.set('Cache-Control', cacheControl(operation.cache));
  response.headers.set('X-PoolLab-Cache', 'MISS');
  // Store a clone; the original is still streaming to the client.
  c.executionCtx.waitUntil(cache.put(key, response.clone()));
  return response;
});

export default app;
