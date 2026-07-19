import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONSTANT_COUNT,
  computeTickConstants,
  renderTickConstants,
} from '../../scripts/gen-tick-constants.js';
import { TICK_CONSTANTS } from '../../src/tickMath.constants.js';

const Q128 = 1n << 128n;

describe('tick constants', () => {
  it('matches a fresh run of the generator, byte for byte', () => {
    const committed = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/tickMath.constants.ts'),
      'utf8',
    );
    expect(committed).toBe(renderTickConstants());
  });

  it('covers every bit of the maximum |tick|', () => {
    // |tick| <= 887272 < 2^20. One constant short and high ticks silently
    // lose a factor; one too many is harmless but means the bound moved.
    expect(CONSTANT_COUNT).toBe(20);
    expect(TICK_CONSTANTS).toHaveLength(20);
    expect(887272).toBeLessThan(2 ** CONSTANT_COUNT);
  });

  /**
   * Independent oracle for the bits whose exponent is a whole number:
   * C[i] = round(2^128 / 1.0001^(2^(i-1))) = round(2^128 * 10000^n / 10001^n),
   * an exact rational needing no square root and no fixed-point iteration.
   * If the generator's iterated squaring ever drifts, this catches it.
   */
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('bit %i equals the exact rational', (i) => {
    const n = BigInt(2 ** (i - 1));
    const num = Q128 * 10000n ** n;
    const den = 10001n ** n;
    const nearest = (num + den / 2n) / den;
    expect(TICK_CONSTANTS[i]).toBe(nearest);
  });

  it('bit 0 equals the exact integer square root form', () => {
    // C[0] = round(2^128 / sqrt(1.0001)) = round(sqrt(2^256 * 10000 / 10001))
    const target = ((1n << 256n) * 10000n) / 10001n;
    let x = 1n << 129n;
    for (;;) {
      const next = (x + target / x) >> 1n;
      if (next >= x) break;
      x = next;
    }
    // x is floor(sqrt(...)); the committed value is that or one above it.
    const bit0 = TICK_CONSTANTS[0];
    expect(bit0).toBeDefined();
    expect(bit0 === x || bit0 === x + 1n).toBe(true);
  });

  it('is strictly decreasing — each constant is a larger negative power', () => {
    const cs = computeTickConstants();
    for (let i = 1; i < cs.length; i++) {
      const prev = cs[i - 1];
      const current = cs[i];
      expect(prev).toBeDefined();
      expect(current).toBeDefined();
      expect((current as bigint) < (prev as bigint)).toBe(true);
    }
  });

  it('is nearest-rounded, not floored', () => {
    // The distinction is load-bearing: a floored table drifts from pool state.
    // Bit 1 is the cheapest witness — floor gives …2139, nearest gives …213a.
    expect(TICK_CONSTANTS[1]).toBe(0xfff97272373d413259a46990580e213an);
    expect((Q128 * 10000n) / 10001n).toBe(0xfff97272373d413259a46990580e2139n);
  });
});
