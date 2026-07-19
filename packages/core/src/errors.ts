/**
 * Core never returns NaN, never returns 0 to mean "couldn't compute", and never
 * returns null in place of a number. It returns a value or it throws.
 */
export type CoreErrorCode =
  | 'TICK_OUT_OF_RANGE'
  | 'SQRT_RATIO_OUT_OF_RANGE'
  | 'INVALID_RANGE'
  | 'UNKNOWN_FEE_TIER'
  | 'NEGATIVE_AMOUNT'
  | 'CANDLES_NOT_ASCENDING'
  | 'GRID_MISMATCH'
  | 'UNREPRESENTABLE_POSITION'
  | 'NOT_FINITE';

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly detail: unknown;

  constructor(code: CoreErrorCode, message: string, detail?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'CoreError';
    this.code = code;
    this.detail = detail;
  }
}

export function invariant(
  condition: boolean,
  code: CoreErrorCode,
  message: string,
  detail?: unknown,
): asserts condition {
  if (!condition) throw new CoreError(code, message, detail);
}
