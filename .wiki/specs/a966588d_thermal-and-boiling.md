# Spec a966588d — Neighbour-coupled temperature, and a sun that boils open water

Status: **not started** · Target: `main` · Written 2026-07-30 · Written to be picked up cold

Two changes that interact and should land together, in this order. Part A rewrites how a
tile's temperature is computed. Part B lets the beam's core destroy open ocean. They interact
because the beam's acute heat is applied *on top of* whatever Part A produces.

---

## Context a fresh session needs

**Read `CLAUDE.md` and `.wiki/rules.md` first.** This spec assumes the ten active rules
(R-001…R-010) and does not restate them. The ones that bite hardest here:

- **R-003** — every number about the simulator comes from a run you actually executed. The
  previous epic produced **five** defects of one shape: a number measured under one
  configuration quoted as current under another, one of which reached GM-facing product text.
  Every figure in this document is labelled with when it was measured; **re-measure before
  quoting any of them as current.**
- **R-004** — determinism. Same seed + options ⇒ bit-identical world.
- **R-005** — churn is the load-bearing liveness metric and the `still` control MUST keep
  failing. That failure is what proves the test discriminates.
- **R-010** — `npm run sim:golden` green before merge; a deliberate world change re-baselines
  with `--update` and updates `SIMULATION.md` + `README.md` **in the same commit**.

⚠️ **npm swallows flags not after `--`.** `npm run sim -- --days 1500 --cycles crucible`.
Writing `npm run sim --days 1500` silently runs the default world; that mistake once
invalidated this repo's own recorded evidence.

### Baseline as of `948b49f` (2026-07-30) — verify, do not trust

```
goldens      still 10468117cccd7501 · crucible 0a1c093d0850b2ad
liveness     crucible 0.769 / 3.40%   anvil 0.744 / 1.18%   still 0.637 / 0.05% FAILS both
taxonomy     23 biomes, 185 rules, single SCC
thermal      THERMAL_ALPHA_LAND 0.5 · THERMAL_ALPHA_WATER 0.023
             WATER_COUPLING 0.6 · WATER_COUPLING_FOLD 2 · WATER_REACH 6
beam         shape blob · radius 8 · focusRadius 2 · oscillations 2 · amplitude 1
             transit 60 · continuous true · greatYearTraverses 8
```

Water trend figures (60 game-years, pp/world/game-year) — **measured BEFORE the wandering-sun
spec `0280c42b` changed the beam, so they are stale and must be re-measured**: still −0.0264 ·
anvil +0.0197 · garden −0.0579 · kiln −0.0525 · crucible +0.0415.

Epic-standing water budget ceilings, still in force: **0.05 pp/y per new edge, 0.125 pp/y total.**

---

# Part A — Temperature couples to neighbours

## The intent

> "the algorythm needs to use the relative temperature of its direct neighbors when calculating
> the delta temperature of a tile. The tile itself might be more resistant to temperature change
> also. For example an ocean tile might be harder to change the temperature of than a desert
> tile. But still the temperature should be relative to its neighbor. When calculating
> temperature it should be based on a snapshot of the whole map, this way we dont get like a
> temperature chain. So we snap shot, adjust the temperature of every tile based on its
> neighbors, then apply any immediate effects on top of that (solar beam, storm, etc...)."

Three requirements. One is already satisfied, one is partly satisfied, one was previously
attempted and **latched the world** — but in a form this spec deliberately does not use.

| requirement | status today |
|---|---|
| immediate effects applied on top | ✓ already exactly this (`heat = T[i] + effect.heat`) |
| per-tile resistance to temperature change | partial — two classes, water 0.023 vs land 0.5 |
| temperature relative to neighbours | ✗ **not present, and the obvious form was measured to latch** |
| snapshot / no propagation chain | ✗ required, and it is a genuine hazard — see below |

## ★ Why the previous attempt failed, and why this one is different

This is the most important section in the document. Do not skip it.

Spec `2915cb06-2` prototyped neighbour coupling as a **blend toward the mean anomaly**:

```
target = H + m · ā          // ā = mean neighbour anomaly, a = T − H
```

In a spatially *uniform* region `ā = a`, so this collapses to:

```
T += α(1 − m)(H − T)
```

The coupling weight multiplies the **global time constant** by `1/(1−m)` — at m=0.9, a 10×
slowdown of every tile on the map, whether or not it has any spatial gradient at all. Measured
on `garden`: sea-ice annual maximum fell 36.3 → 31.3 against `ICE_THAW = 28`, **18.01% of
sea-ice tiles never thawed in a year**, and invariant 8 latched (`frozensea` 2.53%, `forest`
2.30%, against a 2.00% per-biome limit). The absolute-temperature variant was worse and
additionally exported the ocean's systematic −18 offset inland.

`world.ts:452-459` records the conclusion: *"in any nearest-neighbour scheme
`reach ≈ 0.5·√(α·τ)`, so reach and inertia are the same knob. A field separates them."* That
is why the shipped design uses a per-day BFS water-proximity field instead of diffusion.

**The fix is the form.** Write the coupling as a true discrete Laplacian:

```
T[i] += α_i · (H_i − T[i])                    // pull toward this tile's own equilibrium
      + κ_i · (mean(T_neighbours) − T[i])     // exchange with neighbours
```

In a uniform field `mean(T_nb) = T[i]`, so **the second term vanishes**. It cannot multiply the
time constant. It acts only where a spatial gradient actually exists — which is the requested
behaviour and precisely what the rejected form got wrong. This is a different design, not a
retune of the one that failed.

**Stability:** an explicit scheme needs `α_i + κ_i ≤ 1` for **every** biome, or it oscillates
and then diverges. Enforce it in code (a throw at construction), not in a comment.

## The design

### A1. Snapshot / double buffer — mandatory

`World.step()` evaluates tiles in swept bands (`world.ts` `step()`, decision `0006`). A
neighbour-reading update that writes in place would read **partially updated** values: heat
would propagate arbitrarily far in the sweep direction within a single day, and — worse — the
artifact would *drift* as the bands drift, so it would not even be a consistent bias. That is
the "temperature chain" the intent names, and it is a real defect class in this codebase's
update model, not a theoretical one.

Requirement: compute the diffusion pass **once per day, from a frozen snapshot, into a second
buffer**, at the day boundary — the same place `refreshCycles` and the water-anomaly field
already resolve (`world.ts` `refreshCycles`). Then swap. Within a day the temperature field is
read-only, so band ordering cannot leak into it.

Precedent to follow: the existing `waterAnomaly` pass already does exactly this and is the
model for how to hook in.

### A2. Per-biome thermal mass

Promote the two-class `alpha` to a per-`BiomeDef` field. `BiomeDef` is in `biomes.ts`; adding a
field there is the established way to give a biome a physical property (see `moistureSource`,
`selfHeat`, `stone`, `vegetated`).

Physical shape to aim for: ocean and deep water very slow; rock, mountain and glacier slow;
sand, ash, barren and soil fast. Vegetated ground intermediate. The current 0.023 / 0.5 split
is the sanity anchor — ocean is already ~20× more resistant than land and that ratio is
measured-good, so do not collapse it.

`κ` may also be per-biome (conductivity as distinct from capacity). Start with a single global
`κ` and only split it if a measurement demands it — two per-biome tables is two things to tune.

### A3. This probably deletes the BFS field

`WATER_COUPLING`, `WATER_COUPLING_FOLD`, `WATER_REACH`, the per-day multi-source BFS and the
`waterDist` / `waterAnomaly` arrays exist **only because diffusion was rejected**. They are the
workaround for getting distance falloff. A working Laplacian produces falloff emergently, so
they should come out — roughly 60 lines plus a per-day BFS.

Do not delete them until the replacement is measured to reproduce the property they were built
for: **coastal seasonal amplitude falling monotonically with distance from water.** The shipped
figures (spec `2915cb06-2`, `garden`): d=1 −12.4%, d=2-3 −6.6%, d=4-7 −1.9%, d≥8 −0.4%.

Known tradeoff to measure and record: with diffusion, reach and inertia are coupled
(`reach ≈ 0.5·√(α·τ)`). Per-biome `α` and `κ` buy back some independence. **How much is a
measurement, not an argument** — report the achieved reach.

### A4. Acute effects stay on top, unfiltered

Non-negotiable and already correct. `CycleEffect` has two heat channels (decision `0009`):

- `ambientHeat` — slow, seasonal; goes through the filter. `Seasons` writes here.
- `heat` — acute; **bypasses the filter entirely**. Beam, volcanism, tectonics write here.

Reason, measured: `Focus` dwell is **exactly 1 day** carrying `heat 70 + focusHeat 45 = +115`
against `melting()`'s `heat > MOLTEN (120)` gate. At α=0.5 a one-day +115 impulse delivers
+57.5 and **nothing on the world ever melts again**. Do not route acute heat through the
Laplacian.

## Part A acceptance criteria

1. **The polar cap still breathes.** This is the test that killed the last attempt. On `garden`,
   sampled over ≥3000 days: report `frozensea` and `glacier` share, sea-ice annual maximum
   against `ICE_THAW = 28`, and **the percentage of sea-ice tiles that never thaw in a year —
   which must be 0.00%.**
2. `npm run sim:check` all invariants hold, **including invariant 8**, on all five presets.
   Report escapability per preset. Watch `garden` `forest`, which was at 1.17% of a 2.00% limit
   and is the first thing to move.
3. Coastal seasonal amplitude still falls monotonically with distance from water (A3 figures).
4. **Melt chemistry intact** — `glass`, `basalt`, `mountain`, `lava`, `shallows` shares unchanged
   within noise. This is the test that acute heat still bypasses the filter.
5. `still` still FAILS (R-005). All five presets' entropy and churn reported.
6. `α_i + κ_i ≤ 1` enforced in code for every biome.
7. Determinism (R-004): two independent runs at one seed produce bit-identical worlds. A
   snapshot/double-buffer bug shows up here first.
8. `npm run typecheck` green; goldens re-baselined with `--update` and hashes recorded.
9. Achieved thermal reach reported, and the BFS field either removed or its retention justified.

---

# Part B — The sun's core boils open water

## The intent

> "Im expecting the solar beam to boil oceans into deserts as its core passes through"

## Why it does not happen — and it is NOT a temperature problem

Measured 2026-07-30 at `948b49f`, water tiles lit by the beam's `Focus`, over 240 days on a
240×144 world:

| | |
|---|---|
| mean heat under the focus | **153.5** |
| hottest observed | **181.6** |
| SCORCHING / VITRIFY / MOLTEN | 78 / 110 / 120 |

The water is already far past the temperature at which **rock melts into lava**. No temperature
increase will produce the requested behaviour, because every water→land rule is gated on **how
enclosed the tile is**, not on heat:

| rule | `biomes.ts` | gate |
|---|---|---|
| `ocean → shallows` "the sea boils back" | ~`:445` | `Beam && waterNeighbours ≤ 4` |
| `shallows → barren` "seabed bared" | ~`:449` | `Beam && waterNeighbours ≤ 2` |
| `shallows → desert` "the shallows bake dry" | spec `2915cb06-3` | `waterNeighbours ≤ 2 && heat ≥ SCORCHING` |

And the distribution of what the core actually lights (same run, 2364 focus-lit water tile-days):

```
waterNeighbours:  3 → 47    4 → 95    5 → 45    6 → 2177   (92%)
```

**92% of the water the core touches is open ocean with all six neighbours water, and open ocean
has no beam-driven exit at any temperature.**

## Two deliberate decisions stack into this

Both are real and must be consciously overridden, not accidentally broken:

1. **`biomes.ts` beam section:** *"He remakes; he does not annihilate. The beam boils water back
   from the edges, but DEEP OCEAN SURVIVES A PURGE. If deep water can be destroyed, every purge
   permanently removes the world's moisture source and the map ends as glass."*
2. **Spec `2915cb06-3`** gated evaporation on geometry rather than heat because a heat gate
   closes a positive feedback loop with **measured gain above one**: `world.ts` gives every open
   water neighbour −3.0 heat, so converting one to desert adds **+4.2** to each remaining
   adjacent sea tile (larger than the +2.5 albedo term that once sterilised a world, and than
   the −0.8 ice term that latched one). Halving `garden`'s sea produced ~3.5× more
   above-threshold exposure *per remaining sea tile*.

## The design

### B1. Gate on the `Focus` flag, never on heat

This is what makes it safe, and it is the same trick `melting()` already uses. If the trigger is
"the core is here" rather than "it is hot", then destroying water raises neighbouring heat but
**does not create more triggers**. The loop cannot close. A heat-gated version reproduces the
measured latch; a flag-gated one cannot.

The new edge should be roughly: *open water under the beam's focus becomes desert (or barren),
regardless of `waterNeighbours`.* Author it by hand on `Ocean` and `Shallows`; do not fan it out.

### B2. ★ The budget problem, and why the scar must heal

Rough arithmetic from the measured footprint: 2364 focus-lit water tile-days over 240 days ≈
9.85/day ≈ 3546 per game-year. At a dramatic median (3 days) that is ≈730 tiles/year ≈
**2.1 pp of world per game-year** — against a per-edge ceiling of **0.05**. That is **40× over
budget** and would drain the ocean.

**The resolution is the return path, not a smaller number.** A desert tile stranded in open
ocean has 6 water neighbours, which is exactly what `sea takes it` requires
(`waterNeighbours ≥ 4`, median 14). So the sea should reclaim it. That turns a permanent ratchet
into a **transient scar that closes behind the beam** — which is both the requested effect and
the same scar-legibility mechanic (decision `0025`) now operating on water.

**This must be measured, not assumed.** The whole viability of Part B rests on it:

- net water trend over 60 game-years, all five presets, against the (re-measured) baseline and
  the 0.125 pp/y total ceiling
- the *transient*: how large the boiled scar gets at its peak, and how many days it takes to
  close. A scar that never closes is a drain wearing a costume.
- ★ **`sweep.ts` samples at decade resolution and cannot see a transient** — spec `2915cb06-3`
  recorded that probes moved crucible 25.12% → 12.41% *inside a 5-year window* with nothing
  visible at 10-year marks. Measure the transient directly; do not rely on the sweep.

### B3. Interaction with Part A

If Part A gives ocean a high thermal mass, the sea will resist heating *between* passes — which
is correct and desirable. It does **not** weaken Part B, because acute beam heat bypasses the
filter (A4), so the core still reads 150+ over water. Verify both properties coexist rather than
assuming it.

## Part B acceptance criteria

1. The beam's core visibly boils open ocean — demonstrated by an **ASCII render of the scar**,
   not only a statistic.
2. **The scar closes.** Report peak scar size and days-to-close, measured directly at daily
   resolution, not from `sweep.ts`.
3. Net water trend, 60 game-years, all five presets, inside the 0.125 pp/y total ceiling, against
   a re-measured baseline.
4. `npm run sim:check` all invariants hold, including invariant 8 and the single-SCC check.
5. `still` still FAILS (R-005).
6. The rule is gated on the `Focus` flag, **not** on a temperature threshold. If a reviewer
   cannot see that at a glance, the comment is wrong.
7. Goldens re-baselined; `SIMULATION.md` and `README.md` updated in the same commit (R-010).
8. Decision entries (R-008) for: overriding "deep ocean survives a purge", and why flag-gating
   breaks the feedback the heat gate closed. **Mark the superseded reasoning, do not delete it** —
   `biomes.ts`'s original note explains a real failure mode and the next person needs to know it
   was overridden deliberately.

---

## Suggested sequencing

Part A first, alone, gated and merged. Part B second. Reason: Part A moves every tile's
temperature on every world, so measuring Part B's water budget against a baseline that Part A is
concurrently changing would produce evidence about nothing. This is the same discipline epic
`2915cb06` used for its six specs and the reason its numbers held up.

## Explicitly out of scope

`ICE_FORM` / `ICE_THAW` and the polar seasonal amplitude — `biomes.ts` records these three
numbers as the difference between a breathing polar cap and 12.5% of a world being permanently
immutable. Any liveness threshold in `report.ts`. New biomes. New cycle kinds. If a measurement
says one of these must move, **escalate with the numbers**; do not adjust it in passing.

## Known-open items inherited from earlier work

Not part of this spec, but a session working here will trip over them:

- **The ±5 pp / 40-year membrane test cannot distinguish converged from draining.** `kiln`
  projects to ~15% sea and `crucible` ~32% at year 200 while both pass comfortably. Pre-existing;
  gating on the rate would fail `kiln` today.
- **`viewer/limits.ts`'s `MAX_TILES` is questionable** — ~75 ms/day at the cap with six cycles,
  ~225 ms of blocked event loop per tick at top speed. Lowering it is a product decision.
- **The beam's radius default (8) is a placeholder chosen by an agent, not a user decision.**
  `SIMULATION.md` carries the radius table justifying it.
