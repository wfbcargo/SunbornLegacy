# 0029 — `tectonic` is a static channel, exposed raw, that no rule reads yet

Status: accepted · Spec: `d53ccbb6-2` · Date: 2026-07-30

## Decision

Worldgen gains a second static field, `tectonic` (0..1, 4 octaves of the same periodic
fbm), stored on `World` as a `Float32Array` written once and never again, and exposed to
the ruleset as a **raw** `TileContext.tectonic`. **No rule reads it.** Both golden hashes
are unchanged.

It exists for permanent mineral geography. `ARCHITECTURE.md#4.6`'s justification for it —
repairing a Rock collapse — was struck by `decisions/0028`, which measured that collapse as
not happening. What survives is the economy's need: `ARCHITECTURE.md#7.1` separates harvest
flows from permanent geology, and mineral country re-rolled every time the beam passes is
not geology.

## Why raw, when elevation is deliberately not

Decision `0018` hides elevation behind derived fields (`upstreamRiverNeighbours`,
`downhillNeighbours`) and says a rule must never threshold it directly. `tectonic` breaks
that pattern on purpose, and the reason is decision `0021`'s condition rather than
convenience: **a gate may read only what the feature cannot create.**

Elevation needs indirection because it feeds `heatOffset`, so a rule thresholding it sits
one step from a self-reinforcing loop — the albedo runaway with a longer fuse. `tectonic`
feeds nothing. Nothing in the stepping path writes it; no transition, cycle or feedback can
move it. That is a property of *this field*, not of static fields in general, and the next
static channel has to re-earn it.

## The octave count was measured, and the first guess failed the opposite way

The worry was salt-and-pepper — a high-octave field thresholding into speckles, so
"this range has always been iron country" would be false at the scale a caravan crosses.
So it started at 2 octaves. Connected components of the above-threshold set, 240×144,
seed 20260729:

| octaves | t=0.60 | t=0.70 |
|---|---|---|
| 2 | 35.77%, **1 component** | 17.01%, **1 component** |
| 3 | 31.69%, 2 | 11.15%, 2 (3742, 112) |
| **4** | 30.70%, 3 | **8.52%, 6 (1909, 877, 89)** |
| 5 | 29.90%, 5 | 7.10%, 9 (1537, 807, 55) |

Two octaves failed as a **supercontinent**, not a speckle: a third of the world above
threshold in one component means every mineral province touches every other, and regional
materials have no geography to be regional about. Four octaves breaks it into a large
craton plus genuinely separate provinces. Shipped at 4.

★ **One component dominates at every octave count**, which is a property of thresholding
fractal noise — level sets of smooth noise percolate — not a tuning failure. It also
resembles real continental crust: a few big cratons, a scatter of small ones. Many
similar-sized provinces would need a different construction (Worley cells), not a
different octave count.

The field is a **fraction-of-world** property, as the LOD design requires: at t=0.65,
octaves 4, the share above threshold reads 19.36% / 19.38% / 19.38% at 120×72, 240×144 and
480×288 on the same seed.

## The probe is pinned, not swept, and that was also measured

`reachability.ts`'s `makeContext` must fill every `TileContext` field or the satisfiability
probe runs against a malformed world. Sweeping `tectonic ∈ {1, 0}` outermost — permissive
value first, so satisfiable rules early-exit — was built, measured and reverted. Counted in
`rule.when()` invocations, which is deterministic where wall-clock on this machine was not
(identical runs varied more than 4×):

| preset | unsat rules | pinned | swept | ratio |
|---|---|---|---|---|
| `anvil` | 46 | 490,112,220 | 973,020,450 | **1.99×** |
| `garden` | 50 | 2,836,335,003 | 5,635,803,003 | **1.99×** |
| `crucible` | 0 | 51,966,809 | 51,966,809 | 1.00× |
| unrestricted | 0 | 51,966,809 | 51,966,809 | 1.00× |

The early exit protects only *satisfiable* rules; an unsatisfiable one runs both passes to
completion. `reachableCore` exists to probe **restricted** flag masks, where unsatisfiable
is the common case — so the sweep is free exactly where nothing needed it and doubles the
cost exactly where the 0.2–31 s is spent, which the viewer's `/api/reachability` waits on.

Pinned at the permissive value 1, as `downhillNeighbours` is pinned at 6. ⚠️ Sound only
while every rule reading it wants "more"; a `tectonic < T` gate would be probed against 1
alone and could be wrongly called unsatisfiable.

## What a `tectonic`-gated rule would actually buy — the held decision's evidence

Prototyped and reverted: `Barren → Rock`, medianDays 300, `when: c => c.tectonic > 0.70`.
`anvil` (beam only, no tectonics), 240×144, seed 20260729, 1500 days:

| | Rock day 0 | Rock final | Mountain day 0 | Mountain final |
|---|---|---|---|---|
| without the rule | 1.733% | **0.038%** | 0.203% | **0.023%** |
| with the rule | 1.733% | **0.489%** | 0.203% | **0.023%** |

**Rock is restored 13× and stabilises around 0.5% instead of decaying toward zero. Mountain
does not move at all.**

That is the finding that matters for the decision, and it is the opposite of the worry the
spec was written around. Every route into Mountain is gated on `Uplift` or `Quake`
(`biomes.ts:947`, `:951`, `:955`, `:962`, `:973`), so a tectonic-gated route to Rock cannot
produce a single mountain on a world with no tectonics cycle. `README.md` finding #4's
claim — *"with no tectonics the transition graph has no path to `mountain` at all"* —
**survives such a rule intact.** The GM's difficulty dial would be softened only for
building stone, not for granite, silver or skyquartz.

The rule is **not shipped**. This decision records what it would cost so the choice is the
user's and is informed; see `specs/d53ccbb6-2_tectonic-channel.md`.

## Consequences

- `WorldgenConfig` gains `tectSeed`, drawn **last** from the `mulberry32` stream. Appending
  leaves the first three seeds bit-identical; inserting anywhere earlier moves every hash.
- 4 bytes/tile, as `elevation`: 138 KiB at 240×144.
- `TileContext` gained a field, so `reachability.ts`'s `makeContext` had to fill it — the
  trap that file warns about in its own comment, and decision `0018` hit before.
