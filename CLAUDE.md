# PoolLab

Uniswap V3 LP strategy simulator and backtester. Greenfield — **not** a fork.

## Layout

| Path | What |
|---|---|
| `packages/core` | All domain math. Pure TypeScript, **zero runtime dependencies**, no DOM, no network. |
| `apps/api` | Allowlisted GraphQL proxy to The Graph. Hono on Cloudflare Workers. |
| `apps/web` | Vite + React SPA. TanStack Router (URL state) + Query (server state) + visx (charts). |

One Worker serves both the SPA and `/api` (`apps/api/wrangler.toml`, `run_worker_first`).

## Non-negotiable rules

1. **No math outside `packages/core`.** If a component computes a price, a tick, or a
   token amount, it belongs in core with a test.
2. **No BigInt→float conversion outside `convert.ts`.** A quantity crosses the boundary
   exactly once, as late as possible, and never crosses back.
3. **A failing golden test gets investigated, never regenerated.** The oracle is an
   independent `decimal.js` implementation, not our own past output. Disagreement means
   one of the two is wrong.
4. **Core throws, never degrades.** No `NaN`, no `0` meaning "couldn't compute", no `null`
   in place of a number. `CoreError` with a code, or a value.
5. **`GRAPH_API_KEY` never leaves `apps/api`.** CI greps the built bundle for it.

## Why the math is being rewritten

The predecessor (`~/projects/uniswap-v3-simulator`) computed everything in `Number`:

- `parseInt()` on a uint256 `feeGrowthGlobalX128` discards ~205 bits, and `feeGrowthGlobal`
  wraps mod 2^256 by design — a float cannot represent either fact.
- `Math.pow(1.0001, tick)` does not agree with on-chain `sqrtPriceX96` near the boundaries.
- `tickSpacing = feeTier / 50` is correct for the 0.05/0.3/1% tiers and **wrong for 0.01%**.
- Real pools carry `L ≈ 1e21…1e25`; a double loses whole tokens at that magnitude.

It is also legally unforkable: upstream (DefiLab-xyz) ships no license at all, so the domain
math there is all-rights-reserved. Everything here is reimplemented from the Uniswap V3
whitepaper and the core contracts' published behavior.

## Tick constants

`src/tickMath.constants.ts` is **generated**, not transcribed. `scripts/gen-tick-constants.ts`
computes `floor(1.0001^(-2^i/2) · 2^128)` from first principles at 256-bit working precision.
A test re-runs the generator and asserts the committed file is byte-identical. Do not hand-edit.

`getTickAtSqrtRatio` is a binary search over `getSqrtRatioAtTick`, not a port of the contract's
log2 approximation. The approximation exists because gas costs money; we are in a browser, and
21 iterations of obviously-correct code is worth more than the microseconds.

## Testing layers

| Layer | Runs | What it proves |
|---|---|---|
| Property (`fast-check`) | every PR | Invariants: round-trips, monotonicity, never-over-mint, IL ≤ 0. |
| Golden | every PR | Agreement with an independent `decimal.js` oracle at 60 digits. |
| Differential (`@uniswap/v3-sdk`) | every PR | Exact integer agreement with the reference SDK. |
| On-chain fixtures | nightly | `getTickAtSqrtRatio(slot0.sqrtPriceX96) === slot0.tick` on real pools. |

`@uniswap/v3-sdk` and `decimal.js` are **test-only oracles**. Biome forbids importing them from
`packages/core/src/**`; CI asserts they are absent from core's production dependency graph.

Web tests check data, not rendering. No SVG path snapshots.

## Data layer facts worth not rediscovering

- The client sends `{chain, op, variables}` — **never GraphQL text**. An open GraphQL proxy on
  your own Graph key is a free faucet for anyone who opens the Network tab.
- **GET, not POST**, so the edge CDN can cache with per-operation TTLs.
- The subgraph ID resolves on the **(chain, op) pair**, not on chain alone. `feeGrowthGlobal*X128`
  is absent from the official Uniswap schema; only patched forks expose it, and those forks in
  turn lack `ticks`. bnb and unichain each need two deployments.
- Rank pools by **`volumeUSD`, not TVL**. TVL is inflatable via `derivedETH` — the Base top-8 was
  once entirely fake pools with $1–3.5B TVL and near-zero volume.
- The Graph gateway returns **`200 OK` with `{errors: [...]}`** for a dead or unsynced subgraph.
  That is a `502 UPSTREAM_GRAPHQL`, not empty data. `{data: {pools: []}}` is a successful empty
  result and must stay distinguishable — conflating them turns a broken deployment into an
  eternal spinner.

## Charts

visx wraps the same d3 scales and inherits their behavior: a scale returns `undefined` (band,
out of domain) or `NaN` (continuous, non-numeric input), and that lands straight in an SVG
attribute. Route every coordinate through the `finite()` helper.
