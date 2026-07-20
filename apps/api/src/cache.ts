/**
 * Edge caching.
 *
 * GET, not POST, is the whole reason this works: a GET with a canonical URL is
 * cacheable by the colo, so the common case never reaches the Worker body, let
 * alone the gateway.
 *
 * Variables are canonicalised (keys sorted, no whitespace) before they reach
 * the URL, so `{a:1,b:2}` and `{b:2,a:1}` are one cache entry rather than two.
 */
import type { CachePolicy } from './operations.js';

/** Deterministic JSON: object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export function encodeVariables(variables: unknown): string {
  return canonicalJson(variables);
}

export function decodeVariables(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function cacheControl(policy: CachePolicy): string {
  return `public, s-maxage=${policy.ttl}, stale-while-revalidate=${policy.swr}, max-age=${Math.min(policy.ttl, 30)}`;
}

/**
 * The cache key. Built from the canonical variables rather than the raw query
 * string, so a client that orders its JSON differently still hits.
 */
export function cacheKeyFor(
  request: Request,
  chain: string,
  op: string,
  variables: unknown,
): Request {
  const url = new URL(request.url);
  const key = new URL(`${url.origin}/api/graph/${chain}/${op}`);
  key.searchParams.set('v', canonicalJson(variables));
  return new Request(key.toString(), { method: 'GET' });
}
