import { HumanPrice, roundTick, type Tick, tickAtPrice } from '@poollab/core';
import { useMemo } from 'react';
import type { Pool } from '../api/types.js';
import { formatPrice, formatUsd } from '../lib/format.js';
import { buildModel, type ModelInput } from '../lib/model.js';
import { useWidth } from '../lib/useWidth.js';
import { ILChart } from './ILChart.js';
import { PayoffChart } from './PayoffChart.js';
import { PoolOverview } from './PoolOverview.js';

export interface StrategyHandlers {
  onNotional: (n: number) => void;
  onRange: (lower: number, upper: number) => void;
  onToggleInvert: () => void;
}

export function StrategyView({
  pool,
  input,
  handlers,
}: {
  pool: Pool;
  input: ModelInput;
  handlers: StrategyHandlers;
}) {
  // Destructure so the memo depends on primitives, not the input object identity
  // (which changes every render). Hooks all run before any early return.
  const { notional, lower, upper, inverted } = input;
  const result = useMemo(
    () => buildModel(pool, { notional, lower, upper, inverted }),
    [pool, notional, lower, upper, inverted],
  );
  const [payoffRef, payoffWidth] = useWidth<HTMLDivElement>();
  const [ilRef, ilWidth] = useWidth<HTMLDivElement>();

  if (!result.ok) {
    return (
      <>
        <PoolOverview pool={pool} />
        <section className="card">
          <p className="error" role="alert">
            {result.error}
          </p>
        </section>
      </>
    );
  }

  const model = result.model;

  // Two boundary prices -> ticks, snapped to spacing, ordered. Works in either
  // orientation because the ordering is resolved in tick space, not price space.
  const commitPrices = (priceA: number, priceB: number) => {
    const spacing = model.scale.pool.tickSpacing;
    const toTick = (p: number) =>
      roundTick(tickAtPrice(model.scale, HumanPrice.of(Math.max(p, 1e-18))), spacing, 'nearest');
    const t1 = toTick(priceA);
    const t2 = toTick(priceB);
    const lower = Math.min(t1, t2) as Tick;
    const upper = Math.max(t1, t2) as Tick;
    if (lower === upper) return;
    handlers.onRange(lower, upper);
  };

  const onDragCommit = (edge: 'lower' | 'upper', price: number) => {
    const otherPrice = edge === 'lower' ? model.upperPrice : model.lowerPrice;
    commitPrices(price, otherPrice);
  };

  const minPrice = Math.min(model.lowerPrice, model.upperPrice);
  const maxPrice = Math.max(model.lowerPrice, model.upperPrice);
  const ratio0Pct = Math.round(model.split.ratio0 * 100);

  return (
    <>
      <PoolOverview pool={pool} />

      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Strategy</h2>
          <button type="button" className="chip" onClick={handlers.onToggleInvert}>
            Price in {model.quoteSymbol} ⇄
          </button>
        </div>

        <div className="strategy-controls">
          <label>
            <span className="label">Position size ({model.quoteSymbol})</span>
            <input
              type="number"
              className="search-input"
              min={1}
              value={model.notional}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0) handlers.onNotional(n);
              }}
            />
          </label>
          <label>
            <span className="label">Min price</span>
            <input
              type="number"
              className="search-input"
              value={Number(minPrice.toPrecision(6))}
              onChange={(e) => {
                const p = Number(e.target.value);
                if (p > 0) commitPrices(p, maxPrice);
              }}
            />
          </label>
          <label>
            <span className="label">Max price</span>
            <input
              type="number"
              className="search-input"
              value={Number(maxPrice.toPrecision(6))}
              onChange={(e) => {
                const p = Number(e.target.value);
                if (p > 0) commitPrices(minPrice, p);
              }}
            />
          </label>
        </div>

        {/* token split at entry */}
        <div style={{ marginTop: 14 }}>
          <div className="label" style={{ marginBottom: 4 }}>
            Deposit at entry
          </div>
          <div className="split-bar" title={`${ratio0Pct}% ${pool.token0.symbol}`}>
            <span style={{ width: `${ratio0Pct}%` }} className="split-0" />
            <span style={{ width: `${100 - ratio0Pct}%` }} className="split-1" />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {ratio0Pct}% {pool.token0.symbol} · {100 - ratio0Pct}% {pool.token1.symbol}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>
          Payoff · {formatUsd(model.notional, false)} at {formatPrice(model.entryPrice)}{' '}
          {model.quoteSymbol}/{model.baseSymbol}
        </h2>
        <div ref={payoffRef}>
          <PayoffChart model={model} width={payoffWidth} onRangeCommit={onDragCommit} />
        </div>
      </section>

      <section className="card">
        <h2>Impermanent loss vs. HODL</h2>
        <div ref={ilRef}>
          <ILChart model={model} width={ilWidth} />
        </div>
      </section>
    </>
  );
}
