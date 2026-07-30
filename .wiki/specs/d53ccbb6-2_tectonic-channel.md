# Spec d53ccbb6-2 — The static `tectonic` channel

Status: **done** — 2026-07-30
Epic: `d53ccbb6` · Target branch: `main--epic/d53ccbb6_lod-gate`

## Result

All six acceptance criteria met. Full reasoning and every table in `decisions/0029`.

- `npm run sim:golden` — **both worlds unchanged**; no rule reads the channel.
- `npm run typecheck` — clean.
- **Criterion 6 initially FAILED and the field was changed because of it.** At the
  2 octaves this spec started with, threshold 0.60 put 35.77% of the world above the line
  in **one connected component** — a supercontinent, not provinces. Shipped at 4 octaves:
  8.52% in 6 components at t=0.70, the largest three 1909 / 877 / 89 tiles. One component
  dominates at every octave count, which is what thresholding fractal noise does.
- Size-independence holds: 19.36% / 19.38% / 19.38% above t=0.65 at 120×72, 240×144,
  480×288 on one seed — the field is a fraction of the world, which is what the coarse
  tier will need.

**Criterion 3 was amended by its own measurement.** It asked that `satisfiable()` sweep
`tectonic`. Built, measured, reverted: the sweep costs **1.99×** on restricted flag
vocabularies (`anvil` 490M → 973M rule evaluations, `garden` 2.84B → 5.64B) and 1.00× on
`crucible`, because the early exit protects only satisfiable rules and `reachableCore`'s
expensive work is precisely the restricted masks where rules are unsatisfiable. Pinned at
the permissive value instead, with the trap documented. An initial wall-clock A/B was
discarded — `sim:check` varied more than 4× between identical runs on this machine, more
than the effect being measured.

## The held decision, now with evidence

Prototyped `Barren → Rock` at `tectonic > 0.70`, measured on `anvil`, reverted:

| | Rock final | Mountain final |
|---|---|---|
| without | 0.038% | 0.023% |
| with | **0.489%** (13×) | **0.023%** (unmoved) |

**The worry this spec was written around does not materialise.** Every route into Mountain
is `Uplift`/`Quake`-gated (`biomes.ts:947`–`:973`), so such a rule gives a beam-only world
building stone and **no mountains at all** — `README.md` finding #4 survives it intact. The
dial would soften for Rock only, not for granite, silver or skyquartz. Still the user's
call; the rule is not shipped.

## Objective

Add a static `tectonic` field to worldgen — permanent geography describing where the
world's crust is active — expose it to the ruleset, and **have no rule read it yet**, so
the golden hashes cannot move.

## Why it exists at all, now that §4.6 is struck

`ARCHITECTURE.md#4.6` asked for this channel to fix a Rock collapse that `decisions/0028`
measured as not happening. That justification is gone. What survives is the other one, and
it is the reason the channel is still worth building:

> Permanent mountain provinces that reliably regenerate — **which is also what province
> mineral suites need geographically.**

The economy (`ARCHITECTURE.md#7.1`) distinguishes harvest flows from permanent geology, and
regional materials are the supply curve the whole trade game rests on (`README.md` finding
#3). Mineral geography that is re-rolled every time the beam passes is not geology. A static
channel is how "this range has always been iron country" becomes true.

It is also the second static channel, after elevation, and the two are deliberately
independent: elevation says how high ground is, `tectonic` says whether it is *live*. A
world can have a high dead plateau and a low active belt.

## Acceptance criteria

1. `worldgenAt` produces a `tectonic` value in 0..1. `World` stores it in a `Float32Array`
   written once and never again, exactly as `elevation` is (decision `0018`).
2. `TileContext.tectonic` exists and `reachability.ts`'s `makeContext` fills it. That file's
   own warning applies: *"EVERY `TileContext` FIELD MUST BE FILLED HERE… a field added to
   the interface and forgotten here silently probes a malformed world."*
3. `satisfiable()` sweeps `tectonic` so a future gate on it is probed honestly, and the
   added cost of that sweep is **measured**, not assumed — `reachableCore` already costs
   0.2–31 s and the viewer waits on it.
4. **`npm run sim:golden` reports both worlds unchanged** (`still 3bc4c35b1b99adc7`,
   `crucible 406cbd9ca84e3e3f`). No rule reads the channel, so nothing may move. `--update`
   is not authorised.
5. `npm run typecheck` and `npm run sim:check` green.
6. **A measured province table** — for a range of thresholds: share of world above it,
   connected-component count, and largest/mean component size. The channel's whole purpose
   is coherent *provinces*; a field that thresholds into salt-and-pepper has failed even if
   it typechecks, and only a measurement can tell the difference.

## The seed must be drawn LAST

`worldgenConfig` draws `elevSeed`, `moistSeed`, `roughSeed` from one `mulberry32` stream.
Appending a fourth draw leaves the first three bit-identical; inserting one anywhere else
shifts every subsequent seed and moves every hash. Draw `tectSeed` **after** `roughSeed`.

## Exposing it raw is safe here, and the reason is not "it's fine"

Decision `0018` established that elevation is exposed only through *derived* fields
(`upstreamRiverNeighbours`, `downhillNeighbours`), never as a raw number a rule can
threshold. `tectonic` breaks that pattern deliberately, and the justification is
decision `0021`'s principle — **a gate must read only what the feature cannot create.**

Elevation needed indirection because it feeds `heatOffset`, so a rule thresholding it sits
one step from a self-reinforcing loop. `tectonic` feeds nothing. It is written once at
worldgen and read by nobody else; no biome transition, cycle or feedback can alter it. A
raw threshold on a field the simulation cannot move is exactly the safe case that
`downhillNeighbours` is the safe case of. Record this in the field's comment, because the
next person to add a static channel will read the elevation precedent and conclude the
opposite.

## Scope

**You may touch:** `src/sim/worldgen.ts`, `src/sim/world.ts`, `src/sim/biomes.ts`
(`TileContext` only — **no rule changes**), `src/sim/reachability.ts`, `.wiki/`.

**You may not touch:** any `RuleDef`. `golden.ts`'s expected hashes. `SIMULATION.md`,
`README.md`. No new npm dependencies (R-001), no enums (R-006), no I/O in stepping code
(R-007).

## The held decision this spec must inform, not settle

Whether any rule should gate on `tectonic` is **the user's call**, because it trades against
a shipped design property. Every route into Rock is currently gated on `CycleFlag.Quake`
(`biomes.ts:884`–`:1122`), and that is precisely what makes `README.md` finding #4 true:

> with no tectonics the transition graph has no path to `mountain` at all… **The GM's
> difficulty dial reaches all the way into the economy** — a garden world has no volcanic
> stone and must trade for it.

A `tectonic`-gated `Barren → Rock` that fires without a Quake would give `anvil` — a
beam-only world — mountains it currently cannot have, and soften that dial.

This spec therefore ships the channel unread, and **delivers the tradeoff as a prototype
measurement**: `anvil`'s Rock and Mountain share over 1500 days with and without such a
rule, against the `decisions/0028` baseline of Rock 1.733% → 0.038%, Mountain 0.203% →
0.023%. The prototype rule is measured and then **reverted**; it does not ship in this spec.
