# Spec d53ccbb6-3 — The coarse tier is the same world at 1/8 resolution

Status: **done** — 2026-07-30
Epic: `d53ccbb6` · Target branch: `main--epic/d53ccbb6_lod-gate`

## Result

`src/sim/coarse.ts`. The coarse world is an ordinary `World` at `width/8 × height/8` running
the ordinary `stepDay()` — no second stepping loop — plus `projectBiome` / `projectMoisture`
and a `coarseDistortion()` report. `typecheck`, `sim:check` and `sim:golden` green; the fine
tier is untouched and both hashes are unchanged.

### Two bugs found by measuring, both in this spec's own code

**1. The scaling scaled nothing.** `coarseCycleSpec` walked `Object.entries(spec)`, but a
preset spec names almost no parameters — `anvil` is `[{ kind: 'solarbeam', transitDays: 60 }]`
— and `radiusHexes: 8` arrives from catalogue defaults. So no geometry was scaled at all, and
the coarse world read `radiusHexes: 8` as **eight coarse cells = 64 tiles**, a beam wider than
the 30×18 coarse world. The first smoke run reported `crucible` at 4.4% cell-for-cell and
83.15% composition distance; those numbers described the bug, not LOD. Fixed by merging
catalogue defaults first.

**2. The hand-written classification was wrong, and the catalogue already knew.**
`CycleCatalogueEntry.params` carries a `unit` on every parameter, so "is this a length?" is
derivable. Deriving it caught two omissions in the hand list immediately —
`solarbeam.homeRow` (`rows`) and `weather.sampleSpread` (`hexes`). Classification is now
`unit ∈ {tiles, hexes, columns, rows}`, and an unrecognised unit throws.

*(`params` is an **array** of `{name, default, unit, …}` descriptors, not a keyed record,
though its declared type reads `Readonly<Record<string, …>>`. Spreading it produced keys
`"0"`, `"1"`, … and every cycle threw.)*

### Measured — 240×144 fine, 30×18 coarse, seed 20260729, 300 days

Coarse CA stepped independently, compared against the modal projection of the fine world:

| preset | cell-for-cell | composition distance |
|---|---|---|
| `still` | 49.8% | **26.67%** |
| `anvil` | 38.9% | 31.67% |
| `garden` | 51.3% | 18.15% |
| `kiln` | 51.5% | 18.89% |
| `crucible` | 48.0% | 22.59% |

⚠️ **These are a smoke test, not the gate.** Cell-for-cell agreement between an
independently-stepped stochastic CA and a projection is expected to decay regardless; spec 4
owns the real criteria (per-rule activation counts, patch-size distribution, two-point
correlation).

★ **The result to hand spec 4: `still` has no cycles at all and still shows 26.67%
composition distance.** With no disturbance engine running, cycle-parameter scaling cannot
be the cause. That points at the two structural things instead — point-sampling the block
corner rather than its average, and small biomes (river ~5%, marsh) having no
representation at 1/8 resolution. Spec 4 should test those before it tests the cycles.

### The distortion table — ranked suspects for spec 4

Area a coarse feature covers, in tiles, against the area it should cover:

| cycle | param | tiles | cells | area | true area | ratio |
|---|---|---|---|---|---|---|
| solarbeam | `focusCols` | 2 | 1 | 448 | 19 | **23.6×** |
| solarbeam | `focusRadiusHexes` | 2 | 1 | 448 | 19 | **23.6×** |
| weather | `sampleSpread` | 4 | 1 | 448 | 61 | 7.3× |
| volcanism | `lavaRadius` | 5 | 1 | 448 | 91 | 4.9× |
| weather | `radiusHexes` | 7 | 1 | 448 | 169 | 2.7× |
| tectonics | `shakeCols` | 12 | 2 | 1216 | 469 | 2.6× |
| solarbeam | `radiusHexes` / `widthCols` | 8 | 1 | 448 | 217 | 2.1× |
| volcanism | `ashRadius` | 14 | 2 | 1216 | 631 | 1.9× |
| monsoon | `bandRows` | 9 | 1 | 448 | 271 | 1.7× |
| tectonics | `reachRows` | 34 | 4 | 3904 | 3571 | 1.1× |

The beam's **focus is over-represented 23.6× by area** — it is the flag gating
`the core boils it dry`, `sand to glass` and `stone fuses`, so on the coarse tier the beam's
core chemistry fires across 448 tiles' worth of ground where it should touch 19.

## Objective

Build the 8×8 coarse cellular automaton `ARCHITECTURE.md#4.1` requires: a world of
`width/8 × height/8` cells, generated from the **same continuous worldgen field**, running
the **identical rule set** with neighbour coupling intact — plus the projection that maps a
fine world onto coarse cells, which is how a materialized region stays consistent with the
tier around it.

This spec **builds** the coarse tier. Spec 4 **judges** it. Keeping those apart matters:
an implementation that also owns its own pass/fail criteria will meet them.

## Why the same field comes for free

Spec `d53ccbb6-1` established that `periodicNoise` normalises by grid dimensions:

```ts
const gx = (col / width) * periodX;
```

So for a coarse grid of `width/8`, coarse cell `(c, r)` evaluates `gx` at
`(c / (width/8)) * periodX`, which is identical to fine tile `(8c, 8r)`'s
`(8c / width) * periodX`. The coarse world is a **point sample of the same continuous
field**, not a different world — and `latitudeHeat` agrees for the same reason, since
`26·cos(2π·8r/height) = 26·cos(2π·r/(height/8))`.

★ It is a point sample at the block's **corner**, not the block's average. That is a real
difference from the projection below and spec 4 must measure it rather than assume it is
small. It is also unavoidable: the coarse tier exists so that a world can be simulated
without materializing its tiles, and averaging 64 tiles per cell would mean generating
every tile in the world — which is the cost the whole storage model exists to avoid.

## Acceptance criteria

1. `src/sim/coarse.ts` exports a way to build the coarse world for a given fine
   `WorldOptions`, and it is a `World` running the ordinary `stepDay()` — **not** a second
   simulation loop. If the coarse tier needs its own copy of the stepping code, the two
   will drift, which is the failure this whole phase exists to prevent.
2. Projection: modal biome and mean moisture per 8×8 block, per `ARCHITECTURE.md#4.1`
   ("modal biome, mean moisture, min entered_step"). Ties in the mode broken
   deterministically (R-004).
3. Dimensions that do not divide by 8 are **rejected, not silently rounded** —
   `limits.ts`'s established stance ("Rejects, never clamps").
4. Spatial cycle parameters are scaled, and **every parameter is classified explicitly**
   as a length (scales), a count (does not), or a time (does not). A parameter nobody
   classified is a silent bug.
5. `npm run typecheck`, `npm run sim:check`, `npm run sim:golden` green. The fine tier is
   untouched, so **both hashes must be unchanged**.
6. The sub-cell distortion table below is **measured and recorded**, not estimated.

## ⚠️ The finding this spec exists to surface: sub-cell features cannot survive

Spatial cycle parameters are in tiles. Divided by 8:

| parameter | tiles | coarse cells | representable? |
|---|---|---|---|
| `SolarBeam.radiusHexes` | 8 | 1 | barely |
| `SolarBeam.focusRadiusHexes` | 2 | 0.25 | **no** |
| `SolarBeam.widthCols` (band) | 8 | 1 | barely |
| `SolarBeam.focusCols` (band) | 2 | 0.25 | **no** |
| `Volcanism.lavaRadius` | *(measure)* | | |
| `Volcanism.ashRadius` | *(measure)* | | |
| `Weather.radiusHexes` | *(measure)* | | |

**`Focus` is the flag that matters most and the one that vanishes.** It gates
`the core boils it dry` (decision `0027`), `sand to glass`, `stone fuses` and the melt
chemistry — the beam's entire signature. A focus of radius 2 tiles is a quarter of one
coarse cell, so a coarse tier that scales it down produces a world where the beam's core
does nothing.

Do **not** quietly drop it and do **not** quietly keep it at full size. Clamp lengths to a
minimum of one cell (`max(1, round(x/8))`), which keeps the feature alive, and record the
resulting area distortion: a radius-2 disc is ~19 tiles, a radius-1 coarse cell is ~7 cells
= ~448 tiles, so the clamp **over-represents the focus by more than an order of
magnitude**. That number is not a footnote — it is a leading candidate for whatever
disagreement spec 4 measures, and spec 4 should be told where to look.

## Scope

**You may touch:** a new `src/sim/coarse.ts`, `.wiki/`. Read-only elsewhere.

**You may not touch:** `world.ts`'s stepping path, `biomes.ts` rules, `cycles.ts` geometry,
`golden.ts`. No new npm dependencies (R-001), no enums (R-006), no I/O in `src/sim`
stepping code (R-007) — a harness that prints belongs outside the stepping path.

## Out of scope

The agreement measurement itself: per-rule activation counts, patch-size distribution and
two-point correlation are spec 4. This spec's job is to produce the thing spec 4 measures,
and to hand it an honest list of where the bodies are likely buried.
