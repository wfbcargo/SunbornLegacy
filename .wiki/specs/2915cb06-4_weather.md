# Spec 2915cb06-4 — Weather systems that travel, morph and die

Epic: `2915cb06` · Status: in progress · Order: 4 of 6

## Objective

> "We should also introduce weather cycles, in addition to hot and cold, areas can be
> subjected to rain, heavy rain, wind, heavy wind, clouds, and heavy clouds. Weather should
> be like circles that also move in a sinusoidal fashion across the world, these weather
> cycles can change shape mid cycle and the circle can also change radius and morph depending
> on what it passed over. For example Heavy winds could turn into heavy rains if it passes
> over a large body of water, or turn back to heavy winds if it hasnt passed water in a
> while, or maybe the storm dies completely when passing another terrain."

A new cycle kind, `weather`, carrying a small population of storms. Each storm is a disc on a
sinusoidal track whose **type**, **radius** and **survival** are functions of the terrain it
has crossed. Six new cycle flags, and transition rules that consume them.

## The architectural problem, and its resolution

`cycles.ts:38-64` states every cycle is a pure function of `(worldSeed, cycleKey, day)` with
no accumulated state, justified by lazy fast-forwarding of unobserved regions. A storm that
morphs against terrain it has crossed is path-dependent on the *world*, which that contract
forbids.

**The justification is already obsolete, and this was verified rather than assumed.** Nothing
implements lazy terrain fast-forward: `ARCHITECTURE.md:166` scopes resolve-on-read to
movement, production, growth, consumption and budgets — terrain's clock is the solar sweep;
`ARCHITECTURE.md:709-716` steps *every* region every step at coarse resolution;
`materializeRegion` is O(1) upsampling from the always-resident coarse tier, not replay; and
`ARCHITECTURE.md:1744` (decision 10.1) explicitly records the property as **given up**.

What purity still buys — and this is real — is `forecast()` without touching the simulation.
That survives, with an honest label.

**Resolution: bounded lookback over the current grid.** The storm's *track* stays a pure
function of seed and day. Its *type* is derived by sampling the current biome grid under the
last `K` days of that pure track. There is no accumulated state anywhere; the storm's whole
condition is recomputable from `(seed, day, world-now)`.

Spec 1 already landed the contract: `WorldView`, `dayState(day, view)`, `readsWorld`, and
`CycleForecast.basis`. **This spec is the first consumer.** Set `readsWorld = true`.

Measured on the prototype: a freshly-bound storm that never ran a day, handed only the day-N
grid, reproduced the live simulation's storm state on **501 of 501 days**, bit-identical.
Determinism (R-004) verified across independent builds: 0 differing cells of 15,360.

Cost of the mechanism is **reach, not compute**: at K=20 the lookback reads 56.9 tiles from
today's centre (~2 region widths) at 441 tile reads/day against 15,360 tile evaluations —
59.4 µs/day for the whole world.

## ★ Two rules that are not negotiable

### 1. Classify on geography, never on wetness

A storm that decides it is raining from the moisture it created is a positive feedback of
exactly the albedo shape `world.ts:165-171` warns about. Measured, 1500 days, rain share per
300-day window:

| classifier | rain share over time | entropy |
|---|---|---|
| gated on `BiomeDef.water && !molten` | 28.4 · 28.4 · 38.3 · 30.9 · 21.1 % | 0.738 |
| gated on `moisture > 60` | 80.1 · 99.3 · 93.4 · **100.0** · 94.8 % | 0.754 |

The wetness-gated storm **latches** — it rains, the ground gets wet, so it rains forever. The
sea-gated one oscillates 21–38% with no trend at any magnitude tested, and could not shift
its own classifier's input (final water share 23.8% vs 23.9% across a 3× magnitude range).

**Classify on `BiomeDef.water && !molten` — ocean, shallows, frozen sea. Never on moisture,
marsh or swamp.** That single choice is what keeps the loop open.

*Note for the implementer:* spec 5 adds a river biome that is deliberately `water: false`.
It must NOT feed the storm classifier — a storm that makes rain that makes rivers that make
the storm rain is the same latch with an extra hop.

### 2. The moisture ceiling is `rainMoisture × radius² ≤ 300`

`CycleEffect.moisture` is an additive push on a diffusion target with retention 0.9998
(`world.ts:387`), so a sustained broad push has enormous steady-state gain. This is the
mistake that produced `Seasons.moistureAmplitude`'s ★ warning (at 10 the desert belt vanished
for half of every year) and `Monsoon.moisture`'s (at 26 "a monsoon did not water a region, it
flooded the planet").

Measured against `still` land-moisture mean 67.1 and `monsoon-only` 78.4, the ok/over boundary
sits between `M·R² = 343` and `384` across three independent radii:

| R | M | M·R² | land mean | |
|---|---|---|---|---|
| 7 | 7 | 343 | 77.6 | ok |
| 7 | 8 | 392 | 78.7 | **over** |
| 14 | 1 | 196 | 74.1 | ok |
| 14 | 2 | 392 | 79.2 | **over** |
| 28 | 1 | 784 | 85.0 | **over** |

**Breadth dominates strength — doubling the radius costs 4× the budget.** At radius 7 the
ceiling is `rainMoisture ≤ 6`, the same order as `Monsoon`'s 10 and `Seasons`' 4. Enforce the
ceiling in code or in validation, not merely in a comment.

## The six flags

`Rain`, `HeavyRain`, `Wind`, `HeavyWind`, `Cloud`, `HeavyCloud` join `CycleFlag` and
`CYCLE_FLAG_NAMES`. Note `CycleFlag.Storm` already exists and is raised by `Seasons` and
`Monsoon`; keep it, and have heavy rain also raise it so every existing `Storm`-gated rule
keeps working unchanged.

`reachability.ts:134-146` hand-lists flag combinations for the satisfiability probe and
`FLAG_BIT` is derived from `CYCLE_FLAG_NAMES`. Add combinations for the new flags or the
reachable-biome analysis will silently never probe them.

## Storm behaviour

- **Track**: a disc on a sinusoid, same geometry family as spec 1's beam. Reuse that code
  rather than writing a second sinusoid; two implementations of one curve is how this repo
  got two separate beam seam bugs.
- **Morph**: type is a function of the water fraction under the last `K` days of track.
  High → rain / heavy rain. Sustained low → reverts to wind / heavy wind. The user's
  "dies completely when passing another terrain" is a genuine death: the storm goes dormant
  for the rest of its life. An absorbing `alive` flag cannot be inferred from a grid, so
  derive death from the same bounded lookback — do not store it.
- **Radius** may vary with type and over the storm's life. Keep `M·R²` inside the ceiling at
  *every* point of the life, not on average.
- **Wind** should do something other than raise a flag: a small drying/erosive term is the
  natural fit, and `dryingBoost` (`biomes.ts:356`) is the existing idiom. **Wind must not add
  heat** — that is a whole new climate term and it is not in scope.
- Storms are Poisson-scheduled per the `EPOCH_DAYS` pattern already used by `Tectonics` and
  `Volcanism` (`cycles.ts:386-406`), including `epochLookback` so a long-lived storm is not
  silently truncated.

## `forecast()` for a world-reading cycle — what it may promise

Measured over 400 tiles, forecasting at day 300 with a 150-day horizon:

```
predicted a hit AND got one : 246
predicted a hit, none came  : 26     <- storm dissipated en route (9.6%)
predicted nothing, hit came : 0
ARRIVAL DAY exact           : 244/246 (99.2%), mean |error| 0.04 d
FLAGS exact                 : 227/246 (92.3%)
```

So: **WHEN is near-fact** (the track is world-independent), **WHAT is a projection**, and
about **1 in 10 forecast arrivals never happens** because the storm dies first. There were
zero unpredicted arrivals — a projected forecast over-promises, never under-promises. Report
`basis: 'projected'` and let the API surface it rather than implying false precision.

## Acceptance criteria

1. `readsWorld` is true only for `weather`; the five existing kinds are untouched.
2. **Determinism (R-004)**: two independent runs at one seed produce bit-identical worlds.
3. **Cold-resolve equivalence**: a freshly-bound `weather` cycle handed only the day-N grid
   reproduces the live simulation's day-N storm state. Report the agreement fraction over
   ≥500 days. This is the property that justifies the whole design; measure it, do not assert it.
4. Rain share is reported per 300-day window over ≥1500 days and shows **no trend toward
   saturation**. If it climbs past ~60% and stays there, the classifier has latched — stop.
5. Land-moisture mean stays inside the measured envelope (`still` 67.1 / `monsoon` 78.4).
6. Water budget: report net pp/game-year contribution, against the epic's ceilings and
   against `garden`'s post-spec-2 baseline of −0.2335 pp/y.
7. `npm run sim:check` all invariants hold; the new flags are probed by `reachability.ts`.
8. `still` still FAILS (R-005). **Be honest about liveness**: the prototype measured the storm
   as liveness-*neutral* (crucible 0.746/2.66% without, 0.748/2.65% with). Do not present
   weather as a disturbance driver unless your numbers show it is one; texture and legibility
   are the honest claim.
9. `npm run typecheck` green; goldens updated with `--update` and new hashes recorded here.
10. At least one preset in `CYCLE_PRESETS` carries weather so it is exercised by default runs.

## Explicitly NOT in this spec

Rivers (spec 5). Wind as a heat term. Any change to `Monsoon` or `Seasons` behaviour beyond
what spec 2 already did. Any change to `ICE_FORM`/`ICE_THAW`.

## Measured

Implemented by `impl-weather-8a4d63`. Every number below is from a run executed on this
branch; where a figure disagrees with the design section above, the design section is the
prototype's and this one is the shipped world's.

### Golden hashes (R-010)

| world | before | after |
|---|---|---|
| `still` 160×96 seed 20260729 500d | `10468117cccd7501` | **`10468117cccd7501`** (unchanged — no cycles) |
| `crucible` 160×96 seed 20260729 500d | `e34f6edacd80b9d0` | **`63f85bcb6b2a4f16`** |

Two intermediate checkpoints were verified bit-identical before the presets changed, and
both are load-bearing evidence rather than housekeeping:

- **Extracting the beam's sinusoid into shared geometry moved nothing.** Both hashes
  unchanged with `SinusoidTrack` / `SweptArc` / `arcDistance` in place and `SolarBeam`
  rewired onto them.
- **The whole `weather` kind, its six flags and its three rules moved nothing while no
  preset carried it.** Both hashes unchanged. That is the check that the new flags and
  the two rewritten boost helpers are inert on a world with no weather in it, which is
  what makes `anvil`, `kiln` and `still` legitimate untouched controls below.
- The per-tile reject was later rewritten (modulo-free axis offsets, and the bounding-box
  half tested first is the one that filters more). Both hashes unchanged across that too,
  so the 27% speed-up bought nothing with a tile.

### 1 — `readsWorld` is true only for `weather`

`Weather.readsWorld` returns true; the catalogue entry carries `readsWorld: true`. The
five existing kinds are untouched and still declare `dayState(day: number)` with one
parameter. `basis` therefore reports `projected` for weather forecasts and `exact` for
everything else, with no per-kind special case anywhere.

### 2 — Determinism (R-004) ✓

`npm run sim:golden` reports both worlds "deterministic across two builds", now including
a world-reading cycle. Cross-PROCESS, two separate `node` invocations, 240×144 seed
20260729 300 days: `crucible 1a68d689d678c0c5`, `garden 55a24a84018f6ad4` — identical.

### 3 — Cold-resolve equivalence ✓ **600 / 600 days**

A `weather` cycle that never ran a day, handed only the day-N terrain grid, reproduced the
live simulation's day-N storm state on **600 of 600 days (100.0%)** — 581 with storms, 19
dormant. The comparison is bit-exact, not approximate: it includes every storm's flags,
radius, moisture, heat drop, wetness and both swept-arc coordinate arrays, formatted to
17 significant digits.

This holds *by construction* rather than by luck, and that is the point of the
architecture. `dayState(day, view)` reads nothing but `(seed, key, day, view)`: the type
comes from a K-day lookback recomputed from today's grid and death comes from rescanning
the storm's own bounded life against today's grid. There is nowhere for a day to hide.

### 4 — Rain share shows no trend toward saturation ✓

160×96, seed 20260729, 1800 days, per 300-day window, as a share of storm-days:

| preset | w1 | w2 | w3 | w4 | w5 | w6 | first→last | max |
|---|---|---|---|---|---|---|---|---|
| `garden` | 38.4 | 26.5 | 24.8 | 37.6 | 34.0 | 34.1 | −4.2 pp | 38.4% |
| `crucible` | 35.8 | 27.8 | 29.0 | 37.4 | 39.4 | 39.2 | +3.4 pp | 39.4% |

Oscillating in a 25–39% band with no direction, against a latch line of ~60%. The whole
vocabulary stays in use — normalised type entropy **0.973** on both presets (2.514 bits of
a possible 2.585), with the six types splitting 10.4 / 22.5 / 22.9 / 18.4 / 15.5 / 10.2 %
of storm-days on `garden`.

Weather covers **3.8%** (`garden`) / **3.1%** (`crucible`) of the world per day, at 1.9–2.8
live storms.

### 5 — Land moisture stays inside the envelope ✓

160×96, 1500 days, mean over non-water tiles across the tail two-thirds. **The envelope
was re-measured on this branch rather than carried from the spec**: specs 1–3 moved it,
and `still` now reads 74.0 where the spec quotes 67.1.

| config | mean | min | max |
|---|---|---|---|
| `still` (floor) | 74.0 | 69.0 | 75.5 |
| `monsoon-only` (ceiling) | 83.7 | 79.8 | 90.1 |
| **`weather-only`** | **75.5** | 71.2 | 77.1 |
| `garden` −weather | 68.4 | 20.6 | 99.7 |
| **`garden` +weather** | **69.1** | 22.5 | 99.7 |
| `crucible` −weather | 68.5 | 22.0 | 99.8 |
| **`crucible` +weather** | **69.1** | 23.5 | 99.8 |

Weather alone adds **+1.5** over the no-disturbance control where a monsoon adds +9.7, and
on a full preset it adds **+0.6 to +0.7**. The moisture ceiling is enforced in
`Weather.onBind`, which throws: `rainMoisture: 8` at radius 7 is refused at M·R² = 392,
`radiusHexes: 14` at the default moisture is refused at 1176, and the measured-legal
R=14 / M=1 (196) is accepted.

### 6 — Water budget: **+0.0069 / −0.0174 pp per game-year**, both toward flat

120×72, seed 20260729, 60 game-years, sea share at 20-year marks, late rate y40→y60:

| config | y0 | y20 | y40 | y60 | drift | late pp/y |
|---|---|---|---|---|---|---|
| `still` | 23.8% | 22.2% | 22.2% | 22.2% | −1.6 pp | +0.0000 |
| `weather-only` | 23.8% | 22.7% | 22.9% | 22.9% | −0.9 pp | +0.0000 |
| `garden` −weather | 23.8% | 21.3% | 20.9% | 20.3% | −3.5 pp | −0.0272 |
| `garden` +weather | 23.8% | 21.0% | 20.8% | 20.4% | −3.4 pp | **−0.0203** |
| `crucible` −weather | 23.8% | 25.3% | 25.9% | 26.3% | +2.5 pp | +0.0203 |
| `crucible` +weather | 23.8% | 25.9% | 26.3% | 26.4% | +2.6 pp | **+0.0029** |

Weather's own contribution, as the difference between the same cycle set with and without
it: **`weather-only` vs `still` +0.0000**, **`garden` +0.0069**, **`crucible` −0.0174**.
All inside the epic's 0.05 pp/y per-edge ceiling and its 0.125 pp/y total, and **all three
move the late rate toward zero rather than away from it** — weather slows `garden`'s drain
and damps `crucible`'s flood.

**On the epic's pre-existing slow drain: this makes it slightly better, not worse.**
Extrapolating the late rate to y200, `garden` goes from 16.5% to **17.6%** sea and
`crucible` from 29.1% to **26.8%**. Nothing here fixes the drain and nothing here was
trying to.

The structural reason the number is this small is worth stating: **all three new rules are
land→land**, and so are every rule the two rewritten boost helpers scale. A storm cannot
move the coastline directly at all; its only route to the water budget is the moisture it
adds to the diffusion target, which is what the M·R² ceiling bounds. The 40-game-year
per-rule flux ledger in `npm run sim:sweep` confirms it: no weather-gated rule appears in
the coastline flux list on any preset, because none of them crosses the sea boundary.

`npm run sim:sweep` reports "the coastline is a two-way membrane on every cycle set" ✓.

### 7 — `npm run sim:check` ✓ all invariants hold

165 rules (was 162), 165 unique keys, 165 distinct roll streams. 130 distinct edges over 22
nodes, **single strongly connected component containing all 22 biomes**, all 165 rules
satisfiable somewhere in climate × flag space, 0 derived/hand-written clashes, every biome
still has an exit that needs no cycle at all.

Reachable core per preset — the two changed presets are the two that gained weather, and
the new flags are probed (`FLAG_COMBOS` gained six type combinations and two
weather×season pairs):

| preset | live edges before → after | core |
|---|---|---|
| `still` | 92 → 92 | 19/22 |
| `anvil` | 108 → 108 | 21/22 |
| `garden` | 98 → **99** | 20/22 |
| `kiln` | 126 → 126 | 22/22 |
| `crucible` | 129 → **130** | 22/22 |

The one new edge is `savanna → barren`, live only where something raises `HeavyWind`.
Every weather rule is gated on a flag only the `weather` cycle can raise, so a preset
without it does not get them counted — the honesty problem spec 3's unflagged
`shallows→basalt` rule created is not repeated here.

Escapability in a live world: `garden` improved from 9.05% to **8.55%** with no live exit
(forest 1.17→0.95%, marsh 0.86→0.74%, grassland 0.78→0.66%); `crucible` 5.06 → 5.08%,
entirely deep-ocean interiors. `still` unchanged at 92.37%.

### 8 — `still` still FAILS, and weather is liveness-NEUTRAL

240×144, 1200 days, seed 20260729, `npm run sim` test 1:

| preset | entropy before → after | churn % before → after | biomes>1% | verdict |
|---|---|---|---|---|
| `still` | 0.651 → **0.651** | 0.06 → **0.06** | 9 | ✗ **FAILS** (R-005 holds) |
| `anvil` | 0.740 → 0.740 | 1.20 → 1.20 | 11 | ✓ (untouched) |
| `garden` | 0.699 → **0.701** | 2.95 → **2.94** | 12 | ✓ |
| `kiln` | 0.726 → 0.726 | 3.08 → 3.08 | 12 | ✓ (untouched) |
| `crucible` | 0.749 → **0.750** | 3.56 → **3.56** | 13 | ✓ |

**★ THE HONEST CLAIM IS TEXTURE, NOT DISTURBANCE.** Adding six storms to `garden` moved
entropy by +0.002 and churn by −0.01 pp; on `crucible`, +0.001 and +0.00. That reproduces
the prototype's finding exactly — weather is liveness-neutral — and it should be described
as legibility and variety, never as a disturbance driver. If someone wants more churn, the
answer is still a faster beam.

### 9 — `npm run typecheck` ✓ green. Goldens updated and recorded above.

### 10 — Two presets carry weather

`garden` (the preset whose name was already a promise of weather) and `crucible`
(everything at once — and the golden world, so a world-reading cycle is now under the
determinism gate on every run rather than only under a harness).

### What `forecast()` actually promises here

400 tiles, forecasting at day 300 over a 150-day horizon against the day-300 grid frozen,
then simulating those 150 days and comparing against the flags the simulation applied:

| | `garden` | `crucible` |
|---|---|---|
| predicted a hit AND got one | 395 | 395 |
| predicted a hit, none came | **1 (0.3%)** | **0 (0.0%)** |
| predicted nothing, hit came | **0** | **0** |
| arrival day exact | **395/395 (100%)** | **395/395 (100%)** |
| flags exact | 385/395 (97.5%) | 394/395 (99.7%) |
| mean lead time | 39.5 d | 39.4 d |

Split by lead time on `garden`: **0–9 days 84/84 flags exact · 10–29 days 115/115 · 30–149
days 186/196 (94.9%)**, and the single no-show is in the long bucket.

So WHEN is a fact and WHAT decays with distance, which is what a projection ought to do.
The spec predicted 99.2% / 92.3% / 9.6% from the prototype; WHEN and WHAT both came out
better, and the no-show rate came out far lower because the shipped storm population is
dense enough that the mean lead is 39 days rather than the horizon — most forecast storms
do not live long enough to die first. **The conclusion those numbers supported reproduces
exactly: a projected forecast over-promises and never under-promises. Zero unpredicted
arrivals on both presets.**

### Storm mortality, and the cost of the lookback

Death is not a tuned constant, it is a reading of the world. Share of scheduled storm-days
killed by terrain, 160×96, 1500 days, at the shipped `deathFraction: 0.3` / `deathDays: 2`:

| preset | scheduled | survived | killed |
|---|---|---|---|
| `still` | 3700 | 3689 | **11 (0.3%)** |
| `garden` | 3700 | 3360 | **340 (9.2%)** |
| `crucible` | 3700 | 2782 | **918 (24.8%)** |

Nothing in the code says "storms die more on a volcanic world". They die on stone and
lava, and a world with beam scars, basalt fields and live vents has more of both.

Cost is reach, not compute, exactly as the prototype predicted: the lookback reads
**334 tiles/day on `garden` and 292 on `crucible`, against 15,360 tile evaluations — 2.2%
and 1.9%**. Step time at 240×144, median of five interleaved repetitions of 120 days:
`garden` 5.02 → **6.40 ms/day**, `crucible` 7.16 → **7.35 ms/day**. Before the reject was
rewritten it was 8.23 ms/day on `garden`; the modulo-free axis offsets and the
filter-ordered bounding box are worth **27%** of a weathered world's step and were verified
bit-identical.

### Departures from the spec as written

- **The moisture ceiling is enforced by a throw in `Weather.onBind`, not by parameter
  bounds.** It is a constraint on a PAIR of parameters — R=14/M=1 is legal and R=14/M=2 is
  not — which a per-parameter min/max cannot express.
- **A storm's disc is clamped to fit its torus rather than rejected.** The beam rejects,
  because its radius IS its severity dial and shrinking it silently would misreport the
  world. A storm's radius is one of six derived sizes, and throwing would turn "16×16 with
  the `garden` preset" into an error page in the viewer, which `limits.ts` cannot pre-empt
  because it does not know about the derived sizes. Verified: `garden` builds at 16×16.
- **`WorldView` grew a fifth member, `terrainAt`.** Decision `0015` — the storm classifier
  needs `BiomeDef.water && !molten`, and `cycles.ts` cannot import `biomes.ts`.
- **Wind's drying term and cloud's shade term are multiplicative factors on the existing
  `dryingBoost`, not new rules.** Decision `0017`.
