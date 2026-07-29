# Architecture

Full technical design: `ARCHITECTURE.md` (repo root, ~2000 lines, **cut off at BRAINSTORM
Session 8** — see its caveat). This file is the *current shipped shape*, which is much smaller.

## What exists today

Zero **runtime** dependencies, no build step. `typescript` and `@types/node` are type-only
devDependencies, erased at runtime (decision `0004`).

```
src/sim/          headless terrain simulator — TypeScript, Node 24 native TS
├── hex.ts        HexTorus: toroidal hex grid, neighbour offsets, index<->col/row
├── rng.ts        hash32 / rollAt / mulberry32 / hashString (FNV-1a over a string)
├── biomes.ts     22 biomes + 160 transition rules + climate thresholds.
│                 RuleDef (authored) and Rule (identity attached) are separate types;
│                 a rule's roll stream comes from its content-derived keyHash (decision 0002)
├── cycles.ts     WorldCycle subclasses (SolarBeam, Seasons, Tectonics, Volcanism,
│                 Monsoon), CycleSpec union, makeCycle(), CYCLE_PRESETS
├── world.ts      World — owns biome/moisture arrays, band sweep, stepDay()
├── report.ts     ASCII presentation + assessStability / NicheSampler (the two tests)
├── run.ts        CLI entry: argv -> World -> console report
├── invariants.ts transition-graph checks (single SCC, reachability, rule-key uniqueness)
├── golden.ts     golden-world hash gate — has the simulation drifted?
├── sweep.ts      cycle-parameter sweep harness
└── diagnose.ts   day-by-day trace of one disturbance cycle

src/viewer/       local world viewer — a DEV INSTRUMENT, not a product surface (R-009)
├── server.ts     node:http on 127.0.0.1 (hardcoded); /api/meta, /api/frame, /api/control;
│                 static assets served from an allowlist, not a path join
├── session.ts    owns the World, the playback timer, and a 600-day rolling sample window
├── palette.ts    xterm-256 -> RGB, so BiomeDef needs no hex-colour field
└── public/       plain-JS client (index.html, viewer.css, viewer.js). Deliberately .js,
                  so it sits outside tsc's include: ["src/**/*.ts"] — see conventions.md
```

## Data flow

`WorldOptions` → `new World()` → worldgen fills `biome`/`moisture` →
`stepDay()` advances a double-buffered band sweep (`bandWidth` columns per step,
`ceil(width/bandWidth)` steps per day) → cycles contribute additively into a reused
`CycleEffect` per tile → rules in `RULES_BY_BIOME[biome]` roll against
`rollAt(seed, tile, day, rule.keyHash)` — keyed on the rule's **content-derived identity**,
never its array position, so reordering `RULES` changes precedence only (decision `0002`).

## Boundaries

- **`World` is the read surface.** `world.grid` (HexTorus), `world.biome` (Uint8Array,
  one `Biome` id per tile), `world.moisture` (Float32Array), `world.day`, `world.stepDay()`.
  Anything rendering a world reads those; nothing reaches into private fields.
- **Simulation computes, callers present.** `report.ts` renders ASCII; `run.ts` parses argv;
  `src/viewer/` serves HTTP. No module under `src/sim/` that participates in stepping may do
  I/O (R-007). `run.ts`, `golden.ts`, `sweep.ts`, `diagnose.ts` and `invariants.ts` are
  harnesses — callers, not stepping code.
- **`src/viewer/` depends on `src/sim/`; the sim never knows the viewer exists.** One-way.
  The seam is the `World` read surface plus the exports of `report.ts`, `biomes.ts` and
  `cycles.ts`. Presentation policy stays viewer-side — the 600-day sample window and the
  ANSI→RGB palette both belong there, not in the sim.
- **The HTTP seam is name-frozen.** `StabilityVerdict` field names, plus `BiomeDef` fields
  and `CYCLE_PRESETS` keys, reach the browser verbatim as JSON. The typechecker cannot see
  across that seam, so renaming one breaks the client at runtime with no compile error.
  Adding fields is safe; renaming is not.
- **Determinism is a boundary, not a nicety.** All randomness derives from `seed` via
  `rollAt`. See R-004, and `gotchas.md` on engine-specific golden hashes.

## Direction of travel

Target shape is five deployable units over PostgreSQL (`ARCHITECTURE.md#1`). The next
structural step is extracting a reusable sim core with a pure `worldgenAt(seed, col, row)`
and no whole-grid allocation, so a server can materialize regions lazily
(`ARCHITECTURE.md#13` Phase 1). **No database yet** — the viewer runs the sim in memory.
