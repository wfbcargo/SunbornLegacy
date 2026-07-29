# Spec 495707fd — Make the simulator's numbers trustworthy

Branch: `main--epic/208817c9_world-viewer--spec/495707fd_sim-trust`
Epic: `208817c9_world-viewer`
Status: landed in epic 208817c9, pending merge to main

## Objective

Any number the simulator produces can be trusted, and a ruleset edit can no longer
silently re-key history.

Source: `ARCHITECTURE.md#13` Phase 0 (trust-critical subset only).

## Why this blocks the viewer

The viewer makes simulator output *visible*, which makes it *believed*. Shipping a
world viewer over an unchecked simulator turns a silent numeric bug into a
convincing picture. Phase 0 lands first for that reason.

## Acceptance criteria

1. **`npm run typecheck` exists and exits 0.** `typescript` added as a devDependency
   (this is the one sanctioned exception to R-001 — `ARCHITECTURE.md#13` Phase 0
   mandates it by name). Every type error surfaced by `tsc --noEmit` is fixed, not
   suppressed. `@ts-ignore`/`any` used to silence an error is a spec violation; if an
   error reveals a real design question, escalate instead.
2. **Every rule has a stable string key**, and `rollAt` is keyed on that key rather
   than on the rule's positional index in `RULES`. Reordering or inserting a rule must
   not change the outcome of unrelated rules. A uniqueness check over all rule keys
   runs in `invariants.ts` and fails loudly on collision.
3. **A golden-world hash test exists** — `npm run sim:golden` — that builds a world at
   a fixed seed, size, preset and day count, hashes the resulting biome array, and
   compares against a checked-in expected hash. It exits non-zero on drift and prints
   both hashes.
4. **`npm run sim`, `npm run sim:check` still pass**, with output pasted into the work
   log as evidence.
5. **Recorded numbers are re-measured.** Criterion 2 changes rule keying, so every
   world changes. `SIMULATION.md` and `README.md` numbers produced by an actual run are
   updated from fresh runs, and the fact that the re-key invalidated the old figures is
   stated explicitly. Do not carry forward a single unverified number (R-003).

## Scope

**May touch:** `src/sim/biomes.ts`, `src/sim/rng.ts`, `src/sim/invariants.ts`,
`src/sim/world.ts`, `package.json`, `tsconfig.json`, a new `src/sim/golden.ts`,
`SIMULATION.md`, `README.md`, `.wiki/gotchas.md`.

**Must not touch:** `src/viewer/**` (owned by the parallel spec `dd49a107`). The
`World` public read surface — `world.grid`, `world.biome`, `world.moisture`,
`world.day`, `world.stepDay()` — is **frozen**: a parallel sibling is building against
it. Changing it requires escalation, not a unilateral edit.

## Explicitly deferred (do NOT do these)

Moisture → u16 fixed-point, `acceptsU32`, the 8×8 coarse CA / LOD-agreement gate, and
`worldgenAt` extraction. Those are Phase 1 and belong to a later spec.

## Notes

- Rule keys should derive from stable content (e.g. `<fromKey>-><toKey>:<label>`),
  not from array position. `BiomeDef.key` already gives a stable biome name.
- Expect the biome composition to shift after the re-key. That is correct and expected
  — it is the old positional keying that was arbitrary. What must NOT shift is whether
  the world passes its liveness tests. If `crucible` stops passing or `still` stops
  failing, that is a finding — escalate, do not retune thresholds to hide it (R-005).
