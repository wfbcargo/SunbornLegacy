# Spec dd49a107 — Local world viewer

Branch: `main--epic/208817c9_world-viewer--spec/dd49a107_world-viewer`
Epic: `208817c9_world-viewer`
Status: landed in epic 208817c9, pending merge to main

## Objective

`npm run viewer` opens a browser view of a live Sunborn Legacy world: the hex map
renders in colour, time can be played/paused/stepped, and the liveness metrics update
as the world changes.

Source: `.wiki/decisions/0001-in-memory-viewer-before-persistence.md`.

## Acceptance criteria

1. **`npm run viewer` starts a server on `127.0.0.1`** (localhost only — R-009) and
   prints the URL. Zero npm dependencies; Node's built-in `node:http` only (R-001).
2. **The map renders as hexes on a `<canvas>`**, one hex per tile, coloured per biome,
   at the default 240×144 world without the page becoming unusable.
3. **Time controls work:** play, pause, single-step, and a speed control. While
   playing, the map visibly changes as cycles fire.
4. **Hovering a tile reads out** its column/row, biome name, and moisture.
5. **A metrics panel shows, live:** current day, entropy, late churn, largest biome +
   its share, and count of biomes above 1% — the same quantities `assessStability`
   reports, reusing `report.ts` rather than reimplementing them.
6. **The world is configurable from the UI**: seed, cycle preset (from
   `CYCLE_PRESETS`), and a reset/regenerate action.
7. **`npm run typecheck` passes** for the new code, and the viewer is verified by
   actually loading it in a browser — a screenshot or an explicit description of what
   rendered, not an assumption that it works.

## Scope

**May touch:** a new `src/viewer/**` tree, and `package.json` (to add the `viewer`
script only).

**Must not touch:** anything under `src/sim/`. A parallel sibling spec (`495707fd`)
owns that tree; edits there will collide at merge. If the viewer needs something the
sim does not expose, escalate — do not reach in and change it.

## The sim read surface you build against (frozen for this spec)

```ts
new World(opts: WorldOptions)   // width, height, seed, cycles?, seaLevel?
world.grid                      // HexTorus — width, height, size, index<->col/row
world.biome                     // Uint8Array, one Biome id per tile
world.moisture                  // Float32Array
world.day                       // number
world.stepDay()                 // advance one day
```
Plus from `report.ts`: `sample(world)`, `assessStability(samples)`, and from
`biomes.ts`: `BIOMES` (per-biome `key`, `name`, `glyph`, `colour`, `materials`), and
from `cycles.ts`: `CYCLE_PRESETS`.

## Boundary decisions already made (do not relitigate)

- **Colour conversion happens in the viewer, not the sim.** `BiomeDef.colour` is an
  ANSI-256 terminal code. Convert it to RGB with an xterm-256 palette table that lives
  under `src/viewer/`. Do NOT add a hex colour field to `BiomeDef` — `src/sim/` is out
  of scope and a sibling is editing it.
- **The client is plain HTML + JS served as static files.** No framework, no bundler,
  no build step — that is the whole project's runtime model (`.wiki/conventions.md`).
- **Frame transport should be binary**, not JSON-per-tile. The biome grid is one byte
  per tile (34,560 bytes at default size); send it as a raw body and read it as a
  `Uint8Array`. A JSON array of 34,560 numbers per frame is the obvious wrong turn.
- **The server owns the `World`; the client owns none of the simulation.** The client
  requests frames and renders them.

## Notes

- Measured baseline: 300 days at 240×144 took 1.45s (~7.1M tile-evals/sec), so a
  single `stepDay()` is roughly 5ms. Stepping on a server timer is comfortably viable;
  no need for workers or precomputation.
- `assessStability` wants a series of `Sample`s over time — keep a rolling history on
  the server as days advance, and note that it measures the tail, never one frame
  (`.wiki/gotchas.md`).
- This is a development instrument. It intentionally serves whole-world state, which
  the real API must never do (R-009). Do not add auth, accounts, or deployment.
