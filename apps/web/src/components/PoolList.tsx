import type { Pool } from '../api/types.js';
import { formatFeeTier, formatUsd, pairLabel } from '../lib/format.js';

function dailyVolume(pool: Pool): string {
  const today = pool.poolDayData?.[0];
  return today ? formatUsd(today.volumeUSD) : '—';
}

export function PoolList({
  pools,
  selectedId,
  onSelect,
}: {
  pools: readonly Pool[];
  selectedId: string | undefined;
  onSelect: (pool: Pool) => void;
}) {
  if (pools.length === 0) {
    return <p className="placeholder">No pools found.</p>;
  }

  return (
    <ul className="pool-list">
      {pools.map((pool) => (
        <li key={pool.id}>
          <button
            type="button"
            className="pool-row"
            aria-current={pool.id === selectedId}
            onClick={() => onSelect(pool)}
          >
            <span className="pair">{pairLabel(pool)}</span>
            <span className="fee">{formatFeeTier(pool.feeTier)}</span>
            <span className="stat" title="24h volume">
              {dailyVolume(pool)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
