# Rank pools by txCount; reconstruct USD volume in the core

Neither of the obvious ranking keys is trustworthy.

**TVL is inflatable.** It derives from `derivedETH`, which a counterfeit token controls.
The Base top-8 was once entirely fake pools showing $1–3.5B TVL against near-zero volume.

**`volumeUSD` is not always real either.** The fork subgraphs gate `volumeUSD`/`feesUSD`
behind a token whitelist that is unconfigured for the chain, so genuine pools report `0`
— 56 of Polygon's top 150.

So the proxy orders the candidate set by **`txCount`**: un-gated on-chain activity that
counterfeits cannot fake cheaply. The client then re-ranks by USD volume **reconstructed
in `packages/core/src/usd.ts`** from `volumeToken*`, `derivedETH` and `ethPriceUSD`.

Where the subgraph's own `volumeUSD` is non-zero it wins, because it carries true
per-swap prices and a current-price estimate cannot. The two agree within 0.2% wherever
both exist, which is what makes the reconstruction trustworthy rather than merely
plausible.

## Consequences

`txCount` is a coarse first pass — it favours pools with many small swaps — which is
acceptable only because it selects a candidate *set* that the USD re-ranking then orders.
Dropping the re-ranking would leave a visibly wrong list.
