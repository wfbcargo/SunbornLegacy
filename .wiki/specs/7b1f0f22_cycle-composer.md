# Spec 7b1f0f22 — Cycle composer and world sizing

Branch: `main--spec/7b1f0f22_cycle-composer` (standalone spec; epic `208817c9` is closed and merged)
Status: implemented by `impl-composer-3e91b7` — awaiting review

## Outcome

All eight criteria met, including the should-have. Verified in Chrome, not assumed: a set
composed by hand (beam + seasons + two monsoons out of phase + tectonics) regenerated at
320×192 seed 7, stepped to day 582 and reported ALIVE (churn 0.566%, entropy 0.708, 12
biomes above 1%), console clean.

**Nothing about any world changed.** `sim:golden` unchanged (`ea1caa9f367a0453`,
`f4bece63b740b9e2`), and `sim:check`'s reachable-core table is byte-identical after moving
that analysis into `src/sim/reachability.ts`.

The world-size constraints required by criterion 4 are recorded in **decision `0005`** and
enforced in `src/viewer/limits.ts`: height even (hard — `HexTorus` throws), **width a
multiple of 8** (measured: width 250 evaluates six columns twice a day, 1.024
evals/column/day, and nothing crashes), minimum 16×16, maximum 262,144 tiles bounded by
**step time** — 42.2 ms/day measured at the cap, so the top playback speed blocks the
event loop for ~127 ms per tick. The canvas is not the binding constraint: 98.2 Mpx at the
cap at maximum zoom, drawn in 48 ms.

Criterion 8 is delivered with its cost stated rather than hidden: the sweep is 0.2 s for all
five kinds, 4.7 s for none and 30.8 s for seasons + monsoon + tectonics, so it is an explicit
action, driven a rule at a time so the frame route stays live, and cached per flag mask. It
reports why each biome is out — *nothing creates it* / *permanent once formed* / *off the main
cycle* — because those are three different claims, and says plainly that it models cycle
KINDS and not parameter values: unreachable is a hard fact, reachable is a possibility.

## Objective

A world is configured, not chosen: any combination of cycles can be assembled in the
viewer, each cycle explains what it does to the world, and the world's dimensions are
set from the UI.

Source: user request — "each cycle has a description and I can pick multiple to run at
once. I also need to be able to set the world size."

## Why this is mostly surfacing, not building

The simulator already supports all of it. `WorldOptions.cycles` takes
`(CycleSpec | WorldCycle)[]` — arbitrary combinations, including two of the same kind
(`key` is per-cycle and seeds its own RNG stream, so "two monsoons differ").
`WorldOptions.width/height` already exist and `src/viewer/server.ts` already parses
`--width/--height`. `WorldCycle.describe(): CycleDescription` is implemented by all five
cycles. What is missing is the UI, and one honest description field.

## Acceptance criteria

1. **A cycle catalogue exists that does not require a world to exist.** The UI must list
   the available cycle kinds, their parameters, each parameter's default, and a
   description, *before* any world is built. `describe()` is an instance method, so it
   cannot serve this. Add a static, serialisable catalogue in `src/sim/cycles.ts`
   (one entry per kind: `kind`, `label`, `summary`, parameter list with defaults). The
   `DEFAULT_*_PARAMS` constants already hold the defaults — derive from them, do not
   re-type the numbers by hand.
2. **Every cycle kind has a real description**, added as `summary` to the catalogue and
   to `CycleDescription`. `label` today is a poetic phrase ("the cleansing sweep") —
   keep it, but `summary` is prose that says what the cycle *does mechanically* and what
   it *costs or unlocks*. Two to four sentences. **Mine the existing JSDoc**: the
   comments on `CYCLE_PRESETS.crucible`, `SolarBeamParams.transitDays/cycleDays`, and
   `BiomeDef.selfHeat` already contain the good material, written from measurements. Do
   not invent flavour text — this project's descriptions state consequences that were
   measured (R-003).
3. **The composer replaces the preset dropdown as the primary control.** Each of the
   five kinds can be toggled on or off independently; multiple instances of one kind can
   be added and removed; each instance's parameters are editable with defaults
   prefilled. Presets remain, demoted to a "load a starting point" action that populates
   the composer — after which any value can be changed.
4. **World size is settable** (width and height) with a regenerate. Invalid input is
   rejected with a message that says what the constraint is, not a silent clamp or a
   crash. Determine and enforce the real constraints yourself, then write them down:
   at minimum, latitude is a periodic band with a hot equator at row 0 and a cold band
   at row `H/2`, which makes odd heights suspect — verify what actually happens and
   handle it deliberately. Also establish an upper bound you have measured, and say what
   it is bounded by (step time, canvas size, or frame bytes).
5. **Cost is visible before it is paid.** Changing size or adding cycles changes step
   cost and frame size. Show the tile count and measured step time so a 480×288 world
   with five cycles is an informed choice. The viewer already measures step time.
6. **`npm run typecheck` passes; `npm run sim`, `sim:check`, `sim:golden` still pass.**
   Adding a catalogue must not perturb any world — a golden-hash change means you
   altered simulation behaviour, which is out of scope for this spec. If a golden hash
   changes, stop and escalate.
7. **Verified in a browser**, not assumed: compose a set by hand, regenerate at a
   non-default size, confirm the world steps and the descriptions read correctly. Report
   what you saw.

## Should-have (attempt it; escalate rather than force it)

8. **Show which biomes the selected cycle set can never produce.** This is the most
   useful description of a cycle set that exists, and it is *measured, not asserted*:
   `src/sim/invariants.ts` already computes reachability per preset and reports, e.g.,
   that with no tectonics there is no path to `mountain` at all, and with no volcanism
   and no beam, `lava`/`ash`/`basalt`/fertile `soil` are unreachable. Reuse that
   analysis for an arbitrary composed set and surface it in the composer.
   If it requires restructuring `invariants.ts` beyond extracting a reusable function,
   escalate with what you found instead of forcing it — a half-correct reachability
   claim is worse than none, because it would be believed.

## Scope

**May touch:** `src/viewer/**`, `src/sim/cycles.ts` (catalogue + `summary` only),
`src/sim/invariants.ts` (only to *extract* a reusable reachability function, criterion 8),
`.wiki/`, `package.json`.

**Must not touch:** simulation behaviour. No changes to how any cycle computes heat,
moisture or flags; no changes to rule keying, thresholds, or worldgen. This spec adds
description and control, and changes no outcome. The golden hashes are your guard: if
they move, you broke this rule.

## Frozen surfaces

`StabilityVerdict`, `BiomeDef` field names, and `CYCLE_PRESETS` keys are read across the
server→browser seam by name, and the typechecker cannot see that seam. Adding fields is
fine; renaming or removing is not.

## Notes

- Read `.wiki/specs/dd49a107_world-viewer.md` and `.wiki/decisions/0003` first — the
  viewer's canvas batching constant and its 600-day sample window cap are load-bearing
  and easy to break by accident when the world can change size.
- Resizing the world invalidates the sample history. `assessStability` compares
  proportions across samples; splicing pre-resize samples onto post-resize ones would
  report churn that never happened. Reset the history on regenerate.
- Two instances of the same kind is a real case the sim supports and the UI should not
  block: `key` is unique per cycle and seeds its RNG stream. Two monsoons out of phase
  is a legitimate world.
