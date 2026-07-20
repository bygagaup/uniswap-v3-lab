import {
  clipDensity,
  concentrationIndex,
  type DensityBar,
  finite,
  Liquidity,
  liquidityDensity,
  type Tick,
} from '@poollab/core';
import { scaleLinear } from '@visx/scale';
import { useMemo, useState } from 'react';
import type { TickRow } from '../api/ticks.js';
import { formatPrice } from '../lib/format.js';
import type { StrategyModel } from '../lib/model.js';

const HEIGHT = 220;
const MARGIN = { top: 12, right: 16, bottom: 28, left: 16 };

export function DensityChart({
  model,
  ticks,
  poolLiquidity,
  width,
}: {
  model: StrategyModel;
  ticks: readonly TickRow[];
  /** The pool's reported active liquidity, to seed a windowed tick set. */
  poolLiquidity: string;
  width: number;
}) {
  // Zoom is a half-width in ticks around the current tick; the buttons scale it.
  const spacing = model.scale.pool.tickSpacing;
  const rangeWidth = Math.max(model.range.upper - model.range.lower, spacing * 4);
  const [zoom, setZoom] = useState(2);

  const bars = useMemo(() => {
    const parsed = ticks
      .map((t) => ({ tickIdx: Number(t.tickIdx), liquidityNet: t.liquidityNet }))
      .sort((a, b) => a.tickIdx - b.tickIdx);
    if (parsed.length < 2) return [];
    return liquidityDensity({
      scale: model.scale,
      ticks: parsed,
      currentTick: model.currentTick,
      currentSqrtPrice: model.currentSqrtPrice,
      // Seed with the pool's live liquidity so a truncated (first-1000) tick set
      // reconstructs correctly outward from the current price.
      activeLiquidity: Liquidity.of(poolLiquidity),
    });
  }, [ticks, model.scale, model.currentTick, model.currentSqrtPrice, poolLiquidity]);

  const window = {
    lower: (model.currentTick - rangeWidth * zoom) as Tick,
    upper: (model.currentTick + rangeWidth * zoom) as Tick,
  };
  const visible = clipDensity(bars, window);
  const concentration = concentrationIndex(bars, {
    lower: model.range.lower,
    upper: model.range.upper,
  });

  if (visible.length === 0) {
    return <p className="placeholder">No tick liquidity available for this pool.</p>;
  }

  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  // Price is antitonic to tick in one orientation, so a bar's price bounds can
  // be either way round; use min/max for a stable x mapping.
  const priceOf = (bar: DensityBar) => [
    Math.min(bar.priceLower, bar.priceUpper),
    Math.max(bar.priceLower, bar.priceUpper),
  ];
  const minPrice = Math.min(...visible.map((b) => priceOf(b)[0] as number));
  const maxPrice = Math.max(...visible.map((b) => priceOf(b)[1] as number));
  const yMax = Math.max(...visible.map((b) => Number(b.liquidity)));

  const x = scaleLinear({ domain: [minPrice, maxPrice], range: [0, innerW] });
  const y = scaleLinear({ domain: [0, yMax], range: [innerH, 0] });

  const rangeLoPrice = Math.min(model.lowerPrice, model.upperPrice);
  const rangeHiPrice = Math.max(model.lowerPrice, model.upperPrice);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {(concentration * 100).toFixed(0)}% of liquidity in your range
        </span>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <button
            type="button"
            className="chip"
            onClick={() => setZoom((z) => Math.max(0.5, z / 1.5))}
          >
            +
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => setZoom((z) => Math.min(20, z * 1.5))}
          >
            −
          </button>
        </span>
      </div>

      <svg width={width} height={HEIGHT} role="img" aria-label="Liquidity density by price">
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* selected range band */}
          <rect
            x={finite(x(rangeLoPrice))}
            y={0}
            width={Math.max(finite(x(rangeHiPrice)) - finite(x(rangeLoPrice)), 0)}
            height={innerH}
            fill="var(--accent)"
            opacity={0.1}
          />

          {/* bars */}
          {visible.map((bar) => {
            const [lo, hi] = priceOf(bar);
            const bx = finite(x(lo as number));
            const bw = Math.max(finite(x(hi as number)) - bx, 0.5);
            const h = finite(y(0)) - finite(y(Number(bar.liquidity)));
            const belowPrice = (bar.tickUpper as number) <= model.currentTick;
            return (
              <rect
                key={bar.tickLower}
                x={bx}
                y={finite(y(Number(bar.liquidity)))}
                width={Math.max(bw - 0.5, 0.5)}
                height={Math.max(h, 0)}
                fill={
                  bar.isActive
                    ? 'var(--accent)'
                    : belowPrice
                      ? 'var(--positive)'
                      : 'var(--text-muted)'
                }
                opacity={bar.isActive ? 0.9 : 0.55}
              />
            );
          })}

          {/* current price */}
          <line
            x1={finite(x(model.entryPrice))}
            x2={finite(x(model.entryPrice))}
            y1={0}
            y2={innerH}
            stroke="var(--text)"
            strokeDasharray="2 3"
            opacity={0.6}
          />

          {x.ticks(5).map((p) => (
            <text
              key={p}
              x={finite(x(p))}
              y={innerH + 18}
              textAnchor="middle"
              fontSize={11}
              fill="var(--text-muted)"
            >
              {formatPrice(p)}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}
