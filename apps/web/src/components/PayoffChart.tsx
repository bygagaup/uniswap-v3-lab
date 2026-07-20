import { finite } from '@poollab/core';
import { scaleLinear } from '@visx/scale';
import { useRef, useState } from 'react';
import { formatPrice, formatUsd } from '../lib/format.js';
import type { StrategyModel } from '../lib/model.js';

const HEIGHT = 340;
const MARGIN = { top: 16, right: 16, bottom: 34, left: 64 };

type Edge = 'lower' | 'upper';

/** Points to an SVG path `d`, guarding every coordinate through finite(). */
function linePath(
  points: readonly { price: number; value: number }[],
  x: (p: number) => number,
  y: (v: number) => number,
): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${finite(x(p.price))} ${finite(y(p.value))}`)
    .join(' ');
}

export function PayoffChart({
  model,
  width,
  onRangeCommit,
}: {
  model: StrategyModel;
  width: number;
  onRangeCommit: (edge: Edge, price: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ edge: Edge; price: number } | null>(null);

  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const prices = model.grid.prices;
  const xDomain: [number, number] = [prices[0] as number, prices[prices.length - 1] as number];

  const leveredValues = model.levered ? model.levered.curve.map((p) => p.value) : [];
  const compareValues = model.compare ? model.compare.curve.map((p) => p.value) : [];
  const allValues = [
    ...model.curves.v3,
    ...model.curves.v2,
    ...model.curves.hodl5050,
    ...model.curves.hodlBase,
  ]
    .map((p) => p.value)
    .concat(leveredValues, compareValues);
  const yMax = Math.max(...allValues) * 1.05;
  // The levered equity curve can go negative (toward liquidation); give it room.
  const yMin = Math.min(0, ...leveredValues);

  const x = scaleLinear({ domain: xDomain, range: [0, innerW] });
  const y = scaleLinear({ domain: [yMin, yMax], range: [innerH, 0] });

  const priceAtX = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return model.entryPrice;
    const px = clientX - rect.left - MARGIN.left;
    return x.invert(Math.max(0, Math.min(innerW, px)));
  };

  const lowerX = finite(x(drag?.edge === 'lower' ? drag.price : model.lowerPrice));
  const upperX = finite(x(drag?.edge === 'upper' ? drag.price : model.upperPrice));

  const startDrag = (edge: Edge) => (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ edge, price: edge === 'lower' ? model.lowerPrice : model.upperPrice });
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag({ edge: drag.edge, price: priceAtX(e.clientX) });
  };
  const endDrag = () => {
    if (!drag) return;
    onRangeCommit(drag.edge, drag.price);
    setDrag(null);
  };

  const gridTicks = x.ticks(5);
  const valueTicks = y.ticks(4);

  const curves: {
    key: keyof StrategyModel['curves'];
    color: string;
    dash?: string;
    label: string;
  }[] = [
    { key: 'v3', color: 'var(--accent)', label: `V3 range` },
    { key: 'v2', color: 'var(--text-muted)', label: 'V2 unbounded' },
    { key: 'hodl5050', color: 'var(--positive)', dash: '5 4', label: 'HODL 50/50' },
  ];

  return (
    <div>
      <svg
        ref={svgRef}
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Payoff of a ${model.notional} ${model.quoteSymbol} position across ${model.baseSymbol} price`}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        style={{ touchAction: 'none' }}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* liquidation bands: price spans where the levered equity is wiped out */}
          {model.levered?.segments
            .filter((seg) => seg.liquidated && seg.points.length > 0)
            .map((seg) => {
              const first = seg.points[0] as { price: number };
              const last = seg.points[seg.points.length - 1] as { price: number };
              const bx = finite(x(first.price));
              const bw = Math.max(finite(x(last.price)) - bx, 1);
              return (
                <rect
                  key={first.price}
                  x={bx}
                  y={0}
                  width={bw}
                  height={innerH}
                  fill="var(--danger)"
                  opacity={0.1}
                />
              );
            })}

          {/* second-range (S2) band, dimmer and behind */}
          {model.compare && (
            <rect
              x={Math.min(finite(x(model.compare.lowerPrice)), finite(x(model.compare.upperPrice)))}
              y={0}
              width={Math.abs(
                finite(x(model.compare.upperPrice)) - finite(x(model.compare.lowerPrice)),
              )}
              height={innerH}
              fill="var(--text-muted)"
              opacity={0.08}
            />
          )}

          {/* range band */}
          <rect
            x={Math.min(lowerX, upperX)}
            y={0}
            width={Math.abs(upperX - lowerX)}
            height={innerH}
            fill="var(--accent)"
            opacity={0.08}
          />

          {/* y grid + labels */}
          {valueTicks.map((v) => (
            <g key={v} transform={`translate(0,${finite(y(v))})`}>
              <line x1={0} x2={innerW} stroke="var(--border)" strokeWidth={1} />
              <text x={-8} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-muted)">
                {formatUsd(v)}
              </text>
            </g>
          ))}

          {/* x labels */}
          {gridTicks.map((p) => (
            <text
              key={p}
              x={finite(x(p))}
              y={innerH + 20}
              textAnchor="middle"
              fontSize={11}
              fill="var(--text-muted)"
            >
              {formatPrice(p)}
            </text>
          ))}

          {/* zero line, only drawn when the levered curve dips below it */}
          {yMin < 0 && (
            <line
              x1={0}
              x2={innerW}
              y1={finite(y(0))}
              y2={finite(y(0))}
              stroke="var(--border)"
              strokeWidth={1}
            />
          )}

          {/* curves */}
          {curves.map((c) => (
            <path
              key={c.key}
              d={linePath(
                model.curves[c.key],
                (p) => x(p),
                (v) => y(v),
              )}
              fill="none"
              stroke={c.color}
              strokeWidth={c.key === 'v3' ? 2.5 : 1.5}
              strokeDasharray={c.dash}
            />
          ))}

          {/* second-range (S2) payoff curve */}
          {model.compare && (
            <path
              d={linePath(
                model.compare.curve,
                (pp) => x(pp),
                (v) => y(v),
              )}
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth={2}
              strokeDasharray="6 3"
            />
          )}

          {/* leveraged equity overlay */}
          {model.levered && (
            <path
              d={linePath(
                model.levered.curve,
                (p) => x(p),
                (v) => y(v),
              )}
              fill="none"
              stroke="var(--danger)"
              strokeWidth={2}
            />
          )}

          {/* current price marker */}
          <line
            x1={finite(x(model.entryPrice))}
            x2={finite(x(model.entryPrice))}
            y1={0}
            y2={innerH}
            stroke="var(--text)"
            strokeWidth={1}
            strokeDasharray="2 3"
            opacity={0.5}
          />

          {/* draggable range handles */}
          {(['lower', 'upper'] as Edge[]).map((edge) => {
            const hx = edge === 'lower' ? lowerX : upperX;
            return (
              <g key={edge} transform={`translate(${hx},0)`} style={{ cursor: 'ew-resize' }}>
                <line y1={0} y2={innerH} stroke="var(--accent)" strokeWidth={2} />
                <rect
                  x={-8}
                  y={0}
                  width={16}
                  height={innerH}
                  fill="transparent"
                  onPointerDown={startDrag(edge)}
                  aria-label={`Drag ${edge} bound`}
                />
                <rect
                  x={-4}
                  y={innerH / 2 - 12}
                  width={8}
                  height={24}
                  rx={2}
                  fill="var(--accent)"
                />
              </g>
            );
          })}
        </g>
      </svg>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8, fontSize: 12 }}>
        {curves.map((c) => (
          <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 0,
                borderTop: `2px ${c.dash ? 'dashed' : 'solid'} ${c.color}`,
                display: 'inline-block',
              }}
            />
            <span className="muted">{c.label}</span>
          </span>
        ))}
        {model.compare && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 0,
                borderTop: '2px dashed var(--text-muted)',
                display: 'inline-block',
              }}
            />
            <span className="muted">V3 range S2</span>
          </span>
        )}
        {model.levered && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 0,
                borderTop: '2px solid var(--danger)',
                display: 'inline-block',
              }}
            />
            <span className="muted">
              Levered equity{model.leverage > 1 ? ` ${model.leverage}×` : ''}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
