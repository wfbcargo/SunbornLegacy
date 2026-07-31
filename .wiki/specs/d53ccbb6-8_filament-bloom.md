# Spec d53ccbb6-8 — Filament representability (Bloom)

Status: **done — coarse Bloom 0.74% vs fine 1.04%; no longer ABSENT** · 2026-07-31
Epic: `d53ccbb6`

## Result

`decisions/0034`. `bloomMoistureMin(cellSize)`: 93 fine / 50 coarse. Goldens
unmoved. Garden Bloom share recovered; gate still red on non-Bloom grounds.

## Objective

Make Bloom reachable on the coarse tier without widening its niche on the fine
tier, then re-measure unexplained one-sided bloom rules.

## Diagnosis (measured, post-spec-6)

Bloom's envelope (`biomes.ts` `blooming()`):

```
moisture >= 93 && heat in [56, 64] && no hostile neighbours &&
forest+rainforest+bloom neighbours >= 4
```

LOD ladder 5 after spec 6, garden: land moisture p90 **fine 100 / coarse 80**.
Crucible: **fine 100 / coarse 65**. The moisture gate sits above the coarse
upper tail — Bloom is not merely a 2-tile filament the grid cannot hold; it is
**chemically unreachable** on coarse. Area-weighted fine patch ~2 tiles is the
spatial half of the same scarcity.

`biomes.ts` forbids widening the niche to make Bloom common on fine. A
resolution correction that keeps the fine envelope bit-identical is not that.

## Hypothesis

Treat `93` as "the wet extreme on a 1-tile cell". On a coarse cell, the wet
extreme of the moisture field is lower (p90 65–80). A cellSize-aware floor
that restores Bloom's fine-tier scarcity (~0.2–1%) on coarse — measured, not
guessed — is the fix.

Do **not** relax the canopy-neighbour count or heat band on fine. Prefer a
single `bloomMoistureMin(cellSizeTiles)` used only when `cellSizeTiles > 1`,
defaulting to 93 at 1.

## Experiments

1. Probe coarse garden/crucible Bloom share vs moisture floor in
   `{93, 90, 85, 80, 75, 70}` (override hook or temporary).
2. Pick the floor that lands Bloom share within ~2× of fine (garden ~1.04%),
   without exploding (prototype rejected 3–6%).
3. Ship via `TileContext` / world cellSize readable from rules — **problem:**
   rules today don't see cellSize. Options:
   - (A) add `cellSizeTiles` to `TileContext` (world already has it)
   - (B) keep blooming() at 93; raise coarse moisture p90 by other means

Prefer (A): one gate, fine bit-identical at cellSize=1.

## Acceptance

- Fine goldens **unmoved**.
- Garden coarse Bloom share > 0 and within ~3× of fine (not ABSENT).
- Bloom-sourced unexplained one-sided on garden/crucible drop vs post-6 baseline
  (garden had 2 bloom rules in the structural list).
- ADR `0034`. Thresholds are spec 7's business — this spec may still leave the
  gate red on other rules.

## Scope

**In:** `biomes.ts` blooming moisture floor via cellSize on TileContext; `world.ts`
TileContext plumbing; wiki.
**Out:** widening fine niche; changing medianDays; threshold edits (spec 7).
