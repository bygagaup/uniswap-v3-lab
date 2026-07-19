/**
 * Differential test against @uniswap/v3-sdk.
 *
 * The SDK is MIT-licensed, so using it as a test oracle is legitimate; it ships
 * in no production artifact. THIS FILE IS THE ONLY PLACE IT MAY BE IMPORTED —
 * Biome enforces that for `src/**`, and a packaging test asserts core declares
 * no runtime dependencies at all.
 *
 * These are integer functions. Agreement means exact equality, not "close".
 */
import { TickMath } from '@uniswap/v3-sdk';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TICK_CONSTANTS } from '../../src/tickMath.constants.js';
import { getSqrtRatioAtTick, getTickAtSqrtRatio } from '../../src/tickMath.js';
import { MAX_TICK, MIN_TICK, type Tick } from '../../src/units.js';

const anyTick = fc.integer({ min: MIN_TICK, max: MAX_TICK }).map((t) => t as Tick);

describe('tick math vs @uniswap/v3-sdk', () => {
  it('agrees on the tick bounds', () => {
    expect(MIN_TICK).toBe(TickMath.MIN_TICK);
    expect(MAX_TICK).toBe(TickMath.MAX_TICK);
  });

  it('agrees on the sqrt-ratio bounds', () => {
    expect(getSqrtRatioAtTick(MIN_TICK as Tick)).toBe(BigInt(TickMath.MIN_SQRT_RATIO.toString()));
    expect(getSqrtRatioAtTick(MAX_TICK as Tick)).toBe(BigInt(TickMath.MAX_SQRT_RATIO.toString()));
  });

  it('getSqrtRatioAtTick agrees exactly, for random ticks', () => {
    fc.assert(
      fc.property(anyTick, (t) => {
        expect(getSqrtRatioAtTick(t)).toBe(BigInt(TickMath.getSqrtRatioAtTick(t).toString()));
      }),
      { numRuns: 500 },
    );
  });

  it('getSqrtRatioAtTick agrees exactly, at every power-of-two boundary', () => {
    // The bit decomposition is where a wrong constant hides; exercise each bit
    // alone and each carry between adjacent bits.
    const ticks = new Set<number>([0, 1, -1, MIN_TICK, MAX_TICK]);
    for (let i = 0; i < TICK_CONSTANTS.length; i++) {
      for (const candidate of [2 ** i, 2 ** i - 1, 2 ** i + 1]) {
        if (candidate <= MAX_TICK) {
          ticks.add(candidate);
          ticks.add(-candidate);
        }
      }
    }
    for (const t of ticks) {
      expect(getSqrtRatioAtTick(t as Tick)).toBe(BigInt(TickMath.getSqrtRatioAtTick(t).toString()));
    }
  });

  it('getTickAtSqrtRatio agrees exactly across the SDK’s domain', () => {
    fc.assert(
      // MAX_TICK is excluded deliberately — see the divergence test below.
      fc.property(
        fc.integer({ min: MIN_TICK, max: MAX_TICK - 1 }).map((t) => t as Tick),
        (t) => {
          const ratio = getSqrtRatioAtTick(t);
          const sdkTick = TickMath.getTickAtSqrtRatio(TickMath.getSqrtRatioAtTick(t));
          expect(getTickAtSqrtRatio(ratio)).toBe(sdkTick);
        },
      ),
      { numRuns: 500 },
    );
  });

  /**
   * A deliberate, documented divergence — not a bug, and not to be "fixed"
   * without replacing the reasoning below.
   *
   * The pool requires `sqrtPriceX96 < MAX_SQRT_RATIO`, and the SDK mirrors that,
   * because a live pool can never sit at the maximum ratio. We accept it, so
   * that `getTickAtSqrtRatio ∘ getSqrtRatioAtTick` is the identity over *every*
   * tick. That totality is what the round-trip property — and everything built
   * on it — relies on. A simulator evaluates the boundary; a pool never reaches it.
   */
  it('accepts MAX_SQRT_RATIO where the SDK rejects it', () => {
    const max = getSqrtRatioAtTick(MAX_TICK as Tick);
    expect(getTickAtSqrtRatio(max)).toBe(MAX_TICK);
    expect(() => TickMath.getTickAtSqrtRatio(TickMath.getSqrtRatioAtTick(MAX_TICK))).toThrow(
      /SQRT_RATIO/,
    );
  });
});
