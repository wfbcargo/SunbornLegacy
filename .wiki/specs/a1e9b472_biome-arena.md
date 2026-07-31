# Spec a1e9b472 — Biome-derived arena terrain

Branch: `main--epic/70a8a238_battle-sim--spec/a1e9b472_biome-arena`
Epic: `70a8a238_battle-sim`
Status: done

## Objective

Generate per-hex arena features from the world tile's biome so small fights have
texture. Deterministic from `hash(tileIndex, biome, battleId)` — both sides and
replays see the same field.

Source: `BRAINSTORM.md` Session 12 ("Generate arena terrain from the world tile's
biome"). Epic: `.wiki/specs/70a8a238_battle-sim.md`.

## Acceptance criteria

1. **`src/battle/terrain.ts`** (no I/O): `generateTerrain({ biomeKey, battleId,
   tileIndex, width, height }) → TerrainField` with one feature per cell.
2. **Features:**
   | Feature | Effect |
   |---|---|
   | `open` | default |
   | `cover` | defender dodge += 0.15 (clamped ≤ 0.95) |
   | `mud` | after ending a move on mud, `moveReadyIn += 1` extra |
   | `block` | impassable — movement skips; never placed in deploy cols 0–3 / 6–9 |
   | `high` | abilities with `range ≥ 2` gain +1 range while attacker stands here |
3. **Biome profiles** (density targets, not exact counts — rolls fill them):
   - forest / rainforest → scattered `cover`
   - glass / desert / barren / ash → nearly all `open`
   - mountain / rock / basalt / badlands → `block` chokepoints + `high`
   - marsh / swamp / river → `mud`
   - other land → light `cover`; sea / lava / glacier → `open`
4. **`runBattle` / `runEngagement`** accept optional `terrain`. Default = all open
   (existing scenarios unchanged in outcome when terrain omitted).
5. **CLI:** `npm run battle -- --id <id> --biome forest --tile 0` prints a terrain
   summary line and uses that field.
6. **Caravan skirmish** passes current tile biome key + tile index into the arena.
7. **Determinism** holds with terrain. `typecheck` green; `sim:golden` unmoved.

## Scope

**May touch:** `src/battle/**`, `src/caravan/bridge.ts` (pass biome only), wiki.
**Must not touch:** `src/sim/` stepping / biomes authorship. Read-only biome **keys**
via string is fine; do not import transition rules.

## Boundary decisions

- Features are discrete hex tags, not a second CA.
- No LOS blocking this slice — cover is dodge only.
- Deploy cells never get `block` so authored placements stay valid.
