# 0015 — A cycle may read the world, and this is what it costs

Date: 2026-07-30
Status: accepted
Spec: `2915cb06-4_weather`
Decided by: `impl-weather-8a4d63`

## Context

Decision `0007` built the channel — `WorldView`, `dayState(day, view)`, `readsWorld`,
`CycleForecast.basis` — and shipped it with nothing on the other end of it. `weather` is
the first cycle to declare `readsWorld = true`, so this is the decision that spends what
`0007` only made spendable, and it should be read as the invoice rather than the offer.

The thing being bought is a storm whose type, radius and survival are functions of the
terrain it has crossed. That is path-dependence on the *world*, which `cycles.ts:38-64`
forbids in as many words: every cycle is a pure function of `(worldSeed, cycleKey, day)`,
justified by lazy fast-forwarding of unobserved regions.

## Decision

**Bounded lookback over the current grid. No accumulated state, anywhere.**

- The storm's TRACK is a pure function of seed and day.
- Its TYPE is the water fraction under the last `K` days of that track, sampled from the
  grid **as it is today**.
- Its DEATH is a run of lethal days found by rescanning the storm's own bounded life,
  again against **today's** grid. Nothing is remembered.

So the storm's whole condition is recomputable from `(seed, day, world-now)`, and the
cheapest way to say what that buys is that it is the same computation whether it is the
five-hundredth day of a run or the first thing the process ever did.

**Measured: 600 of 600 days, bit-exact.** A `weather` cycle that never ran a day, handed
only the day-N terrain grid, reproduced the live simulation's day-N storm state on every
one of 600 days — flags, radius, moisture, heat drop, wetness and both swept-arc
coordinate arrays to 17 significant digits. 581 of those days had storms.

The measurement matters even though the property holds by construction, because "by
construction" is a claim about code that a memo, a cache or a stray field on `this` would
quietly falsify. It is cheap to keep: the harness is a subclass that records what the live
cycle returned alongside the grid it read.

**An accumulator was considered and is unimplementable against this contract**, which is
why the lookback is not merely the tidy option. The epic's prior analysis measured a
day-by-day wetness accumulator against a cold resolver: max |Δwetness| 0.045 → 0.256 with
*no decay in K*, i.e. the two never converge no matter how far back the cold resolver
looks. An absorbing `alive` flag was wrong for 2 of 3 storms at small K. Derive; do not
store.

### `WorldView` grew a fifth member, and this is why

```ts
/** OR of `TerrainClass` bits at a wrapping coordinate. */
terrainAt(col: number, row: number): number;
```

`0007` said four members and "nothing widens it by accident". This is not an accident, and
the alternative was worse in a way that is specific rather than aesthetic.

The storm classifier must be `BiomeDef.water && !molten` (decision `0016`). A cycle that
reads `biomeAt` and compares ids needs the biome taxonomy — and **`cycles.ts` cannot import
`biomes.ts`**, because `biomes.ts` already imports `CycleFlag`. The cycle would be legal
ESM and would work, right up until an entry point evaluated the two modules in the other
order and a module-scope `BIOMES` read hit the temporal dead zone. This repo has eight
entry points. The safety of that arrangement would be "nobody ever writes a top-level
reference in either file", which is not a property, it is a hope.

The other alternative — a list of "which biome ids count as sea" written inside the cycle —
is exactly the trap `biomes.ts` refuses to build for its own biome sets (`SEA`,
`DROWNABLE`, `FREEZABLE` are all derived from predicates for this reason). The day someone
adds a water biome, the storm classifier silently stops seeing it.

`World` derives `TERRAIN_CLASS` from `BiomeDef.water && !molten`, `.molten` and `.stone`
and hands it over. A new biome joins the classification the moment it joins `BIOMES`.
`TerrainClass` has three members and they are geography, not taxonomy: the cycle still
cannot tell a marsh from a forest, and that is deliberate.

`DETACHED_VIEW.terrainAt` returns 0, and `weather` returns `null` for `view.width === 0`
exactly as `0007` requires.

## Evidence

- Cold-resolve equivalence **600/600 (100.0%)**, bit-exact, 160×96 seed 20260729.
- Determinism (R-004) across two separate `node` processes, 240×144 300 days:
  `crucible 1a68d689d678c0c5`, `garden 55a24a84018f6ad4`, identical. `npm run sim:golden`
  reports both worlds deterministic across two builds with a world-reading cycle in
  `crucible`.
- **The whole kind, its six flags and its three rules moved neither golden hash while no
  preset carried it.** That is what proves the plumbing is inert and makes `anvil`, `kiln`
  and `still` legitimate untouched controls.
- Cost is reach, not compute: the lookback reads **334 tiles/day on `garden`, 292 on
  `crucible`, against 15,360 tile evaluations (2.2% / 1.9%)**. Step time at 240×144,
  median of five interleaved repetitions: `garden` 5.02 → 6.40 ms/day, `crucible`
  7.16 → 7.35.

## Consequences

- **`readsWorld` is now load-bearing rather than decorative, and there is a world that
  sets it.** Anyone reaching for lazy fast-forward must check the world's cycle set: on
  `garden` and `crucible` the answer is now "no, step the region". `0007` said this would
  happen; this is it happening.
- **`forecast()` on a world-reading cycle is honest about a specific thing.** Measured over
  400 tiles at a 150-day horizon, WHEN is exact (395/395, mean error 0.00 d — the storm
  population, schedule and track are all world-independent) and only WHAT decays: 100%
  correct inside ten days, 94.9% past thirty. Zero unpredicted arrivals on either preset.
  The failure mode is a storm that dies en route, which shows up as an arrival that never
  comes — never as one on the wrong day. `basis: 'projected'` covers all of it.
- **The lookback is bounded by the storm's LIFE, not by K.** Death has to be rescanned from
  birth or it is not a death, and that is affordable only because a storm's life is
  bounded (`durationDays × 1.4` at most). A cycle that wanted unbounded history could not
  use this pattern.
- **The extraction of the beam's sinusoid is part of this decision, not a drive-by.**
  `SinusoidTrack` / `SweptArc` / `arcDistance` are shared by the beam and every storm.
  Decision `0008` records that two implementations of one curve is how this repo got two
  separate beam seam bugs; the second consumer took the first one's geometry rather than
  writing its own, and both golden hashes are unchanged across the extraction.
