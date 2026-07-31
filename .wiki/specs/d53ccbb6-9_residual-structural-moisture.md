# Spec d53ccbb6-9 — Residual structural M1 chemistry (moisture extremes)

Status: **done — `still` structural one-sided 4→0; M1 median 1.43× PASS; gate still FAIL 0/5** · 2026-07-31
Epic: `d53ccbb6` · Target: `main--epic/d53ccbb6_lod-gate`

## Result

`decisions/0035`. Five cellSize-aware moisture helpers on four creation rules plus
`wetland dries`. Fine goldens **unmoved**. `still` structural silences cleared;
outlier fraction + M2 still red. Full numbers in the ADR.

## Objective

Clear the four **structural** one-sided rules on `still` (and the rock-share skew
they drive) by the same resolution-aware moisture-extreme pattern as Bloom
(`0034`), without moving fine-tier goldens or LOD thresholds.

## Diagnosis (measured, post-specs 7+8)

`npm run sim:lod` after `0033`+`0034`: **FAIL 0/5**. Factor-1 control PASSes.
Remaining `still` M1 structural silences (expected ≥ 3):

| silence | expected | root cause (day-350 snapshot, 240×144 seed 20260729) |
|---|---|---|
| fine silent `tundra→rock:scoured bare` | 640 | Coarse tundra dry% **18.8** vs fine **1.9** (`moisture < DRY(40)`). Heat bands match. |
| coarse silent `savanna→desert:the scrub burns off` | 7.2 | Coarse savanna arid% **0** vs fine **4.35** (`moisture < ARID(25)`). Heat all warm. |
| coarse silent `grassland→marsh:ground waterlogs` | 6.0 | Fine marsh-ok is via `moisture > 92` (coast `waterNeighbours≥2` is **0**). Coarse `>92%` = **0** — Bloom's failure mode. |
| coarse silent `grassland→forest:trees take root` | 4.5 | Cool∩moist empty on coarse: moist grassland heat p50 **38.5** (< COLD), cool grassland moist p90 **51** (< MOIST). |

Global arid share already matches (`0031`). This is **biome-local tail compression**,
not another leak-power miss. M2 single-patch Desert/Frozen Sea and coastal Shallows
weighted ratios are mostly topology / coastline; this spec does not claim to clear them.

## Hypothesis

Treat the four hard moisture cutoffs the way `bloomMoistureMin` treats 93: fine
value unchanged at `cellSizeTiles === 1`; coarse value calibrated so eligibility
fraction ≈ fine.

Measured coarse calibrations (eligibility % of source biome):

| helper | fine | coarse pick | coarse eligibility | fine eligibility |
|---|---|---|---|---|
| scrub arid ceiling | 25 | **26** | 8.7% → post-fix ~4.8% | 4.35% |
| scoured dry ceiling | 40 | **35** | 0% | 0% (snapshot; fine dry%=1.9) |
| marsh wet floor | 78 | **70** | ~1.4% | marsh-ok 1.83% |
| marsh wet-extreme | 92 | **70** | (OR with wet floor; coast rare) | 92 |
| forest moist floor | 60 | **55** | ~1.4% | 1.03% |

Post-fix: coarse cool grassland max moisture ≈ 73, so `WET(78)` alone stays
unreachable — both the wet floor and the extreme path must move on coarse.

DRY=35 is the first integer that zeros coarse `scoured bare` eligibility (at 40 it
is 7.14%). Do **not** retarget global `ARID`/`DRY`/`MOIST` — only the four rules
read the helpers, so grassland→barren and canopy-thins keep their fine chemistry
everywhere.

## Design

1. In `biomes.ts`, export helpers (Bloom's shape):
   - `scrubBurnsAridMax(cellSizeTiles)`
   - `scouredBareDryMax(cellSizeTiles)`
   - `groundWaterlogsWetMin(cellSizeTiles)` + `groundWaterlogsExtreme(cellSizeTiles)`
   - `treesTakeRootMoistMin(cellSizeTiles)`
2. Wire only the four named rules to them via `c.cellSizeTiles`.
3. `reachability.ts` probes stay at `cellSizeTiles: 1` (fine envelope).
4. ADR `0035`. Update epic table. Thresholds in `lod.ts` stay put.

## Acceptance

- Fine goldens **unmoved** (`still 3bc4c35b1b99adc7`, `crucible 406cbd9ca84e3e3f`).
- `npm run typecheck`, `sim:check`, `sim:golden` green.
- On `still`, the four structural one-sided rules above are **gone** (or no longer
  structural). Rock coarse share moves toward fine (was 1.26% vs 0.09%).
- Full `sim:lod` may still FAIL on M2 single-patch / coastal weighted / outlier
  fraction — report honestly. Do not escalate thresholds in this spec.

## Scope

**In:** the four rule predicates + helpers + wiki.
**Out:** leak-power retune; season push; M2 topology; threshold edits; medianDays.

## Experiments

1. Ship helpers at the calibrated integers above.
2. `npm run sim:lod -- --preset still` — count structural one-sided; rock share.
3. Full `sim:lod` + goldens.
4. If scrub arid=26 overshoots rates badly, try 25.5; if forest moist=58 underfires
   over the window, try 57. Re-measure, do not guess.
