# 0030 — The LOD gate FAILS, and the cause is a physical length denominated in cells

Status: accepted · Spec: `d53ccbb6-4` · Date: 2026-07-30

## Decision

**The two-tier LOD model as built does not pass its own gate.** At the shipped
`COARSE_FACTOR = 8` the coarse tier disagrees with the tile tier on per-rule activation and
on biome composition, on **all five presets**, including `still` — which carries no cycles
at all.

`ARCHITECTURE.md#13` Phase 1 called this "the one gate that can invalidate the architecture,
so it comes before any database". It has done its job. **No database work should start on the
assumption that a coarse cell simulates like the 64 tiles under it, because measured, it does
not.**

The cause is **not** the LOD mapping. It is that `world.ts`'s field physics has its length
constants denominated in **grid steps**, so every diffusion length is 8× larger in world
distance on the coarse tier. Consequence, measured: **0.00% of coarse land is below `ARID`
where 22.87% of fine land is.** Every `moisture < ARID` transition is unreachable on the
coarse tier — a whole chemistry the coarse world cannot see.

That is a repairable defect with an identified mechanism, not an unexplained divergence, and
it is repairable in `world.ts` rather than in the storage design. The recommendation is
**the spec's option 1, but not the option-1 spec 3 expected** — see "What to do" below.

## The verdict, as the spec's own thresholds read it

`npm run sim:lod` · 240×144 fine / 30×18 coarse · seed 20260729 · burn-in 300d, tail window
100d, 5 snapshots. Thresholds fixed in `specs/d53ccbb6-4_lod-gate.md` before measurement.

| preset | M1 activation | M2 patch size | M3 correlation | overall |
|---|---|---|---|---|
| `still` | **FAIL** | **FAIL** | PASS | **FAIL** |
| `anvil` | **FAIL** | **FAIL** | PASS | **FAIL** |
| `garden` | **FAIL** | **FAIL** | UNRESOLVED | **FAIL** |
| `kiln` | **FAIL** | **FAIL** | PASS | **FAIL** |
| `crucible` | **FAIL** | **FAIL** | PASS | **FAIL** |

**0/5 presets. 0/3 of the load-bearing three.**

M1 in detail — the criterion is a median ratio in 0.5–2.0× and ≤10% of firing rules outside
0.2–5.0×, with any rule firing on one tier and never the other a **hard fail**:

| preset | median ratio | outside 0.2–5× | one-sided | of which sample size does *not* explain |
|---|---|---|---|---|
| `still` | **33.00×** | 96.30% | 17 | **5** |
| `anvil` | **2.13×** | 61.63% | 35 | **8** |
| `garden` | 1.31× | 52.54% | 27 | **4** |
| `kiln` | 1.68× | 50.46% | 46 | **2** |
| `crucible` | 1.79× | 51.39% | 58 | **3** |

The median ratio passes on `garden`, `kiln` and `crucible` — the aggregate is not where the
damage shows. The outlier fraction fails by five-fold on every preset, and the hard fail
lands on all five.

The hard fail is not marginal and it is not sampling noise. `desert->glass:sand vitrifies`
is silent on the coarse tier where the fine tier's rate predicts 13.2 firings; on `garden`
`savanna->desert:the scrub burns off` runs **6,538 fine firings against 11 coarse**, a
0.11× rate ratio, and on `crucible` 6,347 against 8, **0.08×**.

## The diagnosis: the ladder's four rungs were all measured, and all came back minor

The spec's diagnostic ladder named three structural suspects before the cycles. All three
were measured. **None of them is the cause.**

**Rung 2 — corner point sample vs modal projection.** Spec 3's leading suspect. Measured at
day 0, unstepped: **82.04% cell-for-cell, 2.78% composition distance.** That is the floor
under every later number and it is small. The spec then asked what happens if the coarse
world is seeded from `projectBiome(fine)` instead. Measured, `still`:

| | cell-for-cell | composition | M1 median |
|---|---|---|---|
| coarse as built (corner sample) | 50.30% | 26.85% | 33.00× |
| coarse reseeded from the projection | 54.15% | **28.56%** | **39.11×** |

**Reseeding makes composition and M1 slightly WORSE.** The divergence is the stepping, not
the seeding, and the same holds on every preset. Spec 3's structural suspect is exonerated.

**Rung 3 — small filamentary biomes.** Also not it. The biomes that vanish are large
contiguous provinces, not filaments. On `still` the coarse tier loses Desert (13.64% → 0.00%),
Savanna (5.52% → 0.00%) and Barren (3.05% → 0.00%) — 22% of the world — and Desert's
area-weighted fine patch is **70.0 coarse-cell equivalents, i.e. ~4,480 tiles**. A 1/8 grid
represents a 4,480-tile province perfectly well. It is not a resolution problem.

**Rung 4 — cycle geometry.** Cannot be it, and the spec said so in advance: `still` carries
no cycles and fails hardest of the five. The 23.6× focus-area distortion spec 3 ranked first
is real and is reported, but it is not what this gate measured.

## Rung 5 — the rung the ladder did not have

Every preset shows one shape: **the coarse tier is systematically wetter, and its dry biomes
disappear.** So the thing to measure was the moisture field.

`world.ts`'s hydrology is a nearest-neighbour diffusion whose retention,
`0.9998 - max(0, heat - 52) * 0.0006`, is applied **once per grid step**. Its own comment
fixes the scale in tiles: *"moisture falls off as `exp(-sqrt(2(1-r))·distance)`"*. One coarse
step is 8 tiles of world, so the identical constant carries moisture eight times farther
across the same world. Measured:

| preset | land mean moisture, fine → coarse | land below `ARID`, fine → coarse |
|---|---|---|
| `still` | 58.2 → **97.2** | 22.87% → **0.00%** |
| `anvil` | 56.3 → **98.6** | 24.30% → **0.00%** |
| `garden` | 44.9 → 66.8 | 43.00% → **9.25%** |
| `kiln` | 43.4 → 66.7 | 44.12% → **8.45%** |
| `crucible` | 42.5 → 66.4 | 44.79% → **8.28%** |

Mean land moisture against distance inland from open water, `still`, **in tiles on both
tiers so the two rows are over the same ground**:

| tiles inland | 8 | 16 | 24 | 32 | 40 | 48 |
|---|---|---|---|---|---|---|
| fine | 51 | 46 | 56 | 69 | 71 | 99 |
| coarse | 97 | 97 | 97 | 97 | 97 | 97 |

The fine world has the interior gradient the hydrology was written to produce — `world.ts`'s
own words, *"wet coasts, arid hearts"*. **The coarse world is saturated everywhere and has no
gradient at all** (spread 55 against 3). Its continents have no interiors.

That is the whole result. Every `moisture < ARID` gate — `savanna → desert`,
`desert → glass`, `grassland → savanna`, `glass → barren` — is structurally unreachable on a
tier whose land never goes dry, which is exactly the spec's stated hard fail: *"a transition
the coarse world cannot see, and `world_metric`, the heat-death alarm, would be computed from
a tier blind to it."*

## Shrinking `COARSE_FACTOR` does not fix it — measured, not assumed

The spec's remedy option 1 offers "a smaller `COARSE_FACTOR`". `npm run sim:lod --preset
still --factor N`:

| factor | land below `ARID` (fine 22.87%) | land mean moisture (fine 58.2) | inland gradient (fine 55) | M1 median | M1 outliers | overall |
|---|---|---|---|---|---|---|
| **1** | **22.87%** | **58.2** | **55** | **1.00×** | **0.00%** | M1 **PASS**, M2 **PASS** |
| 2 | 4.70% | 71.8 | 36 | 1.39× | 32.14% | **FAIL** |
| 4 | 0.00% | 89.2 | 15 | 6.29× | 70.37% | **FAIL** |
| 8 | 0.00% | 97.2 | 3 | 33.00× | 96.30% | **FAIL** |

Aridity collapses monotonically with the factor and is **already gone at 4**. Even at 2 —
four tiles per cell, sixteen times more storage than the shipped design — the world holds a
fifth of the dry ground it should and M1 still fails with five structurally silent rules.
**The only factor that passes is 1, which is not LOD.** Option 1 in the form spec 3 imagined
it is measured and rejected.

## ★ The factor-1 run is also the proof that this gate can fail *and* pass

`--factor 1` builds the coarse tier at full resolution from the same seed: two worlds that
are the same world. Every measurement reads **1.00×**, M1 reports 0 outliers and 0 one-sided
rules, M2 reports 1.00× on every biome, and rung 5's two rows are identical.

This matters because of `d53ccbb6-1`: this repo has already shipped a check that could not
fail, when spec 1's first agreement check compared `worldgenAt` against a `generate()` that
calls `worldgenAt`. A gate nobody has watched pass is not evidence. This one has been
watched pass, at the same size and window as the real run.

## Three thresholds are wrong, argued rather than moved

The spec is explicit: *"If a threshold below turns out to be badly chosen, say so, argue it,
and escalate — do not quietly move it."* **None of the three below was moved.** Every number
in the verdict table is the spec's own criterion applied literally. Each has a companion
measure reported next to it, labelled, that does not decide anything.

**`THRESHOLD-03` — M3 cannot discriminate, and the factor-1 control proves it.** `P(same
biome | d)` decays to `sum(p_b^2)`, not to zero — ~0.16 on `still`. When `C(1)/e` sits below
that floor the curve never crosses it, and the correlation length is not "long", it is
**unresolved**. At `--factor 1` the two curves are bit-identical and M3 still returned
not-PASS. *A criterion that fails a tier which IS the fine tier is not comparing tiers.*
Reported as a third value, `UNRESOLVED`, which the overall verdict treats exactly as a
failure — the gate is not softened by one basis point. The connected correlation
`C(d) - C(inf)` does have a `1/e` point and is reported beside it; on it the tiers agree at
0.94–1.02× on every preset.

**`THRESHOLD-04` — M2's plain median measures quantisation, not physics.** A biome's
component-size distribution is dominated in count by its smallest fragments, and the smallest
representable fragment is one cell on either tier — 1 tile fine, 64 tiles' worth coarse. The
ratio therefore starts at 64× before any physics happens, and the run duly reports 64.00×,
64.00×, 96.00×, 128.00× over and over: the signature of a metric measuring its own units.
**A 3× threshold on it cannot be met by any coarse tier, correct or not.** Reported as
specified and still FAIL. The area-weighted median — the patch a randomly chosen *cell* sits
in — has no such floor, and on it the large biomes agree well (Deep Ocean 0.84×, Tundra
1.04×, Grassland 1.71× on `still`) while the small ones do not. That split is the real
finding M2 was reaching for.

**`THRESHOLD-01` — M1's hard fail conflates two different silences.** The coarse tier draws
1/64 the samples, so a rule firing 40 times on the fine tier has an expected coarse count of
0.6 and observing zero is the *most likely* outcome. The hard fail is reported exactly as
written; the one-sided rules are additionally split by whether sample size explains the
silence. It is the unexplained ones — 3 to 8 per preset — that carry the spec's meaning — 2 to 8 per preset — and
they exist, so the hard fail stands on its own merits.

*(A fourth, `THRESHOLD-02`, is not a threshold judgement but an operationalisation: M2's
"not systematically single-patch where the fine tier is fragmented" names no number, so it
is read here as coarse ≤ 1 component against fine ≥ 3. Stated in the open because a
criterion whose operationalisation is buried is one nobody can check.)*

## What to do — the recommendation, which is the user's call to accept

The spec ranks three honest options. Measured, they land like this:

**1. Fix the mapping — RECOMMENDED, but not the mapping spec 3 named.** Block-averaging
worldgen instead of corner sampling is worth 2.78% and reseeding measurably *hurts*; a
smaller `COARSE_FACTOR` is rejected by the table above. What the measurement points at
instead is **scaling the field-physics length constants with resolution, exactly as
`coarse.ts` already scales cycle geometry**. `coarse.ts` was careful to say every spatial
cycle parameter is classified explicitly because "a parameter nobody classified is a silent
bug" — and then the hydrology's retention and `THERMAL_KAPPA` turned out to be exactly that:
spatial constants nobody classified, living in `world.ts` where `coarse.ts` could not see
them.

From the file's own stated law, `exp(-sqrt(2(1-r))·distance)`, holding decay-per-*tile*
constant needs `1 - r_coarse = factor² · (1 - r_fine)` — at `r = 0.9998` and factor 8, a
coarse retention of ~0.9872. ⚠️ **That number is derived, not measured, and this spec did not
run it**: `world.ts` stepping is outside spec 4's scope, and R-003 means a derived constant
is a hypothesis until a run says otherwise. It is the follow-up spec's first experiment, not
a result.

**2. Narrow the claim — available now, and worth stating.** The two tiers already agree on
**spatial texture** and disagree on **chemistry**. M3 passes on 4/5 presets (ratios
1.02–1.31×), the connected correlation agrees at 0.94–1.02× on all five, and area-weighted
patch sizes for the large biomes agree within ~1.7×. What fails is composition and rule
activation. So a coarse tier could already be trusted for *"how big and how connected is the
terrain out there"* and must **not** be trusted for `world_metric`, the heat-death alarm, the
beam forecast, or anything reading biome shares — which is most of what
`ARCHITECTURE.md` wanted it for.

**3. Escalate the architecture.** Not needed yet. Two-tier LOD is not disproven; one
identified defect in `world.ts` sits between it and its gate. It becomes the live option only
if the follow-up spec's rescaling fails to close the aridity gap.

## Consequences

- **Phase 2 stays blocked on this**, and now for a second reason on top of the missing
  Postgres. Lazy materialization assumes a coarse cell simulates like its 64 tiles.
- `src/sim/lod.ts` and `npm run sim:lod` are the standing instrument. It is a harness and may
  print (R-007); it writes nothing into the stepping path.
- Both golden hashes are **unchanged** — `still 3bc4c35b1b99adc7`, `crucible
  406cbd9ca84e3e3f`. This spec measured; it did not alter the world.
- The suspected second instance, `THERMAL_KAPPA = 0.30`, is **not** separately confirmed
  here. Coarse land temperature runs 2–3 units cooler than fine on every preset, which is
  consistent with an over-long thermal reach but is far smaller than the moisture effect and
  was not isolated. The follow-up spec should treat it as a second candidate, not a finding.
