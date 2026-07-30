# Spec 2915cb06-3 — Water is two-way traffic

Epic: `2915cb06` · Status: in progress · Order: 3 of 6

## Objective

> "water pretty much doesnt change. I think we need to add more things that turn into water,
> and more ways to create land from water. For example lava next water should have a chance
> to solidify as some kind of land. And then water that gets super heated should evaporate
> into desert."

Two new water→land edges, plus the instrument that makes them safe to have:

1. **Lava beside water makes land** — the *water* tile solidifies, not just the lava tile.
2. **Superheated water evaporates to desert.**
3. **`sweep.ts` learns to see them.** Today it cannot.

## The budget this spec spends

The coastline membrane has **no restoring force**. Measured over 60 game-years across all
five presets: net drift is only 4–22% of gross flux, and the sea ends roughly where it
started — perturbing the day-0 sea level moves the 60-year end state from 0.00% to 91.23%,
so there is no attractor pulling it back. Headroom from the shipped equilibrium to the
runaway-drain knee is **≈6 pp of world surface**.

Reference rates, all measured:

| | pp of world / game-year |
|---|---|
| Today's worst net ratchet (crucible) | +0.054 |
| `shallows -> barren` "seabed bared", the existing heat-ish edge (crucible) | 0.022 |
| `sweep.ts`'s own fail threshold (5 pp / 40 y) | 0.125 |
| **Per-edge ceiling for this epic** | **0.05** |
| **Total new-edge ceiling for this epic** | **0.125** |

**Spec 2 already spent some of it.** Thermal inertia made `garden`'s membrane hungrier:
−0.1695 → **−0.2335 pp/game-year**, an attributable **−0.064 pp/y**, and it is a rate
difference, not a level shift (the gap widens 0.03 → 0.45 pp over 8.2 game-years). Budget
against `garden` as it is *now*, not against the epic's opening survey.

## Edge 1 — lava beside water makes land

Today `Lava -> Glass` "quenched to glass" (`biomes.ts:541`) fires with `pressure = waterNeighbours`
at median 2 — the lava tile hardens, the water tile is untouched. There is currently **zero**
water↔lava traffic in either direction on any preset; this spec creates the category.

**Do NOT write the symmetric mirror.** Measured over 30 game-years, a `water -> land` edge at
median 2 with `pressure = lavaNeighbours`:

| shape | anvil pp/y | kiln | crucible | anvil sea drift, 30 y |
|---|---|---|---|---|
| median 2, pressure = lavaNb (the mirror) | 0.2909 | 0.1269 | 0.2091 | **−6.99 pp** |
| median 6, pressure 1 | 0.1184 | 0.1057 | 0.0733 | −2.87 pp |
| **median 20, pressure 1** | **0.0347** | **0.0174** | **0.0247** | −1.10 pp |

`anvil`, not `crucible`, is the binding constraint — most lava/water contact (0.280 sea tiles
with a lava neighbour per day, against crucible's 0.172) and the least land→sea flux to
absorb it (0.0785 pp/y total). The mirror shape is **3.7× anvil's entire land→sea flux**.

There is also a coupling that is easy to miss: the new edge competes with `quenched to glass`
for the same contacts. At the mirror shape, quench firings fell 37–57% and standing lava rose
7.7–17.7%. At median 20 / pressure 1 the suppression is 7–31% and lava rises ~1.5%.

**Ship: `pressure 1`, median ≥ 20.** Expected ≈0.017–0.035 pp/y — inside today's net-ratchet
band and inside the per-edge ceiling.

The product should be **basalt**, not glass: `quenched to glass` already covers the lava
tile's own fate, and basalt is what a flow entering water actually leaves. Author it as a
hand-written rule on `Shallows` (and `Ocean` if you can justify the rate), not a fan-out.

## Edge 2 — superheated water evaporates to desert

★ **A heat gate closes a positive feedback loop whose gain is greater than one. Do not use
one as the primary condition.**

`world.ts:188` gives every open-water neighbour **−3.0 heat**. Converting one water neighbour
to land therefore adds **+3.0** to every remaining adjacent sea tile, and **+4.2** if the
product is desert or glass (the `+1.2` albedo term). For scale: the albedo bug that
sterilised a world was **+2.5**/neighbour, and the ice-cooling term that latched one was
**−0.8**/neighbour. **The maritime term at 3.0 is larger than both.** It is safe today only
because nothing converts water to land on the basis of heat — this edge is the wire that
would close the loop.

Measured gain: halving `garden`'s sea (by worldgen, same ruleset) took above-threshold
exposure from 10,807 to 16,827 sea-tile-days/year *while the sea itself halved* — roughly
**3.5× more exposure per remaining sea tile**. Gain > 1. It latches.

Measured cost of the naive version, crucible, 5 game-years:

| probe | pp/y | sea after 5 y |
|---|---|---|
| shallows→desert, heat>120, median 5 | 0.7986 | 21.68% (−3.44) |
| all-sea→desert, heat>120, median 5 | 3.7292 | 12.41% (−12.71) |
| all-sea→desert, heat>78, median 5 | 4.0926 | **0.01%** |

At any median in this ruleset's dramatic idiom (1–45 days) a heat-gated bulk evaporation edge
is **10–3,000× over budget**.

**Ship it gated on GEOMETRY, with heat secondary.** `seabed bared` (`biomes.ts:449`) already
does exactly this: `waterNeighbours <= 2`. That population is **0.00–0.02% of sea tiles**
against **0.09–0.95%** for `heat >= 120` — a 15–45× smaller target, and crucially it is
**self-limiting**: removing an isolated water tile does not manufacture more isolated water
tiles, whereas removing a hot tile heats its neighbours. Geometry is the brake; heat is what
decides the *product* is desert rather than barren.

The feature the user asked for is still delivered — shallow, cut-off, baking water dries to
desert — it is simply not permitted to run as a bulk area rule.

If the measured rate at the geometry gate comes out below ~0.005 pp/y, say so and propose the
largest safe relaxation with numbers; do not quietly widen the gate to make the feature more
visible.

## Edge 3 — make `sweep.ts` able to see any of this

`sweep.ts:43` hand-enumerates `SEA_SHARE = [Ocean, Shallows, FrozenSea]`, while `biomes.ts:267`
derives `SEA` from the predicate `water && !molten` — precisely because hand lists are "a trap
factory" (`biomes.ts:245-259`). **Spec 5 adds a water-ish biome and `sweep.ts` would not
notice it at all.** Import `SEA` from `biomes.ts`.

That is the minimum. `sweep.ts` is also blind in four other measured ways; fix what you can
justify and record the rest in this file as known gaps:

1. **Gross flux is never measured**, only the stock at 10-year marks. Two new edges moving
   5 pp/y in opposite directions net to zero and are invisible. `shallows` is already only
   0.88% of a crucible world — an edge could zero it with sea share flat.
2. **Transients are invisible** at decade sampling. Probes moved crucible 25.12% → 12.41%
   *inside a 5-year window*.
3. **It cannot distinguish "converged" from "draining forever."** Pass/fail is `|drift| < 5pp`
   at 40 y; a world draining at 0.12 pp/y passes and is dry at 200 y. Given there is no
   restoring force, that is the realistic failure mode, not a hypothetical.
4. **One worldgen point** (`seaLevel` 0.44). The *unmodified* ruleset fails its own 5 pp test
   at 0.37 (garden −5.41, kiln −4.83) and collapses at 0.30.

The per-rule flux ledger that produced the numbers in this spec is cheap and worth having:
replacing each `Rule.to` with a counting getter is an exact per-rule firing counter that
changes no arithmetic (`world.ts:437` reads `rule.to` only on the winning roll) and was
verified bit-identical. ~15 lines. Consider adding it as a diagnostic.

## Acceptance criteria

1. Both new edges exist and each reports its **measured net contribution in pp/game-year**,
   per preset, against the 0.05 per-edge ceiling. An edge that cannot state its number does
   not ship.
2. 60-game-year water trend for all five presets, before and after, showing no new ratchet.
   Report `garden` against its post-spec-2 baseline of −0.2335 pp/y.
3. `sweep.ts` derives `SEA` from the predicate, and its section C passes.
4. `npm run sim:check` all invariants hold, including invariant 8 and the single-SCC check.
5. `still` still FAILS (R-005). `crucible`, `garden`, `kiln`, `anvil` still pass.
6. Quench suppression reported: how much did `quenched to glass` firings and standing lava
   share move?
7. `npm run typecheck` green; goldens updated with `--update` and new hashes recorded here.

## Explicitly NOT in this spec

Rivers (spec 5), storms (spec 4), any change to `ICE_FORM`/`ICE_THAW`, the polar seasonal
amplitude, `world.ts`'s maritime coefficient, or the `+1.2` albedo cap. If the analysis says
the maritime `-3.0` is the real problem, **say so and escalate** — do not change it here.
No new biome.

## Measured

Implemented by `impl-water-chemistry-5c9a12`. Everything below is from a run on this tree.

**★ THE NUMBERS IN THE SECTIONS ABOVE WERE TAKEN ON `main` AT `b924a35`, BEFORE SPECS 1
AND 2.** They were treated as design constraints and every one that is restated as a
current fact was re-measured. Two of them did not survive: see "Corrections" at the end.

### What shipped

| | edge | rule |
|---|---|---|
| 1 | lava beside water makes land | `shallows → basalt` "the flow builds new land", **median 20, pressure 1**, `lavaNeighbours >= 1` |
| 2 | superheated water evaporates | `shallows → desert` "the shallows bake dry", **median 8**, `waterNeighbours <= 2 && heat >= SCORCHING` |
| 3 | the sweep can see them | `SEA` imported from `biomes.ts`; per-rule flux ledger; late-rate column |

Decisions `0012` (the ledger and the derived `SEA`), `0013` (why edge 1 is not the mirror),
`0014` (why edge 2 is gated on geometry).

### AC1 — per-edge net contribution, against the 0.05 pp/y ceiling

120×72, seed 20260729, **60 game-years**. A/B against the identical tree with the rule's
`when` forced to 0. Because rule identity is content-derived (decision `0002`), a disabled
rule perturbs no other rule's dice — the `none` column reproduced the pre-edge trend
**bit-for-bit on all five presets**, which is what makes these deltas attributable rather
than merely correlated.

**Edge 1 — `the flow builds new land`:**

| preset | firings / 60 y | gross pp/y | net drift before | after | **attributable Δnet** |
|---|---|---|---|---|---|
| anvil | 140 | 0.0270 | +0.0372 | +0.0197 | **−0.0175** |
| crucible | 99 | 0.0191 | +0.0540 | +0.0436 | **−0.0104** |
| kiln | 17 | 0.0033 | −0.0523 | −0.0525 | **−0.0002** |
| garden | 0 | 0.0000 | −0.0579 | −0.0579 | 0.0000 |
| still | 0 | 0.0000 | −0.0264 | −0.0264 | 0.0000 |

**Worst case 0.0270 pp/y gross against the 0.05 ceiling** — and against the 0.2909 pp/y the
mirror shape cost. `garden` and `still` are exactly zero: neither has any route to lava.

**Edge 2 — `the shallows bake dry`** (measured with edge 1 held on throughout):

| preset | firings / 60 y | gross pp/y | Δnet |
|---|---|---|---|
| crucible | 103 | **0.0199** | −0.0021 |
| anvil | 13 | 0.0025 | 0.0000 |
| garden | 0 | **0.0000** | 0.0000 |
| still | 0 | **0.0000** | 0.0000 |

`kiln` was not run through this 60-game-year A/B; its figure comes from the `sim:sweep`
ledger below — **3 firings in 40 game-years, 0.0009 pp/y**.

**Worst case 0.0199 pp/y against the 0.05 ceiling.** Combined worst-preset total for both
new edges: **crucible 0.0399 pp/y gross against the 0.125 total ceiling.**

Cross-check from a completely separate harness — `npm run sim:sweep`'s own ledger, 40
game-years — agrees: edge 1 anvil 0.0249 / crucible 0.0200 / kiln 0.0055; edge 2 crucible
0.0229 / anvil 0.0029 / kiln 0.0009.

**★ EDGE 2 IS NEARLY INVISIBLE, AND THAT IS BEING REPORTED RATHER THAN FIXED.** It is below
the spec's ~0.005 pp/y "nearly invisible" line on four of five presets and exactly zero on
two. The gate population is the reason, and it is a cliff rather than a slope — shallows
tile-days per day, 10 game-years:

| preset | shallows | `wn<=2` | `wn<=2 & h>=78` | `wn<=3` | hottest `wn<=2` tile |
|---|---|---|---|---|---|
| still | 52.9 | 0.086 | 0.000 | **43.0** | 70.0 |
| anvil | 111.1 | 0.170 | 0.024 | **42.9** | 182.6 |
| garden | 69.3 | 0.208 | 0.000 | **34.1** | 70.0 |
| kiln | 72.1 | 0.235 | 0.007 | **32.5** | 122.7 |
| crucible | 106.2 | 0.488 | 0.111 | **35.9** | 197.2 |

**One neighbour of relaxation multiplies the target by 200–400×**, because `wn == 3` is the
ordinary coastal ribbon and `wn <= 2` is a genuinely cut-off pool. Measured cost of every
relaxation considered, 60 game-years:

| gate | anvil pp/y | garden pp/y | crucible pp/y | worst sea at y60 |
|---|---|---|---|---|
| `wn<=2 h>=78` **m8 — shipped** | 0.0025 | 0.0000 | **0.0199** | 24.99% |
| `wn<=2 h>=78` m20 | 0.0006 | 0.0000 | 0.0098 | 24.99% |
| `wn<=2 h>=78` m3 | 0.0046 | 0.0000 | 0.0473 | 24.99% |
| `wn<=2 h>=50` m20 | 0.0010 | 0.0019 | 0.0122 | 24.99% |
| `wn<=3 h>=78` m20 | **0.1271** | 0.0000 | **0.0847** | anvil 19.75% |
| `wn<=3 h>=62` m20 | **0.2110** | **0.0810** | **0.2166** | crucible 12.99% |
| `wn<=3 h>=62` m8 | **0.3042** | **0.1119** | **0.3071** | crucible 10.63% |
| `wn<=4 h>=62` m20 | **0.4373** | **0.1007** | **0.4190** | crucible 7.97% |

**The largest safe relaxation was taken: median 20 → 8.** That doubles the events (crucible
0.0098 → 0.0199) at 2.5× margin under the ceiling, without touching the geometry gate.
Median 3 was rejected at 0.0473 — 95% of the ceiling, no margin. Median is also the *only*
safe lever: `wn<=3` is 1.7–8.7× over the per-edge ceiling on every live preset.

**There is no safe way to make it visible on `garden` or `still`.** Their hottest cut-off
shallows tile ever reaches **70.0** against a `SCORCHING` gate of 78, so the rule cannot
fire at all. Reaching them needs either `h>=62` (0.0004 pp/y — still invisible) or `wn<=3`
(0.0810 pp/y, 1.6× the ceiling, drains `garden` 8.43 pp in 60 game-years). The honest
physical reading is that a world with no purge and no vent does not superheat its sea, and
the feature is correctly tied to the disturbance engine. **Delivered small, and said so.**

### AC2 — 60-game-year water trend, before and after, all five presets

120×72, seed 20260729. "pp/y" is end-minus-start over 60 game-years.

| preset | before (sea % at y0→y60) | pp/y | after | pp/y | **Δ** |
|---|---|---|---|---|---|
| still | 23.81 → 22.22 | −0.0264 | 23.81 → 22.22 | −0.0264 | **0.0000** |
| anvil | 23.81 → 26.04 | +0.0372 | 23.81 → 24.99 | +0.0197 | **−0.0175** |
| garden | 23.81 → 20.34 | −0.0579 | 23.81 → 20.34 | −0.0579 | **0.0000** |
| kiln | 23.81 → 20.67 | −0.0523 | 23.81 → 20.66 | −0.0525 | **−0.0002** |
| crucible | 23.81 → 27.05 | +0.0540 | 23.81 → 26.30 | +0.0415 | **−0.0125** |

**No new ratchet on any preset, and the two worst existing ones got smaller.** `anvil` and
`crucible` were the two presets drifting *landward*; both new edges remove water, so they
partially cancel the pre-existing flood rather than adding to a drain. `garden` and `still`
are unchanged to four decimal places because neither edge can fire there.

**`garden` against its stated post-spec-2 baseline.** The spec records `garden` at
**−0.2335 pp/game-year**. Re-measured on this tree it is **−0.0579 pp/y** over 60
game-years, and **−0.0231 pp/y** over y10→y60 with the worldgen transient excluded. The
−0.2335 does not reproduce at this horizon — see "Corrections". What this spec is
accountable for is the delta, and the delta is **0.0000**: `garden` has no lava and never
superheats a cut-off pool, so both new edges fire zero times on it.

### AC3 — `sweep.ts` derives `SEA`, and section C passes

`SEA_SHARE` is now `SEA` from `biomes.ts` (`water && !molten`), so spec 5's water-ish biome
joins the measurement automatically. `npm run sim:sweep`, 120×72, 40 game-years:

```
  preset            y 0    y10    y20    y30    y40     drift    late pp/y   → y200
  still           23.8%  22.2%  22.2%  22.2%  22.2%   ✓  -1.6pp     +0.000     22%
  anvil           23.8%  24.3%  25.1%  25.5%  25.2%   ✓  +1.4pp     +0.004     26%
  garden          23.8%  21.5%  21.3%  21.0%  20.9%   ✓  -2.9pp     -0.021     18%
  kiln            23.8%  22.2%  22.2%  21.9%  21.0%   ✓  -2.8pp     -0.061     11%
  crucible        23.8%  24.2%  25.3%  25.2%  25.9%   ✓  +2.1pp     +0.028     30%

  ✓ the coastline is a two-way membrane on every cycle set
```

**Section C passes on all five presets.** Two of the four listed blindnesses were fixed:

- **#1 gross flux** — a per-rule ledger now prints beside the stock, at no extra runtime.
  Measured net as a fraction of gross: **crucible 3.4%**, kiln 7.4%, garden 11.9%, anvil
  14.7%, still 57.8%. On the busiest world the sea share is the 3% residue of two flows 20×
  its size, so the stock alone was very close to uninformative there.
- **#3 converged vs draining forever** — a `late pp/y` (y20→y40, transient excluded) column
  and a y200 projection. It earned its place immediately: **`kiln` projects to 11% sea at
  y200 and `garden` to 18%, while both pass the ±5 pp drift test comfortably.** Neither is
  caused by this spec — the pre-edge baseline has the same rates (kiln −0.0523, garden
  −0.0579 pp/y over 60 game-years). The ±5 pp verdict was deliberately **not** changed:
  a new merge gate is not this spec's to add.

**Known gaps, left as gaps:**

- **#2 transients are still invisible** between decade marks. The late-rate column narrows
  this but does not close it; a 5-year excursion still hides.
- **#4 one worldgen point** (`seaLevel` 0.44). Not re-measured here. The pre-spec analysis
  found the *unmodified* ruleset failing its own 5 pp test at 0.37 and collapsing at 0.30,
  so this is the largest remaining blind spot in the instrument and it is pre-existing.
- The ±5 pp verdict still ignores the late rate it now prints. Making the late rate a gate
  would fail `kiln` today, on a drain this spec did not introduce. That is a decision for
  spec 6 or the user, not for this spec.

### AC4 — `npm run sim:check`

**✓ all invariants hold**, including the single-SCC full-flag graph. Escapability
("no live exit"), against a 2% per-biome limit:

| preset | before | after |
|---|---|---|
| still | 92.37% (control, expected) | 92.37% |
| anvil | 13.60% (ocean 13.56%) | **13.54%** (ocean 13.51%) |
| garden | 9.05% | 9.05% |
| kiln | 7.53% | 7.53% |
| crucible | 5.07% (ocean 5.07%) | **5.06%** |

No biome moved above the limit; `Ocean` interiors are the expected residue.

**One side effect worth recording.** The reachable-core diagnostic *improved* on the two
quiet presets — `still` 17/22 → **19/22** (4 SCCs, was 6) and `garden` 18/22 → **20/22** (3,
was 5), because `shallows → basalt` carries no cycle flag and the static graph therefore
counts basalt and soil as reachable without volcanism. **That is slightly optimistic**: the
rule needs a lava *neighbour*, which the static analysis cannot evaluate, and neither preset
ever has one. The live measurement (escapability, above) is unmoved and is the one that
matters. Flagged so nobody later reads the core column as evidence that `garden` can make
basalt.

### AC5 — liveness

`npm run sim -- --days 1200 --cycles <preset>`, default size:

| preset | entropy (needs ≥ 0.65) | late churn (needs ≥ 0.15%) | verdict |
|---|---|---|---|
| **still** | 0.651 | **0.06%** | **✗ heat death — FAILS, as required (R-005)** |
| anvil | 0.740 | 1.20% | ✓ |
| garden | 0.699 | 2.95% | ✓ |
| kiln | 0.726 | 3.08% | ✓ |
| crucible | 0.749 | 3.56% | ✓ |

`still` also fails test 2 (15 generic and 19 thin regions). The four live presets pass both.

### AC6 — quench suppression

The new edge competes with `quenched to glass` for the same contacts, so it must suppress
it, and the risk is that lava's dwell time lengthens. 60 game-years, edge 1 alone:

| preset | quench firings before → after | standing lava | basalt |
|---|---|---|---|
| anvil | 1947 → 1863 (**−4.3%**) | 0.000% → 0.000% | 0.579% → 0.613% |
| crucible | 1591 → 1412 (**−11.2%**) | 0.625% → 0.625% | 2.801% → 2.824% |
| kiln | 634 → 501 (**−21.0%**) | 0.602% → 0.602% | 3.264% → 3.264% |

**Suppression 4.3–21.0%; standing lava does not move at three decimal places on any
preset.** At the mirror shape the same measurement gave −37% to −57% on quench and +7.7% to
+17.7% on lava. Lava still has three other exits and its 30-day unconditional backstop, so
the new edge takes contacts from `quenched to glass` without extending lava's dwell time.

### AC7 — typecheck and goldens

`npm run typecheck` green. `npm run sim:golden -- --update`, then verified:

```
  ✓ still     160×96 seed 20260729 500d   10468117cccd7501  (deterministic across two builds)
  ✓ crucible  160×96 seed 20260729 500d   e34f6edacd80b9d0  (deterministic across two builds)
```

| case | before | after |
|---|---|---|
| still | `10468117cccd7501` | `10468117cccd7501` — **unchanged** |
| crucible | `d2a499ca80d5114c` | **`e34f6edacd80b9d0`** |

`still` being byte-identical is a real result, not a missed update: neither new edge can fire
on a world with no lava and no superheated cut-off water, and `golden.ts`'s two cases are
chosen precisely so a failure localises. The flux ledger was separately verified
bit-identical — both hashes were unchanged with it enabled and the edges absent.

### Corrections to this spec's own pre-implementation numbers

Per R-003, two figures stated above as measured did not reproduce on this tree and are
**superseded, not deleted** — the conclusions they supported are intact.

1. **`garden`'s post-spec-2 rate of −0.2335 pp/game-year.** Re-measured: **−0.0579 pp/y**
   over 60 game-years, −0.0231 over y10→y60. The claim that spec 2 made `garden`'s membrane
   hungrier is not contradicted (the direction is the same), but the magnitude is ~4× off at
   this horizon, most likely because the original was taken over 8.2 game-years where the
   worldgen transient dominates. **The budget argument is unaffected** — this spec's delta on
   `garden` is 0.0000 either way.

2. **Lava/water contact rates**, and specifically the claim that **`anvil` has the most
   lava/water contact.** Re-measured on this tree, sea tiles with ≥ 1 lava neighbour,
   tile-days per day at 120×72 over 5 game-years: **still 0.000, anvil 0.340, garden 0.000,
   kiln 0.356, crucible 0.582.** By this measure `crucible` has the most contact and `anvil`
   the least of the three volcanic presets — the reverse of the recorded ordering. The
   recorded figures (anvil 0.280 / crucible 0.172 / kiln 0.109) are not reproducible from
   here and I could not establish their world size or normalisation, so **I am not claiming
   they were wrong, only that I cannot confirm them and did not rely on them.**

   **The design conclusion is unaffected, because it does not rest on contact counts.**
   `anvil` binds for the other reason the spec gives: it has by far the least opposing flux
   to absorb a new sea→land edge — gross land→sea **0.134 pp/y against crucible's 0.782**,
   measured by the new ledger. And the shipped shape was validated by direct A/B on `anvil`
   (0.0270 pp/y, the worst of any preset) rather than inferred from contact at all.

Not re-measured, and therefore not restated as current fact anywhere above: the ≈6 pp
headroom to the runaway-drain knee, the 3.5× exposure-gain figure, the naive-evaporation
probe costs (0.7986 pp/y etc.), and the mirror-shape costs. These are cited only as the
prior analysis's design constraints, which is what they are.

### Escalations

**None.** Both edges came inside the 0.05 pp/y per-edge ceiling, `still` still fails, no
liveness threshold was touched, no biome was added, and `world.ts`'s maritime `−3.0` and
`+1.2` albedo terms were not modified.

One thing to hand upward rather than escalate, because it changes nothing this spec ships:
**the maritime `−3.0` is still the largest single feedback coefficient in the world model,
and the loop it would close remains open only by convention.** Edge 2 avoids it by gating on
geometry. Any *future* rule that converts water to land on a condition heat can influence
re-opens it and must re-measure the exposure-per-remaining-sea-tile gain first. Recorded in
decision `0014`; not proposed as a change here.
