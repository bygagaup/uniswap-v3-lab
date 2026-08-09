import {
  CoreError,
  finite,
  type HourResult,
  HumanUsd,
  runBacktest,
  summarize,
} from '@poollab/core';
import { scaleLinear } from '@visx/scale';
import { useMemo } from 'react';
import { useHours } from '../api/hours.js';
import type { ChainSlug, Pool } from '../api/types.js';
import { formatUsd } from '../lib/format.js';
import type { SimulationModel } from '../lib/model.js';
import { useWidth } from '../lib/useWidth.js';

function Tile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'pos' | 'neg';
  hint?: string;
}) {
  return (
    <div className="stat-tile" title={hint}>
      <div className="label">{label}</div>
      <div
        className="value"
        style={tone ? { color: tone === 'pos' ? 'var(--positive)' : 'var(--danger)' } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

const HEIGHT = 200;
const MARGIN = { top: 12, right: 16, bottom: 26, left: 64 };

function CumulativeFeeChart({ rows, width }: { rows: readonly HourResult[]; width: number }) {
  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const t0 = rows[0]?.timestamp ?? 0;
  const tN = rows[rows.length - 1]?.timestamp ?? 1;
  const x = scaleLinear({ domain: [t0, tN], range: [0, innerW] });
  const yMax = Math.max(...rows.map((r) => r.cumulativeFeeValue), 1) * 1.05;
  const y = scaleLinear({ domain: [0, yMax], range: [innerH, 0] });

  const line = rows
    .map(
      (r, i) =>
        `${i === 0 ? 'M' : 'L'} ${finite(x(r.timestamp))} ${finite(y(r.cumulativeFeeValue))}`,
    )
    .join(' ');
  const area = `${line} L ${finite(x(tN))} ${finite(y(0))} L ${finite(x(t0))} ${finite(y(0))} Z`;

  return (
    <svg
      width={width}
      height={HEIGHT}
      role="img"
      aria-label="Cumulative fees over the backtest window"
    >
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {y.ticks(4).map((v) => (
          <g key={v} transform={`translate(0,${finite(y(v))})`}>
            <line x1={0} x2={innerW} stroke="var(--border)" />
            <text x={-8} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-muted)">
              {formatUsd(v, false)}
            </text>
          </g>
        ))}
        {x.ticks(5).map((t) => (
          <text
            key={t}
            x={finite(x(t))}
            y={innerH + 18}
            textAnchor="middle"
            fontSize={11}
            fill="var(--text-muted)"
          >
            {new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </text>
        ))}
        <path d={area} fill="var(--accent)" opacity={0.12} />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} />
      </g>
    </svg>
  );
}

export function BacktestView({
  chain,
  pool,
  model,
  canBacktest,
}: {
  chain: ChainSlug;
  pool: Pool;
  model: SimulationModel;
  canBacktest: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const hours = useHours(chain, pool.id, canBacktest);

  type Result =
    | { kind: 'ok'; rows: readonly HourResult[]; summary: ReturnType<typeof summarize> }
    | { kind: 'error'; message: string }
    | null;

  const result = useMemo<Result>(() => {
    if (!hours.data || hours.data.length < 2) return null;
    try {
      const rows = runBacktest({
        scale: model.scale,
        position: model.position,
        candles: hours.data,
        currentSqrtPrice: model.currentSqrtPrice,
        tvl: {
          // Throws a CoreError on a subgraph figure that isn't a usable amount;
          // the catch below turns that into a message rather than a NaN chart.
          usd: HumanUsd.of(Number(pool.totalValueLockedUSD)),
          token0: Number(pool.totalValueLockedToken0),
          token1: Number(pool.totalValueLockedToken1),
        },
      });
      return { kind: 'ok', rows, summary: summarize(rows) };
    } catch (error) {
      if (error instanceof CoreError) return { kind: 'error', message: error.message };
      throw error;
    }
  }, [hours.data, model.scale, model.position, model.currentSqrtPrice, pool]);

  return (
    <section className="card">
      <h2>Backtest · last 30 days</h2>
      <div ref={ref}>
        {!canBacktest && (
          <p className="placeholder muted">
            Backtesting isn’t available on {chain} — this chain has no fee-growth data.
          </p>
        )}
        {canBacktest && hours.isPending && <p className="placeholder">Running backtest…</p>}
        {canBacktest && hours.isError && (
          <p className="placeholder error" role="alert">
            Could not load hourly data for this pool.
          </p>
        )}
        {result?.kind === 'error' && <p className="placeholder error">{result.message}</p>}
        {result?.kind === 'ok' && (
          <>
            <div className="stat-grid" style={{ marginBottom: 14 }}>
              <Tile
                label="Fee APR"
                value={`${(result.summary.apr * 100).toFixed(1)}%`}
                tone="pos"
                hint="Fee ROI annualised over the backtest window. Fees only — excludes price movement."
              />
              <Tile
                label="Fees earned"
                value={formatUsd(result.summary.feeUsd, false)}
                hint="Total swap fees the position would have earned over the last 30 days."
              />
              <Tile
                label="Fee ROI"
                value={`${(result.summary.feeRoi * 100).toFixed(2)}%`}
                hint="Fees earned as a fraction of the position's value at the start of the window."
              />
              <Tile
                label="Active share"
                value={`${(result.summary.avgActiveBps / 100).toFixed(0)}%`}
                hint="Share of the window the position earned fees, estimated from how much of each hourly candle's tick span fell inside the range — not measured time."
              />
              <Tile
                label="Total return"
                value={`${(result.summary.totalReturn * 100).toFixed(2)}%`}
                tone={result.summary.totalReturn >= 0 ? 'pos' : 'neg'}
                hint="Fees plus the change in the position's asset value over the window."
              />
            </div>
            <CumulativeFeeChart rows={result.rows} width={width} />
          </>
        )}
      </div>
    </section>
  );
}
