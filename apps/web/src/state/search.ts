/**
 * All simulation state lives in the URL, validated here. This is the single
 * source of truth the predecessor's six Redux slices turn out to be: server
 * data is TanStack Query's, everything the user chooses is a search param, and
 * a shared link reproduces the exact view for free.
 */
import { z } from 'zod';
import type { ChainSlug } from '../api/types.js';

const CHAINS: readonly ChainSlug[] = [
  'ethereum',
  'polygon',
  'base',
  'optimism',
  'arbitrum',
  'bnb',
  'unichain',
];

export const searchSchema = z.object({
  chain: z.enum(CHAINS as [ChainSlug, ...ChainSlug[]]).default('ethereum'),
  /** Selected pool address, lowercased. Absent until one is chosen. */
  pool: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((s) => s.toLowerCase())
    .optional(),
  /** Free-text search in the pool picker. */
  q: z.string().max(64).optional(),
  /** Position size in quote-token units. */
  notional: z.coerce.number().positive().max(1e12).default(10_000),
  /** Range boundaries as ticks. Absent until a pool defaults them. */
  lower: z.coerce.number().int().optional(),
  upper: z.coerce.number().int().optional(),
  /** Invert the price orientation (flip which token the axis is priced in). */
  inv: z.coerce.boolean().default(false),
  /** Leverage multiplier on the position (1 = unlevered). */
  lev: z.coerce.number().min(1).max(20).default(1),
  /** Perp hedge side. */
  hedge: z.enum(['none', 'long', 'short']).default('none'),
  /** Hedge notional as a fraction of position size (0..2). */
  hedgePct: z.coerce.number().min(0).max(2).default(0.5),
});

export type Search = z.infer<typeof searchSchema>;

/** For TanStack Router's `validateSearch`: never throws, always yields a valid shape. */
export function parseSearch(input: Record<string, unknown>): Search {
  const result = searchSchema.safeParse(input);
  // Garbage falls back to the schema's own defaults, so the returned shape is
  // always complete (notional, inv, …) — never a partial object.
  return result.success ? result.data : searchSchema.parse({});
}
