/**
 * Display formatting only. No arithmetic that belongs in core lives here — this
 * turns already-computed numbers into strings a human reads.
 */
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
});

const USD_EXACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatUsd(value: string | number, compact = true): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return (compact ? USD : USD_EXACT).format(n);
}

/** A price with a sensible number of significant figures across many magnitudes. */
export function formatPrice(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n <= 0) return '—';
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { maximumSignificantDigits: Math.max(digits, 1) });
}

/** Fee tier (parts per million) as a percentage: "3000" -> "0.3%". */
export function formatFeeTier(feeTier: string | number): string {
  const n = typeof feeTier === 'string' ? Number(feeTier) : feeTier;
  if (!Number.isFinite(n)) return '—';
  return `${(n / 10_000).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`;
}

export function pairLabel(pool: {
  token0: { symbol: string };
  token1: { symbol: string };
}): string {
  return `${pool.token0.symbol} / ${pool.token1.symbol}`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
