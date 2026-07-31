# Spec 60e8f1a2 — Soil fertility (biome lookup)

Branch: `main--epic/fc2c41c9_headless-loop-finish--spec/60e8f1a2_soil-fertility`
Epic: `fc2c41c9_headless-loop-finish`
Status: done

## Objective

Staffed `food_grower` throughput is gated by **local tile fertility** derived from
biome — no new sim channel, no golden churn. Farm sites on barren/glass/sea produce
nothing.

## Acceptance criteria

1. **`fertilityOf(biome): number`** in `terrain.ts` — integer 0…3.
   - 3: Soil, Bloom
   - 2: Grassland, Savanna, Forest, Rainforest, Marsh, Swamp
   - 1: Tundra, River, Ash (weak)
   - 0: everything else (sea, desert, rock, mountain, glass, lava, …)
2. **`produceAt`** deposits `PRODUCE_QTY * fertility` per interval when fertility > 0;
   fertility 0 → skip (unstaffed already skips).
3. **Investigate / state** show fertility at current tile.
4. **`npm run caravan -- --world`** prints fertility at spawn.
5. **`npm run typecheck` green.** Goldens unmoved.

## Scope

**May touch:** `src/caravan/**`, wiki notes.
**Must not touch:** `src/sim/**` arrays/stepping, goldens.

## Boundary decisions

- Lookup table only — real depleting soil scalar is a later sim epic (may rebaseline).
- Valid farm site ≡ fertility > 0 this slice.
