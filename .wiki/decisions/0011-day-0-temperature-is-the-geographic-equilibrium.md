# 0011 — Day-0 temperature is the GEOGRAPHIC equilibrium, and the constructor may not call `affect`

Date: 2026-07-29
Status: accepted
Spec: `2915cb06-2_thermal-inertia`
Decided by: `impl-thermal-inertia-7b3c05`

## Context

Decision `0009` gives water a 43-day time constant. A filter that slow does not forget its
initial condition quickly, so "what does `temperature` hold at day 0" is a real question with
a wrong answer sitting where the obvious one is.

`2915cb06-2` specified `T[i] = heatBase[i] = H` in a post-`generate` pass, where `H` is
today's equilibrium including the ambient channel. That is the wrong seed, for a reason the
spec did not have, and it is also unimplementable without breaking an existing invariant.

## Decision

**Seed `T = heatBase = heatAt(...)` with ZERO cycle contribution — the tile's *geographic*
equilibrium, not day 0's instantaneous `H`.**

Day 0 is the seasonal peak: `Seasons.dayState` is `cos(2π·(day − phase)/period)`, which at
day 0 is 1, so today's `H` is `H_geo + 22·w(row)` — up to +22 at the cold band. Seeding a
43-day filter at the summer maximum seeds it with a whole season of error, which then leaks
out over hundreds of days. The annual mean of the ambient channel is zero, so **the
cycle-free equilibrium IS the correct initial condition for the slow water filter.** Land at
alpha 0.5 relaxes out of any residual within a handful of days either way.

**And the constructor must not call `affect`, which forecloses the alternative anyway.**
`invariants.ts` check 9 counts `affect` calls through a zero-effect observer cycle to measure
the sweep, and asserts the constructor makes zero of them — a day-0 pass that resolved a real
`TileContext` per tile would land in the same tally as a real day and report 3.667
evaluations/column/day over three days instead of 1.000. Decision `0007` moved
`refreshCycles(0)` after `generate()` and added that assertion; this is the first spec whose
natural implementation would have tripped it. `seedTemperature` therefore gathers neighbours
and calls `heatAt` directly, which is per-cycle-free by construction.

This is the same discipline `generate` already applies to moisture (`world.ts`, "seed from the
SAME per-biome source the simulation uses"): day 0 must already be a consistent state, not a
state the first hundred days are spent recovering from.

## Evidence

**`mean |T − H|` is not the right instrument, and the spec named it.** The spec quoted 0.526 /
3.515 / 9.459 for the three seeds; this tree measures 2.808 (shipped) / 1.873 (latitude) /
10.970 (zero) on `garden` at day 10. The latitude seed scores *better* — because water is
DESIGNED to sit away from `H`, so a seed that happens to start too warm at the seasonal peak
reads as "closer to equilibrium". The metric conflates a correct lag with an error.

The right measurement is paired: two worlds identical in every way except the initial
temperature, compared tile by tile.

```
  shipped vs latitude seed   d1 |dT| 5.05, biome 0.88%  ·  d10 3.34, 4.85%  ·  d40 1.34, 6.37%
                             d80 0.68, 3.50%  ·  d160 0.15, 0.66%  ·  d320 0.05, 0.78%
  shipped vs zero seed       d1 |dT| 25.70, biome 2.56%  ·  d10 7.31, 13.45%  ·  d40 3.03, 14.24%
                             d80 1.11, 8.24%  ·  d160 0.28, 2.00%  ·  d320 0.15, 2.73%
```

**A zero seed puts 14.24% of the world in a different biome at day 40** and does not fall back
to the chaotic floor (~2-3%, where the two worlds have simply diverged) until about day 160.
The spec's claim of a 160–320 day transient is confirmed; the instrument it proposed is not.

Invariant 9 reads 1.000 evaluations/column/day at every tested width and band, which is the
assertion that `seedTemperature` calls `affect` zero times.

## Consequences

- **A day-0 pass over the grid is allowed; a day-0 pass that touches a CYCLE is not.**
  `seedTemperature` is the template: gather neighbours, call the climate function directly,
  pass zero for anything a cycle would have contributed. Anything that genuinely needs a
  cycle's contribution at construction needs check 9 rewritten first, deliberately, with the
  instrument's premise restated — not a quiet allowance.
- **Measurement windows that start at day 0 are still measuring a transient**, just a much
  smaller one. The 500-day goldens and the 720-day settle used throughout this spec clear it;
  a 100-day run does not, and neither does a viewer session that starts a fresh world.
- **`mean |T − H|` should not be quoted as a seeding-quality metric anywhere.** On a design
  where the sea is supposed to lag, the number it produces is not the number it appears to
  produce. Use the paired form.
