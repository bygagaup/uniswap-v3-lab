import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/errors.js';
import {
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  roundTick,
} from '../../src/tickMath.js';
import { MAX_TICK, MIN_TICK, type SqrtPriceX96, type Tick } from '../../src/units.js';

const anyTick = fc.integer({ min: MIN_TICK, max: MAX_TICK }).map((t) => t as Tick);
const anySqrtRatio = fc
  .bigInt({ min: MIN_SQRT_RATIO, max: MAX_SQRT_RATIO })
  .map((v) => v as SqrtPriceX96);
const anySpacing = fc.constantFrom(1, 4, 8, 10, 60, 200);

describe('getSqrtRatioAtTick', () => {
  it('is strictly monotonic in tick', () => {
    fc.assert(
      fc.property(anyTick, anyTick, (a, b) => {
        fc.pre(a !== b);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        expect(getSqrtRatioAtTick(lo) < getSqrtRatioAtTick(hi)).toBe(true);
      }),
    );
  });

  it('stays within the representable sqrt-ratio band', () => {
    fc.assert(
      fc.property(anyTick, (t) => {
        const r = getSqrtRatioAtTick(t);
        expect(r >= MIN_SQRT_RATIO).toBe(true);
        expect(r <= MAX_SQRT_RATIO).toBe(true);
      }),
    );
  });

  it('pins the band endpoints exactly', () => {
    expect(getSqrtRatioAtTick(MIN_TICK as Tick)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MAX_TICK as Tick)).toBe(MAX_SQRT_RATIO);
  });

  it('puts tick 0 at exactly 1.0 (2^96)', () => {
    expect(getSqrtRatioAtTick(0 as Tick)).toBe(1n << 96n);
  });
});

describe('getTickAtSqrtRatio', () => {
  it('round-trips every tick', () => {
    fc.assert(
      fc.property(anyTick, (t) => {
        expect(getTickAtSqrtRatio(getSqrtRatioAtTick(t))).toBe(t);
      }),
    );
  });

  it('sandwiches any sqrt ratio between its tick and the next', () => {
    fc.assert(
      fc.property(anySqrtRatio, (sqrtP) => {
        const t = getTickAtSqrtRatio(sqrtP);
        expect(getSqrtRatioAtTick(t) <= sqrtP).toBe(true);
        if (t < MAX_TICK) {
          expect(sqrtP < getSqrtRatioAtTick((t + 1) as Tick)).toBe(true);
        }
      }),
    );
  });

  it('rejects ratios outside the band rather than clamping', () => {
    expect(() => getTickAtSqrtRatio((MIN_SQRT_RATIO - 1n) as SqrtPriceX96)).toThrow(CoreError);
    expect(() => getTickAtSqrtRatio((MAX_SQRT_RATIO + 1n) as SqrtPriceX96)).toThrow(CoreError);
  });
});

describe('roundTick', () => {
  it('always lands on a multiple of the spacing', () => {
    fc.assert(
      fc.property(
        anyTick,
        anySpacing,
        fc.constantFrom('nearest', 'down', 'up' as const),
        (t, s, mode) => {
          // `===` rather than toBe: `-1 % 1` is -0, which toBe rejects against +0.
          expect(roundTick(t, s, mode as 'nearest' | 'down' | 'up') % s === 0).toBe(true);
        },
      ),
    );
  });

  it('never moves a tick by more than one spacing', () => {
    fc.assert(
      fc.property(anyTick, anySpacing, (t, s) => {
        expect(Math.abs(roundTick(t, s, 'nearest') - t)).toBeLessThanOrEqual(s);
      }),
    );
  });

  it('orders down <= nearest <= up', () => {
    fc.assert(
      fc.property(anyTick, anySpacing, (t, s) => {
        const down = roundTick(t, s, 'down');
        const up = roundTick(t, s, 'up');
        const near = roundTick(t, s, 'nearest');
        expect(down).toBeLessThanOrEqual(near);
        expect(near).toBeLessThanOrEqual(up);
      }),
    );
  });

  it('stays inside the representable band even when snapping outward', () => {
    fc.assert(
      fc.property(anySpacing, (s) => {
        expect(roundTick(MIN_TICK as Tick, s, 'down')).toBeGreaterThanOrEqual(MIN_TICK);
        expect(roundTick(MAX_TICK as Tick, s, 'up')).toBeLessThanOrEqual(MAX_TICK);
      }),
    );
  });

  it('rejects a non-positive spacing rather than dividing by zero', () => {
    expect(() => roundTick(0 as Tick, 0)).toThrow(CoreError);
    expect(() => roundTick(0 as Tick, -60)).toThrow(CoreError);
  });
});
