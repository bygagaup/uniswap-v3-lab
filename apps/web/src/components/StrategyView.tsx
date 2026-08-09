import { HumanPrice, priceAtTick, roundTick, type Tick, tickAtPrice } from '@poollab/core';
import { useEffect, useMemo, useState } from 'react';
import { useTicks } from '../api/ticks.js';
import type { ChainSlug, Pool } from '../api/types.js';
import { formatPrice, formatUsd } from '../lib/format.js';
import { buildModel, type ModelInput } from '../lib/model.js';
import { useWidth } from '../lib/useWidth.js';
import { BacktestView } from './BacktestView.js';
import { DensityChart } from './DensityChart.js';
import { ILChart } from './ILChart.js';
import { PayoffChart } from './PayoffChart.js';
import { PoolOverview } from './PoolOverview.js';

/** The safe price band of a levered position, or null if it never liquidates. */
function liquidationRange(model: {
  levered: {
    segments: readonly { liquidated: boolean; points: readonly { price: number }[] }[];
  } | null;
}): string | null {
  if (!model.levered) return null;
  const anyLiquidated = model.levered.segments.some((s) => s.liquidated);
  if (!anyLiquidated) return null;
  const safe = model.levered.segments.filter((s) => !s.liquidated).flatMap((s) => s.points);
  if (safe.length === 0) return 'liquidated across the whole range';
  const lo = Math.min(...safe.map((p) => p.price));
  const hi = Math.max(...safe.map((p) => p.price));
  return `${formatPrice(lo)} – ${formatPrice(hi)}`;
}

export interface StrategyHandlers {
  onNotional: (n: number) => void;
  onRange: (lower: number, upper: number) => void;
  onToggleInvert: () => void;
  onLeverage: (lev: number) => void;
  onHedge: (side: 'none' | 'long' | 'short') => void;
  /** null clears the comparison range. */
  onCompare: (range: { lower: number; upper: number } | null) => void;
}

export function StrategyView({
  chain,
  pool,
  input,
  handlers,
  canBacktest,
}: {
  chain: ChainSlug;
  pool: Pool;
  input: ModelInput;
  handlers: StrategyHandlers;
  canBacktest: boolean;
}) {
  // Destructure so the memo depends on primitives, not the input object identity
  // (which changes every render). Hooks all run before any early return.
  const {
    notional,
    lower,
    upper,
    inverted,
    leverage = 1,
    hedgeSide = 'none',
    hedgePct = 0.5,
    lower2,
    upper2,
  } = input;
  const result = useMemo(
    () =>
      buildModel(pool, {
        notional,
        lower,
        upper,
        inverted,
        leverage,
        hedgeSide,
        hedgePct,
        lower2,
        upper2,
      }),
    [pool, notional, lower, upper, inverted, leverage, hedgeSide, hedgePct, lower2, upper2],
  );
  const [payoffRef, payoffWidth] = useWidth<HTMLDivElement>();
  const [ilRef, ilWidth] = useWidth<HTMLDivElement>();
  const [densityRef, densityWidth] = useWidth<HTMLDivElement>();
  const ticksQuery = useTicks(chain, pool.id, result.ok ? result.model.currentTick : 0, true);

  const [draftMin, setDraftMin] = useState<string | null>(null);
  const [draftMax, setDraftMax] = useState<string | null>(null);
  const [draftMin2, setDraftMin2] = useState<string | null>(null);
  const [draftMax2, setDraftMax2] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pool.id is the intended trigger — switching pools discards any half-typed price drafts.
  useEffect(() => {
    setDraftMin(null);
    setDraftMax(null);
    setDraftMin2(null);
    setDraftMax2(null);
  }, [pool.id]);

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

  // Adjust a price up or down by exactly one tick spacing.
  const adjustPrice = (currentPrice: number, direction: 1 | -1): number => {
    const spacing = model.scale.pool.tickSpacing;
    const tick = tickAtPrice(model.scale, HumanPrice.of(Math.max(currentPrice, 1e-18)));
    const snapped = roundTick(tick, spacing, 'nearest');
    // When orientation is inverted (token0PerToken1), higher tick = lower price.
    const dir = model.scale.orientation === 'token0PerToken1' ? -direction : direction;
    const newTick = (snapped + dir * spacing) as Tick;
    return priceAtTick(model.scale, newTick);
  };

  const onDragCommit = (edge: 'lower' | 'upper', price: number) => {
    const otherPrice = edge === 'lower' ? model.upperPrice : model.lowerPrice;
    commitPrices(price, otherPrice);
    setDraftMin(null);
    setDraftMax(null);
  };

  // Comparison range: convert two prices to snapped, ordered ticks.
  const commitCompare = (priceA: number, priceB: number) => {
    const spacing = model.scale.pool.tickSpacing;
    const toTick = (p: number) =>
      roundTick(tickAtPrice(model.scale, HumanPrice.of(Math.max(p, 1e-18))), spacing, 'nearest');
    const t1 = toTick(priceA);
    const t2 = toTick(priceB);
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    if (lo !== hi) handlers.onCompare({ lower: lo, upper: hi });
  };

  const toggleCompare = () => {
    if (model.compare) {
      handlers.onCompare(null);
    } else {
      // Default the comparison range wider than the position range, so it says something.
      const width = model.range.upper - model.range.lower;
      const mid = (model.range.lower + model.range.upper) / 2;
      handlers.onCompare({
        lower: Math.round(mid - width),
        upper: Math.round(mid + width),
      });
    }
    setDraftMin2(null);
    setDraftMax2(null);
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
          <div className="field">
            <label htmlFor="s1-min" className="label">
              Min price
            </label>
            <span className="input-with-step">
              <button
                type="button"
                className="step-btn"
                onClick={() => {
                  commitPrices(adjustPrice(minPrice, -1), maxPrice);
                  setDraftMin(null);
                }}
                aria-label="Decrease min price"
              >
                −
              </button>
              <input
                id="s1-min"
                type="text"
                inputMode="decimal"
                className="search-input"
                value={draftMin ?? String(Number(minPrice.toPrecision(10)))}
                onChange={(e) => setDraftMin(e.target.value)}
                onBlur={() => {
                  if (draftMin === null) return;
                  const p = Number(draftMin);
                  if (Number.isFinite(p) && p > 0) commitPrices(p, maxPrice);
                  setDraftMin(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draftMin !== null) {
                    e.preventDefault();
                    const p = Number(draftMin);
                    if (Number.isFinite(p) && p > 0) commitPrices(p, maxPrice);
                    setDraftMin(null);
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    commitPrices(adjustPrice(minPrice, 1), maxPrice);
                    setDraftMin(null);
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    commitPrices(adjustPrice(minPrice, -1), maxPrice);
                    setDraftMin(null);
                  }
                }}
              />
              <button
                type="button"
                className="step-btn"
                onClick={() => {
                  commitPrices(adjustPrice(minPrice, 1), maxPrice);
                  setDraftMin(null);
                }}
                aria-label="Increase min price"
              >
                +
              </button>
            </span>
          </div>
          <div className="field">
            <label htmlFor="s1-max" className="label">
              Max price
            </label>
            <span className="input-with-step">
              <button
                type="button"
                className="step-btn"
                onClick={() => {
                  commitPrices(minPrice, adjustPrice(maxPrice, -1));
                  setDraftMax(null);
                }}
                aria-label="Decrease max price"
              >
                −
              </button>
              <input
                id="s1-max"
                type="text"
                inputMode="decimal"
                className="search-input"
                value={draftMax ?? String(Number(maxPrice.toPrecision(10)))}
                onChange={(e) => setDraftMax(e.target.value)}
                onBlur={() => {
                  if (draftMax === null) return;
                  const p = Number(draftMax);
                  if (Number.isFinite(p) && p > 0) commitPrices(minPrice, p);
                  setDraftMax(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draftMax !== null) {
                    e.preventDefault();
                    const p = Number(draftMax);
                    if (Number.isFinite(p) && p > 0) commitPrices(minPrice, p);
                    setDraftMax(null);
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    commitPrices(minPrice, adjustPrice(maxPrice, 1));
                    setDraftMax(null);
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    commitPrices(minPrice, adjustPrice(maxPrice, -1));
                    setDraftMax(null);
                  }
                }}
              />
              <button
                type="button"
                className="step-btn"
                onClick={() => {
                  commitPrices(minPrice, adjustPrice(maxPrice, 1));
                  setDraftMax(null);
                }}
                aria-label="Increase max price"
              >
                +
              </button>
            </span>
          </div>
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

        {/* leverage + hedge */}
        <div className="strategy-controls" style={{ marginTop: 14 }}>
          <label>
            <span className="label">Leverage · {model.leverage.toFixed(1)}×</span>
            <input
              type="range"
              min={1}
              max={10}
              step={0.5}
              value={model.leverage}
              onChange={(e) => handlers.onLeverage(Number(e.target.value))}
              aria-label="Leverage"
            />
          </label>
          <label>
            <span className="label">Hedge</span>
            <select
              className="search-input"
              value={model.hedge.side}
              onChange={(e) => handlers.onHedge(e.target.value as 'none' | 'long' | 'short')}
            >
              <option value="none">None</option>
              <option value="short">Short {model.baseSymbol}</option>
              <option value="long">Long {model.baseSymbol}</option>
            </select>
          </label>
          {model.levered && (
            <div>
              <span className="label">Liquidates outside</span>
              <div style={{ marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
                {liquidationRange(model) ?? <span className="muted">— safe across range</span>}
              </div>
            </div>
          )}
        </div>

        {/* comparison range */}
        <div style={{ marginTop: 14 }}>
          <button type="button" className="chip" onClick={toggleCompare}>
            {model.compare ? 'Remove comparison range' : '+ Compare a second range'}
          </button>
          {model.compare && (
            <div className="strategy-controls" style={{ marginTop: 10 }}>
              <div className="field">
                <label htmlFor="s2-min" className="label">
                  Comparison min price
                </label>
                <span className="input-with-step">
                  <button
                    type="button"
                    className="step-btn"
                    onClick={() => {
                      const cmp = model.compare;
                      if (!cmp) return;
                      const p = Math.min(cmp.lowerPrice, cmp.upperPrice);
                      const other = Math.max(cmp.lowerPrice, cmp.upperPrice);
                      commitCompare(adjustPrice(p, -1), other);
                      setDraftMin2(null);
                    }}
                    aria-label="Decrease comparison min price"
                  >
                    −
                  </button>
                  <input
                    id="s2-min"
                    type="text"
                    inputMode="decimal"
                    className="search-input"
                    value={
                      draftMin2 ??
                      String(
                        Number(
                          Math.min(model.compare.lowerPrice, model.compare.upperPrice).toPrecision(
                            10,
                          ),
                        ),
                      )
                    }
                    onChange={(e) => setDraftMin2(e.target.value)}
                    onBlur={() => {
                      if (draftMin2 === null) return;
                      const p = Number(draftMin2);
                      const other = Math.max(
                        model.compare?.lowerPrice ?? 0,
                        model.compare?.upperPrice ?? 0,
                      );
                      if (Number.isFinite(p) && p > 0) commitCompare(p, other);
                      setDraftMin2(null);
                    }}
                    onKeyDown={(e) => {
                      const cmp = model.compare;
                      if (!cmp) return;
                      const p = Math.min(cmp.lowerPrice, cmp.upperPrice);
                      const other = Math.max(cmp.lowerPrice, cmp.upperPrice);
                      if (e.key === 'Enter' && draftMin2 !== null) {
                        e.preventDefault();
                        const val = Number(draftMin2);
                        if (Number.isFinite(val) && val > 0) commitCompare(val, other);
                        setDraftMin2(null);
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        commitCompare(adjustPrice(p, 1), other);
                        setDraftMin2(null);
                      }
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        commitCompare(adjustPrice(p, -1), other);
                        setDraftMin2(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="step-btn"
                    onClick={() => {
                      const cmp = model.compare;
                      if (!cmp) return;
                      const p = Math.min(cmp.lowerPrice, cmp.upperPrice);
                      const other = Math.max(cmp.lowerPrice, cmp.upperPrice);
                      commitCompare(adjustPrice(p, 1), other);
                      setDraftMin2(null);
                    }}
                    aria-label="Increase comparison min price"
                  >
                    +
                  </button>
                </span>
              </div>
              <div className="field">
                <label htmlFor="s2-max" className="label">
                  Comparison max price
                </label>
                <span className="input-with-step">
                  <button
                    type="button"
                    className="step-btn"
                    onClick={() => {
                      const cmp = model.compare;
                      if (!cmp) return;
                      const p = Math.max(cmp.lowerPrice, cmp.upperPrice);
                      const other = Math.min(cmp.lowerPrice, cmp.upperPrice);
                      commitCompare(other, adjustPrice(p, -1));
                      setDraftMax2(null);
                    }}
                    aria-label="Decrease comparison max price"
                  >
                    −
                  </button>
                  <input
                    id="s2-max"
                    type="text"
                    inputMode="decimal"
                    className="search-input"
                    value={
                      draftMax2 ??
                      String(
                        Number(
                          Math.max(model.compare.lowerPrice, model.compare.upperPrice).toPrecision(
                            10,
                          ),
                        ),
                      )
                    }
                    onChange={(e) => setDraftMax2(e.target.value)}
                    onBlur={() => {
                      if (draftMax2 === null) return;
                      const p = Number(draftMax2);
                      const other = Math.min(
                        model.compare?.lowerPrice ?? 0,
                        model.compare?.upperPrice ?? 0,
                      );
                      if (Number.isFinite(p) && p > 0) commitCompare(other, p);
                      setDraftMax2(null);
                    }}
                    onKeyDown={(e) => {
                      const cmp = model.compare;
                      if (!cmp) return;
                      const p = Math.max(cmp.lowerPrice, cmp.upperPrice);
                      const other = Math.min(cmp.lowerPrice, cmp.upperPrice);
                      if (e.key === 'Enter' && draftMax2 !== null) {
                        e.preventDefault();
                        const val = Number(draftMax2);
                        if (Number.isFinite(val) && val > 0) commitCompare(other, val);
                        setDraftMax2(null);
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        commitCompare(other, adjustPrice(p, 1));
                        setDraftMax2(null);
                      }
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        commitCompare(other, adjustPrice(p, -1));
                        setDraftMax2(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="step-btn"
                    onClick={() => {
                      const cmp = model.compare;
                      if (!cmp) return;
                      const p = Math.max(cmp.lowerPrice, cmp.upperPrice);
                      const other = Math.min(cmp.lowerPrice, cmp.upperPrice);
                      commitCompare(other, adjustPrice(p, 1));
                      setDraftMax2(null);
                    }}
                    aria-label="Increase comparison max price"
                  >
                    +
                  </button>
                </span>
              </div>
            </div>
          )}
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
        <h2>Liquidity density</h2>
        <div ref={densityRef}>
          {ticksQuery.isPending && <p className="placeholder">Loading tick liquidity…</p>}
          {ticksQuery.isError && (
            <p className="placeholder muted">Tick liquidity is unavailable for this pool.</p>
          )}
          {ticksQuery.isSuccess && (
            <DensityChart
              model={model}
              ticks={ticksQuery.data.ticks}
              poolLiquidity={pool.liquidity}
              width={densityWidth}
            />
          )}
        </div>
      </section>

      <BacktestView chain={chain} pool={pool} model={model} canBacktest={canBacktest} />

      <section className="card">
        <h2>Impermanent loss vs. HODL</h2>
        <div ref={ilRef}>
          <ILChart model={model} width={ilWidth} />
        </div>
      </section>
    </>
  );
}
