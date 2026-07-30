# 0010 — Maritime reach is a daily field, not neighbour diffusion

Date: 2026-07-29
Status: **superseded by `0026`** (2026-07-30) — the BFS field described below has been
deleted. **The measurement in it is still true and is still the reason not to write
`target = H + m·ā`; read it before proposing any neighbour coupling.** What `0026` changed is
narrower than "diffusion works after all": a *Laplacian* (`κ·(mean(T_nb) − T)`) vanishes in a
uniform region where the blend-toward-mean-anomaly form does not, so it cannot multiply the
global time constant and cannot latch the world the way the prototype below did. It also does
**not** reproduce this field's reach — measured 3 hexes and −23.60% at the shoreline against
this field's 4 hexes and −33.45%. The field was removed because it was measured to add
**0.16 pp** on top of the Laplacian, not because the Laplacian matched it.
Spec: `2915cb06-2_thermal-inertia`
Decided by: `impl-thermal-inertia-7b3c05`

## Context

Decision `0009` gives the sea a thermal lag. Getting that lag inland — "areas near water
should be influenced by the temperature of the water, areas further away less so" — is a
separate problem, and the obvious solution is wrong in a way that took a prototype to see.

## Decision

**Neighbour diffusion of temperature was prototyped and it LATCHES. It is not used.**

Diffusing the anomaly (`Θ = H + m·ā`, `ā` the neighbour mean) reduces, in any spatially
uniform region, to

```
T ← T + α(1 − m)(H − T)
```

The coupling weight multiplies the **global** time constant by `1/(1 − m)` — a 10× slowdown
of every tile on the map at m = 0.9, including tiles nowhere near water. Reach and inertia
are not independent knobs there. In any nearest-neighbour scheme `reach ≈ 0.5·√(α·τ)`, so a
3-tile reach *demands* a 36-day time constant on every land tile. It is structural, not a
tuning miss.

Measured on `garden` at m=0.9 / aW=0.06: ice annual max fell **36.3 → 31.3** against
`ICE_THAW` 28, **18.01% of sea-ice tiles never thawed in a year**, and invariant 8 latched
with `frozensea 2.53%` and `forest 2.30%` against a 2.00% limit. The absolute-temperature
variant was worse (`forest 2.79%`) and additionally exported the ocean's systematic −18
offset inland.

**Instead: one capped multi-source BFS out from every true-water tile, once per day**,
refreshed alongside `refreshCycles` in `World.beginDay`. Each land tile learns a live
distance `d` and `A`, the mean thermal anomaly of the water that reached it. A field
separates the two knobs completely — reach is the BFS cap, inertia is `alpha`.

```
w(d) = 0.6 · exp(−(d−1)/2),  zero beyond d = 6
d:     1     2     3     4     5     6
w:  0.60  0.36  0.22  0.13  0.08  0.05
```

**★ DAILY, NOT AT WORLDGEN.** A static field is free and wrong: 4.0% of the tiles inside the
maritime band changed water-distance over 260 days on `crucible`, and this epic exists to
make coastlines move considerably more than that.

**★ THE BFS IS PULL-BASED, WHICH IS WHY IT IS DETERMINISTIC.** R-004 names a multi-source BFS
as exactly the shape that violates determinism, so nothing here depends on discovery order.
Ring 0 is built by an ascending index scan into an `Int32Array` — no `Set`, no `Map`. A tile
discovered at ring `d` then computes its own anomaly by gathering ITS neighbours that sit at
ring `d−1`, in fixed direction order 0..5. Ring `d−1` is complete and frozen by then, so the
value written is a function of the biome array and yesterday's state alone — not of which
source happened to reach the tile first, and not of any float summation whose order could
vary. This is a stronger property than "deterministic": it is **order-independent**, so the
determinism does not have to be re-argued when the frontier representation changes.

The field is one-directional — land reads water, water reads nothing (`w(0) = 0`) — so there
is no loop to close, which is the other half of why decision `0009`'s no-latch argument holds.

## Evidence

**Cost: 0.306 ms/refresh** on `crucible` 240×144 at day 400, 2000 reps, against the spec's
0.26 ms prediction. That is ~2% of a 15.6 ms simulated day. The alternatives the spec priced:
a 3-ring per-tile gather cost 5.4%, and a static field costs nothing and is wrong. The BFS is
both the correct option and the cheap one.

**Coverage, measured on the same world: 8,174 water sources reach 4,758 land tiles — only
13.8% of the world is within 6 hexes of water.** 62% of the map never reads the field. The
coupling is genuinely coastal, not a global offset wearing a falloff.

**It delivers the gradient.** `garden`, 240×144, annual swing per tile over 360 days after a
720-day settle, latitude-stratified (six seasonal-weight buckets, common weights — raw band
means are confounded because coasts sit at different latitudes than interiors):

| band | swing before | after | change |
|---|---|---|---|
| d=1 | 23.77 | 20.82 | **−12.4%** |
| d=2-3 | 25.17 | 23.52 | −6.6% |
| d=4-7 | 26.16 | 25.67 | −1.9% |
| d≥8 | 25.56 | 25.46 | −0.4% |

Monotone, against a ≈−14% target at the shoreline. Coastal mean `|dT/day|` 0.169 → 0.141.
Mean heat 44.81 → 45.03 — lag moved, level did not.

**`w0` is spent out of invariant 8's headroom** and the trade is close to linear. At the
shipped 0.6, `garden` forest sits at 1.17% against the 2.00% limit; the prototype measured
1.19% at 0.6, 1.33% at 1.0 and 1.57% at the most aggressive safe setting. It is not a free
"more maritime climate" dial.

**The ceiling is the thaw window, and it was not approached.** Maritime moderation and sea-ice
break-up are the same number: warming a coast in winter is what makes ice; cooling its summer
is what stops ice melting. Baseline mean annual max over sea-ice tiles is 33.33 against
`ICE_THAW` 28 — 5.33 degrees — and this spends 1.52 of them (→ 31.81), with 0.00% of sea-ice
tiles failing to reach the threshold. `frozensea` still swings 0.31% – 12.56% and `glacier`
0.00% – 18.11% across 3000 days.

## Consequences

- **`World` now carries a per-day derived field, and `beginDay` is where per-day derived
  state goes.** It refreshes the cycles and then the field, in that order, because the field
  reads `temperature`/`heatBase` as they stood at the end of yesterday. Both are snapshots,
  which is what keeps a day's result independent of where the gaze is when a question is
  asked. Anything else derived per day belongs there and nowhere else.
- **`inspect()` triggers `beginDay` too.** It always did for cycles; it now also refreshes the
  field, so `invariants.ts` check 8 — which calls it for every tile every third day, after
  `stepDay` has already advanced the clock — reads the same field the next sweep will.
- **Reach cannot be raised without re-measuring invariant 8.** Reach is what decides how much
  of the map reads the field at all (13.8% at 6), and `w0` is what decides how hard. They are
  independent by construction, which is the whole point of the field, but both spend the same
  headroom.
- **A future "distance to the nearest X" field should reuse this shape**, not a per-tile
  gather and not a `Set`-based frontier. The pull-based ring average is what makes the
  determinism structural.
