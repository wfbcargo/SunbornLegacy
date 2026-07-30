# 0019 — A river is land: `water: false`

Status: accepted · Spec: `2915cb06-5` · Date: 2026-07-30

## Decision

`Biome.River` is `water: false`, `molten: false`, `moistureSource: 0`. It is therefore
excluded from `SEA`, from `waterNeighbours`, and from `TERRAIN_CLASS`'s `Sea` bit —
structurally, by predicate, without any of those places naming it.

It is still wet where wetness is a *land* question: it is counted in `wetNeighbours()` and
it pushes `+2` into the moisture diffusion target, exactly as marsh and swamp do.

## The counterfactual, measured

Keep `water: false` but count River in `waterNeighbours` (`world.ts`), 1500 days on
`crucible`, everything else identical (prototype, `main` at `b924a35`):

| | river = land (shipped) | river counted as water |
|---|---|---|
| river standing share | **1.14%** | **0.00% — the biome is annihilated** |
| water trend d150→d1500 | 23.7 → 24.0%, flat | 23.7 → **25.2%, still climbing** |
| entropy | 0.754 | 0.741 |

Two failures at once, and they are the same failure seen from two ends.

**The river drowns itself.** A chain tile has two river neighbours by construction, so at
any bend or confluence it reads `waterNeighbours >= 3` and its own mouth rule fires. The
predicate that makes a river linear is the same predicate that guarantees it is always at
the drowning threshold.

**And every tile it loses becomes `Shallows`** — permanent land→sea, a +1.5 pp water ratchet
in four game-years that had not converged, against a flat baseline. That is SIMULATION.md
bug #3 in a new costume, on a coastline the epic already established has no restoring force.

## Why this is a safety property and not a classification preference

`SEA` is `water && !molten`, derived from `BiomeDef`. `world.ts`'s neighbour gather tests
the same expression. `TERRAIN_CLASS` — the taxonomy spec 4's storm classifier reads through
`WorldView.terrainAt` — is built from the same predicate. So one flag, set correctly once,
keeps the river out of drowning, deposition, evaporation, subsidence, the maritime thermal
field, the sea-share instrument in `sweep.ts`, and the storm classifier, all at once.

`invariants.ts` makes a half-done version loud rather than silent: it fails any biome with
`moistureSource > 0 && !water`. So `moistureSource` must stay 0, and if someone "fixes" the
river to be a moisture source without making it water, the build says so.

## Verified as shipped, not merely asserted

Observed through the real `WorldView` a world-reading cycle is handed, `garden`, 1500 days:
**374,061 river tile-days, 0 classed `TerrainClass.Sea`**, terrain bitset 0 on every one.
`SEA` resolves to `ocean, shallows, frozensea`.

Water trend over 60 game-years at 120×72, with rivers present on three of five presets:
`still` −0.0264 and `anvil` +0.0197, both **bit-identical to the pre-river baseline** (those
two grow no rivers); `garden` −0.0328, `kiln` −0.0336, `crucible` +0.0426. The one land→sea
edge the biome adds, `the river widens its mouth`, costs 0.0012 / 0.0033 / 0.0027 pp/y
against a 0.05 pp/y per-edge ceiling.

## Consequences

- A river reads as a river *valley*, one tile wide at minimum. Consistent with `Mountain`
  already being a range.
- `River` must be in `HAND_DROWNED`, which excludes it from both `DROWNABLE` and
  `SUBSIDABLE`, or the derived fan-outs duplicate the hand-written mouth rule (invariant 3).
- Do **not** add a river branch to the `waterNeighbours` gather in `world.ts`. The table
  above is what that costs.
