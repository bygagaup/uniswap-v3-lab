/**
 * The ONLY place where a BigInt quantity becomes a float.
 *
 * The rule: a value crosses this boundary exactly once, as late as possible,
 * and never crosses back. Everything upstream of a call here is exact; every
 * sum, ratio and chart coordinate downstream is a double, and that is fine —
 * a pixel does not need 256 bits.
 */
import { CoreError } from './errors.js';
import type { FeeGrowthX128, Liquidity, Raw, SqrtPriceX96 } from './units.js';

const Q96 = 2 ** 96;
const Q128_F = 2 ** 128;

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new CoreError('NOT_FINITE', 'decimals must be an integer in [0, 36]', decimals);
  }
}

/**
 * Raw on-chain amount -> human units.
 *
 * Splits integer and fractional parts in BigInt first. The obvious
 * `Number(raw) / 10 ** decimals` overflows to Infinity for uint256-scale
 * inputs, which is exactly the range this function exists to handle.
 */
export function rawToNumber(raw: Raw, decimals: number): number {
  checkDecimals(decimals);
  const divisor = 10n ** BigInt(decimals);
  const whole = Number(raw / divisor);
  const frac = Number(raw % divisor) / Number(divisor);
  const out = whole + frac;
  if (!Number.isFinite(out)) {
    throw new CoreError('NOT_FINITE', 'raw amount does not fit in a double', raw.toString());
  }
  return out;
}

/** Human units -> raw on-chain amount. Truncates below one unit of the token. */
export function numberToRaw(value: number, decimals: number): bigint {
  checkDecimals(decimals);
  if (!Number.isFinite(value)) {
    throw new CoreError('NOT_FINITE', 'value must be finite', value);
  }
  if (value < 0) {
    throw new CoreError('NEGATIVE_AMOUNT', 'value must be >= 0', value);
  }

  const divisor = 10n ** BigInt(decimals);
  const whole = Math.floor(value);
  const frac = value - whole;
  return BigInt(whole) * divisor + BigInt(Math.floor(frac * Number(divisor)));
}

/**
 * sqrtPriceX96 -> the raw price it encodes, `token1/token0` in unscaled units.
 * Decimals and orientation are applied by `price.ts`, not here.
 */
export function sqrtRatioToRawPrice(sqrtP: SqrtPriceX96): number {
  const root = Number(sqrtP) / Q96;
  const out = root * root;
  if (!Number.isFinite(out)) {
    throw new CoreError('NOT_FINITE', 'sqrt ratio does not square into a double', sqrtP.toString());
  }
  return out;
}

/** A Q128 fixed-point fee-growth value -> human token units. */
export function q128ToNumber(value: FeeGrowthX128, decimals: number): number {
  checkDecimals(decimals);
  // Keep the integer part exact, then add the sub-1 remainder as a fraction.
  const whole = value >> 128n;
  const frac = Number(value & ((1n << 128n) - 1n)) / Q128_F;
  const out = Number(whole) / 10 ** decimals + frac / 10 ** decimals;
  if (!Number.isFinite(out)) {
    throw new CoreError('NOT_FINITE', 'fee growth does not fit in a double', value.toString());
  }
  return out;
}

/** Liquidity L -> a double, for chart heights and ratios only. */
export function liquidityToNumber(liquidity: Liquidity): number {
  const out = Number(liquidity);
  if (!Number.isFinite(out)) {
    throw new CoreError('NOT_FINITE', 'liquidity does not fit in a double', liquidity.toString());
  }
  return out;
}

/**
 * Guard for anything about to become an SVG attribute.
 *
 * d3 scales — and visx, which wraps them — return `undefined` for a band scale
 * out of domain and `NaN` for a continuous scale given a non-number, and both
 * land in the DOM as an attribute the browser silently drops.
 */
export function finite(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
