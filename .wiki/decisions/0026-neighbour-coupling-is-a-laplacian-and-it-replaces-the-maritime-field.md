# 0026 — Neighbour coupling is a Laplacian, and it replaces the maritime field

Date: 2026-07-30
Status: accepted
Spec: `a966588d_thermal-and-boiling` (Part A)
Supersedes: `0010` (the maritime BFS field), and the two-class `alpha` half of `0009`

## Context

The requested behaviour: *"the algorythm needs to use the relative temperature of its direct
neighbors when calculating the delta temperature of a tile … the tile itself might be more
resistant to temperature change also … it should be based on a snapshot of the whole map, this
way we dont get like a temperature chain."*

Decision `0010` records that neighbour coupling was prototyped once and **latched the world**,
and chose a per-day BFS proximity field instead. That measurement is real and is not disputed
here. What is disputed is that it generalises to *all* neighbour coupling.

## Decision

**Three changes, and the first one is the whole argument.**

### 1. The coupling is a discrete Laplacian, not a blend toward the mean anomaly

`0010`'s prototype wrote the coupling as `target = H + m·ā` (`ā` = mean neighbour anomaly).
In a spatially uniform region `ā = a`, so it collapses to `T += α(1−m)(H−T)` — the coupling
weight multiplies the **global** time constant by `1/(1−m)`, slowing every tile on the map
whether or not it sits on a gradient. That is why it latched, and it is structural.

What ships is

```
T += κ · (mean(T_neighbours) − T)          κ = THERMAL_KAPPA = 0.30
```

In a uniform field `mean(T_nb) = T`, so the term is **exactly zero**. It cannot multiply any
time constant. It acts only where a spatial gradient exists, which is the requested behaviour
and precisely what the rejected form got wrong. **This is a different operator, not a retune.**

It is also a max-principle update: the new value is a convex combination of `T` and the
neighbour mean for any `0 ≤ κ ≤ 1`, so the field cannot leave the range it started the day in.
The stricter `α_i + κ ≤ 1` bound for the two terms together is **enforced by a throw at module
evaluation** in `world.ts`, per biome — not asserted in a comment.

### 2. Thermal mass is per biome — `BiomeDef.thermalAlpha`

`THERMAL_ALPHA_LAND` (0.5) and `THERMAL_ALPHA_WATER` (0.023) are deleted. Relaxation rate is a
property of the material, so it lives on the material. Deep water and shallows and sea ice all
keep 0.023 — that is the measured anchor behind the sea's ~37-day seasonal lag and it was not
touched. Land now spans 0.15 (glacier, river) to 0.60 (desert, ash, barren), with stone at
0.25–0.30 and vegetated ground at 0.35–0.45.

### 3. The pass is double-buffered at the day boundary

`diffuseTemperature()` copies `temperature` into `temperatureSnapshot`, then reads only the
snapshot. It runs in `beginDay`, alongside `refreshCycles`.

This is not defensive coding. `step()` evaluates tiles in **bands that drift** (decision
`0006`). An in-place neighbour-reading update would read partially updated values, so heat
would propagate arbitrarily far in the sweep direction inside a single day *and the artifact
would move as the bands move* — not even a consistent bias. That is the "temperature chain"
the intent names, and in this update model it is a real defect class.

The equilibrium half of the filter, `α_i·(H_i − T)`, stays in `evaluateTile`, because `H`
needs the tile's neighbour composition and today's `ambientHeat` — and resolving cycles per
tile is exactly what `invariants.ts` §9 counts to measure the sweep. So a day is: **exchange
from a snapshot, then relax during the sweep.**

### 4. ★ The maritime BFS field is deleted

`WATER_COUPLING`, `WATER_COUPLING_FOLD`, `WATER_REACH`, `COUPLING_WEIGHT`, `waterDist`,
`waterAnomaly`, `fieldQueue` and `refreshWaterField()` are gone.

## Evidence

All figures: `garden` 160×96 seed 20260729, 1200-day settle. Amplitude = per-tile
`max(T) − min(T)` over one year, land tiles whose water-distance never changed, measured
against **the d=6..12 plateau** and not the `≥12` bucket — amplitude keeps climbing past d=12
in every configuration including the untouched baseline, because the deep-interior bucket is
systematically different terrain. That is a geographic confound, not thermal reach, and
measuring against it is what made the first read of this experiment wrong.

| configuration | shoreline d=1 vs plateau | reach |
|---|---|---|
| BFS field only (as shipped before) | **−33.45%** | 4 hexes |
| Laplacian + BFS field | −23.44% | 3 hexes |
| Laplacian, no BFS field | **−23.60%** | 3 hexes |
| Laplacian at κ=0.40, no BFS field | −22.62% | 3 hexes |

**0.16 pp is what sixty lines and a whole-map BFS were buying, once the Laplacian was in.**
The field is redundant, so it comes out. That is why it comes out — *not* because the
Laplacian reproduced its reach, which it does not.

**★ The 10 pp is a real cost, and it is paid to the Laplacian, not to the deletion.** The
shoreline signature weakens from −33.45% to −23.60% and the reach from 4 hexes to 3.
It is **not** recoverable by turning κ up: at κ=0.40 the shoreline reads −22.62%, *weaker*,
with the reach still 3. This confirms `0010`'s structural claim from the other side — in a
nearest-neighbour scheme reach and inertia are the same knob, so the coupling weight cannot
buy reach. Per-biome `α` buys back some independence; it does not buy back all of it.

**The polar cap still breathes** — the test that killed the previous attempt. `garden`, three
measured years after settle, ice cohort taken at each year's start:

| | frozensea % | glacier % | mean annual max heat | never thaw |
|---|---|---|---|---|
| before | 5.43 / 5.24 / 5.05 | 7.56 / 7.52 / 7.88 | 32.16 / 32.27 / 32.25 | **0.00%** |
| after | 5.44 / 5.27 / 5.12 | 7.64 / 7.68 / 8.08 | 33.24 / 33.20 / 33.16 | **0.00%** |

Against `ICE_THAW` 28. Summers got **warmer**, by ~0.95 — the opposite direction to the
rejected form, which drove the annual max down 36.3 → 31.3 and stranded 18.01% of sea ice.

**Melt chemistry intact**, which is the test that acute heat still bypasses the filter
(160×96, 1500d, tail mean over the final third):

| preset | lava | basalt | glass | mountain | shallows |
|---|---|---|---|---|---|
| `crucible` before → after | 0.265 → 0.260 | 1.348 → 1.299 | 4.529 → 4.425 | 1.265 → 1.234 | 0.994 → 1.020 |
| `anvil` before → after | 0.044 → 0.045 | 0.525 → 0.528 | 6.771 → 6.733 | 0.051 → 0.051 | 0.959 → 1.026 |

**Invariants**: all hold, single SCC preserved. Invariant 8 escapability moved
`garden` 8.40% → 8.18%, `crucible` 5.53% → 5.87%, `anvil` 13.97% → 14.51%,
`kiln` 7.55% → 7.30%; the largest non-ocean offender on `garden` is grassland at **0.60%**
against the 2.00% per-biome limit (it was forest 0.89%). **No biome family latched.**

**Liveness**, 240×144, 1500d, entropy / late churn: `crucible` 0.769 / 3.42%,
`kiln` 0.753 / 3.23%, `anvil` 0.743 / 1.19%, `garden` 0.724 / 3.20% — all ALIVE — and
`still` **0.636 / 0.05%, correctly FAILING both tests** (R-005).

**Goldens re-baselined** (R-010): `still` `10468117cccd7501` → `3bc4c35b1b99adc7`,
`crucible` `0a1c093d0850b2ad` → `4bc5ea27c0744876`. `still` moving is the informative one —
it has no cycles at all, so the only thing that can have changed its world is the thermal
scheme itself.

**Water trend**, 120×72, 60 game-years, pp of world per game-year:

| preset | before | after | Δ |
|---|---|---|---|
| `still` | −0.0264 | −0.0287 | −0.0023 |
| `anvil` | +0.0378 | +0.0567 | +0.0189 |
| `garden` | −0.0328 | −0.0382 | −0.0054 |
| `kiln` | −0.0336 | −0.0255 | +0.0081 |
| `crucible` | +0.0571 | +0.0530 | −0.0041 |

All inside the 0.125 pp/y aggregate ceiling. `anvil` moves most, and it is the preset where
the beam is the only disturbance.

**Determinism (R-004)**: two independent worlds at one seed, 600 days, `garden` and
`crucible` — zero biome diffs and zero temperature diffs. This is the check a double-buffer
bug fails first.

## Consequences

- **`beginDay` now has three passes and the exchange is first.** Anything derived per day
  still belongs there and nowhere else.
- **`heatBase` has no reader in the stepping path.** It is kept as a diagnostic — `T − H` is
  the one number that says whether a tile is ahead of or behind its own climate — and its doc
  comment says so, rather than continuing to claim the field reads it.
- **`α` is now a per-biome budget shared with κ.** Raising any `thermalAlpha` above
  `1 − THERMAL_KAPPA` throws at import. Raising κ requires lowering the largest `α`.
- **Decision `0010` is superseded but its measurement is not wrong.** The blend-toward-mean-
  anomaly form still latches; the BFS field still separated reach from inertia. What changed
  is that a Laplacian does not need them separated, because it does nothing where there is no
  gradient. Keep `0010` readable — the next person proposing `target = H + m·ā` needs it.
- **The maritime signature is weaker than it was.** −23.60% at the shoreline against −33.45%.
  If that is too weak as a product property, the lever is **lower land `thermalAlpha`**
  (reach goes as `√(κ/α)`), not higher κ, and it is spent from invariant 8's headroom.
