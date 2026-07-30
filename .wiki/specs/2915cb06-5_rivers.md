# Spec 2915cb06-5 — Rivers

Epic: `2915cb06` · Status: in progress · Order: 5 of 6

## Objective

> "rivers need to be able to form. water needs to have a chance to spread to nearby tiles
> such that it chains. rivers that are heated turn into swamps."

A 23rd biome, `River`, that nucleates from springs and glacial meltwater, extends downhill in
chains, and leaves by warming to swamp, spreading to marsh, drying to barren, freezing to
tundra, widening into shallows at its mouth, or being overrun by lava.

## The decision this spec ratifies

`README.md` open question #5 and `biomes.ts:593-596` both record the position that **rivers
are an edge feature, not an area**. The user's description is unambiguously an area feature —
"water spreads to nearby tiles such that it chains" is tile→tile state propagation and
"rivers that are heated turn into swamps" is a biome transition with a climate gate. Both are
`RuleDef` shapes.

An edge layer would need a parallel `Uint8Array(n*3)`, a second ruleset type, a second
`evaluateTile`, a second satisfiability probe, a second SCC checker (`invariants.ts` and
`reachability.ts` are entirely `Biome`-typed), an edge renderer, and an economy hook — and it
still could not answer "heated rivers become swamps", because a swamp is an area.

**Ratified: area, and a 23rd biome.** What is lost: a river is at minimum one tile wide, so it
reads as a river *valley*, not a stream. That is consistent with everything else here — a
`Mountain` tile is already a range, and `report.ts:239` treats 3% of a 20×18 region as an
export. Retire the edge-feature position: update the comment at `biomes.ts:593-596`, and
**flag it for spec 6 to fix in `README.md`** (spec 6 owns that file).

## ★ Three findings that are the whole design

### 1. The downhill gate is the only thing that bounds growth

`heatOffset` (`world.ts:512`) is `-34*max(0, elev-0.5) + (rough-0.5)*10` — flat below 0.5 and
contaminated by roughness, so **elevation is not recoverable from it**. Retain `elevation` as
a `Float32Array` written in `generate()` (4 bytes/tile: 138 KiB at 240×144, 983 KiB at the
viewer's 640×384 ceiling) and add a directed `upstreamNeighbours` count to `TileContext`.

A/B at identical rates, 900 days on `crucible`:

| | river share | components | longest |
|---|---|---|---|
| downhill gate **on** | **1.88%** | 193 | 34 |
| downhill gate **off** | **24.91% and climbing** | 3189 | 77 |

With decay disabled to isolate growth: 1.30% with the gate, **32.63%** without, longest
component 1959 tiles. Undirected, an "extend into a neighbour" rule is a branching process
with mean offspring > 1 — every tip forks three ways and nothing removes a direction.
Elevation makes it *directed* on a field bounded below, so every filament terminates at a
local minimum or at the sea.

**Elevation is static.** Subsidence and orogeny move the biome, never the height. A mutable
elevation field feeding climate would be the albedo runaway with a longer fuse. Record this
as a decision (R-008).

### 2. Linearity comes from "exactly one river neighbour" — and it destroys the river unless it can also heal

Requiring exactly one river neighbour gives chains rather than blobs: on a hex grid a tile
beside a straight chain touches *two consecutive* chain tiles and is refused; a tile beyond a
tip touches one and is admitted. Branching is the same rule, not a second one. Measured: the
share of river tiles with 4+ river neighbours was **0.0% in every configuration**.

But a tile in a one-tile hole in a chain has **two** river neighbours, so `exactly-one`
refuses it. One decay event severs a chain permanently and both halves keep severing. Measured
at 1500 days: **534 "rivers", mean 1.9 tiles, 25.2% isolated singletons** — while the *same
growth machinery* with decay disabled produced 14 rivers, mean 32.2, longest 131. Growth was
never the problem. **A river under this predicate does not decay, it dissolves.**

The fix is exact, not heuristic. `hex.ts:14-33` walks the neighbour ring in cyclic order for
both row parities, so direction `d` and `(d+1)%6` are geometrically adjacent:

- two river neighbours **adjacent** on the ring (60°) = a pocket *beside* a channel → refuse;
  this is what widening looks like
- two river neighbours **not adjacent** (120°/180°) = a hole *in* a channel → admit

A 64-entry `Uint8Array` lookup, one index in the hot loop. After: mean river-neighbour count
1.56–1.92, isolated singletons 1.4–6.5%, 0% at 4+.

### 3. A river is land. `water: false`. This is a safety property, not a detail

Measured counterfactual — keep `water: false` but count River in `waterNeighbours`
(`world.ts:352`), 1500 days on `crucible`, everything else identical:

| | river = land (ship this) | river counted as water |
|---|---|---|
| river standing share | **1.14%** | **0.00% — the biome is annihilated** |
| water trend d150→d1500 | 23.7 → 24.0%, flat | 23.7 → **25.2%, still climbing** |
| entropy | 0.754 | 0.741 |

Two failures at once. The river **drowns itself**: a chain tile has two river neighbours, so
at any bend or confluence it reads `waterNeighbours >= 3` and its own mouth rule fires. And
every tile it loses becomes `Shallows` — permanent land→sea, a **+1.5 pp water ratchet in four
game-years that has not converged**, against a flat baseline. That is `SIMULATION.md` bug #3
in a new costume.

`SEA` is derived from `BiomeDef` (`biomes.ts:267`) and `world.ts:352` tests
`def.water && !def.molten`, so a `water: false` river is *structurally* excluded from all
coastline arithmetic. `invariants.ts:145` (`moistureSource > 0 && !water`) makes any half-done
version fail loudly — so `moistureSource` **must stay 0**.

The river is still wet where it should be: add `Biome.River` to `wetNeighbours()`
(`biomes.ts:414`) and to the marsh/swamp `+2` moisture-diffusion term (`world.ts:389`).

## Derived-set memberships — check every one

A new biome joins the predicate-derived sets automatically. For `water:false, molten:false,
stone:false, vegetated:false, moistureSource:0`:

| set | River joins | verdict |
|---|---|---|
| `SEA` (`:267`) | no | **the safety property above** |
| `DROWNABLE` (`:279`) | yes | **TRAP** — collides with the hand-written mouth rule (invariant 3) |
| `SUBSIDABLE` (`:325`) | yes | **TRAP**, same collision |
| `STONE` (`:284`) | no | correct |
| `ALL_LAND` (`:287`) | yes | correct |
| `OVERRUNNABLE` (`:301`) | yes | **desirable** — free `river→lava`, keeps volcanism's door open |
| `VEGETATED` (`:304`) | no | correct |
| `BURNABLE` (`:307`) | no | judgement call: a river does not burn to ash. The beam destroys it by drying, not directly |
| `FREEZABLE` (`:310`) | **no** — needs `vegetated \|\| Soil \|\| Barren` | **TRAP, and this is the one that bites**: a polar river would have no cold exit at all. Needs a hand-written `river→tundra` |

Both traps are closed by one edit: add `River` to `HAND_DROWNED` (`:270`), exactly the
marsh/swamp precedent. Note `HAND_DROWNED` feeds two predicates — one line, two effects.

## The graph

Verified on the prototype: 23 biomes, 70 materials all unique, 177 rules → 144 distinct edges,
**single strongly connected component containing all 23**, 0 derived/hand-written clashes, all
rules satisfiable, every biome escapable. River degree **out 6 / in 11**, clearing the
`out===1` / `in===1` failures at `invariants.ts:222-224`.

- **IN**: `glacier→river` (gated on the same `GLACIAL+4` as `the ice retreats`, requires 0
  river neighbours) · `marsh→river` (`moisture > SOAKED` + stone neighbours, so a world with
  no ice still gets rivers) · `CHANNELABLE→river` (derived, the extension rule)
- **OUT**: **`river→swamp` at `heat > 60`, ×2 under Heatwave — the requested rule** ·
  `river→marsh` (temperate; this is the decay term) · `river→barren` (runs dry) ·
  `river→tundra` (freezes) · `river→shallows` (mouth widens, `waterNeighbours >= 3`) ·
  `river→lava` (derived)

`CHANNELABLE` should reuse the `SUBSIDABLE` predicate verbatim — "unconsolidated ground water
can move" is one physical property — which inherits the Glacier/Marsh/River exclusions for
free, so no derived rule duplicates a hand-written one and **invariant 3 holds without a
second exception list**.

## Rates

Growth pressure scales with the number of **tips**; decay with the number of **tiles**. That is
the exact opposite of `silt builds`, whose growth scaled with the *area* of the growing phase —
which is why one `>=4 → >=3` there drained every ocean. Expected filament length
`L* = 3·p_g/p_d`, O(1) in world size.

Starting point, measured 1.14% tail mean at 1500 days: sources m30000, extend m6, decay
swamp m90 / marsh m300 / barren m90 / tundra m90.

**The trade-off is not tunable away:** standing share ∝ nucleation × lifetime × length, and both
lifetime and length go as `1/p_d`, so **share ∝ 1/p_d²**. Long trunk rivers cost quadratically
more standing share, and slow-decay configurations take >3000 days to equilibrate. Set
abundance with **spring density** (linear, safe), never with the spread median (hyperbolic).

## Taxonomy cost — `BIOME_COUNT` 22 → 23

`ln 22 = 3.091042`, `ln 23 = 3.135494`, ratio 0.985823. **Every recorded entropy figure shifts
and the liveness threshold's calibration story changes, not just its inputs.** Measured: `still`
0.647 → **0.638**, landing exactly on the pure-renormalisation prediction (its composition is
untouched — it grows 0.00% river at 3000 days, having no glaciers and no wet marsh on stone);
`crucible` 0.753 → **0.754**, beating the prediction by +0.012 because the river is real added
variety.

`ALIVE_ENTROPY` is 0.65 (`report.ts:118`) and the control previously failed it by 0.003; under
`ln(23)` the same unchanged world fails by 0.012. **R-005 gets safer, not riskier** — but the
calibration narrative in `SIMULATION.md` and `README.md` now describes a denominator that no
longer exists. **Flag that for spec 6; do not edit those files.**

Call sites to update — verified list, do not trust it blindly, re-grep:
`biomes.ts:61,242,1135` · `world.ts:104,207,299,347,352,361,525,619,621,632,636` ·
`report.ts:52,70,73,87,143-145,149,160-161,168,269-270,282,295,299,309,312,319,324` ·
`invariants.ts:79,95-96,132-147,198-208,219-225,230,413,467,475,499-501` ·
`reachability.ts:49,154,**156-183**,338-339` · `sweep.ts:89,100,258,264` · `diagnose.ts:12,87` ·
`run.ts:15,128` · `golden.ts:80,89` · `server.ts:164-165,290,315,328` ·
`viewer/public/viewer.js:105,111,114,123,130,337,389,797-802`.

`palette.ts` needs **no change** — it is computed from the ANSI code; the new biome only needs a
`colour` unique against the existing 22 (`invariants.ts:140`). Three new material names, ≥3 and
globally unique (`invariants.ts:141-144`).

★ **`reachability.ts:156-183` (`makeContext`) is the easy miss**: any new `TileContext` field
must be filled there or the satisfiability probe runs against a malformed context and silently
mis-reports.

## Acceptance criteria

1. `npm run sim:check`: 23 biomes, **single SCC**, all rules satisfiable, every biome escapable,
   invariant 8 within limits, no derived/hand-written clash. Report river's in/out degree.
2. Rivers **look like rivers**: ASCII render of river tiles only, plus mean river-neighbour
   count, isolated-singleton share, and share with 4+ neighbours (must be ~0).
3. Standing river share, tail mean over ≥1500 days, per preset. `still` should be ~0.
4. 60-game-year water trend per preset, against `garden`'s post-spec-2 baseline of −0.2335 pp/y
   and the epic's 0.125 pp/y total new-edge ceiling. `sweep.ts` must now see the river biome —
   spec 3 made `SEA` derive from the predicate; confirm that still holds.
5. `still` still FAILS (R-005), and report by what margin under the new denominator.
6. Entropy and churn for `crucible` and `garden` under `ln(23)`.
7. `npm run typecheck` green; goldens updated with `--update`, new hashes recorded here.
8. Decisions written (R-008) for: elevation retained and static; river is land not sea, with the
   measured counterfactual; the ring-adjacency gap/pocket discriminator.

## Explicitly NOT in this spec

Editing `README.md` or `SIMULATION.md` (spec 6). Changing `ALIVE_ENTROPY` or any liveness
threshold — **escalate** if the new denominator makes one wrong. `ICE_FORM`/`ICE_THAW`. Making
elevation mutable. An edge-based river layer.

## Measured

All figures below are from runs on this worktree at the shipped rates. Seed 20260729
throughout. Prototype figures quoted earlier in this file were taken on `main` at `b924a35`,
before specs 1–4; where they did not reproduce, see `## Corrections`.

### 1 — `npm run sim:check` ✓ all invariants hold

```
23 biomes · 70 materials · 70 unique · 23 glyphs · 23 colours
✓ 185 rules · 185 unique keys · 185 distinct roll streams
185 rules → 148 distinct edges over 23 nodes (29.2% density)
✓ single strongly connected component containing all 23 biomes
✓ 0 derived/hand-written clashes
✓ all 185 rules can fire somewhere in climate × flag space
✓ every biome has at least one exit that needs no cycle at all
✓ 10 required direct edges present
```

**River degree: out 6 / in 12.** Out — swamp, marsh (×2 rules, one climate-gated and one
unconditional), barren, tundra, shallows, lava. In — glacier, marsh, and the 10-member
`CHANNELABLE` fan-out.

Reachable core per preset (core / 23): still 20, anvil 22, garden 21, kiln 23, crucible 23 —
unchanged in shape from HEAD, river inside the core on every preset.

**★ AND THE CORE COLUMN IS OPTIMISTIC ABOUT RIVER, EXACTLY AS SPEC 3'S WAS ABOUT BASALT.**
Every new river rule is gated on climate and static geography only — not one *requires* a
`CycleFlag` to fire, the two that mention one (`the river warms to swamp`, `the river
freezes over`) merely doubling a rate that is already live. So the static core admits River
on a preset with no disturbance at all, and `still` duly reports 20/23 with River inside its
core. §3 below measures `still` and `anvil` at **exactly 0.000% river**, and it is a
structural zero rather than a rare event: `still` has no marsh beside two stone tiles that
ever passes the gate, and its glaciers never warm past `GLACIAL + 4`. Nobody may read "river
inside the core on every preset" as evidence that a `still` world makes rivers. It is the
same wrinkle spec 3 flagged for its own unflagged `shallows→basalt` rule ("Flagged so nobody
later reads the core column as evidence that `garden` can make basalt"), and it is recorded
here rather than fixed: gating a rule on a flag it does not need would be a behaviour change,
and the invariant is doing its job — it answers "can climate ever admit this edge", not "does
this world ever get there".

Invariant 8, escapability in a live world — **river appears in no preset's stuck list**:

| preset | no live exit | vs HEAD |
|---|---|---|
| still | 92.37% (control, exempt) | unchanged |
| anvil | 13.54% | unchanged |
| garden | 8.40% | 8.55% |
| kiln | 7.55% | 7.53% |
| crucible | 5.08% | unchanged |

### 2 — Rivers look like rivers

Largest `garden` component at 1500 days, 68 tiles, rendered with the odd-r half-column shift
applied so hex adjacency is what the eye sees (`##` = this component, `++` = other river
components, `~~` = sea, `··` = other land):

```
    ··············································
   ··············································
    ······················######··················
   ····················####····##················
    ················####····++··##················
   ++······##########······++··##················
    ++··####··········++++··++··##··++····##······
   ~~~~~~~~··####··++······++··##··++··####······
    ~~~~~~~~##··##··++++++++··##······##··##······
   ··~~~~~~~~##················######····##······
    ++~~~~~~~~##################····######··##····
   ······~~~~~~················######····####····
    ······~~~~~~··········++++········####··##····
   ········~~~~~~++++++++++··++++++++······##····
    ········~~~~~~~~~~····++··········##··##······
   ··········~~~~~~~~~~++··++··++··####··##······
    ··········~~~~~~~~~~++··++··++····####········
   ··········~~~~~~~~~~~~++··++++··####····++++··
    ··········~~~~~~~~~~~~~~++····##····++++··++··
   ············~~~~~~~~~~~~~~++++··####······++··
```

A single meandering channel with tributaries, descending to its mouth at the sea on the
left. Its river-neighbour histogram is `1:9  2:50  3:9  4+:0`, mean 2.00 — the mode is two,
which is what "channel interior" means.

Shape statistics, 1500 days, 160×96:

| preset | tail-mean share | components | longest | mean length | singleton share of tiles | mean river-neighbours | 4+ neighbours |
|---|---|---|---|---|---|---|---|
| still | 0.000% | 0 | — | — | — | — | — |
| anvil | 0.000% | 0 | — | — | — | — | — |
| garden | 2.297% | 43 | 68 | 8.4 | 2.2% | 1.78 | **0.00%** |
| kiln | 1.502% | 32 | 66 | 7.4 | 2.1% | 1.77 | **0.00%** |
| crucible | 1.504% | 38 | 32 | 6.2 | 3.4% | 1.70 | **0.00%** |

Mean river-neighbour count is inside the prototype's 1.56–1.92 band and the singleton share
inside its 1.4–6.5%. **4+ neighbours is 0.00% everywhere**, which is structural rather than
lucky — the largest independent set on a 6-cycle is 3, so `CHANNEL_OK` cannot admit a fourth.

### 3 — Standing share, and it is stationary

Tail means at 1500 days are in the table above. `still` and `anvil` are **exactly 0.000%**,
and structurally so rather than by rarity: `still` has no marsh beside two stone tiles that
ever passes the gate and its glaciers never warm past `GLACIAL + 4`; `anvil` is beam-only,
with no seasons, monsoon or weather, and produces 279 glacier tile-samples against `garden`'s
63,863.

Because share goes as `1/p_d²` and slow configurations take thousands of days to settle, the
number that matters is the long-horizon trend. 7300 days (20 game-years), 50-day trailing
means, 160×96:

| preset | d730 | d1460 | d2190 | d2920 | d3650 | d4380 | d5110 | d5840 | d6570 | d7300 |
|---|---|---|---|---|---|---|---|---|---|---|
| garden | 1.94% | 2.24% | 1.54% | 1.72% | 2.61% | 2.26% | 2.65% | 1.56% | 1.60% | 1.74% |
| kiln | 1.52% | 1.51% | 1.58% | 1.94% | 2.66% | 2.08% | 2.18% | 1.39% | 0.72% | 0.84% |
| crucible | 1.80% | 1.52% | 0.51% | 1.61% | 4.01% | 2.44% | 2.54% | 2.08% | 0.91% | 0.84% |

Large oscillation, **no trend**. Getting here required two structural fixes, not tuning —
see `## Corrections` and decisions `0020` and `0021`.

### 4 — Water budget, 60 game-years at 120×72

| preset | sea y0 | sea y60 | trend pp/y | HEAD baseline | `river→shallows` pp/y |
|---|---|---|---|---|---|
| still | 23.81% | 22.22% | **−0.0264** | −0.0264 | 0.0000 |
| anvil | 23.81% | 24.99% | **+0.0197** | +0.0197 | 0.0000 |
| garden | 23.81% | 21.84% | **−0.0328** | −0.0579 | 0.0012 |
| kiln | 23.81% | 21.79% | **−0.0336** | −0.0525 | 0.0033 |
| crucible | 23.81% | 26.37% | **+0.0426** | +0.0415 | 0.0027 |

`still` and `anvil` are **bit-identical to the pre-river baseline** — they grow no rivers, so
nothing this spec added touches them. Largest magnitude is 0.0426 pp/y against the epic's
**0.125 pp/y total** ceiling. `garden` and `kiln` drain *less* than at HEAD, because a river
tile displaces marsh, which is more erodible than it is.

`the river widens its mouth` is the only land→sea edge the biome adds, at **0.0012 / 0.0033 /
0.0027 pp/y** against the **0.05 pp/y per-edge** ceiling. It did not start there: at
`waterNeighbours >= 3` it measured 0.0523 / 0.0791 / 0.0642, **over the ceiling on all three
presets**. Tightening the gate to `>= 4` — geometry, the brake this coastline uses everywhere
— cut it 20–37×. `wn == 3` is the ordinary coastal ribbon, not a river mouth, which is the
same neighbour-of-relaxation finding `the shallows bake dry` already records.

`sweep.ts` sees the river correctly: `SEA` derives from `water && !molten` and resolves to
`ocean, shallows, frozensea`, so a `water: false` river is **excluded** from sea share, which
is what makes the trends above meaningful.

### 5 — `still` still FAILS, by a wider margin than at HEAD

1500 days, 240×144:

| preset | entropy (tail mean) | churn %/sample | verdict |
|---|---|---|---|
| **still** | **0.637** | **0.05%** | **✗ FAILS** |
| anvil | 0.728 | 1.51% | ✓ alive |
| garden | 0.723 | 3.17% | ✓ alive |
| kiln | 0.755 | 3.25% | ✓ alive |
| crucible | 0.772 | 3.65% | ✓ alive |

`still` fails **both** gates: entropy 0.637 against `ALIVE_ENTROPY` 0.65 — a margin of
**0.013** — and churn 0.05% against 0.15%. At HEAD it measured 0.651/0.06%, i.e. it *passed*
entropy and failed only on churn. **R-005 is strictly safer under `ln(23)`, not riskier**, and
no threshold was touched.

`anvil` is the clean check on the denominator: it grows no rivers, so its composition is
unchanged, and 0.740 × ln(22)/ln(23) = 0.7295 predicts what it actually measures, 0.728.
`garden`, `kiln` and `crucible` all rose despite the larger denominator (0.701→0.723,
0.726→0.755, 0.750→0.772) because the river is real added variety.

### 6 — The river is land in every classifier

Observed through the real `WorldView` handed to a world-reading cycle, `garden`, 1500 days:

```
BiomeDef.water false · molten false · moistureSource 0 · River in SEA false
SEA = ocean, shallows, frozensea
river tile-days observed through WorldView.terrainAt   374061
of those classed TerrainClass.Sea                           0
distinct TerrainClass bitsets seen on river tiles           0
```

The moisture latch spec 4 guarded against is untouched: the storm classifier cannot see a
river, and it cannot see one *by construction* rather than by an exclusion someone remembered
to write.

### 7 — Gates

`npm run typecheck` green. `npm run sim:check` ✓ all invariants hold. `npm run sim:golden` ✓.

| world | hash |
|---|---|
| `still` 160×96 seed 20260729 500d | `10468117cccd7501` — **unchanged** |
| `crucible` 160×96 seed 20260729 500d | `599d7815137a0a4f` (was `63f85bcb6b2a4f16`) |

`still` being byte-for-byte unchanged across a change that added a biome and 20 rules is
decision `0002` paying off exactly as predicted: rule dice are content-derived, so adding
rules perturbs only themselves, and a world that never fires the new rules cannot move.

### 8 — Decisions written

`0018` elevation retained and static · `0019` a river is land, not sea, with the measured
counterfactual · `0020` the ring-adjacency discriminator, including the honeycomb fixed point
the first version admitted · `0021` a nucleation gate reads only what the feature cannot
create.

## Corrections

Per R-003, prototype figures in this spec were measured on `main` at `b924a35`, before specs
1–4. Where they did not reproduce on this tree, the design constraint they supported is
intact but the number is superseded.

**1. `garden`'s water-trend baseline is −0.0579, not −0.2335.** The budget section quotes
−0.2335 pp/y; spec 3 corrected that to −0.0579 by measuring over 60 game-years rather than
8.2, where the worldgen transient dominated. Measured against −0.0579 throughout.

**2. River in-degree is 12, not 11.** The spec predicted out 6 / in 11. Out 6 reproduced
exactly. In is 12 because `CHANNELABLE` had to gain `Swamp` as well as `Marsh` — see
correction 4 — and `swamp → river` is a new edge, where `marsh → river` already existed by
hand.

**3. `CHANNELABLE` cannot reuse `SUBSIDABLE` verbatim.** The spec states that it should, "which
inherits the Glacier/Marsh/River exclusions for free". The Glacier and River exclusions are
right. The **Marsh and Swamp exclusions are not**, and taking them silently disables the
healing rule this design depends on: marsh and swamp are exactly what a river *decays into*
(three of its five exits), so every tile the river had just lost became permanently
un-rechannelable. Measured with the verbatim alias, 1500 days: mean river-neighbour count
1.28–1.47 and 33–53% of components a single tile — the `exactly-one` dissolution failure
reproduced by a different route. `CHANNELABLE` is `SUBSIDABLE` plus marsh and swamp, and
`marsh → river` is listed in `ACKNOWLEDGED_EDGE_OVERLAPS`. The two rules that land on it are
**mutually exclusive by construction** (`riverRing === 0` against `CHANNEL_OK[riverRing]`), so
unlike the three existing acknowledged overlaps their combined rate is not even a sum.

**4. The discriminator needs a popcount cap; ring-adjacency alone is not sufficient.** The
spec describes the rule as "two river neighbours adjacent on the ring → refuse, not adjacent
→ admit", which taken literally also admits the 0°/120°/240° arrangement. On a hex grid that
is a sublattice with a **stable dense fixed point**: a honeycomb at 1/3 density where every
tile has three mutually non-adjacent river neighbours and the predicate therefore admits all
of its own cells. Measured on the largest `garden` component with no cap: 106 tiles,
histogram `1:15 2:50 3:41`, mean 2.25, rendering as a braid filling a region rather than a
channel crossing one. The shipped predicate is `count in {1,2} && no two adjacent`. See
decision `0020`.

**5. Springs must not read moisture, and the spec's `marsh→river` gate does.** The spec
specifies `marsh→river` on `moisture > SOAKED` + stone neighbours. A river pushes `+2` into
its neighbours' moisture target, so that gate is a river manufacturing its own nucleation
sites — the epic's own standing constraint violated by the feature that states it. It
presents as a slow climb, not a runaway: halving the spring median multiplied share by
2.9–4.1× instead of 2×, and river and marsh climbed together over 4000 days while the sea
stayed flat. Both springs are now gated on heat and static geography only. See decision
`0021`.

**6. The rates are not the spec's, because the decay structure was wrong.** The spec's
starting point — sources m30000, extend m6, decay swamp m90 / marsh m300 / barren m90 /
tundra m90 — leaves a temperate river with the m300 rule as its *only* exit, giving
`L* = 3·p_g/p_d = 150` tiles and a share that was still climbing at day 4000 on every preset.
Shipped: sources **m12000**, extend m6, decay swamp m90 / **marsh m90 climate-gated** / barren
m90 / tundra m90, with marsh m300 retained as an unconditional escapability backstop, and the
mouth at m20 on `waterNeighbours >= 4`. Spring density remains the linear dial the spec
prescribes; it was re-derived against the corrected decay rather than carried over.

**7. Prototype share/component figures do not transfer.** The spec's "1.14% tail mean at 1500
d, 91 components, longest 35" was measured on a different world. This tree measures 1.50–2.30%
tail mean, 32–43 components, longest 32–68. Both the abundance and the shape are in a sane
band; the numbers are not the same numbers.

**8. `MAX_TILES`'s justification in `viewer/limits.ts` was roughly half the true cost.** It
quoted "42.2 ms/day, all five cycles" and a "~127 ms" blocked event loop at the cap.
Re-measured at the cap (512×512, 262,144 tiles) with `crucible`'s **six** cycles:
**80.1 ms/day**, i.e. ~240 ms blocked per tick at 60 days/second. The comment and the
user-facing message in `checkSize` are corrected. The cap's *rationale* — step time bounds
it, not the canvas — is unchanged and now holds by a wider margin, but the cap sits above the
"feels live" range rather than at its top. Lowering `MAX_TILES` is a product decision and is
deliberately not taken here.
