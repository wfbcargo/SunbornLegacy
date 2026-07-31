# 0035 — Residual structural moisture extremes are resolution-aware

Status: accepted · Spec: `d53ccbb6-9` · Date: 2026-07-31

## Decision

Five rules read cellSize-aware moisture cutoffs (Bloom's `0034` shape). Fine
(`cellSizeTiles === 1`) keeps the previous constants bit-identical. Coarse values
are measured eligibility calibrations on `still` 240×144 seed 20260729:

| helper | fine | coarse | rule |
|---|---|---|---|
| `scrubBurnsAridMax` | 25 (`ARID`) | **26** | `savanna→desert:the scrub burns off` |
| `scouredBareDryMax` | 40 (`DRY`) | **35** | `tundra→rock:scoured bare` |
| `groundWaterlogsWetMin` | 78 (`WET`) | **70** | `grassland→marsh:ground waterlogs` |
| `groundWaterlogsExtreme` | 92 | **70** | same rule, OR branch |
| `treesTakeRootMoistMin` | 60 (`MOIST`) | **55** | `grassland→forest:trees take root` |
| `wetlandDriesMoistureMax` | 78 (`WET`) | **70** | `marsh→grassland:wetland dries` |

Global `ARID` / `DRY` / `MOIST` / `WET` are **unchanged** — other rules keep fine
chemistry at every resolution.

## Why

Post-`0033`/`0034`, `still` still had four structural one-sided rules. Global arid
share already matched (`0031`). Probes showed **biome-local moisture-tail
compression**:

- coarse tundra dry% **18.8** vs fine **1.9** → `scoured bare` overfire (fine silent, expected 640)
- coarse savanna arid% **0** vs fine **4.35** → `scrub burns off` silent
- coarse cool grassland never reaches `WET(78)` / `92` → `ground waterlogs` silent
- cool∩moist empty on coarse grassland → `trees take root` silent

Lowering the marsh wet floor without tightening `wetland dries` latched Cool Marsh
(~5%) and created a new fine-silent `wetland dries`. The pair (wet floor 70 + dries
ceiling 70) clears structural silences; marsh share on coarse remains high (~5% vs
~1.7%) and is an accepted residual for this spec.

## Gate impact (`npm run sim:lod`)

| | post-7+8 | post-9 |
|---|---|---|
| `still` structural one-sided | 4 | **0** |
| `still` M1 median | 3.45× FAIL | **1.43× PASS** |
| `still` outlier fraction | 25% FAIL | 18.5% FAIL |
| `kiln` structural | (had some) | **0** |
| overall | FAIL 0/5 | **FAIL 0/5** |

M2 single-patch Desert/Frozen Sea and coastal weighted ratios remain. Outlier
fraction still fails every preset. Fine goldens **unmoved**
(`still 3bc4c35b1b99adc7`, `crucible 406cbd9ca84e3e3f`).

## Consequences

- Spec 9's acceptance (clear the four `still` structural silences; goldens fixed)
  is met. The gate is still red on outliers + M2 topology/coast.
- Do not "simplify" these helpers back into global climate constants — that would
  move fine goldens or reopen the silences.
