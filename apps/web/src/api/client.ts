/**
 * The single door to the proxy. One function, one failure mode: it returns the
 * `data` payload or it throws a SubgraphError. Nothing here ever returns null
 * or an empty object to mean "it didn't work" — the predecessor's bug was making
 * a dead subgraph indistinguishable from an empty result, and the proxy already
 * draws that line (200-with-errors is a 502); the client must not blur it again.
 */
import type { ChainSlug } from './types.js';

export class SubgraphError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(args: { code: string; message: string; retryable: boolean; status: number }) {
    super(args.message);
    this.name = 'SubgraphError';
    this.code = args.code;
    this.retryable = args.retryable;
    this.status = args.status;
  }
}

/** Deterministic JSON so the URL — and therefore the cache key — is stable. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; retryable?: boolean };
}

/**
 * GET /api/graph/:chain/:op?v=<canonical json>. GET, not POST, so the edge CDN
 * can cache it; the variables ride in a canonicalised query param so two
 * equivalent requests share one cache entry.
 */
export async function graphFetch<T>(
  chain: ChainSlug,
  op: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const url = `/api/graph/${chain}/${op}?v=${encodeURIComponent(canonicalJson(variables))}`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new SubgraphError({
      code: 'NETWORK',
      message: cause instanceof Error ? cause.message : 'network request failed',
      retryable: true,
      status: 0,
    });
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new SubgraphError({
      code: body.error?.code ?? 'UNKNOWN',
      message: body.error?.message ?? `request failed with ${response.status}`,
      retryable: body.error?.retryable ?? response.status >= 500,
      status: response.status,
    });
  }

  const body = (await response.json()) as { data?: T };
  if (body.data === undefined) {
    throw new SubgraphError({
      code: 'UPSTREAM_MALFORMED',
      message: 'the proxy returned a response with no data',
      retryable: false,
      status: response.status,
    });
  }
  return body.data;
}

/** Retry predicate for TanStack Query: trust the server's `retryable` flag. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof SubgraphError && !error.retryable) return false;
  return failureCount < 2;
}
