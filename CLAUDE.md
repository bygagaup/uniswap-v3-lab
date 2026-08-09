# PoolLab

Uniswap V3 LP strategy simulator and backtester. Greenfield — **not** a fork.

## Layout

| Path | What |
|---|---|
| `packages/core` | All domain math. Pure TypeScript, **zero runtime dependencies**, no DOM, no network. |
| `apps/api` | Allowlisted GraphQL proxy to The Graph. Hono on Cloudflare Workers. |
| `apps/web` | Vite + React SPA. TanStack Router (URL state) + Query (server state) + visx (charts). |

One Worker serves both the SPA and `/api` (`apps/api/wrangler.toml`, `run_worker_first`).

`CONTEXT.md` is the glossary — what the words mean. `docs/adr/` holds the decisions and
why they were made. The rules below are the rules; where one has a reason worth the
space, it links to the ADR carrying it.

## Non-negotiable rules

1. **No math outside `packages/core`.** If a component computes a price, a tick, or a
   token amount, it belongs in core with a test.
2. **No BigInt→float conversion outside `convert.ts`.** A quantity crosses the boundary
   exactly once, as late as possible, and never crosses back. Why BigInt at all:
   [ADR-0001](docs/adr/0001-bigint-through-the-core.md).
3. **A failing golden test gets investigated, never regenerated.** The oracle is an
   independent `decimal.js` implementation, not our own past output. Disagreement means
   one of the two is wrong.
4. **Core throws, never degrades.** No `NaN`, no `0` meaning "couldn't compute", no `null`
   in place of a number. `CoreError` with a code, or a value.
5. **`GRAPH_API_KEY` never leaves `apps/api`.** CI greps the built bundle for it.
6. **Unsuffixed value fields are in the quote token; `Usd` means dollars.** The two never
   mix in one sum, and USD amounts carry the `HumanUsd` type. See "Numéraire" in
   `CONTEXT.md`.

## Traps that look like details

- `Math.pow(1.0001, tick)` does not agree with on-chain `sqrtPriceX96` near the boundaries.
- `tickSpacing = feeTier / 50` is correct for the 0.05/0.3/1% tiers and **wrong for 0.01%**.
- `feeGrowthGlobal` wraps mod 2^256 by design, so a position's earnings come from the
  *difference* between two readings, never from either alone.
- "Active share" is an estimate from a candle's tick span, not measured time in range.
  Do not relabel it as time.

Everything here is implemented from the Uniswap V3 whitepaper and the core contracts' published
behavior. MIT-licensed — see `LICENSE`.

## Tick math

`src/tickMath.constants.ts` is **generated**, not transcribed — do not hand-edit it, regenerate
with `scripts/gen-tick-constants.ts`. **The rounding mode is load-bearing:** the table is rounded
to *nearest*, not floored, and a floored table drifts from real pool state. Why, and how it is
verified: [ADR-0002](docs/adr/0002-generated-tick-constants-rounded-to-nearest.md).

`getSqrtRatioAtTick` reproduces the pool's bit-decomposition *including its rounding*, because
pool and position state is defined by that result — a "more accurate" value would disagree with
the chain, which is the wrong kind of correct.

`getTickAtSqrtRatio` is a binary search, and **accepts `sqrtPriceX96 === MAX_SQRT_RATIO`, which
the pool and the SDK both reject.** That is deliberate: it makes the tick round-trip total.
`test/differential/v3-sdk.test.ts` pins it as a decision, not a drift —
[ADR-0003](docs/adr/0003-total-tick-math.md).

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

- The client sends `{chain, op, variables}` — **never GraphQL text** — and the proxy answers on
  **GET, not POST**. Adding a query is a server-side change.
  [ADR-0004](docs/adr/0004-the-proxy-takes-operation-names-over-get.md).
- The subgraph ID resolves on the **(chain, op) pair**, not on chain alone: fees come from one
  deployment, pools and ticks from another, and Arbitrum's fee deployment is our own.
  [ADR-0005](docs/adr/0005-subgraph-resolves-on-chain-and-operation.md).
- **Never rank pools by TVL, and never by `volumeUSD` alone** — the first is inflatable, the
  second reads `0` for genuine pools on the fork subgraphs. Order by `txCount`, then re-rank by
  USD reconstructed in `packages/core/src/usd.ts`.
  [ADR-0006](docs/adr/0006-rank-by-txcount-and-reconstruct-usd.md).
- The Graph gateway returns **`200 OK` with `{errors: [...]}`** for a dead or unsynced subgraph.
  That is a `502 UPSTREAM_GRAPHQL`, not empty data. `{data: {pools: []}}` is a successful empty
  result and must stay distinguishable — conflating them turns a broken deployment into an
  eternal spinner.

## Charts

visx wraps the same d3 scales and inherits their behavior: a scale returns `undefined` (band,
out of domain) or `NaN` (continuous, non-numeric input), and that lands straight in an SVG
attribute. Route every coordinate through the `finite()` helper.
