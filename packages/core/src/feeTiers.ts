/**
 * Fee tiers and tick spacing.
 *
 * The predecessor derived spacing as `feeTier / 50`, which happens to be right
 * for 500/3000/10000 and wrong for the 0.01% tier (gives 2, actual is 1). It is
 * also wrong in principle: governance can enable arbitrary (fee, spacing) pairs,
 * so a value reported by the pool always beats the table.
 */
import { CoreError } from './errors.js';

export type FeeTier = number;

/** Tiers enabled on the canonical factory, plus the ones forks commonly add. */
const CANONICAL_TICK_SPACING: ReadonlyMap<number, number> = new Map([
  [100, 1],
  [200, 4],
  [400, 8],
  [500, 10],
  [3000, 60],
  [10000, 200],
]);

/**
 * @param declared - `tickSpacing` as reported by the pool or subgraph. Always
 *                   wins over the table when present, because the pool is the
 *                   authority on its own spacing.
 * @throws CoreError('UNKNOWN_FEE_TIER') when neither source yields a value.
 */
export function tickSpacingFor(feeTier: FeeTier, declared?: number): number {
  if (declared !== undefined) {
    if (!Number.isInteger(declared) || declared <= 0) {
      throw new CoreError('UNKNOWN_FEE_TIER', 'declared tick spacing must be a positive integer', {
        feeTier,
        declared,
      });
    }
    return declared;
  }

  const known = CANONICAL_TICK_SPACING.get(feeTier);
  if (known === undefined) {
    throw new CoreError(
      'UNKNOWN_FEE_TIER',
      `no tick spacing known for fee tier ${feeTier}; pass the pool's declared tickSpacing`,
      feeTier,
    );
  }
  return known;
}

/** The pool's fee as a fraction: tier 3000 -> 0.003. */
export function feeFraction(feeTier: FeeTier): number {
  if (!Number.isInteger(feeTier) || feeTier <= 0) {
    throw new CoreError('UNKNOWN_FEE_TIER', 'fee tier must be a positive integer', feeTier);
  }
  return feeTier / 1_000_000;
}

/** Read-only view of the table, for tests and UI affordances. */
export function knownFeeTiers(): ReadonlyMap<number, number> {
  return CANONICAL_TICK_SPACING;
}
