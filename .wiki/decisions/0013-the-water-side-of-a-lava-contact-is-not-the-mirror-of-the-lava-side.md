# 0013 — The water side of a lava contact is not the mirror of the lava side

Date: 2026-07-30
Status: accepted
Spec: `2915cb06-3_water-chemistry`
Decided by: `impl-water-chemistry-5c9a12`

## Context

`Lava -> Glass` "quenched to glass" has existed since the ruleset was written: a lava tile
with water beside it hardens, at median 2 with `pressure = waterNeighbours`. The water tile
was untouched. Before this spec there was **zero water↔lava traffic in either direction on
any preset** — lava could be quenched by the sea but could not fill it.

"Lava next to water should have a chance to solidify as some kind of land" is one half of a
contact that the ruleset already models from the other side, so the obvious implementation
is the symmetric mirror: same median, same pressure, endpoints swapped.

## Decision

**The mirror is not shipped. The water side is `pressure 1` at median 20, and the product
is basalt.**

```ts
from: Biome.Shallows, to: Biome.Basalt, medianDays: 20, label: 'the flow builds new land',
when: (c) => (c.neighbourCounts[Biome.Lava]! >= 1 ? 1 : 0),
```

Three choices, each measured:

**1. Pressure 1, not `lavaNeighbours`.** The pressure term is what makes `quenched to glass`
fast, and it is safe there because the lava tile is leaving anyway — it has four exits and a
~30-day unconditional backstop. On the water side there is no such backstop, so the pressure
term is a pure ratchet against a sea with no restoring force. The epic's prior analysis
measured the mirror shape (median 2, `pressure = lavaNb`) at **0.2909 pp of world per
game-year on `anvil`** with a **6.99 pp** sea drain over 30 game-years, against roughly
**6 pp of total headroom** to the runaway-drain knee. *(Those three figures are the prior
analysis's, taken before specs 1 and 2; they were not re-measured here and are cited as the
design constraint they are. Everything in the Evidence section below is from this tree.)*
The epic's per-edge ceiling is **0.05 pp/y**.

**2. `anvil` is the binding constraint, not `crucible`.** This is the non-obvious part and it
is why the shape was chosen against `anvil`'s numbers. `crucible` is the busiest world and
the one most measurements are taken on — and it actually has *more* lava/water contact (0.582
sea tiles with a lava neighbour per day against `anvil`'s 0.340, at 120×72). What makes
`anvil` bind is the other side of the ledger: **it has almost no opposing flux.** Gross
land→sea is **0.134 pp/y on `anvil` against 0.782 on `crucible`** — a factor of 5.8 — so the
same absolute rate of sea→land conversion is nearly six times as large relative to what
`anvil` can absorb. It is also the preset already drifting *landward*.

A shape tuned until `crucible` looked acceptable would therefore have shipped a rule running
at several times `anvil`'s entire opposing flux. Measured: `anvil` is the worst preset for
this edge (0.0270 pp/y) despite having less contact than `crucible` (0.0191).

**3. Basalt, not glass.** `quenched to glass` already covers the lava tile's own fate, so
reusing glass would make the contact produce two glass tiles and no new land. Basalt is what
a flow entering water actually leaves, it is `stone: true` so the sea undercuts it into
rubble rather than swallowing it whole (two steps, which is the ruleset's standing preference
for stone coastlines), and it keeps the new edge out of the `Shallows -> Glass` slot that
does not exist.

## Evidence

`120×72`, seed `20260729`, **60 game-years**, A/B against the identical tree with the rule's
`when` forced to 0. Because rule identity is content-derived (decision `0002`), a disabled
rule perturbs no other rule's dice — the `none` column reproduced the pre-edge trend
bit-for-bit on every preset, which is what makes these deltas attributable.

| preset | firings / 60 y | gross pp/y | net drift before | after | **attributable Δ** |
|---|---|---|---|---|---|
| anvil | 140 | 0.0270 | +0.0372 | +0.0197 | **−0.0175** |
| crucible | 99 | 0.0191 | +0.0540 | +0.0436 | **−0.0104** |
| kiln | 17 | 0.0033 | −0.0523 | −0.0525 | **−0.0002** |
| garden | 0 | 0.0000 | −0.0579 | −0.0579 | 0.0000 |
| still | 0 | 0.0000 | −0.0264 | −0.0264 | 0.0000 |

**Worst case 0.027 pp/y gross against a 0.05 ceiling**, and against the mirror's reported
0.2909 — **an order of magnitude**. `garden` and `still` are exactly zero because neither has
a route to lava at all, which is the cycle set deciding what chemistry a world has, exactly
as intended.

Lava/water contact on this tree, for the record — sea tiles with ≥ 1 lava neighbour,
tile-days per day at 120×72 over 5 game-years: **still 0.000, anvil 0.340, garden 0.000,
kiln 0.356, crucible 0.582.** The prior analysis's ordering (anvil highest) does not
reproduce; its figures could not be tied to a world size from here, so nothing in this
decision rests on them.

The sign is also favourable rather than merely tolerable: `anvil` and `crucible` are the two
presets already drifting *landward*, and this edge removes water, so it shrinks the two
worst existing ratchets instead of adding to them.

**Quench suppression, the coupling that is easy to miss.** The new edge competes with
`quenched to glass` for the same contacts, so enabling it must reduce quench firings and
could raise standing lava:

| preset | quench firings before → after | standing lava before → after |
|---|---|---|
| anvil | 1947 → 1863 (**−4.3%**) | 0.000% → 0.000% |
| crucible | 1591 → 1412 (**−11.2%**) | 0.625% → 0.625% |
| kiln | 634 → 501 (**−21.0%**) | 0.602% → 0.602% |

At the mirror shape the same measurement gave **−37% to −57%** on quench and **+7.7% to
+17.7%** on standing lava. Here standing lava does not move at three decimal places on any
preset: the suppression is real but the lava tile still has three other exits and its 30-day
backstop, so the rule steals contacts from `quenched to glass` without extending lava's
dwell time.

## Consequences

- **Water↔lava is now a two-way category**, and any future rule on that contact inherits
  the constraint: the sea side has no backstop, so it gets a flat pressure and a long
  median, while the lava side can afford a neighbour-scaled one.
- **New shapes on this contact must be measured against `anvil`**, not `crucible`.
- **`Shallows` gained a fourth sea→land exit** (`silt builds`, `mangrove takes hold`,
  `seabed bared`, and now this). It is the biome carrying the whole membrane, and it sits at
  0.88% of a `crucible` world — small enough that a rule which zeroes it would not move the
  sea share much. The flux ledger (decision `0012`) is what makes that visible.
- **`Ocean` deliberately has no equivalent.** A flow reaching deep water builds a seamount,
  not a coast, and `Ocean` tiles adjacent to lava are rarer still. If spec 5's rivers change
  where lava meets water, this is the assumption to re-measure.
