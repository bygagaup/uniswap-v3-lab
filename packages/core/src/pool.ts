import { CoreError } from './errors.js';
import { type FeeTier, tickSpacingFor } from './feeTiers.js';

export interface TokenMeta {
  /** Lowercased 0x address. Mixed case fragments caches and misses lookups. */
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** Immutable pool identity and static parameters. Built once per pool. */
export interface PoolKey {
  readonly token0: TokenMeta;
  readonly token1: TokenMeta;
  readonly feeTier: FeeTier;
  readonly tickSpacing: number;
}

function normalizeToken(t: TokenMeta, which: string): TokenMeta {
  if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) {
    throw new CoreError('NOT_FINITE', `${which} decimals must be an integer in [0, 36]`, t);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(t.address)) {
    throw new CoreError('NOT_FINITE', `${which} address is not a 20-byte hex address`, t.address);
  }
  return { ...t, address: t.address.toLowerCase() };
}

export function poolKey(args: {
  token0: TokenMeta;
  token1: TokenMeta;
  feeTier: FeeTier;
  /** The pool's own tickSpacing, when the data source reports it. */
  tickSpacing?: number;
}): PoolKey {
  const token0 = normalizeToken(args.token0, 'token0');
  const token1 = normalizeToken(args.token1, 'token1');

  if (token0.address === token1.address) {
    throw new CoreError('NOT_FINITE', 'token0 and token1 must differ', token0.address);
  }

  return {
    token0,
    token1,
    feeTier: args.feeTier,
    tickSpacing: tickSpacingFor(args.feeTier, args.tickSpacing),
  };
}
