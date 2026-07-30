# 0014 — Evaporation is gated on geometry; heat only picks the product

Date: 2026-07-30
Status: accepted
Spec: `2915cb06-3_water-chemistry`
Decided by: `impl-water-chemistry-5c9a12`

## Context

"Water that gets superheated should evaporate into desert." The literal reading is a rule
whose condition is a temperature: `Shallows -> Desert when heat > MOLTEN`. That rule cannot
be shipped, and the reason is structural rather than a matter of tuning.

`world.ts:188` gives every open-water neighbour **−3.0 heat**. Converting one water tile to
land therefore adds **+3.0** to every remaining adjacent sea tile, and **+4.2** when the
product is desert, which also carries the `+1.2` albedo term. For scale, the albedo bug that
sterilised a world was **+2.5**/neighbour and the ice-cooling term that latched one was
**−0.8**/neighbour. **The maritime term is larger than both**, and it is safe today only
because nothing in the ruleset converts water to land on the basis of heat.

A heat-gated evaporation edge is the wire that closes that loop, and the loop gain is greater
than one. The epic's prior analysis measured it: halving a world's sea by worldgen — same
ruleset — took above-threshold exposure from 10,807 to 16,827 sea-tile-days per year *while
the sea itself halved*, roughly **3.5× more exposure per remaining sea tile**. It latches.

*(That gain figure, the `−3.0`/`+1.2`/`+2.5`/`−0.8` coefficient comparisons above, and the
naive-probe costs quoted at the end of the Evidence section are the prior analysis's, taken
on `main` at `b924a35` before specs 1 and 2. They are cited as the design constraints they
are. Every table in the Evidence section was measured on this tree.)*

## Decision

**Ship it gated on GEOMETRY. Heat is a secondary condition whose only job is to decide the
product is desert rather than the rubble `seabed bared` leaves.**

```ts
from: Biome.Shallows, to: Biome.Desert, medianDays: 8, label: 'the shallows bake dry',
when: (c) => (c.waterNeighbours <= 2 && c.heat >= SCORCHING ? 1 : 0),
```

`waterNeighbours <= 2` is `seabed bared`'s gate, and it is chosen for one property: it is
**self-limiting**. Removing an isolated water tile does not manufacture more isolated water
tiles — its neighbours were already mostly land — whereas removing a hot tile heats the tiles
around it. Geometry is a brake; heat is an accelerator.

`Shallows` only. An `Ocean` tile with ≤ 2 water neighbours has ≥ 4 land neighbours and is
already being filled by `bay silts up`; a direct deep-water→desert edge would be a second,
faster ratchet on the same tiles.

## Evidence

**The gate population is the whole argument.** Shallows tile-days per day, 120×72, 10
game-years, seed 20260729:

| preset | shallows | `wn<=2` | `wn<=2 & h>=78` | `wn<=3` | `wn<=3 & h>=78` | hottest `wn<=2` tile |
|---|---|---|---|---|---|---|
| still | 52.9 | 0.086 | 0.000 | 43.0 | 0.000 | 70.0 |
| anvil | 111.1 | 0.170 | 0.024 | 42.9 | 1.448 | 182.6 |
| garden | 69.3 | 0.208 | 0.000 | 34.1 | 0.000 | 70.0 |
| kiln | 72.1 | 0.235 | 0.007 | 32.5 | 0.045 | 122.7 |
| crucible | 106.2 | 0.488 | 0.111 | 35.9 | 1.106 | 197.2 |

**One neighbour of relaxation multiplies the target population by 200–400×**, because
`wn == 3` is the ordinary coastal ribbon and `wn <= 2` is a genuinely cut-off pool. That is
not a gentle gradient with a safe setting somewhere in the middle; it is a cliff.

Measured cost, 60 game-years, same world, edge 1 held on throughout:

| gate | anvil pp/y | garden pp/y | anvil sea at y60 | garden sea at y60 |
|---|---|---|---|---|
| **`wn<=2`, `h>=78`, m8 (shipped)** | **0.0025** | **0.0000** | 24.99% | 20.34% |
| `wn<=2`, `h>=78`, m3 | 0.0046 | 0.0000 | 24.99% | 20.34% |
| `wn<=2`, `h>=50`, m20 | 0.0010 | 0.0019 | 24.99% | 20.29% |
| `wn<=3`, `h>=78`, m20 | 0.1271 | 0.0000 | **19.75%** | 20.34% |
| `wn<=3`, `h>=62`, m20 | 0.2110 | 0.0810 | **14.84%** | **15.38%** |
| `wn<=3`, `h>=62`, m8 | 0.3042 | 0.1119 | **11.15%** | **13.62%** |
| `wn<=4`, `h>=62`, m20 | 0.4373 | 0.1007 | **9.49%** | **14.35%** |

Against a **0.05 pp/y per-edge ceiling**: everything inside `wn <= 2` is 2–20× under it at
every heat threshold and median tested; everything outside is 1.6–8.7× over it. **Heat and
median are nearly free inside the geometry gate and ruinous outside it** — which is the
decision restated as a measurement.

The naive heat-gated version, for the record: `shallows→desert, heat>120, median 5` cost
**0.7986 pp/y** on `crucible`, and an all-sea variant at `heat>78` drained the ocean to
**0.01% in five game-years**.

**Median 8 is the largest safe relaxation, and it was taken.** On `crucible`, the worst
preset: m20 → 0.0098 pp/y, **m8 → 0.0199**, m3 → 0.0473. m3 is 95% of the ceiling with no
margin; 8 has 2.5×, and it matches the idiom — `seabed bared` sits at the same geometry gate
with median 5.

## Consequences

- **The feature is small, and on two presets it is exactly zero.** `garden` and `still` never
  produce a cut-off shallows tile hotter than **70.0** against a `SCORCHING` gate of 78, so
  the rule cannot fire there at all. That is the honest physical answer — a world with no
  purge and no vent does not superheat its sea — and it is not fixable safely: reaching
  `garden` needs either `h>=62` (0.0004 pp/y, still invisible) or `wn<=3` (0.0810 pp/y,
  **1.6× the ceiling**, and it drains `garden` 8.43 pp in 60 game-years). **There is no
  relaxation that makes this edge visible on a quiet world without breaking it.**
- **The rule's visibility is bounded by its population, not by its median.** Doubling the
  rate doubles the events and stays safe; widening the gate does not.
- **`heat >= SCORCHING` is doing product selection, not rate limiting.** If a future spec
  wants a cold version of the same geometry, the gate to copy is `waterNeighbours <= 2`, and
  the heat test is what it should vary.
- **The maritime `−3.0` coefficient is untouched and remains the largest single feedback term
  in the world model.** It was not changed here and this spec explicitly forbids changing it.
  The loop it would close is still open only by convention: **any future rule that converts
  water to land on a condition heat can influence re-opens it**, and must re-measure the
  exposure-per-remaining-sea-tile gain before shipping.
