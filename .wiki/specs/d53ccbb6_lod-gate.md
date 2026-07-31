# Epic d53ccbb6 — The LOD gate and a pure worldgen

Status: in progress
Target branch: `main`
Branch: `main--epic/d53ccbb6_lod-gate`

## Why this epic exists, and why it is not the caravan system

The user asked to begin the caravan system and chose the dependency-ordered path
(`ARCHITECTURE.md#13`) over a standalone movement kernel. That path does not start at
Phase 2. It starts here, and `ARCHITECTURE.md` says so in its own words:

> **Proves or kills the entire storage model.** If the coarse tier does not agree with the
> tile tier on rule activation and spatial statistics, everything downstream — lazy
> materialization, the beam forecast, `world_metric`, the supply model — is built on
> fiction. This is the one gate that can invalidate the architecture, so it comes before
> any database.

Caravans are Phase 5. Between here and there sit persistence (P2), the world-sim worker
(P3) and auth + the read plane (P4). This epic is the only one of the four that needs no
database, which is why it is the one that can start today.

**What this epic is really buying for caravans:** a caravan's route is re-validated at
region boundaries against terrain the world changed underneath it, and unmaterialized
regions are simulated at the coarse tier. If the coarse tier disagrees with the tile
tier, then a route quoted across unmaterialized ground is a quote against a world that
does not exist. Movement correctness is downstream of this gate.

## What was measured before this epic was written

Read-only re-measurement against `main` at `be3e44d`, 240×144, seed 20260729, 1500 days.
Script is not committed (throwaway harness; its output is the artifact).

**`ARCHITECTURE.md#4.6` "Required ruleset repairs" is four sessions stale, and three of its
four items are obsolete.** All four were measured at BRAINSTORM Session 8 — before rivers,
thermal inertia, weather, and the wandering sun. Re-measured:

| §4.6 claim | Re-measured | Verdict |
|---|---|---|
| Rock is a true absorbing state, 2.0% → 0.03%, "mathematically irreversible" | `garden` 1.733% → 1.319% (oscillating 0.767–6.635%); `crucible` → 1.296%. Mountain **grows**, 0.203% → 0.521% on `crucible` (max 0.738%) | **Does not reproduce** |
| Bloom has no hysteresis; structurally a transient | max 3.001% (`garden`) / 2.908% (`crucible`), oscillating across the run | **Does not reproduce** |
| Marsh is squeezed from both sides | climbs to 9.682% (`garden`) / 8.981% (`crucible`), still rising at day 1500 | **Reversed** |
| Ash/char/cinder unobtainable with the beam off | `garden` 0.000% at all 16 samples | **Reproduces** |

The Rock collapse reproduces on **`anvil` only** (Rock 1.733% → 0.038%, Mountain 0.203% →
0.023%), and that is not a defect: `anvil` is `[{ kind: 'solarbeam', transitDays: 60 }]`
with no tectonics, and **every** entry into Rock is gated on `CycleFlag.Quake`
(`biomes.ts:884`, `:888`, `:899`, plus the two `tectonic uplift` rules at `:1117`/`:1122`),
which only the Tectonics cycle raises. A beam-only world therefore has no path to Rock by
construction — which is `README.md` finding #4 working exactly as documented, not a bug.
§4.6's proposed repair, "add `Barren → Rock`", **already exists** at `biomes.ts:887`.

The surviving item — ash unobtainable without a beam — is `README.md` finding #4 again
("a garden world has no volcanic stone and must trade for it"). Moving ash to
`origin='salvage'` is an **economy** decision for Phase 7, not a sim repair, and it is
out of scope here.

**Consequence for this epic: the "apply the §4.6 ruleset repairs" line item is struck.**
It is recorded as `decisions/0028` rather than silently dropped, because the next agent to
read `ARCHITECTURE.md#13` Phase 1 will otherwise try to apply it again.

## The specs, in order

| # | Spec | File | Moves goldens |
|---|------|------|---------------|
| 1 | `worldgenAt(seed, col, row)` — pure, allocation-free, bit-identical | `d53ccbb6-1_pure-worldgen.md` | **no — that is the acceptance criterion** |
| 2 | The static `tectonic` channel | `d53ccbb6-2_tectonic-channel.md` | no (channel only; see held decision) |
| 3 | The 8×8 coarse CA over a coarse hex torus | `d53ccbb6-3_coarse-ca.md` | no (additive; tile tier untouched) |
| 4 | `lod-agreement` — the gate that can kill the storage model | `d53ccbb6-4_lod-gate.md` | no |
| 5 | Scale field-physics lengths with resolution (option 1 of `0030`) | `d53ccbb6-5_field-physics-scale.md` | no (fine tier unchanged) |
| 6 | Shrink season moisture-push on coarse (residual after `0031`) | `d53ccbb6-6_cycle-moisture-gain.md` | no |
| 7 | Escalate the three bad LOD thresholds | `d53ccbb6-7_escalate-thresholds.md` | no |
| 8 | Bloom moisture floor resolution-aware | `d53ccbb6-8_filament-bloom.md` | no |
| 9 | Residual structural M1 moisture extremes | `d53ccbb6-9_residual-structural-moisture.md` | no |

Sequential, not parallel. Spec 1 changes how every tile's day-0 state is produced and
specs 2–9 all build on it; running them concurrently would measure each against a moving
baseline, which is the mistake epic `2915cb06` documented at length.

**Spec 1 is a refactor whose proof is that nothing moved.** `npm run sim:golden` must
report both worlds unchanged at `still 3bc4c35b1b99adc7` / `crucible 406cbd9ca84e3e3f`. A
moved hash means the extraction changed the world and the spec has failed — this is the
one spec in this repo's history where R-010's "if the change was intended, `--update`" does
**not** apply, and the spec file says so.

## Standing constraints for every spec in this epic

- **`npm run typecheck`, `npm run sim:check`, `npm run sim:golden` green at every spec
  boundary.** Specs 1–4 must leave the golden hashes **unmoved**; none of them is
  authorised to run `--update`. If a spec believes the world must change, that is an
  escalation, not a re-baseline.
- **R-007 holds for the new modules.** The coarse CA and `worldgenAt` are stepping code and
  do no I/O. The `lod-agreement` lab is a harness — a caller — and may print.
- **R-006:** no enums, no parameter properties. `erasableSyntaxOnly` is on.
- **R-004:** the coarse tier derives all randomness from the same seed via `rollAt`. A
  coarse cell's roll stream must not collide with any tile's.
- **No new npm dependencies** (R-001). Nothing in this epic needs one.
- **The coarse tier runs the identical rule set**, not a summary of it. `ARCHITECTURE.md#4.1`
  is unambiguous that a mean-field proportion vector was measured into the ground: against
  a hard `waterNeighbours >= 3` threshold, real eligible tiles were **0** and mean-field
  predicted **9,702**. Any temptation to approximate is the failure this phase exists to
  prevent.

## Held decisions — the user's, not the epic's

**1. Does a static `tectonic` channel weaken the GM's difficulty dial?**
`ARCHITECTURE.md#4.6` wants the channel to produce "permanent mountain provinces that
reliably regenerate", and the economy needs it for province mineral suites. But every
route to Rock is currently Quake-gated, and that is exactly what makes `README.md` finding
#4 true — *"with no tectonics the transition graph has no path to `mountain` at all. The
GM's difficulty dial reaches all the way into the economy."* A `tectonic`-gated
`Barren → Rock` that fires without a Quake would give `anvil` mountains and soften that
dial.

Spec 2 is therefore scoped to **the channel only** — the field, its statistics, and its
exposure to `TileContext` — with **no rule reading it**, so goldens cannot move. Whether
any rule *should* read it is the user's call, and spec 2 must deliver the measured
tradeoff (Rock/Mountain share on `anvil` with and without) so the choice is informed.

**2. Phase 2 is blocked on this machine.** No Docker, no `psql`, no CI. Phase 2's stated
proof is "the DDL is executable (the persistence design's was not)", which cannot be
claimed without executing it (R-003). Native PostgreSQL 17 is the recommendation over an
in-process WASM Postgres, because Phase 3 tests leases, fencing tokens and `SKIP LOCKED`
across concurrent connections. A pg driver also needs an **R-001 amendment** — it ships
executable code, so the type-only devDependency exemption does not cover it. Neither is
needed until this epic's gate is green.

## Local deviation from the framework

Per `CLAUDE.md` there is no GitHub remote, so this epic squash-merges into `main` and stops
for user review rather than opening a PR.
