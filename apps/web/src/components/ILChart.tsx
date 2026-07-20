import { finite } from '@poollab/core';
import { scaleLinear } from '@visx/scale';
import { formatPrice } from '../lib/format.js';
import type { StrategyModel } from '../lib/model.js';

const HEIGHT = 160;
const MARGIN = { top: 12, right: 16, bottom: 28, left: 64 };

export function ILChart({ model, width }: { model: StrategyModel; width: number }) {
  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const prices = model.grid.prices;
  const x = scaleLinear({
    domain: [prices[0] as number, prices[prices.length - 1] as number],
    range: [0, innerW],
  });
  // IL is ≤ 0; the y domain runs from the worst loss up to 0.
  const worst = Math.min(0, ...model.il.map((p) => p.value));
  const y = scaleLinear({ domain: [worst * 1.1, 0], range: [innerH, 0] });

  const area = `${model.il
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${finite(x(p.price))} ${finite(y(p.value))}`)
    .join(' ')} L ${finite(x(prices[prices.length - 1] as number))} ${finite(y(0))} L ${finite(
    x(prices[0] as number),
  )} ${finite(y(0))} Z`;

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  return (
    <svg width={width} height={HEIGHT} role="img" aria-label="Impermanent loss across price">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {y.ticks(3).map((v) => (
          <g key={v} transform={`translate(0,${finite(y(v))})`}>
            <line x1={0} x2={innerW} stroke="var(--border)" />
            <text x={-8} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-muted)">
              {pct(v)}
            </text>
          </g>
        ))}
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
        <path d={area} fill="var(--danger)" opacity={0.15} />
        <path
          d={model.il
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${finite(x(p.price))} ${finite(y(p.value))}`)
            .join(' ')}
          fill="none"
          stroke="var(--danger)"
          strokeWidth={1.5}
        />
        <line
          x1={finite(x(model.entryPrice))}
          x2={finite(x(model.entryPrice))}
          y1={0}
          y2={innerH}
          stroke="var(--text)"
          strokeDasharray="2 3"
          opacity={0.5}
        />
      </g>
    </svg>
  );
}
