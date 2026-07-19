/**
 * Liquidity <-> token amounts, from the Uniswap V3 whitepaper (§6.29–6.30):
 *
 *   L = Δx · (√Pa·√Pb) / (√Pb − √Pa)        L = Δy / (√Pb − √Pa)
 *   x = L · (1/√Pa − 1/√Pb)                 y = L · (√Pb − √Pa)
 *
 * All arithmetic is BigInt: `L` on real pools reaches 1e25, and a double loses
 * whole tokens at that magnitude. Products are formed before any shift, so no
 * intermediate is ever truncated — with arbitrary precision the 512-bit mulDiv
 * gymnastics the contracts need simply do not arise.
 *
 * Every entry point takes a named object. The predecessor's
 * `liquidityForStrategy(price, low, high, tokens0, tokens1, decimal0, decimal1)`
 * is seven positional numbers, which is an argument-swap bug waiting to happen.
 */
import { CoreError, invariant } from './errors.js';
import {
  type Amounts,
  type Liquidity,
  Liquidity as LiquidityCtor,
  type Raw,
  Raw as RawCtor,
  type SqrtPriceX96,
} from './units.js';

const Q96 = 1n << 96n;

/** Which side of the mint/burn asymmetry a result should favour. */
export type Rounding = 'down' | 'up';

function divRoundingUp(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

/** Orders a pair of sqrt ratios and rejects a degenerate range. */
function ordered(
  sqrtA: SqrtPriceX96,
  sqrtB: SqrtPriceX96,
): { readonly lower: bigint; readonly upper: bigint } {
  const [lower, upper] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (lower === upper) {
    throw new CoreError('INVALID_RANGE', 'range endpoints coincide, so it holds no liquidity', {
      sqrtA: sqrtA.toString(),
      sqrtB: sqrtB.toString(),
    });
  }
  return { lower, upper };
}

/**
 * L obtainable from a token0-only deposit spanning [a, b].
 * Rounds down: never claim more liquidity than the deposit supports.
 */
export function liquidityForAmount0(
  sqrtA: SqrtPriceX96,
  sqrtB: SqrtPriceX96,
  amount0: Raw,
): Liquidity {
  const { lower, upper } = ordered(sqrtA, sqrtB);
  const intermediate = (lower * upper) / Q96;
  return LiquidityCtor.of((amount0 * intermediate) / (upper - lower));
}

/**
 * L obtainable from a token1-only deposit spanning [a, b].
 * Rounds down, for the same reason.
 */
export function liquidityForAmount1(
  sqrtA: SqrtPriceX96,
  sqrtB: SqrtPriceX96,
  amount1: Raw,
): Liquidity {
  const { lower, upper } = ordered(sqrtA, sqrtB);
  return LiquidityCtor.of((amount1 * Q96) / (upper - lower));
}

/** Token0 held by `liquidity` over [a, b]: `L · (1/√Pa − 1/√Pb)`. */
export function amount0Delta(
  sqrtA: SqrtPriceX96,
  sqrtB: SqrtPriceX96,
  liquidity: Liquidity,
  rounding: Rounding,
): Raw {
  const { lower, upper } = ordered(sqrtA, sqrtB);
  const numerator = liquidity * Q96 * (upper - lower);
  const denominator = upper * lower;
  return RawCtor.of(
    rounding === 'up' ? divRoundingUp(numerator, denominator) : numerator / denominator,
  );
}

/** Token1 held by `liquidity` over [a, b]: `L · (√Pb − √Pa)`. */
export function amount1Delta(
  sqrtA: SqrtPriceX96,
  sqrtB: SqrtPriceX96,
  liquidity: Liquidity,
  rounding: Rounding,
): Raw {
  const { lower, upper } = ordered(sqrtA, sqrtB);
  const numerator = liquidity * (upper - lower);
  return RawCtor.of(rounding === 'up' ? divRoundingUp(numerator, Q96) : numerator / Q96);
}

export interface SqrtRange {
  readonly sqrtLower: SqrtPriceX96;
  readonly sqrtUpper: SqrtPriceX96;
}

/**
 * The most liquidity both amounts can support at the current price.
 *
 * Below the range the position is all token0; above it, all token1; inside, the
 * binding constraint is whichever side runs out first, so `min` of the two.
 * Rounds down throughout — the deposit is a ceiling, not a target.
 */
export function liquidityForAmounts(args: {
  sqrtPrice: SqrtPriceX96;
  range: SqrtRange;
  amounts: Amounts;
}): Liquidity {
  const { sqrtLower, sqrtUpper } = args.range;
  const { lower, upper } = ordered(sqrtLower, sqrtUpper);
  const price = args.sqrtPrice;

  if (price <= lower) {
    return liquidityForAmount0(lower as SqrtPriceX96, upper as SqrtPriceX96, args.amounts.amount0);
  }
  if (price >= upper) {
    return liquidityForAmount1(lower as SqrtPriceX96, upper as SqrtPriceX96, args.amounts.amount1);
  }

  const fromToken0 = liquidityForAmount0(price, upper as SqrtPriceX96, args.amounts.amount0);
  const fromToken1 = liquidityForAmount1(lower as SqrtPriceX96, price, args.amounts.amount1);
  return fromToken0 < fromToken1 ? fromToken0 : fromToken1;
}

/**
 * The token amounts `liquidity` represents at the current price.
 *
 * `rounding` is explicit and mandatory-by-default because the pool is not
 * symmetric: minting rounds amounts up (you pay the rounding), burning rounds
 * them down (the pool keeps it). A simulator that mixes the two drifts.
 */
export function amountsForLiquidity(args: {
  sqrtPrice: SqrtPriceX96;
  range: SqrtRange;
  liquidity: Liquidity;
  rounding?: Rounding;
}): Amounts {
  const rounding = args.rounding ?? 'down';
  const { lower, upper } = ordered(args.range.sqrtLower, args.range.sqrtUpper);
  const price = args.sqrtPrice;
  const l = args.liquidity;

  // Below the range: the position is entirely token0, waiting to be bought.
  if (price <= lower) {
    return {
      amount0: amount0Delta(lower as SqrtPriceX96, upper as SqrtPriceX96, l, rounding),
      amount1: RawCtor.ZERO,
    };
  }

  // Above the range: entirely token1.
  if (price >= upper) {
    return {
      amount0: RawCtor.ZERO,
      amount1: amount1Delta(lower as SqrtPriceX96, upper as SqrtPriceX96, l, rounding),
    };
  }

  // In range: split at the current price.
  return {
    amount0: amount0Delta(price, upper as SqrtPriceX96, l, rounding),
    amount1: amount1Delta(lower as SqrtPriceX96, price, l, rounding),
  };
}

/** True when the current price sits strictly inside the range. */
export function isInRange(sqrtPrice: SqrtPriceX96, range: SqrtRange): boolean {
  const { lower, upper } = ordered(range.sqrtLower, range.sqrtUpper);
  return sqrtPrice > lower && sqrtPrice < upper;
}

/** Guards a caller-supplied range before it reaches the math above. */
export function assertRange(range: SqrtRange): void {
  invariant(
    range.sqrtLower < range.sqrtUpper,
    'INVALID_RANGE',
    'sqrtLower must be strictly below sqrtUpper',
    { lower: range.sqrtLower.toString(), upper: range.sqrtUpper.toString() },
  );
}
