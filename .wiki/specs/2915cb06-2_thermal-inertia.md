# Spec 2915cb06-2 — The sea's temperature reaches inland

Epic: `2915cb06` · Status: in progress · Order: 2 of 6

## Objective

> "the temperature needs to change more slowly around water. Temperature of areas near water
> should be influenced of the temperature of the water in addition to the temperature change
> it is experiencing. Areas further from water are less effected."

Three separable mechanics, all requested, all delivered here:

1. **Thermal inertia** — a tile's heat relaxes toward its computed equilibrium instead of
   jumping to it. Requires stored per-tile temperature; there is none today.
2. **Water coupling** — land near water is pulled toward the *water's* thermal anomaly, not
   merely cooled by a constant.
3. **Distance falloff** — the effect decays with distance to the nearest water, out to a
   bounded reach.

## What is true today, measured

`World.heatAt` (`world.ts:172-210`) is a pure function of the current neighbourhood,
recomputed every visit. **There is no stored temperature and no inertia**, so "changes more
slowly" currently has nothing to slow down. The existing `-3.0 * openWaterNeighbours` term
is a level shift, not a thermostat — measured on `garden` over 720 days:

| | mean | annual swing |
|---|---|---|
| mid-latitude coast d=1 | 43.96 | 26.13 |
| mid-latitude inland d≥8 | 49.90 | 27.21 |
| cold-band coast d=1 | 23.63 | 44.36 |
| cold-band inland d≥8 | 21.82 | 44.17 |

−5.94 on the mid-latitude mean, **+0.19 on the cold-band mean (wrong sign)**, and **zero
amplitude moderation anywhere**. That gap is exactly what this spec closes.

## The design

### Stored state

`temperature: Float32Array` **and** `heatBase: Float32Array` (the equilibrium `H` as of the
tile's last visit, so a neighbour's anomaly is readable without recomputing `heatAt` six
times). 17 bytes/tile total including the field arrays below; 588 KB at 240×144.

```
H     = heatAt(...) + effect.ambientHeat          // today's formula plus the ambient channel
target = H + w(d) * A                             // A = mean thermal anomaly of nearby water
T[i] += (target - T[i]) * alpha                   // alpha: land 0.5, water 0.023
heat   = T[i] + effect.heat                       // ★ ACUTE cycle heat BYPASSES the filter
```

### ★ Acute heat must bypass the filter, or the melt chemistry dies

`Focus` dwell is **exactly 1 day** and carries `heat 70 + focusHeat 45 = +115` against
`melting`'s `heat > MOLTEN (120)` gate (`biomes.ts:349-350`). At α=0.5 a one-day +115 impulse
delivers +57.5 and **nothing on the world ever melts again**. Spec 1 already added
`CycleEffect.ambientHeat` for this. This spec moves `Seasons.affect` (`cycles.ts:734`) to
write `out.ambientHeat +=`; beam, volcanism and tectonics keep writing `out.heat +=`.
Seasons through the filter is what delivers the feature; the beam through the filter
destroys the world.

### Water proximity — a per-day field, not neighbour diffusion

**Neighbour diffusion was prototyped and it LATCHES. Do not use it.** Diffusing the anomaly
(`Θ = H + m·ā`) reduces, in a spatially uniform region, to `T ← T + α(1−m)(H−T)` — the
coupling weight multiplies the *global* time constant by `1/(1−m)`, a 10× slowdown of every
tile on the map at m=0.9. Measured on `garden`: ice annual max fell 36.3 → 31.3 against
`ICE_THAW` 28, **18.01% of sea-ice tiles never thawed in a year**, and invariant 8 latched
(`frozensea 2.53%`, `forest 2.30%` against a 2.00% limit). The absolute-temperature variant
was worse and additionally exported the ocean's systematic −18 offset inland.

The reason is structural, not a tuning miss: in any nearest-neighbour scheme
`reach ≈ 0.5·√(α·τ)`, so a 3-tile reach *demands* a 36-day time constant on every land tile.
Reach and inertia are not independent knobs there. Use instead:

**One capped multi-source BFS out from every true-water tile, once per day**, refreshed
alongside `refreshCycles` (`world.ts:224-234`). Each land tile learns its live distance `d`
and `A` = mean thermal anomaly (`T_water − H_water`) of the water that reached it, averaged
over the ring one step closer.

```
w(d) = w0 * exp(-(d-1)/fold),  zero beyond reach
```

Cost measured on `crucible` 240×144: **0.26 ms/day against a 19.67 ms simulated day = 1.3%**.
A static worldgen field is free but wrong — 4.0% of tiles inside the maritime band changed
water-distance over 260 days on `crucible`, and this epic makes coastlines move considerably
more. A 3-ring per-tile gather costs 5.4%. The BFS is both the correct option and the cheap one.

### Constants

`aLand 0.5`, `aWater 0.023`, `w0 0.6`, `fold 2`, `reach 6`.
Weights: d=1 → 0.60, d=2 → 0.36, d=3 → 0.22, d=4 → 0.13, d=5 → 0.08, d=6 → 0.05.

### Day-0 seeding is load-bearing

Seed `T[i] = heatBase[i] = H` in a post-`generate` pass, with the same discipline
`world.ts:520-526` already applies to moisture. Getting it wrong is a 160–320 day
(0.4–0.9 game-year) climate transient sitting inside every early measurement window —
measured mean |T−H| at day 10: 0.526 correct, 3.515 from a latitude seed, 9.459 from zero.

## Why it cannot latch — and what to prove

`A = T_water − H_water` is a **transient**. Any sustained change in `H` moves `T` by the same
amount in steady state and drives `A → 0`, so **the DC gain from `H` to `heat` is exactly 1,
identical to today**: no existing feedback's gain changes and no new steady-state path is
created. The coupling transports lag only. `w(d) ≤ w0 ≤ 1`, and the field is one-directional
(land reads water; water reads nothing), so there is no loop to close.

Sign check on the cold side: water lags, so in winter `A > 0` — the coast is pulled *warmer*,
which is anti-freezing. The dangerous path (cold water → cold coast → colder water) does not
exist because only the sea's lag is transmitted, never its absolute cold.

**The one real constraint, quantified:** maritime moderation and the sea-ice thaw window are
the same number. Baseline ice annual max is 36.3 against `ICE_THAW` 28 — 8.3 degrees of
margin — capping coastal moderation at **~45%** before the polar cap re-latches. Do not
chase more than that here.

## Acceptance criteria

1. `npm run sim:check` all invariants hold, **including invariant 8**, on all five presets.
   Report the escapability percentage per preset.
2. Sea ice demonstrably breathes: report `frozensea` and `glacier` share sampled across
   ≥3000 days on `garden`.
3. Coastal seasonal amplitude falls monotonically with distance to water, reported as a
   d=1 / d=2-3 / d=4-7 / d≥8 table on `garden`. Target ≈ −14% at d=1.
4. `still` still FAILS (R-005). `crucible` and `garden` still pass.
5. Melt chemistry intact — `glass`, `basalt`, `mountain`, `shallows` shares unchanged within
   noise. This is the acute-heat bypass doing its job and it is the test for it.
6. `npm run typecheck` green; goldens updated with `--update` and the new hashes recorded here.

## Known hazards for the implementer

- `refreshCycles(0)` was moved after `generate()` by spec 1. Any field refresh hooked there
  now runs with the arrays allocated — but check it, do not assume.
- **Invariant 8's margin is thinner than it looks.** The 2% per-biome limit is calibrated at
  `settle=365`; the *baseline* already reports forest at 2.67% under a 3-year settle. The
  prototype measured forest 1.19% at `w0=0.6` and 1.57% at the most aggressive safe setting.
  `w0` trades linearly against this headroom. Do not spend it all.
- Moderating temperature reduces threshold crossings, which is what the escapability metric
  counts. A small rise there is expected and is not automatically a defect — but report it.

## Explicitly NOT in this spec

`ICE_FORM`, `ICE_THAW` and the polar seasonal amplitude are **out of bounds** — `biomes.ts:141-157`
records that those three numbers were the difference between a breathing cap and 12.5% of a
world being permanently immutable. If the target cannot be hit without them, escalate.
No new biome, no new rule, no storms, no rivers.

## Measured

Implemented by `impl-thermal-inertia-7b3c05` on `main--epic/2915cb06_living-water` at
`97e0ea0`. **All constants shipped as designed** — `aLand 0.5`, `aWater 0.023`, `w0 0.6`,
`fold 2`, `reach 6`. Nothing was retuned.

### Baseline, verified green before any edit

`npm run typecheck` ✓ · `npm run sim:check` ✓ all invariants hold ·
`npm run sim:golden` ✓ `still ea1caa9f367a0453`, `crucible 938695caecb6f08d`.

### Goldens

Both moved, as intended. New hashes, recorded here per R-010 and pasted into
`golden.ts:80,89`:

| world | before | after |
|---|---|---|
| `still` 160×96 seed 20260729 500d | `ea1caa9f367a0453` | **`10468117cccd7501`** |
| `crucible` 160×96 seed 20260729 500d | `938695caecb6f08d` | **`d2a499ca80d5114c`** |

**The plumbing was proved behaviour-neutral first.** With `THERMAL_ALPHA_LAND = 1`,
`THERMAL_ALPHA_WATER = 1` and `WATER_COUPLING = 0` the filter reduces algebraically to the
old formula (`T = target = H`, `heat = H + acute`), and both hashes came back **bit-identical
to the baseline**. So the stored state, the daily BFS, the moved `Seasons` channel and the
day-0 seeding pass move nothing on their own; the constants are the only thing that moved a
tile. The switch was then removed — nothing dead shipped.

Determinism (R-004) holds across two builds in-process (checked by `golden.ts` itself) **and
across three separate `node` processes** — the same two hashes came out of the drift report,
the `--update` run and the verification run.

### 1 — `npm run sim:check`: all invariants hold, invariant 8 per preset

```
  preset       no live exit   worst per-biome offender (limit 2.00%)
  still       ✓  92.37%   (control: no cycles, expected)
  anvil       ✓  13.60%   ocean 13.56%
  garden      ✓   9.05%   ocean 6.15%, forest 1.17%, marsh 0.86%, grassland 0.78%
  kiln        ✓   7.53%   ocean 5.83%, forest 0.69%, grassland 0.47%, marsh 0.45%
  crucible    ✓   5.07%   ocean 5.07%
```

Against the same run on the baseline tree: `still 92.41 → 92.37`, `anvil 12.67 → 13.60`,
`garden 8.41 → 9.05`, `kiln 6.98 → 7.53`, `crucible 4.98 → 5.07`. The rise is the one the
hazard note predicted — moderating temperature reduces threshold crossings, and threshold
crossings are what this metric counts. **Worst non-ocean biome anywhere is `garden` forest at
1.17% against the 2.00% limit**, i.e. 41% of the headroom still unspent. (The prototype
predicted 1.19%; the post-spec-1 tree agrees to 0.02 pp.)

Invariant 9 also reads 1.000 evals/column/day at every width — confirmation that the day-0
seeding pass calls `affect` **zero** times, which is why it resolves `heatAt` with no cycle
contribution instead of building a real `TileContext`.

### 2 — sea ice breathes (`garden`, 3000 days, sampled every 90d)

```
  day       90   180   270   360   450   540   630   720   810   900   990  1080 ...
  ice      2.8  12.6  10.9   0.4   1.5  12.2  10.5   0.4   1.4  11.9  10.2   0.4
  glacier  0.0  17.3  13.1   0.3   0.0  17.4  13.0   0.3   0.0  17.0  13.0   0.3
```

Over the full 3000 days: **`frozensea` 0.31% – 12.56%**, **`glacier` 0.00% – 18.11%**, and the
pattern repeats on every one of the eight game-years. Baseline for comparison: `frozensea`
0.08 – 12.62%, `glacier` 0.00 – 18.10%. The cap still empties and refills; the winter *floor*
rises (0.08% → 0.31%) and the first-spring peak falls (5.2% → 2.8%), which is maritime
moderation doing exactly what it is for.

Thaw-window margin, the constraint this spec is capped by: of the tiles that are `frozensea`
at day 720, mean annual max heat **33.33 → 31.81** against `ICE_THAW` 28, and **0.00% never
reached the threshold** in either tree. 1.52 of the 5.33 degrees of margin spent — 29%, well
short of the ~45% ceiling.

### 3 — coastal seasonal amplitude falls with distance to water (`garden`)

240×144 seed 20260729, settle 720d, annual swing (max − min of `heat`) per tile over the
following 360 days, 22k land tiles. **Latitude-stratified**: seasonal amplitude is
`22 × (1 − cos(2πrow/H))/2`, so raw band means are confounded by where the coasts happen to
sit; each figure below is a weighted mean over six seasonal-weight buckets with the same
bucket weights for every band.

| band | tiles | swing before | swing after | change | mean \|dT/day\| before → after |
|---|---|---|---|---|---|
| d=1 | 746 | 23.77 | **20.82** | **−12.4%** | 0.169 → **0.141** (−16.6%) |
| d=2-3 | 1544 | 25.17 | **23.52** | −6.6% | 0.170 → 0.154 |
| d=4-7 | 3283 | 26.16 | **25.67** | −1.9% | 0.175 → 0.167 |
| d≥8 | 16723 | 25.56 | **25.46** | −0.4% | 0.172 → 0.166 |

**−12.4% at d=1 against a ≈−14% target, and the falloff is monotone: −12.4, −6.6, −1.9,
−0.4.** Read the other way — within the shipped tree, against its own inland value — d=1 is
−18.2%, d=2-3 −7.6%, d=4-7 +0.8%. The baseline already read −7.0% / −1.5% / **+2.3%** at
those bands from geography alone (coasts are wetter, so they are a different biome mix), so
the *inversion* at d=4-7 is pre-existing and the coupling shrank it from +2.3% to +0.8%. The
coupling's own contribution is the paired column: −12.4 / −6.6 / −1.9 / −0.4, monotone with
no inversion. Mean heat is essentially untouched (d=1 44.81 → 45.03), which is the DC-gain-1
argument confirmed: this moves lag, not level.

### 4 — liveness, `npm run sim -- --days 1200`, 240×144

| preset | entropy before → after | churn before → after | biomes | verdict |
|---|---|---|---|---|
| `crucible` | 0.749 → **0.749** | 3.66% → **3.56%** | 13 | **ALIVE ✓** |
| `garden` | 0.701 → **0.699** | 3.02% → **2.95%** | 12 | **ALIVE ✓** |
| `still` | 0.651 → **0.651** | 0.05% → **0.06%** | 9 | **NOT ALIVE ✗ — the control still fails (R-005)** |

`still` fails both tests exactly as it must: "Composition has stopped moving (0.06%/sample) —
heat death", against a 0.15% floor.

### 5 — melt chemistry intact (the test for the acute-heat bypass)

Tail-mean composition, `crucible` 240×144, final third of a 3000-day run, 34 samples:

| biome | before | after | Δ pp |
|---|---|---|---|
| `glass` | 4.56 | 4.55 | −0.01 |
| `basalt` | 0.87 | 0.86 | −0.01 |
| `mountain` | 0.72 | 0.71 | −0.01 |
| `shallows` | 0.53 | 0.54 | +0.01 |
| `lava` | 0.14 | 0.14 | 0.00 |
| `ash` | 0.37 | 0.37 | 0.00 |
| `soil` | 0.20 | 0.20 | 0.00 |

**Unchanged to 0.01 pp.** The beam still melts. Largest shift in ANY of `crucible`'s 22
biomes is `frozensea` +0.19 pp; on `garden` it is `ocean` −0.38 pp with everything else
≤ 0.28 pp. (Day-1200 single frames read much larger for `ocean`/`frozensea` — ±2.5 pp — but
that is phase noise on a cap that swings 0.3–12.6% within a year, not a distribution shift;
the tail means above are the honest statistic.)

### 6 — typecheck, and cost

`npm run typecheck` ✓ green at the final commit.

Cost, interleaved A/B against the HEAD tree on one machine, 9 blocks of 40 days, median,
240×144:

| preset | HEAD | with the filter | overhead |
|---|---|---|---|
| `crucible` | 15.64 ms/day | 16.57 ms/day | +0.93 ms (**+6.0%**) |
| `garden` | 9.26 ms/day | 10.43 ms/day | +1.18 ms (**+12.7%**) |

**The BFS itself is 0.306 ms/refresh** (crucible at day 400, 2000 reps, replicated over the
live biome array) — the spec's 0.26 ms prediction, confirmed. The remaining ~0.6–0.9 ms is
the per-tile filter: two `Float32Array` reads and two writes plus the field lookup on every
one of 34,560 tiles. **So the spec's "1.3%" was the BFS in isolation and the honest whole-
feature number is 6–13%**, which is still nowhere near a constraint (`garden` runs
3.55M tile-evals/s against the 0.4/s a live world of this size needs).

Field coverage, measured: on `crucible` at day 400, 8,174 water sources reach 4,758 land
tiles — **only 13.8% of the world is within 6 hexes of water**, so the coupling is genuinely
a coastal effect and 62% of the map never reads the field at all.

### Day-0 seeding

Shipped seed is the **geographic** equilibrium (`heatAt` with zero cycle contribution), not
day 0's instantaneous `H`. Two reasons, and the first is a correction to this spec's own
design note: day 0 is the seasonal peak (`cos 0 = 1`), so seeding a 43-day filter at
`H + 22w` seeds it with a whole season of error. The annual mean of the ambient channel is
zero, so the cycle-free equilibrium **is** the correct initial condition for the slow water
filter. The second reason is mechanical: `invariants.ts` §9 asserts the constructor calls
`affect` zero times, and resolving a real `TileContext` per tile at construction would read
as an extra whole sweep.

`mean |T − H|` at day 10 measured 2.808 (shipped), 1.873 (latitude), 10.970 (zero) — and that
metric is **not** the right instrument here, because water is *designed* to sit away from `H`,
so a seed that starts too warm scores well by accident. The paired measurement is:

```
  shipped vs latitude seed  d1 |dT| 5.05, biome 0.88%  ·  d10 3.34, 4.85%  ·  d40 1.34, 6.37%
                            d80 0.68, 3.50%  ·  d160 0.15, 0.66%  ·  d320 0.05, 0.78%
  shipped vs zero seed      d1 |dT| 25.70, biome 2.56%  ·  d10 7.31, 13.45%  ·  d40 3.03, 14.24%
                            d80 1.11, 8.24%  ·  d160 0.28, 2.00%  ·  d320 0.15, 2.73%
```

**A zero seed puts 14.24% of the world in a different biome at day 40** and does not settle
back to the chaotic floor until ~day 160. The spec's "160–320 day transient" is confirmed;
the instrument it named is not.

### Water budget — reported because it moved, though this spec adds no edge

The epic's standing constraint prices **new** water↔land edges; this spec adds none. It does
change the *rate* of existing ones by warming coasts, so the number is reported:

| preset | HEAD | with the filter | attributable |
|---|---|---|---|
| `crucible` 8.2 game-years | +0.0125 pp/y | +0.0208 pp/y | **+0.008 pp/y** |
| `garden` 8.2 game-years | −0.1695 pp/y | −0.2335 pp/y | **−0.064 pp/y** |

`crucible` is negligible. **`garden` is not**: the world was already draining at 0.17 pp/y
there and this makes it 0.23 pp/y, an attributable 0.064 pp/y that would be over the epic's
0.05 pp/y per-edge ceiling if it were an edge. It is a rate modulation on the existing
membrane, not a new one, and it is a straight-line rate rather than a level shift (the gap
between the two trees widens 0.03 pp → 0.45 pp over the eight years). Flagged for spec 3,
which owns the water chemistry and inherits this account.
