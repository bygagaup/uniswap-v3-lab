/**
 * Generates `src/tickMath.constants.ts`.
 *
 * The tick-math bit-decomposition needs, for each bit i of |tick|:
 *
 *     C[i] = round(2^128 / 1.0001^(2^i / 2))
 *
 * Round to NEAREST, not floor: the on-chain table is nearest-rounded, and the
 * two differ for many bits (bit 1 is 0x…213a nearest vs 0x…2139 floored). A
 * floored table would drift from real pool state, so the rounding mode here is
 * load-bearing, not cosmetic. `test/property/tickMath.constants.test.ts` pins
 * it against exactly-computed rationals.
 *
 * These are computed here from the definition at 1024-bit working precision.
 * They are NOT transcribed from any contract source — this script is our
 * expression of the whitepaper formula, and the committed table is its output.
 * `test/property/tickMath.constants.test.ts` re-runs the generator and asserts
 * the committed file is byte-identical, so the table cannot drift by hand.
 *
 * Run: pnpm --filter @poollab/core gen:ticks
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Working precision. Twenty iterated squarings each lose under an ulp, so at
 * 1024 bits the accumulated error sits ~870 bits below the 128 we emit — the
 * rounding of every constant is unambiguous. (512 bits produces an identical
 * table; the headroom is there so nobody has to redo this analysis.)
 */
const PRECISION_BITS = 1024n;
const SCALE = 1n << PRECISION_BITS;
const Q128 = 1n << 128n;

/** |tick| <= 887272 < 2^20, so twenty bits cover every representable tick. */
export const CONSTANT_COUNT = 20;

/** Integer square root, Newton's method. Exact floor for any non-negative n. */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt of negative');
  if (n < 2n) return n;
  // Seed from the bit length so Newton converges in a handful of steps.
  let x = 1n << (BigInt(n.toString(2).length) / 2n + 1n);
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) break;
    x = next;
  }
  return x;
}

export function computeTickConstants(): bigint[] {
  // sqrt(1.0001) in fixed point: floor(sqrt(1.0001 * SCALE^2)).
  let x = isqrt((SCALE * SCALE * 10001n) / 10000n);

  const constants: bigint[] = [];
  for (let i = 0; i < CONSTANT_COUNT; i++) {
    // x == 1.0001^(2^i / 2) * SCALE; adding x/2 before dividing rounds to nearest.
    constants.push((Q128 * SCALE + x / 2n) / x);
    x = (x * x) / SCALE;
  }
  return constants;
}

function render(constants: readonly bigint[]): string {
  const entries = constants
    .map((c, i) => `  0x${c.toString(16)}n, // bit ${i}: round(2^128 / 1.0001^(2^${i}/2))`)
    .join('\n');

  return `// GENERATED FILE — do not edit by hand.
// Produced by scripts/gen-tick-constants.ts; a test asserts this file matches
// a fresh run of that generator. To change it, change the generator.

/** C[i] = round(2^128 / 1.0001^(2^i / 2)), for each bit i of |tick|. */
export const TICK_CONSTANTS: readonly bigint[] = [
${entries}
];
`;
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tickMath.constants.ts');

export function renderTickConstants(): string {
  return render(computeTickConstants());
}

// Only write when run directly, so tests can import the generator functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(outPath, renderTickConstants());
  process.stdout.write(`wrote ${outPath}\n`);
}
