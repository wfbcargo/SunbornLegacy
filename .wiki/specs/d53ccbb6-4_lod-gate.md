# Spec d53ccbb6-4 — The LOD gate

Status: **done — the gate FAILS** · 2026-07-30
Epic: `d53ccbb6` · Target branch: `main--epic/d53ccbb6_lod-gate`

## Result

`src/sim/lod.ts` + `npm run sim:lod`. Full verdict, numbers and recommendation in
**`.wiki/decisions/0030`**. `typecheck`, `sim:check` and `sim:golden` green; both hashes
unchanged (`still 3bc4c35b1b99adc7`, `crucible 406cbd9ca84e3e3f`) — this spec measured and
did not alter the world.

**0/5 presets pass. 0/3 of the load-bearing three.** M1 and M2 fail on every preset; M3
passes on four and is unresolved on `garden`.

### The cause is none of the three the ladder predicted

| rung | suspect | measured | verdict |
|---|---|---|---|
| 2 | corner sample vs modal projection | 82.04% agreement, **2.78%** composition at day 0; reseeding from the projection made composition and M1 **worse** | not the cause |
| 3 | small filamentary biomes | the biomes that vanish are Desert / Savanna / Barren — contiguous provinces, Desert's mean patch ~4,480 tiles | not the cause |
| 4 | cycle geometry | `still` carries no cycles and fails hardest of the five | cannot be the cause |
| **5** | **a physical length denominated in cells** | **0.00% of coarse land is below `ARID` where 22.87% of fine land is** | **the cause** |

`world.ts`'s hydrology applies its retention **once per grid step**, so its decay length is
fixed in cells. One coarse step is 8 tiles of world, the same constant carries moisture 8×
farther, and the coarse continents never develop interiors — mean land moisture 97.2 against
58.2, and a flat 97 at every distance inland where the fine tier runs 51→46→56→69→71→99.
Every `moisture < ARID` transition is then unreachable on the coarse tier, which is this
spec's own stated hard fail.

`coarse.ts` was careful that every spatial *cycle* parameter be classified explicitly
because "a parameter nobody classified is a silent bug". The hydrology's retention and
`THERMAL_KAPPA` are exactly that — spatial constants nobody classified, living in `world.ts`
where `coarse.ts` could not reach them.

### Shrinking `COARSE_FACTOR` is measured and rejected

| factor | land below `ARID` (fine 22.87%) | M1 median | overall |
|---|---|---|---|
| 1 | 22.87% | 1.00× | M1 **PASS**, M2 **PASS** |
| 2 | 4.70% | 1.39× | FAIL |
| 4 | 0.00% | 6.29× | FAIL |
| 8 | 0.00% | 33.00× | FAIL |

Aridity is already gone at factor 4. The only factor that passes is 1, which is not LOD.

### The factor-1 run is also the proof this gate can pass

At `--factor 1` the two tiers are the same world and every measurement reads **1.00×** with
M1 and M2 PASS. Spec 1's first agreement check could not fail; this one has been watched
both fail and pass at the same size and window.

### Three thresholds are argued, and **none is moved**

`THRESHOLD-01/03/04` in `src/sim/lod.ts`, with the argument in `decisions/0030` §"Three
thresholds are wrong". Every number in the verdict is the criterion applied literally; each
has a labelled companion beside it that decides nothing. The sharpest of the three: **at
`--factor 1`, on two bit-identical worlds, M3 still returned not-PASS** — `P(same biome | d)`
decays to `sum(p²)`, not to zero, so `C(1)/e` can sit below the floor and the length is
UNRESOLVED rather than long. Reported as a third value that the overall verdict treats
exactly as a failure.

## Objective

Decide, on measurement, whether the coarse tier agrees with the tile tier closely enough
for the storage model to stand — and report the verdict honestly whichever way it falls.

`ARCHITECTURE.md#13` Phase 1 on what this is:

> **Proves or kills the entire storage model.** If the coarse tier does not agree with the
> tile tier on rule activation and spatial statistics, everything downstream — lazy
> materialization, the beam forecast, `world_metric`, the supply model — is built on
> fiction. This is the one gate that can invalidate the architecture, so it comes before
> any database.

## ★ Thresholds are fixed in this file BEFORE anything is measured

This is the rule that makes the gate a gate. A criterion written after seeing the numbers
is not a criterion, it is a justification — and this epic has already produced three
findings where the first plausible reading was wrong (§4.6's stale repairs, the tectonic
octave count, the coarse tier's unscaled defaults). A gate that grades its own homework
would have passed all three.

**If a threshold below turns out to be badly chosen, say so, argue it, and escalate — do
not quietly move it.** Moving a threshold to make a gate pass is the single failure this
spec cannot survive.

## Cell-for-cell agreement is the WRONG metric — do not use it as the verdict

Spec 3's smoke test reported 38.9–51.5% cell-for-cell agreement, and that number means
much less than it looks like it does. Both tiers are **stochastic** CAs: `rollAt` gives a
coarse cell a different roll stream than any of its 64 tiles, so two runs diverge cell by
cell no matter how well the physics matches. Even the fine world against *itself* at a
different seed would score near zero.

That is exactly why `ARCHITECTURE.md` names three **statistical** measures instead. The
question is not "is this cell the same biome" but "does the coarse world behave like the
fine world". Report cell-for-cell as context if useful; it is not a criterion.

## The three measurements, and their thresholds

All at 240×144 fine / 30×18 coarse, seed 20260729, measured across a **tail window** never
a final frame (a purged world oscillates, and an end-of-run snapshot lands at an arbitrary
phase — the bug `SIMULATION.md` records). Report every preset; `still`, `garden` and
`crucible` are the load-bearing three.

### 1. Per-rule activation counts

For each of the rules, the firing rate per cell per day on each tier. `RULE_FIRINGS` and
`enableFluxLedger()` in `biomes.ts` already exist for this.

Compare as a **rate ratio** `coarse / fine`, per rule, over rules that fire at all.

- **PASS** if the median ratio is within `0.5×–2.0×` and no more than **10%** of firing
  rules fall outside `0.2×–5.0×`.
- A rule that fires on one tier and **never** on the other is a **hard fail** regardless of
  the aggregate — that is a transition the coarse world cannot see, and `world_metric`,
  the heat-death alarm, would be computed from a tier blind to it.

### 2. Patch-size distribution

Connected components per biome, on each tier, coarse measured in cells and fine in tiles
then divided by 64 so the two are in the same units.

- **PASS** if, for every biome holding ≥1% of the world, the median patch size agrees
  within **3×** and the coarse tier is not systematically single-patch where the fine tier
  is fragmented.

### 3. Two-point correlation

For each tier, `P(same biome | separation d)` for `d = 1…8` cells (fine: `d = 8…64` tiles,
so the two curves are over the same world distances).

- **PASS** if the correlation length — the `d` at which the curve falls to `1/e` of its
  `d=1` value — agrees within **2×**.

## The diagnostic ladder — spec 3 says where to look, in this order

Do not start with the cycles. Spec 3 measured **`still`, which carries no cycles at all, at
26.67% composition distance.** With no disturbance engine running, cycle scaling cannot be
the cause, so start with what remains:

1. **`still` first.** No cycles, so this isolates worldgen + terrain rules + projection.
   Whatever fails here fails for structural reasons and will contaminate every other
   preset's reading.
2. **Point sample vs block average.** `coarse.ts` samples the block's CORNER
   (`worldgenAt` at coarse coords ≡ fine tile `(8c, 8r)`), while `projectBiome` takes the
   modal biome of 64 tiles. Measure day-0 disagreement between the two **before a single
   step** — that is the floor under every later number, and it is free to compute.
   If it is large, try seeding the coarse world from `projectBiome(fine, 8)` at day 0 and
   report how much of the divergence was the sampling rather than the stepping.
3. **Small-biome representability.** River holds ~5% of `crucible` and marsh 5–9%, in
   filaments a few tiles wide. A 1/8 grid cannot hold a 2-tile-wide river at all, so those
   biomes may be structurally absent from the coarse tier. Check whether the biomes failing
   measurement 1 are exactly the small/filamentary ones.
4. **Only then the cycles**, worst distortion first — spec 3's table ranks them, and
   `solarbeam.focusRadiusHexes` at **23.6× over-represented by area** leads it.

## What a negative verdict means, and why it is not a disaster

A fail here is **the most valuable outcome this epic can produce**, and it must not be
softened. It arrives before any database exists, which is precisely where Phase 1 was
placed to catch it.

If the tiers do not agree, the honest options are, in order of preference:

1. **Fix the mapping** — block-average worldgen instead of corner sampling; a smaller
   `COARSE_FACTOR`; per-cell sub-flags for features smaller than a cell.
2. **Narrow the claim** — the coarse tier may be adequate for *some* consumers (biome
   composition for `world_metric`) and not others (beam forecast, supply model). Say which,
   with numbers.
3. **Escalate the architecture.** Two-tier LOD is `ARCHITECTURE.md`'s central storage
   decision; abandoning or reshaping it is the user's call, not this spec's.

Write the verdict into `decisions/0030` either way. A gate whose failure is recorded only
as "needs more work" has not been run.

## Acceptance criteria

1. A harness — `src/sim/lod.ts` plus an `npm run sim:lod` script — producing all three
   measurements for every preset. It is a **caller**, so it may print (R-007).
2. Each measurement reported against its threshold above, with an explicit PASS/FAIL per
   measurement per preset, and one overall verdict.
3. The diagnostic ladder's steps 1–3 reported as their own numbers, not folded into the
   aggregate.
4. `npm run typecheck`, `npm run sim:check`, `npm run sim:golden` green. **Both hashes
   unchanged** — this spec measures, it does not alter the world.
5. `decisions/0030` records the verdict, the numbers behind it, and — if it fails — which
   of the three options above is being proposed.
6. Any threshold judged wrong is argued in writing and escalated, never silently moved.

## Scope

**You may touch:** a new `src/sim/lod.ts`, `package.json` (the one script), `.wiki/`.

**You may not touch:** `world.ts` stepping, `biomes.ts` rules, `cycles.ts` geometry,
`coarse.ts`'s mapping (fixing it is a *follow-up* spec once the gate has said what is
wrong), `golden.ts`. No new npm dependencies (R-001), no enums (R-006).
