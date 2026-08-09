# All domain math is BigInt end to end

Uniswap V3's state quantities do not fit a double: `parseInt()` on a uint256
`feeGrowthGlobalX128` discards roughly 205 bits, `feeGrowthGlobal` wraps mod 2^256 by
design so its value is only meaningful as a difference, and real pools carry
`L ≈ 1e21…1e25`, where a double loses whole tokens. So `packages/core` computes in
BigInt from input to output, and a quantity crosses into `number` exactly once, as late
as possible, in `convert.ts` — never back.

## Considered options

`decimal.js` at high precision would have removed the overflow problem without the
ergonomic cost of BigInt. It was rejected as a production dependency for two reasons:
core is meant to have zero runtime dependencies, and — more decisively — a decimal
library gives *more* precision than the chain has, which is the wrong kind of correct.
Pool and position state is defined by the contracts' integer arithmetic including its
truncation, so agreement requires reproducing that arithmetic, not improving on it.

`decimal.js` remains, as a **test-only oracle**: the golden tests check our integer
results against an independent 60-digit implementation, which is a far better use for
it than shipping it.

## Consequences

- Biome forbids importing `decimal.js` or `@uniswap/v3-sdk` from `packages/core/src/**`,
  and CI asserts they are absent from core's production dependency graph.
- Every float that reaches a chart is traceable to one `convert.ts` call, which is what
  makes "no BigInt→float conversion outside `convert.ts`" enforceable rather than
  aspirational.
