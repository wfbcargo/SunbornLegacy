# 0021 — A nucleation gate reads only what the feature cannot create

Status: accepted · Spec: `2915cb06-5` · Date: 2026-07-30

## Decision

Both river springs are gated on **heat and static geography only**:

- `meltwater cuts a channel` — `heat > GLACIAL + 4`, no river neighbour, at least two
  downhill neighbours.
- `a spring rises` — at least two stone neighbours, no river neighbour, at least two
  downhill neighbours.

Neither reads moisture. This is the epic's standing constraint — *never gate a feedback on a
quantity the feedback can create* — applied to the feature that introduced it.

## What the moisture gate did

`a spring rises` was first written as the physically obvious thing: saturated ground against
bedrock, `moisture > SOAKED && stoneNeighbours >= 1`. A river pushes `+2` into its
neighbours' moisture diffusion target (the same channel marsh and swamp use), so a
moisture-gated spring is **a river manufacturing its own nucleation sites**.

It does not present as a runaway. It presents as a slow climb that looks like a long
equilibration, which is exactly why it is worth a decision file.

The first symptom was a **superlinear response to the linear dial**. Halving the spring
median from m30000 to m15000 — nominally a 2× change in nucleation — multiplied the standing
share by 2.9× on `garden` and 4.1× on `crucible`. Standing share is supposed to be linear in
spring density; the spec says so explicitly, and says to set abundance with density precisely
*because* it is the safe dial. It was not behaving linearly, which meant something else was
moving with it.

Tracking the family made the loop visible. 160×96, `garden`, 50-day trailing means — the
river and the marsh it springs from climb **together**, while the sea stays flat:

| day | 500 | 1000 | 1500 | 2000 | 2500 | 3000 | 3500 | 4000 |
|---|---|---|---|---|---|---|---|---|
| river | 2.30% | 3.06% | 5.82% | 4.23% | 5.01% | 6.36% | 6.23% | 9.47% |
| marsh | 7.66% | 7.28% | 14.33% | 5.80% | 10.96% | 12.12% | 7.80% | 13.63% |
| sea | 23.23% | 23.52% | 24.23% | 24.20% | 23.60% | 23.67% | 23.49% | 23.37% |

A flat sea beside a climbing river is the signature of an **internal** loop rather than a
coastline problem — which matters, because the coastline is where this epic's instrumentation
was pointed and it would have reported everything as fine.

## Why the moisture term itself was not the fix

Removing River from the `+2` diffusion term is the obvious response and it is the wrong one.
Measured at m15000 over 4000 days, share still climbed with the term removed — `garden`
0.78% → 2.64%, `crucible` 1.26% → 4.19%. The term is an **amplifier** (+26% at d4000), not
the cause. The cause is that a *gate* read a quantity the feature writes; the term is a
legitimate piece of physics and is kept.

## The other half: the decay structure

The same investigation found an unrelated defect worth recording beside it. `river → marsh`
was initially the *only* exit a temperate river had, at m300, which sets

    L* = 3 · p_g / p_d = 3 · (ln2/6) / (ln2/300) = 150 tiles

Filaments 150 tiles long are not rivers, and the share never settled. Adding the climate
complement — `the channel silts up` at m90 for `heat <= 60`, the exact mirror of `the river
warms to swamp` above it — brings the ratio to 12 and `L*` to ~35, and keeps m300 as an
unconditional escapability backstop.

## Result

With both fixes and springs at m12000, the share is **stationary over 20 game-years**
(7300 days, 160×96):

| preset | d730 | d1460 | d2190 | d2920 | d3650 | d4380 | d5110 | d5840 | d6570 | d7300 |
|---|---|---|---|---|---|---|---|---|---|---|
| garden | 1.94% | 2.24% | 1.54% | 1.72% | 2.61% | 2.26% | 2.65% | 1.56% | 1.60% | 1.74% |
| kiln | 1.52% | 1.51% | 1.58% | 1.94% | 2.66% | 2.08% | 2.18% | 1.39% | 0.72% | 0.84% |
| crucible | 1.80% | 1.52% | 0.51% | 1.61% | 4.01% | 2.44% | 2.54% | 2.08% | 0.91% | 0.84% |

Large oscillation, no trend. The residual `river → marsh → river` path survives — a river
still decays into ground a later spring could rise from — but with the amplifier out of the
gate its gain is ~0.002 river tiles per river tile, against the ~1.0 that would be a ratchet.

## The general rule

Before gating any nucleation rule, ask what the thing being nucleated *writes*. Heat,
elevation and biome-class geography are safe for rivers because a river changes none of them:
it carries `selfHeat: 0`, appears in no term of `heatAt`, cannot alter elevation
(decision `0018`), and cannot manufacture stone — its five exits are swamp, marsh, barren,
tundra and shallows. Moisture is not safe, and neither is anything derived from it.
