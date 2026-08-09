# A subgraph is chosen by (chain, operation), not by chain

`feeGrowthGlobal0X128`/`1X128` are absent from Uniswap's own `PoolHourData` schema. The
deployments that expose them are patched forks, and those forks in turn tend to lack
`ticks` or to reject `pools(orderBy: volumeUSD)`. A sweep of 31 candidates in the Graph
registry found **no single deployment covering any chain completely**. So the subgraph ID
resolves on the (chain, operation) pair: fees come from one deployment, pools and ticks
from another.

Concretely: `bnb` has fee growth and ticks but refuses the ordering pool search runs on;
`unichain` has fee growth and no `ticks` entity at all; `optimism` takes fees from a
Messari fork. For `arbitrum` the registry had no candidate exposing fee growth at all, so
**we indexed our own deployment**. It answers `poolHourData` and nothing else — no Pool
fields, no ticks, no tokens — and serves exactly that one operation.

## Consequences

- Running our own deployment is an operational commitment: if it stops indexing,
  Arbitrum backtesting stops, and no registry alternative exists to fall back to.
- A chain's **capabilities** are derived from which deployments it has configured, so a
  chain with no fee-growth deployment greys out backtesting in the UI rather than failing
  at query time.
- Deployment IDs are deploy configuration, not bundle constants — swapping one is an env
  var, not a rebuild, and the client never learns which deployment answered.
- Defaults were verified by `scripts/probe.ts` against the actual operation documents,
  not a liveness ping. Re-run it before trusting a new ID.

This is also the real reason our predecessor's predecessor disabled Arbitrum
backtesting: not a product decision, a missing field.
