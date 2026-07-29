# Architecture

Full technical design: `ARCHITECTURE.md` (repo root, ~2000 lines, **cut off at BRAINSTORM
Session 8** — see its caveat). This file is the *current shipped shape*, which is much smaller.

## What exists today

```
src/sim/          headless terrain simulator — TypeScript, Node 24 native TS, zero deps
├── hex.ts        HexTorus: toroidal hex grid, neighbour offsets, index<->col/row
├── rng.ts        hash32 / rollAt / mulberry32 — all determinism flows through here
├── biomes.ts     22 biomes + 160 transition RULES + climate thresholds
├── cycles.ts     WorldCycle subclasses (SolarBeam, Seasons, Tectonics, Volcanism,
│                 Monsoon), CycleSpec union, makeCycle(), CYCLE_PRESETS
├── world.ts      World — owns biome/moisture arrays, band sweep, stepDay()
├── report.ts     ASCII presentation + assessStability / NicheSampler (the two tests)
├── run.ts        CLI entry: argv -> World -> console report
├── invariants.ts transition-graph checks (single SCC, reachability)
├── sweep.ts      cycle-parameter sweep harness
└── diagnose.ts   day-by-day trace of one disturbance cycle
```

## Data flow

`WorldOptions` → `new World()` → worldgen fills `biome`/`moisture` →
`stepDay()` advances a double-buffered band sweep (`bandWidth` columns per step,
`ceil(width/bandWidth)` steps per day) → cycles contribute additively into a reused
`CycleEffect` per tile → rules in `RULES_BY_BIOME[biome]` roll against `rollAt(...)`.

## Boundaries

- **`World` is the read surface.** `world.grid` (HexTorus), `world.biome` (Uint8Array,
  one `Biome` id per tile), `world.moisture` (Float32Array), `world.day`, `world.stepDay()`.
  Anything rendering a world reads those; nothing reaches into private fields.
- **Simulation computes, callers present.** `report.ts` renders ASCII; `run.ts` parses argv.
  No module under `src/sim/` that participates in stepping may do I/O (R-007).
- **Determinism is a boundary, not a nicety.** All randomness derives from `seed` via
  `rollAt`. See R-004.

## Direction of travel

Target shape is five deployable units over PostgreSQL (`ARCHITECTURE.md#1`). The next
structural step is extracting a reusable sim core with a pure `worldgenAt(seed, col, row)`
and no whole-grid allocation, so a server can materialize regions lazily
(`ARCHITECTURE.md#13` Phase 1). **No database yet** — the viewer runs the sim in memory.
