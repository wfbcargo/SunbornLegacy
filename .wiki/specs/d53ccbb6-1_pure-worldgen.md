# Spec d53ccbb6-1 — `worldgenAt` is a pure function, and the world does not move

Status: not started
Epic: `d53ccbb6` · Target branch: `main--epic/d53ccbb6_lod-gate`

## Objective

Extract day-0 tile generation from `World.generate()` into a pure function that computes
one tile's worldgen state from `(seed, col, row)` plus the world's dimensions, with **no
whole-grid allocation**, and leave every golden hash exactly where it is.

## Acceptance criteria

1. A pure `worldgenAt(...)` exists in `src/sim/` and allocates nothing per call that scales
   with the grid. Calling it for a single tile must not require a `World`.
2. `World.generate()` is reimplemented as a loop over `worldgenAt`. The duplicate noise
   maths does not survive in two places.
3. **`npm run sim:golden` reports both worlds UNCHANGED** —
   `still 3bc4c35b1b99adc7`, `crucible 406cbd9ca84e3e3f`.
4. `npm run typecheck` and `npm run sim:check` green.
5. A property check: for a sample of tiles across a 240×144 world, `worldgenAt` agrees
   tile-for-tile with the arrays a freshly constructed `World` holds — biome, elevation,
   moisture, `heatOffset`, `moistOffset`. Not a spot check of three tiles; every tile of
   at least one world.

## ★ This is the one spec where a moved golden is failure, not news

R-010 says a golden failure "may be *correct* — it means the world changed", and prescribes
`--update` when the change was intended. **That escape hatch is closed for this spec.** The
entire content of this refactor is that behaviour is preserved; a hash that moves means the
extraction is wrong. This spec is **not authorised to run `sim:golden -- --update`** under
any circumstance. If the hashes move, escalate with the diff — do not re-baseline.

## What the code actually looks like now

`world.ts:915` `private generate(seaLevel)` is already almost pure per tile:

- Three seeds are drawn once from `mulberry32(this.seed ^ 0x5eed)` — `elevSeed`,
  `moistSeed`, `roughSeed`. A fixed sequence, independent of any tile. Derive these in a
  small helper so a caller can get them once and reuse them, or recompute them per call;
  either is acceptable, but **the draw order must not change** — `elev`, `moist`, `rough`,
  in that order — or every seed shifts and every hash moves.
- `fbm(col, row, seed, octaves)` and `periodicNoise` (`world.ts:992`, `:1009`) read only
  `this.grid.width` / `this.grid.height` off the instance. Nothing else.
- `seedBiome(elev, heat, moist, seaLevel)` (`world.ts:964`) is already pure.
- `latitudeHeat(row)` is the remaining instance read to check.

Per-tile outputs to reproduce exactly: `elevation`, `heatOffset`, `moistOffset`, `biome`,
`moisture`. Note `moisture` is seeded from `BIOMES[b].moistureSource` when that is > 0 —
`world.ts:948` explains why, and that branch must move across intact.

## ⚠️ `ARCHITECTURE.md`'s signature is incomplete — record this, do not silently fix it

Phase 1 specifies `worldgenAt(seed, col, row)`. That signature **cannot** reproduce this
world, because `periodicNoise` normalises by grid dimensions:

```ts
const gx = (col / this.grid.width)  * periodX;
const gy = (row / this.grid.height) * periodY;
```

The same `(seed, col, row)` therefore yields different terrain at 240×144 than at 512×512.
The function needs the world's dimensions. Take them explicitly (a `width, height` pair or
a small frozen config object) rather than reading a module global.

This is load-bearing beyond tidiness, and in two directions:

- **For the server**, world dimensions are fixed per world, so a per-world closure or
  config is the natural shape. `ARCHITECTURE.md#4.3` materialization calls this per tile of
  a region and must pass the *world's* dimensions, not the region's.
- **For spec 3's coarse tier**, this dependency is a gift rather than an obstacle: because
  the noise is normalised by grid size, sampling a `width/8 × height/8` grid walks the
  *same continuous field* at lower resolution rather than a different one. Do not
  paper over the parameter — spec 3 needs it.

Record the corrected signature in `.wiki/architecture.md`. It is a genuine error in
`ARCHITECTURE.md#13` Phase 1, not a matter of taste.

## Scope

**You may touch:** `src/sim/world.ts`, a new module under `src/sim/` if the extraction
warrants one, `.wiki/architecture.md`, `.wiki/decisions/` for a new entry if the extraction
turns up something durable.

**You may not touch:** `biomes.ts` rules, `cycles.ts`, `golden.ts`'s expected hashes,
`SIMULATION.md`, `README.md`. No new npm dependencies (R-001). No `enum` or parameter
properties (R-006). Nothing in the stepping path may do I/O (R-007).

**Out of scope:** the `tectonic` channel (spec 2), the coarse CA (spec 3), any change to
what a tile generates. Moisture staying `Float32Array` is fine here —
`ARCHITECTURE.md#13` Phase 0's "move moisture to u16 fixed-point" was never done, and it
would move every hash, so it is not smuggled into a refactor spec.

## Why this spec is first

Specs 2, 3 and 4 all build on it. The coarse CA needs to generate a coarse cell's day-0
state without allocating a fine grid, and lazy materialization in Phase 2 needs to generate
one region's 64 tiles without generating the world. Both are the same function.
