# 0016 — A storm classifies itself on geography, and dies on stone

Date: 2026-07-30
Status: accepted
Spec: `2915cb06-4_weather`
Decided by: `impl-weather-8a4d63`

## Context

A storm that morphs has to morph *against something*. The obvious signal — "is it wet
here" — is the one that cannot be used, and the reason is the shape of the loop rather
than the strength of the term.

## Decision

**Classify on `BiomeDef.water && !molten` — ocean, shallows, frozen sea. Never on
moisture, marsh or swamp.**

The epic's prior analysis measured both, 1500 days, rain share per 300-day window:

| classifier | rain share over time | entropy |
|---|---|---|
| `BiomeDef.water && !molten` | 28.4 · 28.4 · 38.3 · 30.9 · 21.1 % | 0.738 |
| `moisture > 60` | 80.1 · 99.3 · 93.4 · **100.0** · 94.8 % | 0.754 |

The wetness-gated storm LATCHES: it rains, the ground gets wet, so it rains forever. The
sea-gated one could not shift its own classifier's input at all — final water share 23.8%
against 23.9% across a 3× magnitude range — because a storm's rain does not manufacture
ocean. **That asymmetry is the whole safety argument, and it is structural rather than a
matter of degree.** It is the same shape as the albedo bug `world.ts:165-171` warns about
and the ice term that latched a world: a feedback gated on a quantity the feedback creates.

**As shipped, measured on this branch over 1800 days:**

| preset | rain share per 300-day window | first→last |
|---|---|---|
| `garden` | 38.4 · 26.5 · 24.8 · 37.6 · 34.0 · 34.1 % | −4.2 pp |
| `crucible` | 35.8 · 27.8 · 29.0 · 37.4 · 39.4 · 39.2 % | +3.4 pp |

Oscillating in a 25–39% band with no direction, against a ~60% latch line. Normalised type
entropy **0.973** on both — all six types stay in use rather than the vocabulary
collapsing onto one.

**Note for spec 5:** the river biome is deliberately `water: false`, and it must NOT feed
this classifier. A storm that makes rain that makes rivers that make the storm rain is the
same latch with an extra hop. `TerrainClass.Sea` is derived from `water && !molten`, so a
river stays invisible to it automatically — which is the second reason the predicate is
derived rather than a list of ids.

### Death is a run of lethal days, derived from the storm's own life

"The storm dies completely when passing another terrain" is a genuine death: once it has
happened the storm is gone for the rest of its life. An absorbing `alive` flag cannot be
inferred from a grid — the prior analysis measured one wrong for 2 of 3 storms at small K
— so death is DERIVED, by rescanning the storm's bounded life from birth against today's
grid and looking for `deathDays` consecutive days on which `deathFraction` of the seven
terrain probes were `Stone` or `Molten`.

Both numbers are measured. Mortality as a share of scheduled storm-days, `garden`, 1000
days:

|  | 3 days | 2 days |
|---|---|---|
| fraction 0.60 | 0.0% | 1.1% |
| fraction 0.45 | 0.0% | 1.1% |
| **fraction 0.30** | 1.8% | **10.2%** |
| fraction 0.15 | 12.1% | 22.6% |

At 0.45 and above, five of seven probes must land on hard ground at once and no world makes
a mass that solid — storms simply never died, at any duration.

**★ WHAT 0.30 / 2 BUYS IS A DEATH RATE THAT READS THE WORLD RATHER THAN THE PARAMETER.**
Measured over 1500 days at the shipped values:

| preset | scheduled | survived | killed by terrain |
|---|---|---|---|
| `still` | 3700 | 3689 | **0.3%** |
| `garden` | 3700 | 3360 | **9.2%** |
| `crucible` | 3700 | 2782 | **24.8%** |

Nothing in the code says "storms die more on a volcanic world". They die on stone and lava,
and a world with beam scars, basalt fields and live vents has more of both. The lethal set
is `stone || molten` and it is derived from `BiomeDef` for the same reason `Sea` is.

## Consequences

- **The classifier is not a knob a GM may turn onto moisture.** `TerrainClass` exposes
  three geographic predicates and no moisture at all, so the latch is not reachable through
  the configuration surface — the wet thresholds move *where* the ladder sits, never *what
  it reads*.
- **Storm mortality is a property of the cycle SET, not of the weather cycle.** A GM who
  adds volcanism gets shorter-lived storms for free, and one who plays the quiet control
  gets storms that never die. This is the same shape as "a world without tectonics has no
  mountains": the cycle set decides the physics.
- **`forecast()`'s only real failure mode is a storm that dies en route.** Measured, 400
  tiles at a 150-day horizon: 1 of 396 predicted arrivals on `garden` never came, 0 of 395
  on `crucible`, and zero arrivals were unpredicted on either. The rate is low because the
  mean forecast lead is 39 days and most storms do not live long enough to die first.
- **The probe rosette is fixed and type-independent.** Seven points at a parameterised
  spread, scaled at bind time. Sizing the probes by the storm's current radius would be a
  classifier reading its own output — a smaller loop than the moisture one, and the same
  species.
