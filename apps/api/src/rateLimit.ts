/**
 * Rate limiting.
 *
 * The predecessor designed this and never built it, leaving an open faucet on
 * its own Graph API key. Here it is load-bearing from the first deploy.
 *
 * Two rules that matter:
 *
 *  1. Only cache MISSES are counted. A cache hit costs us nothing, and charging
 *     for it just makes the app feel broken behind a corporate NAT where many
 *     users share one address.
 *  2. Heavy operations get their own, tighter bucket keyed by (ip, chain).
 *     `poolHourData` returns 1000 rows and costs real gateway budget; pool
 *     search does not.
 *
 * Cloudflare's binding is unavailable in some local/test setups, so a missing
 * binding means "not enforced" rather than a crash — the deploy-time check in
 * wrangler.toml is what guarantees it exists in production.
 */
import { ApiError } from './errors.js';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitBindings {
  readonly RL_CHEAP?: RateLimiter;
  readonly RL_HEAVY?: RateLimiter;
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for') ?? 'unknown'
  );
}

/** Is this request coming from somewhere other than our own app? */
export function isForeignOrigin(request: Request, selfOrigin: string): boolean {
  const origin = request.headers.get('Origin') ?? request.headers.get('Referer');
  if (!origin) return false;
  try {
    return new URL(origin).origin !== selfOrigin;
  } catch {
    return true;
  }
}

export async function enforceRateLimit(args: {
  bindings: RateLimitBindings;
  request: Request;
  chain: string;
  heavy: boolean;
  foreign: boolean;
}): Promise<void> {
  const { bindings, request, chain, heavy, foreign } = args;
  const ip = clientIp(request);

  // The data is public, so a foreign origin is served — but it is metered at
  // the heavy rate regardless of operation. Cheap deterrent against someone
  // wiring our proxy into their own app.
  const useHeavy = heavy || foreign;
  const limiter = useHeavy ? bindings.RL_HEAVY : bindings.RL_CHEAP;
  if (!limiter) return;

  const key = useHeavy ? `${ip}:${chain}` : ip;
  const { success } = await limiter.limit({ key });
  if (!success) {
    throw new ApiError('RATE_LIMITED', 'Too many requests — please slow down');
  }
}
