import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/errors.js';
import {
  MAX_SQRT_RATIO_VALUE,
  MAX_TICK,
  MIN_SQRT_RATIO_VALUE,
  MIN_TICK,
  Raw,
  SqrtPriceX96,
  Tick,
  UINT256_MAX,
} from '../../src/units.js';

describe('Tick.of', () => {
  it('accepts every tick in range and round-trips the value', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_TICK, max: MAX_TICK }), (n) => {
        expect(Tick.of(n)).toBe(n);
      }),
    );
  });

  it('rejects out-of-range and non-integer ticks', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: MAX_TICK + 1, max: Number.MAX_SAFE_INTEGER }),
          fc.integer({ min: Number.MIN_SAFE_INTEGER, max: MIN_TICK - 1 }),
          fc.double({ min: -1000, max: 1000, noInteger: true, noNaN: true }),
        ),
        (n) => {
          expect(() => Tick.of(n)).toThrow(CoreError);
        },
      ),
    );
  });
});

describe('SqrtPriceX96.of', () => {
  it('accepts bigints and their decimal-string form identically', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: MIN_SQRT_RATIO_VALUE, max: MAX_SQRT_RATIO_VALUE }), (v) => {
        expect(SqrtPriceX96.of(v)).toBe(SqrtPriceX96.of(v.toString()));
      }),
    );
  });

  it('rejects values outside the representable sqrt-ratio band', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.bigInt({ min: 0n, max: MIN_SQRT_RATIO_VALUE - 1n }),
          fc.bigInt({ min: MAX_SQRT_RATIO_VALUE + 1n, max: UINT256_MAX }),
        ),
        (v) => {
          expect(() => SqrtPriceX96.of(v)).toThrow(CoreError);
        },
      ),
    );
  });
});

describe('Raw.of', () => {
  it('never loses precision on values far above Number.MAX_SAFE_INTEGER', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: UINT256_MAX }), (v) => {
        expect(Raw.of(v.toString())).toBe(v);
      }),
    );
  });

  it('rejects malformed strings rather than coercing them', () => {
    for (const bad of ['', '1.5', '0x10', '1e18', ' 1', 'abc']) {
      expect(() => Raw.of(bad)).toThrow(CoreError);
    }
  });
});
