# PoolLab

A Uniswap V3 liquidity-provider strategy simulator and backtester.

Pick a pool on any supported chain, set a price range and position size, and see what the
position would be worth across the price curve — against HODL baselines and an unbounded V2
position — plus a backtest over hourly data showing accrued fees, fee APR, and time in range.

## Status

Early. Milestone M0 (scaffold, tooling, CI, deploy) is in place; the math core and data layer
are being built. See `CLAUDE.md` for architecture and the rules the code is held to.

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

## Relationship to prior work

PoolLab is an independent reimplementation. It was informed by the author's earlier fork of
[DefiLab-xyz/uniswap-v3-simulator](https://github.com/DefiLab-xyz/uniswap-v3-simulator), but
shares no code with it: that project ships no license, so its domain math is all-rights-reserved.
Everything here derives from the [Uniswap V3 whitepaper](https://uniswap.org/whitepaper-v3.pdf)
and the published behavior of the core contracts.

## License

MIT — see `LICENSE`.
