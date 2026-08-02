/**
 * Branded primitives for every quantity that crosses the BigInt/float boundary.
 *
 * The rule this file exists to enforce: a value that came off-chain is a bigint
 * until `convert.ts` turns it into a number, exactly once, as late as possible.
 * Constructors take `string | bigint` — never `number` — because the subgraph
 * returns decimal strings that would already be lossy as a JS number.
 */
import { CoreError } from './errors.js';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Signed tick index. `price = 1.0001^tick` in raw token units. */
export type Tick = Brand<number, 'Tick'>;

/** `sqrt(price) * 2^96`, price being token1/token0 in RAW units. uint160. */
export type SqrtPriceX96 = Brand<bigint, 'SqrtPriceX96'>;

/** Position or pool liquidity L. uint128. */
export type Liquidity = Brand<bigint, 'Liquidity'>;

/** `feeGrowthGlobal{0,1}X128`. uint256 that WRAPS mod 2^256 by design. */
export type FeeGrowthX128 = Brand<bigint, 'FeeGrowthX128'>;

/** On-chain token amount, unscaled by decimals. uint256. */
export type Raw = Brand<bigint, 'Raw'>;

/** A human-readable price. Only ever produced at the display boundary. */
export type HumanPrice = Brand<number, 'HumanPrice'>;

/** A human-readable USD amount. Produced at the display boundary; may be zero. */
export type HumanUsd = Brand<number, 'HumanUsd'>;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** getSqrtRatioAtTick(MIN_TICK) */
export const MIN_SQRT_RATIO_VALUE = 4295128739n;
/** getSqrtRatioAtTick(MAX_TICK) */
export const MAX_SQRT_RATIO_VALUE = 1461446703485210103287273052203988822378723970342n;

export const UINT128_MAX = (1n << 128n) - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;

function toBigInt(v: bigint | string, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (!/^-?\d+$/.test(v)) {
    throw new CoreError('NOT_FINITE', `${what} must be a decimal integer string`, v);
  }
  return BigInt(v);
}

export const Tick = {
  of(n: number): Tick {
    if (!Number.isInteger(n)) {
      throw new CoreError('TICK_OUT_OF_RANGE', 'tick must be an integer', n);
    }
    if (n < MIN_TICK || n > MAX_TICK) {
      throw new CoreError('TICK_OUT_OF_RANGE', `tick must be in [${MIN_TICK}, ${MAX_TICK}]`, n);
    }
    return n as Tick;
  },
  MIN: MIN_TICK as Tick,
  MAX: MAX_TICK as Tick,
} as const;

export const SqrtPriceX96 = {
  of(v: bigint | string): SqrtPriceX96 {
    const x = toBigInt(v, 'sqrtPriceX96');
    if (x < MIN_SQRT_RATIO_VALUE || x > MAX_SQRT_RATIO_VALUE) {
      throw new CoreError(
        'SQRT_RATIO_OUT_OF_RANGE',
        `sqrtPriceX96 must be in [${MIN_SQRT_RATIO_VALUE}, ${MAX_SQRT_RATIO_VALUE}]`,
        x.toString(),
      );
    }
    return x as SqrtPriceX96;
  },
  /** Escape hatch for tickMath's own boundary arithmetic. Skips range checks. */
  unchecked(v: bigint): SqrtPriceX96 {
    return v as SqrtPriceX96;
  },
  MIN: MIN_SQRT_RATIO_VALUE as SqrtPriceX96,
  MAX: MAX_SQRT_RATIO_VALUE as SqrtPriceX96,
} as const;

export const Liquidity = {
  of(v: bigint | string): Liquidity {
    const x = toBigInt(v, 'liquidity');
    if (x < 0n) throw new CoreError('NEGATIVE_AMOUNT', 'liquidity must be >= 0', x.toString());
    if (x > UINT128_MAX) {
      throw new CoreError('NEGATIVE_AMOUNT', 'liquidity exceeds uint128', x.toString());
    }
    return x as Liquidity;
  },
  ZERO: 0n as Liquidity,
} as const;

export const FeeGrowthX128 = {
  of(v: bigint | string): FeeGrowthX128 {
    const x = toBigInt(v, 'feeGrowthX128');
    if (x < 0n || x > UINT256_MAX) {
      throw new CoreError('NEGATIVE_AMOUNT', 'feeGrowthX128 must fit in uint256', x.toString());
    }
    return x as FeeGrowthX128;
  },
  ZERO: 0n as FeeGrowthX128,
} as const;

export const Raw = {
  of(v: bigint | string): Raw {
    const x = toBigInt(v, 'raw amount');
    if (x < 0n) throw new CoreError('NEGATIVE_AMOUNT', 'raw amount must be >= 0', x.toString());
    if (x > UINT256_MAX) {
      throw new CoreError('NEGATIVE_AMOUNT', 'raw amount exceeds uint256', x.toString());
    }
    return x as Raw;
  },
  ZERO: 0n as Raw,
} as const;

export const HumanPrice = {
  of(n: number): HumanPrice {
    if (!Number.isFinite(n)) {
      throw new CoreError('NOT_FINITE', 'price must be finite', n);
    }
    if (n <= 0) {
      throw new CoreError('NEGATIVE_AMOUNT', 'price must be > 0', n);
    }
    return n as HumanPrice;
  },
} as const;

export const HumanUsd = {
  // Zero is a legitimate USD amount (a pool with no volume on a given day), so
  // unlike HumanPrice this only rejects negatives and non-finite values.
  of(n: number): HumanUsd {
    if (!Number.isFinite(n)) {
      throw new CoreError('NOT_FINITE', 'usd amount must be finite', n);
    }
    if (n < 0) {
      throw new CoreError('NEGATIVE_AMOUNT', 'usd amount must be >= 0', n);
    }
    return n as HumanUsd;
  },
} as const;

/** Amounts of a position. Tagged so token0 and token1 cannot be swapped. */
export interface Amounts {
  readonly amount0: Raw;
  readonly amount1: Raw;
}
