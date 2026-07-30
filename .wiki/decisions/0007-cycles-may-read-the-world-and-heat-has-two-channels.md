# 0007 — Cycles may read the world, and heat has two channels

Date: 2026-07-29
Status: accepted
Spec: `2915cb06-1_contract-and-beam`
Decided by: `impl-contract-beam-4f2a91`

## Context

Two things the disturbance engine could not express, both of which the rest of epic
`2915cb06` needs before it can be written.

**A cycle could not see the ground.** `dayState(day)` was a pure function of
`(worldSeed, key, day)` and nothing else. A weather system that steers around a mountain, a
storm that dies over land, a river that follows elevation — none of them can be written
against that signature. The stated justification for the restriction (`cycles.ts:41-45`) was
lazy fast-forwarding of unobserved regions: a region resolved on first contact after 400
quiet days must agree exactly with a server that simulated it day by day. That property was
already gone. `ARCHITECTURE.md` decision 10.1 abandoned it for terrain, which is stepped every
step at coarse resolution rather than reconstructed, so the contract was being defended on
grounds that had expired.

**Heat had one channel for two physically different things.** Spec `2915cb06-2` puts a thermal
filter on tiles so the sea's temperature can reach inland with a lag. A filter is the right
model for a season — a months-long forcing a coastline may legitimately lag behind. It is the
wrong model for a purge: under the blob beam a tile's `Focus` dwell can be a single day
carrying `heat + focusHeat` = +115 against a melt gate of 120, so low-passing it does not
soften the melt chemistry, it deletes it. One channel cannot be both filtered and not.

## Decision

**`dayState(day, view)`, where `view` is a `WorldView` — a four-member read-only window.**

```ts
export interface WorldView {
  readonly width: number;
  readonly height: number;
  biomeAt(col: number, row: number): number;
  moistureAt(col: number, row: number): number;
}
```

Deliberately not `World`. Handing a cycle the world would hand it `stepDay`, the biome array
and the hydrology constants, and a cycle that can step the world is a cycle that can recurse
into itself. `World` builds a plain object closing over itself (`world.ts`), so the affordance
is exactly those four members and nothing widens it by accident.

- **It is the grid as of the START of the day.** `dayState` runs once per day before the sweep
  touches a tile, so every cycle sees the same snapshot and cycle order stays irrelevant — the
  property that lets any cycle set compose. A cycle reading the grid from `affect` would see a
  half-stepped world and its answer would depend on where the gaze happened to be.
- **The five shipped kinds needed zero changes.** A one-parameter override satisfies a
  two-parameter abstract signature in TypeScript, verified under this repo's exact `tsconfig`
  (`strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`). `dayState(day: number)` still
  compiles and still means what it meant.
- **`readsWorld` is the declaration, defaulting to false.** Two things key off it and nothing
  else may: forecasts are labelled, and the catalogue advertises which of a GM's choices are
  schedules and which are weather.

**`CycleForecast.basis: 'exact' | 'projected'`.** A calendar-pure cycle's schedule *is* the
simulation, so its arrival day is a fact. A world-reading cycle's forecast assumed the terrain
stops changing, and it will not. This is a different axis from the existing `announced`, which
is about whether a world would *tell* a player: a quake is exact and unannounced, a storm front
is projected and visible.

**`Infinity` and `null` are answers, not failures.** Under the blob beam the track is periodic
and retraces itself every purge, so a tile it misses is missed for the life of the world. No
horizon however long will find an arrival. `forecast()` returns `null`, `World.daysUntilBeam`
returns `Infinity`, and callers must render "never" — not "unknown", not "not yet". The
horizon-sufficiency proof at `cycles.ts` was corrected rather than the behaviour.

**`CycleEffect.ambientHeat`, alongside `heat`.** `heat` is ACUTE and must bypass any filter;
`ambientHeat` is the slow seasonal channel that will pass through one. Until spec 2 exists
there is nothing to filter with, so `World` sums both into the same place and writing to
either is behaviour-identical.

**Nothing was moved onto the new channel in this spec.** `Seasons.affect` still writes `heat`;
it moves in spec 2. Moving it here would have changed worlds in the same commit whose job was
to prove nothing changed.

**`this.refreshCycles(0)` moved to after `this.generate(...)`.** It was the first statement of
the constructor, which was invisible only for as long as no cycle read the world: `dayState`
was about to be handed a view over a `biome` array that did not exist yet. A world-reading
cycle would either throw during construction or, worse, guard itself and silently resolve
day 0 against nothing.

## Evidence

**Both golden hashes are bit-identical after the whole contract change**, before the beam
default was touched: `still ea1caa9f367a0453`, `crucible f4bece63b740b9e2`. That is the point
of landing the plumbing on its own. The change adds a parameter to a hot-path-adjacent
signature, adds a field to the per-tile accumulator, and moves a constructor statement — all
three are the kind of edit that "looks equivalent"; the hashes are what makes "looks" into
"is". Had one tile moved it would have been a bug in the plumbing, not a world to re-baseline.

`npm run typecheck`, `npm run sim:check` green at the same commit point.

## Consequences

- **The purity contract is now weaker and should be described as such.** What survives is
  R-004 — same seed + same options ⇒ bit-identical world — and not the stronger "any day is
  computable without computing the days before it". Anyone reaching for lazy fast-forward
  should check `readsWorld` on the world's cycle set first; if any is true, the region must be
  stepped.
- **`DETACHED_VIEW` is the no-world case, and it is a signal rather than a crash.** `forecast()`
  is an API call that may run against a cycle held on its own, so `probe` defaults to a view
  with `width === 0`. A cycle with `readsWorld` MUST check for it; a cycle without never
  touches the view at all. The honest forecast for a world-reading cycle with no world is
  `null`, and the cycle returns that for itself rather than being handed a fake world.
- **`invariants.ts` check 9 now asserts the constructor calls `affect` zero times.** The check
  counts `affect` calls through a zero-effect observer cycle, so anything that evaluates the
  grid during construction lands in the same tally as a real day: one whole-grid pass during
  construction reports 3.667 evaluations/column/day over three days instead of 1.000. The
  instrument cannot tell construction from a sweep on its own, so the zero is asserted where
  the mistake would be made.
