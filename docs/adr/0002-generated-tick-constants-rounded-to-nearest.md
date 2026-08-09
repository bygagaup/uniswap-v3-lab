# The tick constant table is generated, and rounded to nearest

`src/tickMath.constants.ts` holds the twenty magic constants of the tick↔price
bit-decomposition. They are **computed**, not transcribed: `scripts/gen-tick-constants.ts`
evaluates `round(2^128 / 1.0001^(2^i/2))` from the definition at 1024-bit working
precision. A test re-runs the generator and asserts the committed file is byte-identical,
and pins eight of the constants against exactly-computed rationals.

**The rounding mode is the decision, and it is load-bearing.** The table is rounded to
nearest, not floored, and the two differ for most bits — bit 1 is `0x…213a` rounded and
`0x…2139` floored. A floored table drifts from real pool state. All twenty generated
constants match the deployed pools exactly.

## Considered options

Copying the constants out of the core contracts' source is the obvious path, and it is
what most ports do. It was rejected because a transcribed table is unverifiable: a typo
in one hex digit produces a table that looks right, passes casual review, and is wrong
by a few ticks in a corner of the price range nobody tests. Generating from the
definition means the constants are checkable against the mathematics rather than against
another copy of themselves.

## Consequences

The file must not be hand-edited — regenerate it. If the generator's rounding is ever
changed to floor, the pinned constants and the byte-identity test both fail, which is
the intended alarm and not a test to relax.
