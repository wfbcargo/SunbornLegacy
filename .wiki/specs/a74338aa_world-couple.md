# Spec a74338aa — Couple caravan to a live World

Branch: `main--epic/fc2c41c9_headless-loop-finish--spec/a74338aa_world-couple`
Epic: `fc2c41c9_headless-loop-finish`
Status: done

## Objective

Replace the 8×6 toy lab board with a small in-memory `World`. Travel respects biome
passability and move cost. Settling claims the tile (one settlement per tile).
Travelling auto-stalls when the soonest food deadline is reached.

## Acceptance criteria

1. **`region.ts`:** `makeRegion(seed)` builds `World` at **24×16**, `cycles: []` (still),
   finds a passable spawn tile, holds `settlements: Map<tileKey, caravanId>`.
2. **`terrain.ts`:** `passable(biome)` / `moveCost(biome)` / tile helpers — no I/O.
   Impassable: true sea (`water && !molten`) and lava/molten. Glacier cost high but
   passable. Costs are positive integers ≥ 1.
3. **Pathing** uses the world’s torus (wrap) and rejects impassable tiles. `commitLeg`
   snapshots `ticksPerTile = baseSpeed * maxEdgeCost` along the path (ceil).
4. **`settle` / `mobilise` / collapse** claim and free the caravan’s park tile in the
   region. Settle rejects if the tile is already claimed.
5. **Hunger stall:** when advancing to `step`, if travelling and any fitted character
   has `satedUntilStep <= step`, `stallAt` before starve/produce.
6. **API / manager Map** expose world size, per-tile biome key (full small map), and
   fertility placeholder ok. Starting caravan origin = region spawn.
7. **`npm run caravan -- --world`** prints seed, size, spawn biome, position.
   **`--path`** on world must refuse sea if present on route.
8. **`npm run typecheck` green.** `npm run sim:golden` unmoved.

## Scope

**May touch:** `src/caravan/**`, this spec, epic, architecture/glossary.
**Must not touch:** `src/sim/**` writes/stepping, goldens, `src/battle/**` resolution.

## Boundary decisions

- Still (no cycles) keeps the lab map stable across days; advancing world day is out
  of scope this slice (biome snapshot at gen is enough for path costs).
- Torus wrap matches `HexTorus`; path module grows a wrap mode rather than a second grid.
