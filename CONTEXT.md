# PoolLab

A Uniswap V3 liquidity-provider strategy simulator and backtester. The domain is
concentrated liquidity: what a range position holds, what it is worth across the price
curve, and what it would have earned over real pool history.

This is the glossary. Rules for the code live in `CLAUDE.md`; decisions and their
reasoning live in `docs/adr/`.

## Position and sizing

**Notional**:
The size of an LP position at entry, in quote tokens, before any leverage.
_Avoid_: size, capital, equity (equity is a different quantity — see below)

**Equity**:
The capital actually committed: position value net of the debt taken on to lever it,
plus any hedge PnL. Under leverage `L`, equity is `notional / L`.
_Avoid_: value, margin, own funds

**Position value**:
What a position holds, valued in the quote token, gross — before any debt is deducted.
A `CurvePoint.value` is this; a `LeveredPoint.equity` is not.
_Avoid_: worth, NAV

**Leverage**:
The multiplier between equity and notional. `1` means unlevered, and an unlevered
position has no margin ratio at all rather than an infinite one.

**Hedge**:
A directional perp overlay carried alongside the position, sized by its own notional
and leverage. A short flattens upside and offsets downside IL; a long amplifies both.

**Margin ratio**:
Equity as a fraction of gross position value. Absent (not infinite, not zero) when
there is no debt.

**Liquidation band**:
A contiguous span of prices over which the margin ratio sits at or below the
maintenance margin.

## Prices and ranges

**Price scale**:
The decision, made once per view, of which token prices are quoted in — base, quote,
and the decimals that go with them. Every module that touches price takes one as a
parameter rather than deciding for itself.

**Base token / Quote token**:
Denominator and numerator of the quoted price. "USDC per WETH" has base WETH, quote
USDC. Distinct from `token0`/`token1`, which are the pool's own ordering and never
change.
_Avoid_: token0/token1 as synonyms for base/quote

**Tick range**:
A pair of ticks, lower below upper. One type in three roles, named by role:
**Position range** (what the position holds), **Comparison range** (a second range
overlaid to compare against), **Density window** (the tick span a chart is clipped to).
_Avoid_: S1, S2, band, window used bare

**Price grid**:
The shared ascending set of prices every curve is sampled at. Two curves from one grid
are pointwise comparable by construction; two curves from different grids are not.

## Curves

**Strategy**:
A position actually held in a pool — a V3 range position, or the V2 unbounded position
(which is a full-range V3 one). Something that could be minted.

**Baseline**:
A comparison held instead of an LP position, never minted: holding the base token,
holding the quote token, or a 50/50 split. Drawn on the same axes as a strategy so the
comparison is direct.
_Avoid_: strategy, benchmark

**Curve kind**:
The tag selecting which curve to sample — a strategy or a baseline. One union covers
both because one function draws them all on one grid.

**Simulation model**:
Everything computed for one set of user inputs: every curve, the IL series, the levered
overlay, the comparison range. Not "one strategy" — it is the whole view.
_Avoid_: strategy model

**Impermanent loss**:
LP value against the value of the entry basket simply held, as a signed fraction ≤ 0,
exactly 0 at the entry price. Relative, so independent of position size.

## Backtest

**Active share**:
The fraction of a window a position was earning fees, in basis points. **Estimated, not
measured**: an hourly candle gives only high and low, so the true path is unknown, and
this is the share of the candle's tick span that overlaps the range. It is not time.
_Avoid_: time in range, uptime

**Fee growth**:
The pool's cumulative per-unit-liquidity fee counter. Grows monotonically and wraps mod
2^256 by design, so a position's earnings come from the *difference* between two
readings, never from either alone.

**Numéraire**:
What a figure is denominated in. Unsuffixed value fields are in the **quote token**; a
`Usd` suffix means US dollars, carried by the `HumanUsd` type. The two never mix in one
sum.

## Pools and data

**Pool key**:
The identity and geometry of a pool — address, both tokens with their decimals, fee
tier, tick spacing. Derived once from a subgraph record; the rest of the core never
sees a subgraph shape.

**Operation**:
A named, allowlisted query the proxy will run. Clients ask for an operation by name and
supply variables; they never send GraphQL text.

**Deployment**:
A specific subgraph serving a chain. A chain needs more than one when no single
deployment carries everything: fee growth from a patched fork, pools and ticks from the
official one.

**Capability**:
What a chain can actually do, derived from which deployments are configured for it. A
chain with no fee-growth deployment cannot be backtested, and the UI greys the control
out instead of failing at query time.
