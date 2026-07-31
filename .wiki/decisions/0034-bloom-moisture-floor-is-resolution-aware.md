# 0034 — Bloom's moisture floor is resolution-aware

Status: accepted · Spec: `d53ccbb6-8` · Date: 2026-07-31

## Decision

`blooming()` reads `bloomMoistureMin(cellSizeTiles)`:

- fine (`cellSizeTiles === 1`): **93** — unchanged, goldens unmoved
- coarse (`cellSizeTiles > 1`): **50** — measured calibration

`TileContext.cellSizeTiles` carries the world's cell size into rules.
`reachability.ts` probes use `cellSizeTiles: 1`.

## Why

Post-spec-6 LOD ladder 5: garden land moisture p90 fine **100** / coarse **80**;
crucible **100** / **65**. Bloom's hard `moisture >= 93` sat above the coarse upper
tail → **ABSENT**, not merely a 2-tile filament.

Sweep of coarse garden Bloom share vs moisture floor (burn 300d, window 100d):

| floor | bloom % |
|---|---|
| 93 | 0 |
| 78 (~p90) | 0.04 |
| 70 | 0.15 |
| 55 | 0.59 |
| **50** | **0.74** |
| 40 | 0.96 |
| fine | ~1.04 |

50 lands within ~1.5× of fine scarcity without exploding toward the 3–6% the
canopy gate was written to prevent. Heat band `[56,64]` and ≥4 canopy neighbours
still bind. This is a resolution correction on a compressed moisture field, not a
widening of the fine niche (`biomes.ts`'s "do not widen" still holds at
`cellSize === 1`).

## Gate impact

Garden Bloom **1.04% → 0.74%** (no longer ABSENT). Bloom-sourced structural
one-sided drop. Gate remains red on other M1/M2 grounds (`0033`).
