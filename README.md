# PoolLab

A Uniswap V3 liquidity-provider strategy simulator and backtester.

Pick a pool on any supported chain, set a price range and position size, and see what the
position would be worth across the price curve — against HODL baselines and an unbounded V2
position — plus a backtest over hourly data showing accrued fees, fee APR, and active share.

## Status

Feature-complete to parity with the predecessor: pool selection across seven chains, payoff
curves (V3 range, V2 unbounded, HODL, a second comparison range), impermanent-loss curve,
liquidity-density depth chart, a 30-day fee backtest, and a leverage/hedge overlay with
liquidation bands. All simulation state lives in the URL, so any view is shareable.

See `CLAUDE.md` for architecture and the rules the code is held to.

## Layout

```
packages/core   domain math — pure TypeScript, zero dependencies
apps/api        allowlisted GraphQL proxy (Hono on Cloudflare Workers)
apps/web        Vite + React SPA
```

## Develop

Requires Node 22.23.1 (see `.tool-versions`) and pnpm via corepack.

```sh
pnpm install
pnpm --filter @poollab/api dev     # Worker on :8787
pnpm --filter @poollab/web dev     # Vite on :5173, proxying /api to the Worker
```

```sh
pnpm test         # property + golden + differential, all offline
pnpm typecheck
pnpm lint
```

## Deploy

One Worker serves the SPA and the API.

```sh
pnpm --filter @poollab/api exec wrangler secret put GRAPH_API_KEY
pnpm deploy
```

## Provenance

The domain math is an independent implementation derived from the
[Uniswap V3 whitepaper](https://uniswap.org/whitepaper-v3.pdf) and the published behavior of the
core contracts — quantities that overflow a double (`sqrtPriceX96`, `feeGrowthGlobalX128`,
liquidity) are computed in BigInt end to end.

## License

MIT — see `LICENSE`.
