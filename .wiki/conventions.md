# Conventions

## Language & runtime
- TypeScript executed natively by Node ≥ 22.6 (currently v24). **No build step, no bundler.**
- `.ts` extensions in import specifiers (`from './world.ts'`) — required by
  `allowImportingTsExtensions` + NodeNext.
- `type` modifier on type-only imports (`verbatimModuleSyntax` is on).
- `erasableSyntaxOnly`: no `enum`, no parameter properties, no namespaces. The established
  substitute is a `const` object plus a derived union type:
  ```ts
  export const Biome = { ocean: 0, ... } as const;
  export type Biome = (typeof Biome)[keyof typeof Biome];
  ```
- `noUncheckedIndexedAccess` is on — index reads are `T | undefined`. Existing code uses `!`
  where the index is provably in range; keep that rather than adding runtime checks in hot loops.

## Performance idiom
Stepping code is a hot loop over `width × height` tiles per day. The codebase deliberately:
uses typed arrays (`Uint8Array`/`Float32Array`) over object-per-tile; reuses a single
`CycleEffect` instance instead of allocating per tile; drops dormant cycles from
`activeCycles` so they cost nothing. Preserve these when editing — do not "clean up" into
allocation-heavy code.

## Naming & style
- 2-space indent, single quotes, semicolons, trailing commas in multiline literals.
- Comments explain *why*, especially where a value was calibrated by measurement. The
  existing comments citing SIMULATION.md findings are load-bearing — do not strip them.
- Thresholds are named exported constants (`ALIVE_MIN_CHURN`), never inline magic numbers.

## Testing
There is no test framework. Verification is executable harnesses run via npm scripts
(`sim:check`, `sim:sweep`, `sim:trace`) that print results and exit non-zero on failure.
New checks follow that pattern unless a framework is explicitly adopted.
