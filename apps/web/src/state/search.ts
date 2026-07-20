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
});

export type Search = z.infer<typeof searchSchema>;

/** For TanStack Router's `validateSearch`: never throws, always yields a valid shape. */
export function parseSearch(input: Record<string, unknown>): Search {
  const result = searchSchema.safeParse(input);
  return result.success ? result.data : { chain: 'ethereum' };
}
