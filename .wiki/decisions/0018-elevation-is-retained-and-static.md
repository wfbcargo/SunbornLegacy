# 0018 — Elevation is retained as a field, and it never changes

Status: accepted · Spec: `2915cb06-5` · Date: 2026-07-30

## Decision

`World.elevation` is a `Float32Array` written once in `generate()` and never written again.
It is exposed to the ruleset only through two derived `TileContext` fields —
`upstreamRiverNeighbours` and `downhillNeighbours` — never as a raw number a rule can
threshold.

## Why it has to be stored

It looks recoverable from `heatOffset`, and it is not. That term is

    heatOffset = -34 * max(0, elev - 0.5) + (rough - 0.5) * 10

which is **flat for every tile below elevation 0.5** and, above it, contaminated by an
independent roughness field. Inverting it would give one constant for half the world and
elevation-plus-noise for the other half. A downhill gate fed by that is a *random* gate on
half the map, which is worse than no gate at all — see the growth figures below.

Cost: 4 bytes/tile. 138 KiB at 240×144, 983 KiB at the viewer's 640×384 ceiling.

## Why the gate is worth paying for

River growth is a branching process. Undirected, "extend into a neighbour" has mean
offspring above one: every tip forks three ways and nothing removes a direction. Elevation
makes it *directed on a field bounded below*, so every filament terminates at a local
minimum or at the sea.

Measured A/B at identical rates, 900 days on `crucible` (prototype, `main` at `b924a35`):

| | river share | components | longest |
|---|---|---|---|
| downhill gate **on** | **1.88%** | 193 | 34 |
| downhill gate **off** | **24.91%, still climbing** | 3189 | 77 |

With decay disabled to isolate growth: 1.30% with the gate against **32.63%** without, and
a longest component of 1959 tiles.

## Why it is static

Subsidence and orogeny move the **biome**, never the height. `ground subsides` writes
`Shallows` onto a tile whose elevation is unchanged; `uplift` writes `Mountain` the same
way. That is a deliberate modelling choice, not an omission.

A mutable elevation field feeding `heatOffset` would be a neighbour-blind, spatially broad,
self-reinforcing heat term — the albedo runaway that sterilised a world (SIMULATION.md bug
#4, +2.5/neighbour) with a longer fuse and no cap. Every other neighbour-dependent term in
`heatAt` is explicitly capped for that reason; an elevation feedback would bypass the cap by
acting through the static channel instead.

Nothing in the stepping path writes to `elevation`. That is the whole safety argument, and
it is checkable by grep.

## Consequences

- A world's drainage pattern is fixed at worldgen. Rivers re-form in the same valleys after
  a purge, which reads as geography rather than as randomness.
- `TileContext` gained two static-geography fields. Both had to be filled in
  `reachability.ts`'s `makeContext` as well, or the satisfiability probe runs against a
  malformed context.
- If elevation is ever made mutable, the downhill gate stops being a guarantee and river
  growth stops being bounded. Re-read the table above before considering it.
