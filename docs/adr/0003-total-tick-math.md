# `getTickAtSqrtRatio` is a total binary search, and accepts MAX_SQRT_RATIO

Two related departures from the reference implementations, both deliberate.

**Binary search instead of the contract's log2 approximation.** The contract approximates
because gas costs money. We run in a browser, where 21 iterations of obviously-correct
code that calls `getSqrtRatioAtTick` — the function whose result *defines* the answer —
is worth more than the microseconds saved by a bit-twiddling approximation nobody can
review.

**We accept `sqrtPriceX96 === MAX_SQRT_RATIO`; the pool and `@uniswap/v3-sdk` both
reject it.** A live pool can never sit at the maximum, so requiring `<` is correct for a
pool. It is wrong for a simulator: accepting the boundary makes
`getTickAtSqrtRatio ∘ getSqrtRatioAtTick` the identity over *every* tick, and that
totality is what the round-trip property test — and everything built on it — relies on.
A simulator evaluates the boundary; a pool never reaches it.

## Consequences

`test/differential/v3-sdk.test.ts` pins this divergence explicitly, so a future reader
finds a recorded decision rather than an apparent bug. Everywhere else in that file,
exact integer agreement with the SDK is required.
