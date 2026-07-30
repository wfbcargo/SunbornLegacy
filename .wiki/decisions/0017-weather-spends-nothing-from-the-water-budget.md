# 0017 — Weather spends nothing from the water budget, and buys texture rather than churn

Date: 2026-07-30
Status: accepted
Spec: `2915cb06-4_weather`
Decided by: `impl-weather-8a4d63`

## Context

Every spec in epic `2915cb06` draws on one shared account — 0.05 pp of world surface per
game-year per new edge, 0.125 pp/y in total — because the coastline membrane has no
restoring force and every new water↔land edge is a pure ratchet. And every spec has to say
what it does to liveness, because R-005 makes churn the load-bearing metric and the `still`
control must keep failing.

Weather adds six flags, three rules and a moisture term. This is the accounting.

## Decision

**Every rule weather touches is land→land. The cycle cannot move the coastline directly at
all.**

The three new rules:

| rule | gate |
|---|---|
| `barren → desert` *the wind drives the sand* | `Wind`, dry, a desert neighbour |
| `savanna → barren` *the gale strips the scrub* | `HeavyWind`, dry |
| `desert → barren` *the cloudburst guts the dune* | `HeavyRain`, wet |

**Wind's and cloud's only channel into the ruleset is `dryingBoost`**, which became three
independent factors multiplied — season × wind × shade:

```
season = Heatwave|Drought ? 2 : 1
wind   = HeavyWind ? 1.5 : Wind ? 1.25 : 1
shade  = HeavyCloud ? 0.5 : Cloud ? 0.75 : 1
```

Two things follow from that and both were checked rather than assumed. **Every rule
`dryingBoost` scales is land→land** (marsh→grassland, grassland→savanna, savanna→desert,
forest→grassland, soil→barren), so a gale cannot reach the water budget even indirectly
through a coastline rule. And **`wettingBoost` needed no new gate for heavy rain**, because
heavy rain raises the existing `Storm` flag — the ruleset's word for "standing water,
flooding, dissolution of glass" — so the wet-season rules fire under a cloudburst with
nothing re-gated. Plain `Rain` was added as a smaller push at 2.

**★ WIND CARRIES NO HEAT, AND THAT IS A HARD LINE.** A wind term on heat is a large,
spatially broad, neighbour-blind heat offset, which is the exact shape that sterilised this
world once at +2.5 albedo. Drying is what wind does that a rule can read, and `dryingBoost`
was already the idiom for it.

**Cloud is a SUPPRESSOR, not a cause.** Shade slows drying and does nothing else. A
suppressor cannot latch: cloud does not manufacture cloud, and the storm carrying it
classifies itself on geography (decision `0016`).

## Evidence

**Water budget, 120×72, 60 game-years, seed 20260729, measured as the difference between
the same cycle set with and without the `weather` entry in one process:**

| config | y0 | y40 | y60 | late pp/y (y40→y60) |
|---|---|---|---|---|
| `still` | 23.8% | 22.2% | 22.2% | +0.0000 |
| `weather-only` | 23.8% | 22.9% | 22.9% | +0.0000 |
| `garden` −weather | 23.8% | 20.9% | 20.3% | −0.0272 |
| `garden` +weather | 23.8% | 20.8% | 20.4% | **−0.0203** |
| `crucible` −weather | 23.8% | 25.9% | 26.3% | +0.0203 |
| `crucible` +weather | 23.8% | 26.3% | 26.4% | **+0.0029** |

Weather's own contribution: **+0.0000** (against the control), **+0.0069** (`garden`),
**−0.0174** (`crucible`). Inside the 0.05 per-edge ceiling by a factor of seven at worst,
and **all three move the late rate toward zero rather than away from it** — weather slows
`garden`'s drain and damps `crucible`'s flood. Projected to y200, `garden` improves from
16.5% to 17.6% sea and `crucible` from 29.1% to 26.8%.

The 40-game-year per-rule flux ledger confirms the structural claim directly: **no
weather-gated rule appears in the coastline flux list on any preset**, because none of them
crosses the sea boundary. `npm run sim:sweep` reports the membrane two-way on every set.

**The moisture ceiling `M·R² ≤ 300` is enforced by a throw in `Weather.onBind`**, not by
parameter bounds, because it is a constraint on a PAIR: R=14/M=1 is legal at 196 and
R=14/M=2 is not at 392. The shipped defaults sit at 6 × 7² = **294**. Land-moisture mean,
1500 days: `weather-only` **75.5** against a `still` floor of 74.0 and a `monsoon-only`
ceiling of 83.7 — weather adds +1.5 where a monsoon adds +9.7 — and on a full preset it
adds +0.6 to +0.7.

**★ Liveness: WEATHER IS NEUTRAL, AND THAT IS THE HONEST CLAIM.** 240×144, 1200 days:

| preset | entropy | churn % |
|---|---|---|
| `garden` | 0.699 → 0.701 | 2.95 → 2.94 |
| `crucible` | 0.749 → 0.750 | 3.56 → 3.56 |
| `still` | 0.651 → 0.651 | 0.06 → 0.06 — **still FAILS** ✓ |

Six travelling storms moved entropy by two thousandths and churn by nothing. This
reproduces the prototype's finding exactly. **Weather buys legibility and variety — a map
with rain crossing it, a forecast a caravan can read, and a reason the desert belt has a
texture — not disturbance.** Anyone who wants more churn should reach for a faster beam,
which is what `SIMULATION.md`'s two-knob finding has said since the prototype.

## Consequences

- **The graph gained exactly one edge: `savanna → barren`.** Live edges `garden` 98 → 99,
  `crucible` 129 → 130; every other preset unchanged. `sim:check` stays a single strongly
  connected component over all 22 biomes with all 165 rules satisfiable.
- **Every weather rule is gated on a flag only `weather` can raise**, so the reachable-core
  analysis stays honest on presets without it. This is deliberately the opposite of spec
  3's `shallows→basalt`, which carries no cycle flag and made the static count slightly
  optimistic on quiet presets.
- **`garden`'s escapability improved**, 9.05% → 8.55% of tiles with no live exit (forest
  1.17 → 0.95%, marsh 0.86 → 0.74%, grassland 0.78 → 0.66%). Storms give parked tiles a
  push that does not depend on the calendar.
- **Renaming `dryingBoost`'s factors is now dangerous in a way the labels are not.** Rule
  identity is content-derived (`ruleKey`), so changing a rule's `when` is free but changing
  its `label` re-keys it and changes the world. The three new rules' labels are load-bearing
  from the moment they shipped.
