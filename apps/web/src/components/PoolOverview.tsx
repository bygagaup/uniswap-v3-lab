import type { Pool } from '../api/types.js';
import { formatFeeTier, formatPrice, formatUsd, pairLabel, shortAddress } from '../lib/format.js';
import { currentPrice } from '../lib/pool.js';
import { dailyFeesUsd, dailyVolumeUsd } from '../lib/usd.js';

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function usdOrDash(value: number | null): string {
  return value === null ? '—' : formatUsd(value);
}

export function PoolOverview({ pool }: { pool: Pool }) {
  const today = pool.poolDayData?.[0];
  // Price is computed by core from sqrtPrice, not read from the subgraph's
  // derived field — the whole point of the rewrite is that this number is ours.
  const priceOfToken0 = currentPrice(pool, 'token1PerToken0');
  // Reconstructed when the fork subgraph reports 0; see lib/usd.ts.
  const volume = today ? dailyVolumeUsd(pool, today, pool.ethPriceUsd) : null;
  const fees = today ? dailyFeesUsd(pool, today, pool.ethPriceUsd) : null;

  return (
    <section className="card">
      <h2>Pool</h2>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 16 }}>
        <strong style={{ fontSize: 22 }}>{pairLabel(pool)}</strong>
        <span className="chip">{formatFeeTier(pool.feeTier)}</span>
        <span className="muted" title={pool.id}>
          {shortAddress(pool.id)}
        </span>
      </div>

      <div className="stat-grid">
        <Tile
          label={`Price of ${pool.token0.symbol}`}
          value={
            priceOfToken0 === null ? '—' : `${formatPrice(priceOfToken0)} ${pool.token1.symbol}`
          }
        />
        <Tile label="TVL" value={formatUsd(pool.totalValueLockedUSD)} />
        <Tile label="24h volume" value={usdOrDash(volume)} />
        <Tile label="24h fees" value={usdOrDash(fees)} />
      </div>
    </section>
  );
}
