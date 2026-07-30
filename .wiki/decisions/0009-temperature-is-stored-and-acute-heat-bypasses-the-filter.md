# 0009 — Temperature is stored state, and acute heat bypasses the filter

Date: 2026-07-29
Status: accepted — **partially superseded by `0026`** (2026-07-30). The two headline claims
below are unchanged and load-bearing: temperature is stored state, and **acute cycle heat
bypasses the filter**. What `0026` replaced is the `alpha` half — the two-class
`THERMAL_ALPHA_LAND` 0.5 / `THERMAL_ALPHA_WATER` 0.023 pair is now per-biome
`BiomeDef.thermalAlpha`, and the `w(d)·A` maritime term in the filter equation below is gone
with the BFS field that fed it. True water still relaxes at 0.023.
Spec: `2915cb06-2_thermal-inertia`
Decided by: `impl-thermal-inertia-7b3c05`

## Context

The user's request was "the temperature needs to change more slowly around water". The
simulator had nothing to slow down. `World.heatAt` was a pure function of the current
neighbourhood, recomputed on every visit, so a tile's heat was its equilibrium by
construction and there was no state for inertia to live in. The existing
`-3.0 × openWaterNeighbours` term looks like maritime climate and is not: measured on
`garden` over 720 days it moved the mid-latitude coastal MEAN by −5.94, moved the cold-band
mean by **+0.19 — the wrong sign** — and moved the annual amplitude by **zero**, anywhere.
A level shift is not a thermostat.

## Decision

**`World.temperature: Float32Array` is the state, and it relaxes towards an equilibrium
instead of being it.**

```
H      = heatAt(...) + effect.ambientHeat     // today's equilibrium
target = H + w(d) · A                         // the water coupling, decision 0010
T     += (target − T) · alpha                 // alpha: land 0.5, water 0.023
heat   = T + effect.heat                      // ★ ACUTE cycle heat BYPASSES the filter
```

**`alpha` is per tile and comes from the biome's `water && !molten`, not from a constant.**
Land at 0.5 settles in a handful of days; water at 0.023 is a ~43-day time constant, which
against the 360-day year puts the sea's seasonal peak ~37 days behind the land's at ~80% of
its amplitude. That lag is not a side effect — it is the entire product. The anomaly it
creates (`T − H`) is what decision `0010` carries inland.

**★ THE LAST LINE IS THE LOAD-BEARING ONE.** `Focus` dwell under the blob beam is exactly one
day and carries `heat 70 + focusHeat 45 = +115` against `melting`'s `heat > MOLTEN (120)`
gate (`biomes.ts:349-350`). At alpha 0.5 a one-day +115 impulse delivers +57.5 and **nothing
on the world ever melts again** — no lava, so no basalt, no glass, no ash, no fertile soil,
and a third of the taxonomy stops existing. Low-passing a season is the feature; low-passing
a purge deletes the chemistry. That is what the two channels added by decision `0007` are
for, and this spec is where they stop being interchangeable: `Seasons.affect` now writes
`out.ambientHeat +=` (`cycles.ts:1150`), and beam, volcanism and tectonics keep writing
`out.heat +=`.

**`heatBase: Float32Array` is stored, not recomputed.** The field needs a water tile's
anomaly `T − H`, and recomputing `heatAt` for every water tile during the daily refresh
would be a second whole-sea neighbour gather. Being one visit stale is correct as well as
cheap: the field is resolved at the START of the day, so every land tile reads the same
snapshot however the sweep is ordered.

**`inspect()` relaxes on copies rather than reading the stored values back.** `invariants.ts`
check 8 calls it for every tile every third day; reading `temperature[i]` directly would
report a tile one day stale and the latch check would be asking about a world the simulator
is not running.

## Why it cannot latch

`A = T_water − H_water` is a **transient**. Any sustained change in `H` moves `T` by the same
amount in steady state and drives `A → 0`, so **the DC gain from `H` to `heat` is exactly 1,
identical to today**: no existing feedback's gain changes and no new steady-state path is
created. Measured confirmation — coastal mean heat on `garden` moved 44.81 → 45.03 while the
amplitude fell 12.4%. Level untouched, lag transported.

Sign check on the cold side: water lags, so in winter `A > 0` and the coast is pulled
*warmer*. The dangerous path (cold water → cold coast → colder water) does not exist,
because only the sea's LAG is transmitted, never its absolute cold.

## Evidence

**Behaviour-neutrality was proved before the constants were turned on.** At
`THERMAL_ALPHA_LAND = 1`, `THERMAL_ALPHA_WATER = 1`, `WATER_COUPLING = 0` the filter reduces
algebraically to the old formula, and both golden hashes came back bit-identical
(`ea1caa9f367a0453` / `938695caecb6f08d`). The plumbing moves nothing; the constants move
everything. Shipped hashes: `10468117cccd7501` / `d2a499ca80d5114c`.

**The acute bypass works, and the melt chemistry is the test for it.** Tail-mean composition
on `crucible` over the final third of 3000 days: `glass` 4.56 → 4.55, `basalt` 0.87 → 0.86,
`mountain` 0.72 → 0.71, `shallows` 0.53 → 0.54, `lava`/`ash`/`soil` unchanged to two
decimals.

Invariant 8 green on all five presets; worst non-ocean biome anywhere is `garden` forest at
**1.17% against the 2.00% limit**. Liveness: `crucible` 0.749 / 3.56% ALIVE, `garden`
0.699 / 2.95% ALIVE, **`still` 0.651 / 0.06% NOT ALIVE** — the control still fails (R-005).

## Consequences

- **`heat` and `ambientHeat` are no longer interchangeable, and a new cycle must choose.**
  The rule is physical, not stylistic: is this forcing something a coastline could plausibly
  lag behind for weeks? A season, yes. A purge, an eruption, a quake, no. Putting a beam on
  `ambientHeat` softens it into nothing; putting a season on `heat` silently switches
  maritime climate off and no test would name the cause.
- **A world now has climate state, so it is no longer reconstructible from `(seed, day)`.**
  Decision `0007` already weakened that contract for cycles; this ends it for terrain too.
  What survives is R-004 — same seed and options give a bit-identical world — and 588 KB of
  per-tile state at 240×144 (17 bytes/tile) is now part of what a persisted world is.
- **The whole feature costs +0.93 ms/day on `crucible` (+6.0%) and +1.18 ms on `garden`
  (+12.7%)** at 240×144, interleaved A/B on one machine. Only 0.31 ms of that is the field
  (decision `0010`); the rest is two `Float32Array` reads and two writes on every tile. The
  spec predicted 1.3% because it had priced the BFS alone.
- **`heatAt` is now the EQUILIBRIUM, not what a rule reads.** Its parameter is
  `ambientHeat`, not `cycleHeat`, and anything reaching for "the tile's heat" wants
  `TileContext.heat` or `World.temperature`.
