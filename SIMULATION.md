# Terrain Simulation — Findings

Results from the headless simulator in `src/sim/`. It exists to answer one question
before anything is built on top of it: **does a stochastic terrain CA driven by world
cycles produce a world that stays alive, or does it flatten into an absorbing state?**

Answer: it stays alive — and **only because of the cycles.**

```
npm run typecheck    # tsc --noEmit — a gate for future edits, see the note below
npm run sim          # full run, map + charts + both tests
npm run sim:check    # transition-graph invariants (single SCC, satisfiability, chemistry)
npm run sim:golden   # golden-world hashes — has the simulation drifted?
npm run sim:sweep    # cycle parameter sweep
npm run sim:trace    # day-by-day trace of one disturbance cycle
```

---

## ⚠️ Every number below was re-measured in one pass, on one tree

Epic `2915cb06` ("living water, weather and a travelling sun") landed five specs that each
moved the world: a travelling-blob sun, stored per-tile temperature, two-way water
chemistry, a weather layer, and a 23rd biome. Each re-baselined the golden hashes; none of
them was allowed to touch this file, because re-measuring it five times would produce five
sets of numbers that were each true for exactly one commit.

**This is that one pass.** Every figure here comes from a run made after the last of those
five commits, on the tree this file is committed with. Nothing is carried forward from an
earlier commit in the epic, however plausible it looked — see bug **#16**, which is the
record of that exact mistake being made three times inside this epic alone.

The earlier re-key provenance table is kept, because it is evidence rather than a metric:
transition rolls used to be keyed on a rule's **positional index** in the `RULES` array, so
inserting or moving any rule handed every rule after it a different stream of dice. Rule
identity is now derived from content (`<from>-><to>:<label>`) — see `ruleKey` in
`src/sim/biomes.ts` and decision `0002`. Verified at the time by inserting a rule that can
never fire (`when: () => 0`) at the head of the array: it moved both golden hashes under the
old keying and moves neither under the new one.

| *(historical, at the re-key commit)* | old keying | content keying |
|---|---|---|
| baseline, `still` | `0c4d5c1bd222dc2b` | `ea1caa9f367a0453` |
| + dead probe rule | `0f61f686021ee87c` | `ea1caa9f367a0453` |
| baseline, `crucible` | `cbfbb340506e0ae6` | `f4bece63b740b9e2` |
| + dead probe rule | `6ba6dd80f4bb49d1` | `f4bece63b740b9e2` |

Both of those content-keyed hashes have since moved, deliberately. The current ones are below.

### ⚠️ The typecheck gate found nothing on the day it was added
The first `tsc --noEmit` reported 94 errors and **every one was a missing Node host global**
(`process`, `console`, `performance`). Filtering those three error codes left an empty list:
there were **zero substantive type errors**. Nothing was fixed — a host environment was
configured (`@types/node`, decision `0004`).

Say it that way round, because "94 errors" invites the opposite reading. **The gate's entire
value is prospective.** It exists to catch the *next* bug #6 below — a CLI flag parsed into a
property that no longer existed, doing nothing, with the recorded numbers right only by luck.
It did not catch that one; it makes the next one impossible.

### ⚠️ Passing options through `npm run`
Use `--`, or the options are silently dropped:

```
npm run sim -- --days 1500 --cycles still     # correct
npm run sim --days 1500 --cycles still        # WRONG: runs crucible at 1200 days
```

Without `--`, npm eats the flags as its own config and the script runs with its defaults — a
*different preset* for the same command line, with nothing to say so. Earlier revisions of
this file and of `README.md` documented the second form. The `sim` script no longer
hard-codes `--days`, so `--`-forwarded options now take effect; `run.ts` resolves each flag
with `lastIndexOf`, so a **duplicated flag takes the LAST occurrence** — what every other CLI
does, and what a person editing the end of a long command line means.

---

## Validated result

240 × 144 torus, 1500 days (4.1 game-years), seed 20260729.
`node src/sim/run.ts --days 1500 --cycles crucible` — `crucible` is beam + seasons + monsoon
+ tectonics + volcanism + **weather**, six cycles.

**Test 1 — is the world alive?** ✓

| Metric | Result | Threshold |
|---|---|---|
| entropy (tail mean) | **0.772** | ≥ 0.65 |
| largest biome | Deep Ocean, **17.7%** | ≤ 40% |
| late churn | **3.65%** / sample | ≥ 0.15% |
| biomes > 1% | **15** of 23 | ≥ 8 |

Entropy opens at 0.521 on the day-0 worldgen and climbs; the tail minimum is 0.521.

**Test 2 — is every start a niche?** ✓
83 habitable regions (13 open water), **0 generic**, **0 thin**, **median 18 materials** each.
Averaged over 73 samples across the final third, not a single snapshot.

**All five presets, same world, same command.**

| preset | entropy (day 0 → tail) | largest biome | late churn | biomes > 1% | test 1 | test 2 |
|---|---|---|---|---|---|---|
| `crucible` | 0.521 → **0.772** | Deep Ocean 17.7% | **3.65%** | 15 | **PASS** | PASS — 83 regions, median 18, 0 generic / 0 thin |
| `kiln` | 0.521 → **0.755** | Deep Ocean 17.2% | **3.25%** | 13 | **PASS** | PASS — 83 regions, median 18, 0 / 0 |
| `anvil` | 0.521 → **0.728** | Barren 17.8% | **1.51%** | 11 | **PASS** | PASS — 81 regions, median 15, 0 / 0 |
| `garden` | 0.521 → **0.723** | Deep Ocean 17.2% | **3.17%** | 13 | **PASS** | PASS — 83 regions, median 18, 0 / 0 |
| `still` | 0.521 → **0.637** | Tundra 29.1% | **0.05%** | 9 | **FAIL** | **FAIL** — 81 regions, median 9, 15 generic / 19 thin |

**Performance.** `crucible` at 1500 days: 51,840,000 tile evaluations in 14.98 s =
**3.46M tile-evals/sec** single-threaded. `still` over the same run: 7.68 s = **6.75M/sec**;
the gap is the six cycles. A live world of this size needs 0.4 evals/sec, so ~8.7M× headroom.
These rates are hardware-dependent and are **not** comparable to the 7.5M/sec recorded before
this epic — the per-tile work itself grew (a stored thermal filter and its daily water field,
a weather layer, a river ring and an elevation gather). Treat the headroom, not the rate, as
the finding.

---

## ★ The central finding: disturbance is what keeps a world alive

The `still` preset is the control — same ruleset, no cycles at all. Both at 1500 days:

| | `crucible` (six cycles) | `still` (no cycles) |
|---|---|---|
| entropy | **0.772** ✓ | 0.637 ✗ |
| late churn | **3.65%** ✓ | **0.05%** ✗ |
| biomes > 1% | 15 | 9 |
| largest biome | Deep Ocean 17.7% | Tundra 29.1% |
| habitable regions | 83, median 18 materials | 81, median 9 materials |
| generic / thin regions | 0 / 0 ✓ | 15 / 19 ✗ |
| **verdict** | **alive** | **heat death** |

Measured to four decimals over the same tail, `crucible` churns **3.6491%** against the
control's **0.0507%** — **72×**, two orders of magnitude. A world with no disturbance
converges to a static equilibrium and stops moving. The Sun God's reshaping is not flavour
laid over a living world; it is the mechanism that makes it live.

`npm run sim:check` corroborates it independently and by a different route: **92.37%** of the
`still` world holds tiles with no live out-rule at all across a full watched game-year,
against **5.08%** for `crucible` — and all of `crucible`'s is Deep Ocean interior, which is
expected and exempt. Nine-tenths of the control is terrain that can never change again.

**How dead "dead" looks depends on how long you watch.** The control's churn decays; it is
not a constant. Measured at 240 × 144, mean churn per 5-day sample by 300-day window:

```
  d   1- 300   1.043%      d1201-1500   0.034%
  d 301- 600   0.135%      d1501-1800   0.024%
  d 601- 900   0.056%      d1801-2100   0.022%
  d 901-1200   0.051%      d2701-3000   0.018%
```

The first window is the worldgen transient, not life. Any comparison against the control has
to say which window it used, and a measurement short enough to still contain the transient
will flatter it — which is exactly how open defect **A** below survived this long.

---

## ★★ The entropy threshold, re-derived — not renumbered

`biomeEntropy()` normalises Shannon entropy by `log(BIOME_COUNT)`. Spec 5 added a 23rd biome,
so the denominator moved from `ln 22 = 3.091042` to `ln 23 = 3.135494` — a factor of
**0.985823** applied to every entropy figure this project has ever recorded. **Every one of
them was stale by construction the moment `River` landed**, including the calibration story
that used to live in this section.

That story was: `ALIVE_ENTROPY = 0.65` is calibrated against a control that fails it by a hair,
so entropy is the metric that *nearly lets a corpse through*. Here is what the same control
does now, with the denominator isolated — one set of tail compositions, evaluated two ways
(240 × 144, 1500 d, seed 20260729):

| preset | `H / ln 23` (shipped) | `H / ln 22` (old denominator) | denominator effect |
|---|---|---|---|
| `still` | **0.6367** | **0.6459** | +0.0092 |
| `crucible` | 0.7723 | 0.7834 | +0.0111 |
| `kiln` | 0.7546 | 0.7654 | +0.0109 |
| `anvil` | 0.7281 | 0.7386 | +0.0105 |
| `garden` | 0.7232 | 0.7336 | +0.0104 |

### ★ Read the control's row carefully: **0.6459 is also below 0.65**

The obvious story — *the new denominator is what pushed the control below the entropy gate* —
**is false**, and this section exists partly to stop it being told. Under the old divisor, on
this tree, the control scores 0.6459 and **still fails**. The 23rd biome widened a failure
that was already there; it did not create one.

That is provable rather than argued, because the control's world did not change when rivers
landed. Two facts, both from this repository:

- **`still` contains no river tiles at all** — river does not appear in its composition at any
  share, on `still` or on `anvil`. The taxonomy grew; the control's map did not gain anything.
- **`still`'s golden hash has been `10468117cccd7501` since spec 2** (`a26c8dd`), unchanged by
  specs 3, 4 and 5. A no-cycle world's worldgen, hydrology and climate-gated rules have not
  moved since thermal inertia landed, so the composition being divided is the same composition
  before and after the biome count changed. The only thing that moved is the divisor.

So for the control, `H / ln 22 = 0.6459` **is** its pre-rivers score at this horizon, measured
rather than remembered: the world is bit-identical and the arithmetic is exact. The margin went
from **0.0041** to **0.0133**, and every bit of that widening is the denominator.

⚠️ **The pre-epic margin is deliberately not quoted here.** The often-repeated "the control
fails entropy by 0.003" was measured before this epic, on a tree whose control has since moved
(spec 2 changed `still`'s hash from `ea1caa9f367a0453`), and the intermediate figures recorded
inside the epic were taken at a 1200-day horizon rather than this file's 1500. Comparing them
against the numbers above would be exactly the defect in bug **#16**. R-003 prefers an absent
number to an unsourced one, so the honest statement is the one above: **as of this tree, the
control fails entropy by 0.0133 under the shipped divisor and by 0.0041 under the old one, and
no matched-horizon comparison against the pre-epic tree was made.**

**That is a stronger argument for R-005 than the one it replaces, not a weaker one.** The old
passage said entropy nearly lets a corpse through, which invites the reading that the threshold
is nearly right. The new one says something worse:

> **The entropy test's safety margin is a function of `BIOME_COUNT`, which is not a property
> of liveness at all.** Adding a biome widens it, removing one narrows it, and neither change
> has anything to do with whether a world is still moving. Churn is a total-variation distance
> — `Σ|Δp| / 2`, bounded 0…1 — and is **invariant to the size of the taxonomy**. It did not
> move when the 23rd biome landed and will not move when the 24th does.

**R-005's conclusion is intact and these numbers still carry it.** Measured today, the control
fails entropy by **2.0%** of its threshold (0.0133 / 0.65) and churn by **66%** of its
threshold (0.05% against 0.15%, a factor of three). Churn's margin is more than thirty times
wider in relative terms, and unlike entropy's it does not drift when the taxonomy changes. Do
not "simplify" test 1 back to entropy alone.

*(Historical measurement, from the ruleset as it stood before the thresholds were recalibrated
and not re-run since: a no-disturbance control measured entropy* **0.707** *against a fully
cycled world's* **0.703** *— the frozen world scored HIGHER, and the old thresholds reported
both as alive. That is the observation R-005 was written from. It was taken when the taxonomy
held 22 biomes; it holds 23 today.)*

`ALIVE_ENTROPY` was **not** changed by this pass. Moving a liveness threshold is an
escalation, not a documentation edit.

---

## ★★★ The coastline membrane has no restoring force

This is the single most important thing epic `2915cb06` learned, and until now it was written
nowhere a future agent would look.

`npm run sim:sweep` runs 40 game-years at 120 × 72 and reports the sea share every decade, the
drift, the post-transient rate, and that rate extrapolated to year 200:

```
  preset            y 0    y10    y20    y30    y40     drift    late pp/y   → y200
  still           23.8%  22.2%  22.2%  22.2%  22.2%   ✓  -1.6pp     +0.000     22%
  anvil           23.8%  24.3%  25.1%  25.5%  25.2%   ✓  +1.4pp     +0.004     26%
  garden          23.8%  22.0%  21.8%  22.0%  22.0%   ✓  -1.8pp     +0.009     23%
  kiln            23.8%  22.6%  22.8%  22.7%  22.0%   ✓  -1.8pp     -0.041     15%
  crucible        23.8%  24.8%  25.5%  25.8%  26.3%   ✓  +2.5pp     +0.036     32%

  ✓ the coastline is a two-way membrane on every cycle set
```

Every preset passes the ±5 pp / 40-game-year test. **That is not the same as the coastline
being stable**, and the same run says so from the other side. Read as *gross flux* rather than
as a stock — the same 40 years, per rule, in percentage points of world per game-year:

| preset | land→sea | sea→land | net | net as % of gross |
|---|---|---|---|---|
| `still` | 0.014 | 0.054 | −0.040 | 57.8% *(degenerate — a few dozen firings in 40 years)* |
| `anvil` | 0.134 | 0.100 | **+0.034** | **14.7%** |
| `garden` | 0.285 | 0.330 | **−0.045** | **7.3%** |
| `kiln` | 0.460 | 0.505 | **−0.045** | **4.7%** |
| `crucible` | 0.772 | 0.710 | **+0.061** | **4.1%** |

**On a live world the net is 4–15% of the gross.** The sea ends roughly where it starts not
because anything pulls it back, but because two large opposed flows happen to nearly cancel.
There is no attractor and no negative feedback anywhere in the coastline: nothing in the
ruleset makes a drained sea refill or a flooded one drain. **Every new water↔land edge is a
pure ratchet whose full magnitude accumulates linearly** — and the budget it spends from is
the few percent of headroom between those two big flows, not the 23% of the world that is sea.

That is the constraint the whole epic was designed around, and it is why every new edge in
specs 3–5 had to state its measured contribution before it shipped. Measured on `crucible`,
the epic's three new coastline edges:

| edge | spec | pp of world / game-year | direction |
|---|---|---|---|
| `shallows → desert` "the shallows bake dry" | 3 | 0.0226 | sea → land |
| `shallows → basalt` "the flow builds new land" | 3 | 0.0191 | sea → land |
| `river → shallows` "the river widens its mouth" | 5 | 0.0023 | land → sea |

All three sit inside the per-edge ceiling of 0.05 pp/y, and 0.044 pp/y in total against the
0.125 pp/y aggregate ceiling (which is `sweep.ts`'s own fail threshold restated: 5 pp over 40
game-years). Decisions `0012`, `0013`, `0014` and `0019` carry the reasoning.

### ⚠️ A slow drain and a slow flood both pass the test — read the "late pp/y" column
`kiln` drifts −1.8 pp over 40 years, comfortably inside ±5, and its **post-transient rate is
−0.041 pp/y**, projecting to **15% sea at year 200**. `crucible` drifts +2.5 pp and projects
to **32%**. Neither is a defect this epic introduced — both became visible only because spec 3
added the rate column — but both say the ±5 pp / 40-year test **cannot distinguish "converged"
from "draining forever"** on the timescale a long-lived server actually runs. Making the rate a
gate would fail `kiln` today, which is a tuning decision and is deliberately not taken here.
See "Open, escalated" below.

---

## The beam: a wandering sun, followed by its scar

**The sun is no longer a wall, and it is no longer an event.** It was a full-height band of
columns — every row under it at once, so a purge covered 100% of the world — and then a blob
that went dormant for five days in six and retraced an identical curve every purge. It is now
a hex disc travelling a sinusoid that **precesses**, permanently present, reaching a fraction
of the world per crossing and all of it over a **great year** (decisions `0023`, `0024`).
`shape: 'band'` is kept rather than deleted: it is the validated `anvil` prototype, `--beam`
still selects it, and every band-only finding below is labelled as such.

### ★ The great year: partial coverage per pass, complete coverage eventually

Without precession the track was derived from progress through one traverse, so every traverse
walked the same curve: coverage after 1 traverse 7.47%, after 5 traverses **still 7.47%**. The
only way to reach every tile was a disc wide enough to cover the map in one pass, which is
exactly how the sun stopped being visible.

Wave phase now advances `1/K` turns per traverse, `K = greatYearTraverses`. 240 × 144, seed
20260729, shipped defaults (radius 8, 2 oscillations, full amplitude, 60-day traverse, K = 8),
driving the real `SolarBeam.dayState` and `affect`:

| traverse | this pass | cumulative |
|---|---|---|
| 1 | 28.50% | 28.50% |
| 2 | 28.46% | 52.34% |
| 3 | 28.49% | 72.88% |
| 4 | 28.48% | 86.92% |
| 5 | 28.49% | 95.35% |
| 6 | 28.45% | 99.31% |
| 7 | 28.48% | **100.00%** |
| 8 | 28.45% | 100.00% |
| 9 | 28.50% | 100.00% — **reproduces traverse 1 exactly** |

Every tile is reached within a 480-day great year, and the sun is exactly as predictable
afterwards. Over those 9 traverses (540 days) there were **0 dormant days and 0 days on which
the beam contributed nothing** — it is always present, which is the second property it lacked.

Because `1/K` is rational the schedule is *learnable*: one number, and a player knows where the
sun will be forever. A random or irrational drift would also cover the map and would not.

### ★ The trail is the terrain, and that constrains the radius

> "I didnt mean to render its path. I simply meant that because of the immense heat of the beam
> effecting the biomes, it will be easy to see where it has been because of the biome changes
> preceding it"

So followability is a property of the simulation, not of a renderer, and it puts a **ceiling**
on beam size where escapability puts a floor: a beam that burns everything leaves nothing for
the burned ground to be legible against.

Measured by differencing a beamed world against a no-cycle control at the same seed, so what is
marked is exactly the ground the beam changed. 240 × 144, seed 20260729, one traverse, each
character a 2 × 6 block: `#` most of the block changed, `:` some of it, blank untouched.

**Shipped defaults — radius 8, 2 oscillations, 60-day traverse. 8.74% of the world changed.**

```
|                                                         :::::::                     :::::#:#:                          |
|    :                                                    : :: :::                   :::::#:#::                          |
| :::::                  ::                                ::::::::                 ::::###::                          : |
|: :::                   ::::: :                            ::::::::                ::::::::                           ::|
|  ::   ::              :: ::::                              ::::::::              :::::::#::                            |
|   ::#:::          :::: : :: :                               :                     : ####::                             |
|  :::#:##:          :##: :                                                      : :::#::::                              |
|  ::######:        :#######:                                   : :: :::        :: ::::::                                |
|   :::::::#:      :###:###:                                     :::::::       :#######::                                |
|    ::#:: :::      ::: :::                                        :::::::    :#######:                                  |
|       ::::  : ::: ::  :                   ::                    ::: :::##::#######::                : :::::            |
|         :: :::::::::::                  ::::::::                   ::::::###:####:                ::##########         |
|           ::::: :                    :::::::::#: :                  ::#::##:::::                :::::##########:       |
|               :                    : :::::::: :  ::                    :::::                  ::#####:###########:     |
|                                  :#::##:#::   ::::: ::                                       :#####:#:   :########:    |
|                                 :########:     :##::::::                                    :#######:      ::######:   |
|                                :########        :##: :                                     :::###:::        ::####:##  |
|                                : ::  :           ::                                         ::#::::          :#######: |
|                               ::::                 ::::::::                               ::::::::            :#######:|
|:                           : :: ::::               ::  ::::                              :#::::#::             :#######|
|#:                           :::::::::                 : :: ::                           ::::##::                :#:###:|
|##                                                    : ::#:::                          :##:#:#:                 :######|
|:                                                      : ::: ::                        ::###:##:                   ###::|
|                                                        ::::::::                      :::::::::                         |
```

Two full waves, traceable end to end, wrapping at the seam.

**The negative case — the r=16 / 9-oscillation default this replaces. 44.44% of the world
changed in a single 45-day transit, and there is no track in it at all.**

```
|             :::: :::                            ::##::#:::::#:#::##:#:###:::###:###:#####:########################     |
|  :::::  ::::::::::::::::                    :::::#####::::::::#:#::##::::###::##:####:##:#:##:####################     |
|:::#:::::::::::::::::::::::          :  ::::::::#::::#::::::::::::::#:::#:#:#:::####:##:###:###:##:################:  ::|
|#:  ::::: ::#::::::::::: : :::::::::::::::#:::#:::::#::#:::#:#:::#::#::::::#:#::::#:::#:::###:::#:######################|
|::::: ::::::#::::: :::::::::::::::::: :::::::::#::::::::::::::::::::::::: ::::#::::::#:::#:##:::#:#:###:################|
|:: :::#####:::::###:#:::  ::: : :::::: :::::: :::        :::::::        :###::::#:##:::#####:###::##################:###|
|::::::#:#######:######::::::::::: :::::::##::::                         :##:::#:###::::::::#:#####:###:#################|
|:##############################:###::::####:::::::: ::::: : ::: ::: :::: #::::##:##:#:####:#########################:###|
|  :::#####:#::###########################:  :::::::::#::::::::::::::::#::############################################:: |
|::#::::::::::::: :::::::::#:::::::#######::::: :  :::::: : :: ::::::##:::##############################################:|
|##::::::## ::::::: :::::#::::::::#::::###:::: :: :: :  :: :::: :::::#::::###############################################|
|####::::::: : ::::::: :#:::: ::::::::::##::#:::::::: :::::::: ::::: : #########:#:######################################|
|#####:::::::::#::#:::::::::::::::::::::::::::#:::::::::: :: :#::::: :###################:##:#:####:#####################|
|#####: ::::: :#####:::: ::#:::::::::::::#######:::::: ::::::::::::::::######::#::#######################################|
|######::###:######::#:#:::::#######::#:##########:::  :::::::::: ::::::################################:::##############|
|###################################################::::##::#::::::::::::###:#:#######################:###::#############|
|#######:#:#::####################################::#: :         :  ::: ::::::::##::::#:##############: :   :::##########|
|#######::::::::: ::::::::::::: :#:::::::::::::::::::                         #:#:#:#:####:::::########:#################|
|#######:::::::::::: :::#:::: ::::: :::: :::######::::::#:#:#::::::::::      :::#::: #:#:######:::#######################|
|#######:: ::: ::::::::::::::::#:#::::::::::::##:: :::::::::::: ::::::::::#:#::#::#:######::#:::#:#######################|
|#####:::                     ::  ::: :: :#:::##:: ::::::::#:::::::::::::::::::::####:####:##:##:#:#####:################|
|##::                                   ::::::::#:::::#::::::::::::#:#:::::::#:#:#:##:##:#############:##################|
|:                                          ::::::#::##::::::#::::::###::#::#::###:##:#################################::|
|             :: : :                           ::::####::: #:#:::##:##:#:#:#::#::#:######:###########################:   |
```

**And the other end — radius 2, same track. 1.37% changed.** The line is the *cleanest* wave of
the three, and the world still fails: on the old geometry a beam-only world at r=2 latched six
biome families with 61.56% of the map having no live out-rule, while `npm run sim` called it
alive. Legibility alone is not a defence; see bug #9.

**Two knobs set whether the scar reads as a wave, and they are the same two.** Row speed is
`4·amplitude·(height/2)·oscillations / transitDays` and track SLOPE is
`2π·amplitude·oscillations / width` — both proportional to `oscillations / transitDays`. Past
roughly one row of rise per column the scar stops reading as a wave and starts reading as
vertical stripes:

| oscillations | slope (rows/col) | daily row travel, mean / max | reads as |
|---|---|---|---|
| 9 *(old default, 45 d)* | 17.0 | 68 / **143** of 144 | a full-height smear |
| 3 | 5.7 | 14.4 / 22 | periodic stripes |
| **2** *(shipped, 60 d)* | **3.8** | **9.6 / 15** | **a wave** |
| 1 | 1.9 | 4.8 / 8 | a wave, at a third of the coverage |

### ★ Radius buys coverage, and coverage is what the world consumes

⚠️ **The two tables in this section were measured on the OLD geometry** — `oscillations: 9`,
full amplitude, dormant between purges, no precession — and radius was the only variable. They
remain the evidence that *coverage is the currency*, which has not changed, but **their
absolute coverage figures are specific to a 9-oscillation track and are not the shipped one**.
Re-measured on the shipped 2-oscillation track, per pass: 7.00% (r=2), 14.17% (r=4), 28.50%
(r=8), 42.73% (r=12), 56.78% (r=16). A shorter track covers less per pass at every radius, and
coverage no longer saturates at 100% within one pass at any radius a world can hold — which is
the point, because saturation is what erased the trail.

240 × 144, 1200 days, seed 20260729. The track is held fixed (`oscillations: 9`,
`amplitudeHalfHeights: 1.0`, `wavePhase: 0`, `homeRow: 0`) and `focusRadiusHexes` scales with
the radius as `round(r/4)`, so **radius is the only variable**. Coverage and tile-days come
from the real `SolarBeam.affect` over one whole purge; entropy and churn from the real
`assessStability`; inv-8 is the verbatim `invariants.ts` escapability recipe (120 × 72, settle
365, watch 365, stride 3).

**`anvil`** — beam only, 60 d transit / 360 d cycle.

| radius | tile-days/purge | coverage % | entropy | churn % | biomes>1% | `npm run sim` | inv-8 % |
|---|---|---|---|---|---|---|---|
| *band* | *129,600* | *100.00* | *0.732* | *1.208* | *11* | *PASS* | *13.69* |
| 2 | 10,623 | 28.46 | 0.676 | 0.180 | 9 | PASS | **61.56 — 6 families latched** |
| 4 | 23,069 | 55.98 | 0.699 | 0.327 | 11 | PASS | **34.16 — 4 families latched** |
| 8 | 52,233 | 93.34 | 0.722 | 0.644 | 11 | PASS | 15.78 |
| 12 | 87,133 | 100.00 | 0.731 | 0.937 | 11 | PASS | 13.88 |
| **16** *(shipped)* | **127,793** | **100.00** | **0.730** | **1.197** | **11** | **PASS** | **13.54** |
| 24 | 226,393 | 100.00 | 0.730 | 1.620 | 11 | PASS | 13.45 |
| 32 | 348,033 | 100.00 | 0.728 | 1.926 | 11 | PASS | 13.09 |

Latched families (per-biome share above the 2% limit, i.e. `npm run sim:check` FAILS):
r=2 — tundra 16.01%, forest 10.66%, grassland 6.27%, frozensea 4.78%, savanna 4.40%, desert
2.47%. r=4 — tundra 5.35%, forest 4.87%, grassland 2.65%, frozensea 2.53%.

**`crucible`** — six cycles, 45 d transit / 420 d cycle.

| radius | tile-days/purge | coverage % | entropy | churn % | biomes>1% | `npm run sim` | inv-8 % |
|---|---|---|---|---|---|---|---|
| *band* | *97,200* | *100.00* | *0.763* | *3.265* | *14* | *PASS* | *5.05* |
| 2 | 10,389 | 28.45 | 0.748 | 2.932 | 13 | PASS | 6.50 |
| 4 | 22,213 | 55.96 | 0.753 | 2.951 | 13 | PASS | 5.74 |
| 8 | 49,023 | 93.32 | 0.760 | 3.064 | 14 | PASS | 5.20 |
| 12 | 80,099 | 100.00 | 0.764 | 3.191 | 14 | PASS | 4.97 |
| **16** *(shipped)* | **115,495** | **100.00** | **0.765** | **3.332** | **14** | **PASS** | **5.08** |
| 24 | 199,247 | 100.00 | 0.766 | 3.495 | 14 | PASS | 4.97 |
| 32 | 298,974 | 100.00 | 0.769 | 3.640 | 15 | PASS | 4.95 |

No family latches at any radius on `crucible`: five other cycles are disturbing the world, so
the beam's coverage is not the only thing standing between a tile and a live out-rule.
`anvil`, the beam-only world, is what sets the floor.

**Coverage saturates between r=8 (93.3%) and r=12 (100%), and everything follows coverage.**
Below saturation, churn and escapability track it almost linearly. Above it, radius buys only
heat: r=12 → r=32 on `anvil` quadruples tile-days per purge (87,133 → 348,033) with coverage
pinned at 100.00% and escapability flat (13.88% → 13.09%).

⚠️ **`radiusHexes: 16` is no longer the default, and it was never a validated choice.** It was
selected to reproduce the previously validated worlds' verdicts — tuned until it was
indistinguishable from the thing it replaced — and the cost was a sun nobody could see. The
shipped default is now **8**, chosen so the scar reads as a wave while `sim:check` stays green
on a beam-only world. Escapability is still the floor; legibility is now the ceiling.

### ⚠️ Two knobs, not one — and this finding is about a `band`. It does not transfer.

Under a **band**, severity and frequency must be separate parameters:
- **transit** — how fast the beam crosses. Sets how long a tile bakes underneath it.
- **cycle** — time from one purge to the next. Sets recovery time.

Collapsing them inverts the intent: a *longer* period means a *slower* beam, each tile is
exposed for longer, and the world sterilises. **Re-measured on this tree** at a single-knob
900-day period, 120 × 72, 60 game-years: sea share **23.81% → 5.60%, −0.3034 pp/y**. The
finding reproduces.

**Under a continuous blob the two knobs are deliberately collapsed, and the same 900-day period
does not drain the sea at all: 23.81% → 23.52%, −0.0048 pp/y.** What goes wrong instead is that
the world goes *quiet* — entropy 0.685, churn 0.24%, converging toward the `still` control —
which the churn floor already catches (R-005). The mechanism differs because a band's dwell and
its dose per day both rise with the period, while a blob's dose per day *falls*:

| geometry | period | mean dwell | max dwell | beam tile-days/day |
|---|---|---|---|---|
| band, 8 cols | 30 d | 1.82 d | 2 d | 180 |
| band, 8 cols | 60 d | 3.59 d | 4 d | 360 |
| band, 8 cols | 120 d | 7.11 d | 8 d | 720 |
| band, 8 cols | 240 d | 14.17 d | 16 d | 1440 |
| blob r6 osc3 | 30 d | 1.30 d | 3 d | 459 |
| blob r6 osc3 | 60 d | 1.60 d | 4 d | 284 |
| blob r6 osc3 | 120 d | 2.21 d | 7 d | 196 |
| blob r6 osc3 | 240 d | 3.42 d | 12 d | 152 |

The liveness runs agree: 1500 days, 240 × 144, a band goes 0.726 → 0.771 entropy as transit
runs 30 → 240, while a blob goes 0.764 → 0.718 and its churn falls monotonically 1.24% →
0.54%.

★ **So the direction a GM turns the dial inverts with the shape.** A *shorter* transit softens
a band; a *longer* traverse softens a blob. That is why `crucible`'s beam period moved from 45
days to 150 in this spec rather than staying put — decision `0024`, and the preset's own
comment carries the water-trend table that set the number.

---

## Bugs the prototype caught

Each would have been far more expensive to find after building on top of it. **#1–#8** predate
epic `2915cb06`; **#9–#16** are what that epic found.

**1. Moisture diffusion constant off by ~25×.** Retention was set as though moisture decayed
like `r^distance`, but the target averages six neighbours — it is a *diffusion equation*, with
falloff `exp(-sqrt(2(1-r))·d)`. At r=0.995 that is ~0.1/tile, so every continental interior was
bone dry by construction and nothing could regrow. Correct value is **0.9998** (~0.02/tile).
This one constant was the difference between 8% and 35% living land.

**2. Heat applied as an additive moisture sink.** A flat subtraction compounds across diffusion
steps, driving any tile above 50 heat that wasn't touching water to zero moisture. Forests and
blooms were mathematically impossible. Heat must be a *multiplicative* decay on retention.

**3. The coastline was a one-way ratchet.** Deposition slightly outran erosion, so oceans
drained from 21% to 11.9% over four game-years — the same absorbing-state failure, slower and
less obvious. The coast must be a genuine two-way membrane. *(See "no restoring force" above:
it is two-way, but only because two large flows nearly cancel — not because anything pulls it
back.)*

**4. Albedo feedback caused runaway desertification.** Desert and glass each added +2.5 heat to
neighbours → lower retention → more desert. One purge desertified the world permanently. Capped
at **+1.2**.

**5. Measurement bug.** A purged world **oscillates**, so a single end-of-run snapshot lands at
an arbitrary cycle phase and reports it as steady state. Metrics must be tail means with the
range reported — the swing *is* the design.

**6. Dead CLI flags.** `run.ts` parsed `--beam-period` into a property `WorldOptions` no longer
declared; Node strips types unchecked, so it silently did nothing. Fixed — `--beam-transit` and
`--beam-cycle` are now genuinely parsed.

**7. ★ Transition rolls were keyed on array position.** `rollAt(seed, tile, day, r)` took `r` =
the rule's index in its per-biome bucket, so a rule's dice were a function of where it happened
to sit in `RULES`. Inserting one renumbered every rule after it: **editing the erosion rules
changed what the forests did**, every recorded number shifted for reasons unrelated to the
edit, and nothing said so. This is the worst kind of bug in a simulator whose entire value is
that its numbers can be believed — it makes any A/B comparison between two rulesets
meaningless, and it is invisible.

Fixed by deriving identity from content: `<fromBiome>-><toBiome>:<label>`, hashed to a 32-bit
stream id. Proven by the probe table at the top of this file. `sim:check` now verifies all 185
keys and all 185 hashes are distinct, because two rules sharing a stream would make the later
one dead code that the graph checks still count as a live edge.

Note the sharp edge this trades for: from/to alone is not unique (glass has three exits), so
`label` is part of the key — which means **renaming a rule re-keys it and changes the world.**
That is the right trade, since a rename is a deliberate edit to the rule where a reorder is
not, but `sim:golden` exists partly to make it loud.

**8. `npm run sim --days N` silently ran a different world.** Without `--`, npm swallows the
flags as its own config; `npm run sim --days 1500 --cycles still` ran **crucible at 1200 days**,
i.e. the opposite preset. The `sim` script also hard-coded `--days 1200`. Both README and this
file documented the broken form. The hard-coded `--days` is gone and `run.ts`'s own default
(1200) applies, so `--`-forwarded options now work; flag resolution also moved from `indexOf`
to `lastIndexOf`, so a repeated flag takes the last occurrence rather than the first.

---

**9. ★ A beam radius can pass the liveness test while latching 61% of the world.**
*Looked reasonable:* a smaller sun is a gentler world, and `npm run sim` is the instrument that
says whether a world is alive. *What it actually did:* `anvil` at radius 2 scores entropy 0.676
against a 0.65 floor and churn 0.180% against a 0.150% floor and is reported **alive** — while
**61.56%** of the world has no live out-rule across a full watched game-year and **six** biome
families are latched, four of them at more than double the 2% limit. Test 1 measures how much
composition *moves*, and a beam reaching 28% of the world moves enough of it to clear the floor
with the other 72% frozen solid. *How it was caught:* `npm run sim:check` — invariant 8,
escapability. **`npm run sim` never sees it.**

The lesson generalises past the beam: **a merge gate can be weaker than it appears, and the way
to find that out is to hold a second instrument that measures a different property.** Liveness
is a statement about the composition histogram; escapability is a statement about individual
tiles. A world can satisfy the first while most of it violates the second. The smallest radius
that keeps `sim:check` green on the beam-only world is **8**.

**10. ★ The one instrument built to catch a water ratchet hand-enumerated the water.**
*Looked reasonable:* `sweep.ts` defined `SEA_SHARE = [Ocean, Shallows, FrozenSea]` — an
explicit, readable list of exactly the biomes that were water when it was written. *What it
actually did:* `biomes.ts` derives `SEA` from a predicate (`water && !molten`), so the two
disagreed the moment a water-ish biome was added after the fact. The sweep's coastline table —
**the only thing in the repo that would notice a one-way membrane** — would have reported a
flat, healthy sea while the sea drained into a biome it could not see, and would have printed a
green ✓ for a river covering a fifth of the land. *How it was caught:* spec 3 was in the file to
add a flux ledger and noticed that `biomes.ts` refuses to build exactly this trap for its own
biome sets while `sweep.ts` had built one. Fixed by `SEA_SHARE = SEA`, so a new biome joins the
measurement the moment it joins `BIOMES`.

**An instrument that enumerates what it measures stops measuring the thing it was built for,
silently, the first time the world grows.** Derive, do not list.

**11. Neighbour-diffusion of temperature latches the polar cap.**
*Looked reasonable:* the sea should warm the land near it, and a nearest-neighbour diffusion
step (`T += α·(mean(neighbours) − T)`) is the obvious way to spread a scalar field on a grid.
*What it actually did:* in any nearest-neighbour scheme, **reach and inertia are the same knob**
— the field's spatial reach goes as `≈ 0.5·√(α·τ)` for relaxation time `τ`, so asking for
maritime influence several tiles inland forces a thermal memory long enough that the cold band
never warms past the ice-thaw gate, and the polar cap freezes permanently. You cannot buy reach
without buying inertia. *How it was caught:* invariant 8 again — the frozen sea, the glacier on
it and the tundra beside it all stuck at once, which is precisely the "family latch" that check
exists to detect. Fixed by making maritime reach a **per-day BFS proximity field with an
explicit distance falloff**, computed independently of the tile's thermal inertia, so the two
became separate parameters. Decisions `0009`, `0010`, `0011`.

**12. ★ A storm classified on wetness latches to 100% rain share.**
*Looked reasonable:* a storm over wet ground should stay wet, a storm over dry ground should dry
out — that is what weather does. *What it actually did:* rain raises moisture, moisture
reclassifies the storm as a rain storm, a rain storm rains. Every storm in the world converged
to rain, 100% share, and the desert belt gained a texture it could never lose. The loop's gain
exceeds one because the quantity being read is the quantity being written. *How it was caught:*
a per-kind storm histogram over a long run, added because the spec required kind shares to be
reported. Fixed by classifying on `BiomeDef.water && !molten` — geography, which a storm cannot
change on the timescale it lives. Classified that way it is stable. Decision `0016`.

**Never gate a feedback on a quantity the feedback can create.** Same shape as bug #4 (albedo →
heat → desert → albedo), and the reason evaporation is gated on geometry (`waterNeighbours <=
2`) rather than on heat: a heat-gated evaporation edge closes a loop whose measured gain is
+4.2 heat on a neighbouring sea tile per converted desert — larger than the +2.5 albedo term
that sterilised a world.

**13. Rivers counted as water annihilate themselves *and* open a water ratchet.**
*Looked reasonable:* a river is water, so `BiomeDef.water: true`. *What it actually did:* two
failures from one flag. `water: true` makes a river tile count as a water neighbour for every
coastline rule in the simulator, so rivers drowned their own banks into shallows and then
themselves — the biome went **1.14% → 0.00%** — and while doing it opened a **+1.5 pp water
ratchet in four game-years**, twelve times the epic's entire aggregate budget. *How it was
caught:* the flux ledger from bug #10's fix, which reports per-rule gross flux, showed a large
new land→sea flow with no return. Fixed by `water: false`: `SEA` is derived, so a non-water
river is **structurally excluded** from drowning, deposition, evaporation, subsidence, the
maritime thermal field and `TERRAIN_CLASS.Sea` alike, without any of them naming it. Decision
`0019`.

**14. ★ A rendering choice hid a fixed point.** The ring-adjacency predicate that stops rivers
widening into lakes admits a **0°/120°/240° sublattice** — a stable honeycomb at 1/3 density,
which is exactly the widening the predicate was written to prevent, wearing a pattern as a
disguise. *Looked reasonable:* the ASCII map showed a thin dendritic network. *What it actually
did:* on a hex torus drawn as a naive square grid of characters, a 1/3-density honeycomb and a
sparse river network look **identical**. The sublattice was invisible until the odd-r
half-column shift was applied to the render. *How it was caught:* by fixing the renderer, not
the simulator.

**A visualisation that does not honour the geometry of the thing it draws can hide a fixed
point of that thing.** The map is an instrument; it needs the same scepticism as a number.
Decisions `0020`, `0021`.

**15. `daysUntilBeam(col)` answered a question that no longer has an answer.** It hardcoded row
0, which was harmless under a band — a band occupies every row of its columns — and is wrong
under a blob, where **172 of 240 columns** are never visited at row 0 and the honest answer is
`Infinity`, meaning *never*, not *not yet*. A blob's track is periodic and retraces itself every
purge, so a tile it misses is missed for the life of the world. The signature now takes a
required `row`. `forecast()`'s claim that one cycle plus one transit is "provably enough for
every column" is likewise true of a band only. Decision `0008`.

**16. ★★ A number measured under one configuration, quoted as current under another — four
times in one epic.** This is deliberately a single entry about the *class* rather than four
entries about four numbers, because the instances are not independent mistakes. They are one
failure mode, and it is this epic's characteristic one.

*Looked reasonable:* every one of these figures was real, was produced by an actual run, and
was correct at the moment it was taken. *What it actually did:* a **plausible** number is
indistinguishable from a **current** number once it is on the page, and a sequential epic
invalidates its own evidence at every commit boundary — five specs, each moving the same three
files and each re-baselining the golden hashes. The four instances:

| # | What was quoted | What was actually true |
|---|---|---|
| 1 | A beam-geometry table (coverage, tile-days) from a working prototype | The prototype used a different track — absolute row amplitude, different oscillation count. 7.47% coverage quoted where the shipped track measures 28.46%. **Reached GM-facing product text.** |
| 2 | "210 of 240 columns return `Infinity`" for `daysUntilBeam` | Same prototype track. Re-measured on the shipped one: **172 of 240**. |
| 3 | World-outcome figures (entropy, churn, escapability) carried past the commit they were taken on | Superseded by the next spec's changes to the same three files. |
| 4 | A "before" comparison for the entropy threshold, headed 1500 days | The "before" figures were lifted verbatim from a section that states its own horizon as **1200 days**. A 1200-day before against a 1500-day after, presented as the effect of adding a biome. |

Instance 4 is the instructive one, because it very nearly produced a **false causal story**
rather than merely a wrong digit: it implied the new `ln 23` denominator is what pushed the
control below the entropy gate. It is not — see the entropy section above, where the control
scores 0.6459 under the *old* divisor and fails there too. A stale number can be rounded off;
a stale number embedded in an explanation propagates into the reasoning built on top of it.

Three defences, in increasing order of usefulness:

1. **Re-measure in one pass at the end of an epic**, not incrementally inside it. Measuring
   five times produces five sets of numbers that are each true for one commit.
2. **State the provenance beside the number** — tree, preset, size, horizon — so a figure with
   no run behind it looks wrong on the page. Instance 4 would have been caught on sight by a
   horizon label.
3. **Prefer an absent number to an unsourced one.** R-003 is phrased as "from a run *you*
   executed" for this reason, and where a matched comparison could not be made, this file says
   so rather than reaching for the nearest plausible figure.

---

## Invariants (`npm run sim:check`)

All passing.

- **23 biomes, 70 materials, 70 unique, 23 glyphs, 23 colours.**
- **185 rules, 185 unique keys, 185 distinct roll streams.** Every rule's identity is derived
  from its content, and no two collide — so no two rules share dice.
- **Single strongly connected component** across all 23 biomes under the full flag set — every
  biome reaches every other by some path. **148 distinct edges over 23 nodes** (29.2% density),
  eccentricity 3–4 (radius 3, diameter 4). Sparse direct edges, total reachability.
- **All 185 rules can fire** somewhere in climate × flag space (no dead rules whose
  precondition is unsatisfiable in their source biome).
- **Every biome has at least one exit needing no cycle at all** — so no biome is a trap on a
  world that lacks the relevant disturbance.
- **0 derived/hand-written fan-out clashes** — no predicate-derived rule silently doubles the
  rate of an edge a biome already carries by hand.
- **10 required chemistry edges present**, with worst-case path lengths:
  ```
  glass      → rainforest  d=3   glass → barren → swamp → rainforest
  glass      → bloom       d=4   glass → lava → soil → forest → bloom
  glacier    → lava        d=1   glacier → lava
  badlands   → bloom       d=4   badlands → desert → grassland → forest → bloom
  mountain   → ocean       d=3   mountain → barren → shallows → ocean
  desert     → glacier     d=3   desert → shallows → frozensea → glacier
  rainforest → mountain    d=3   rainforest → ash → basalt → mountain
  frozensea  → desert      d=2   frozensea → shallows → desert
  ```
- **No biome family latches on a live world.** Share of the world with no live out-rule over a
  watched game-year: `crucible` **5.08%** (all Deep Ocean interior), `kiln` **7.55%**, `garden`
  **8.40%**, `anvil` **13.54%** (ocean 13.51%), `still` **92.37%** (control, exempt by
  construction).
- **The sweep covers every column exactly once a day, at every width** — 1.000
  evaluations/column/day at all ten width × band combinations, measured through a zero-effect
  observer cycle (decision `0006`).

### A world's cycle set determines its biome vocabulary

Reachable core per preset, from the same run:

| preset | live edges | SCCs | core | outside the core |
|---|---|---|---|---|
| `still` | 109 | 4 | 20/23 | mountain, lava, ash |
| `anvil` | 125 | 2 | 22/23 | mountain |
| `garden` | 116 | 3 | 21/23 | lava, ash |
| `kiln` | 144 | **1** | **23/23** | — |
| `crucible` | 148 | **1** | **23/23** | — |

**A world with no tectonics literally cannot make a mountain. One with no volcanism and no beam
has no route to lava or ash.** The GM's cycle dial is expressed as graph connectivity — choosing
a world's cycles chooses which biomes, and therefore which *materials*, can exist there at all.
That reaches all the way into the economy: a garden world simply has no volcanic stone, and must
trade for it.

⚠️ Reachability is **kind-level, not parameter-level** — `reachableCore` restricts the ruleset to
the flags a cycle *kind* can raise, so `seasons` counts as a source of Freeze even at amplitude
0. **"Unreachable" is a hard fact; "reachable" is a possibility.**

---

## Golden worlds (`npm run sim:golden`)

The graph invariants above can all hold while the simulation quietly produces a *different
world* than the one these numbers describe. A changed constant, a reordered array, a renamed
rule, a refactor that looked equivalent — none of them announces itself, and each invalidates
this entire file.

So two worlds are pinned by hash. 160 × 96, seed 20260729, 500 days:

| case | preset | hash |
|---|---|---|
| `still` | no cycles | `10468117cccd7501` |
| `crucible` | all six cycles | `599d7815137a0a4f` |

Both verified deterministic across two independent builds in the same run, which is R-004
tested rather than asserted. **Neither moved during this documentation pass**, which is the
point: a re-baseline that changes no behaviour must not change a hash, and a hash that moved
here would have meant the pass had done something it was not allowed to do.

Two cases rather than one so a failure **localises**: `still` exercises worldgen, the hydrology
and the climate-gated rules only. If both drift, suspect worldgen or hydrology; if only
`crucible` does, suspect the cycles or the cycle-gated rules. `crucible` carries the weather
cycle, which is the first cycle in the project to read world state — so this gate is also what
puts a world-reading cycle under the determinism check on every run rather than only under a
harness (decision `0015`).

500 days is chosen, not arbitrary — it clears `crucible`'s full 420-day beam cycle plus a
transit, a 360-day year of seasons and monsoon, and several 64-day tectonic/volcanic epochs, so
every cycle has both fired and gone dormant before the hash is taken.

**A failure here is not necessarily a bug — it means the world changed.** If that was
deliberate: `npm run sim:golden -- --update`, paste the hashes, then re-run `npm run sim` and
update this file in the same commit. Updating a hash without re-measuring turns the tripwire
into a rubber stamp.

⚠️ **Scope.** This pins the simulator against *itself on one JavaScript engine*. `Math.cos` and
`Math.pow` are not required by ECMA-262 to be correctly rounded, so another engine may produce
different hashes without anything being wrong. Making it cross-engine means replacing those two
calls with our own approximations, not loosening the test.

---

## Found by the documentation pass — one fixed, one still open

This pass was scoped to documentation, and it measured two defects. The first was repaired in
the following commit (`0b664b2`); the second is recorded and deliberately left alone.

**A. `sweep.ts`'s churn column divided by the wrong interval. FIXED in `0b664b2`.**
`measure()` seeded `prev` with the day-0 composition and refreshed it only inside the tail
branch. At 1200 days the tail opens on day 795, so the *first* tail sample was a 795-day delta
averaged in as one 5-day sample among 82. Measured from the same runs (180 × 108, 1200 d, seed
20260729):

| preset | as it printed | corrected | that first sample |
|---|---|---|---|
| `still` | **0.572%** | **0.047%** | 43.14% of the map / 795 d |
| `anvil` | 1.931% | 1.266% | 55.82% |
| `garden` | 3.179% | 2.348% | 70.51% |
| `kiln` | 3.388% | 2.550% | 71.20% |
| `crucible` | 3.774% | 2.951% | 70.46% |

The control read **12× its true churn**, which mattered far more than the ~30% inflation on the
live presets: `sweep.ts` gates on `churn > 0.15%`, so **the control was clearing the sweep's own
frozen-world test spuriously** — the one instrument whose job is to prove disturbance matters
was failing to convict a corpse. Its headline ratio was reading 6.6× where the truth is **63×**.

No shipped verdict ever changed: `still` failed the sweep anyway on "flat, too few biomes", and
`npm run sim`'s `assessStability` computes churn correctly by differencing *within* the tail.
**Every `still` figure in this file comes from `assessStability`, never from the sweep's churn
column.** After the fix `still` reads `flat, frozen, too few biomes` and correctly fails on
churn; no other preset newly fails, so the bug was not masking a second one. The weakest live
configuration in section A (`60d/720d`, 0.36%) stays clear of the 0.15% floor.

The fix has two halves because either alone leaves a hole: the delta now divides by the interval
between the snapshots actually compared, *and* the first tail snapshot is a baseline rather than
a sample — normalising alone still averages the worldgen transient into a late-run rate, giving
an honestly-divided 0.049% that is measuring the wrong thing. `SAMPLE_DAYS` and `TAIL_FROM` were
extracted so cadence and divisor cannot drift apart again. Decision `0022`.

**B. The ±5 pp / 40-year membrane test cannot distinguish converged from draining.** Still open,
below.

**B. The ±5 pp / 40-year membrane test cannot see a slow drain.** `kiln` projects to 15% sea at
year 200 and `crucible` to 32%, both while passing comfortably. Promoting the "late pp/y" rate
to a gate would fail `kiln` today; picking that threshold is a tuning decision for the world's
owner, not a documentation edit.

---

## Mechanics the sim produced

**Life reclaims from the edges.** Regrowth rules scale pressure by living-neighbour count, so a
scoured region recovers inward from survivors. Stops a purge being an absorbing state; visually,
green creeping back across the scar.

**Latitude on a torus.** No poles, so latitude is a smooth periodic band: `26·cos(2πr/H)` — one
hot equator, one cold band, continuous across the seam. The desert belt and tundra band emerge
from hydrology rather than being authored.

**The sea reaches inland.** Temperature is stored per tile and relaxes towards a target, so a
coastline lags the season it is in; a per-day BFS proximity field with distance falloff carries
the sea's moderating influence inland; and acute heat — a purge, a vent, a quake — bypasses the
filter entirely, because a one-day +115 against a melt gate of 120 does not survive being
low-passed. Decisions `0009`–`0011`.

**Weather is legibility, not disturbance.** Storms travel their own sinusoidal tracks, morph
against the ground they cross and die on it — 24.8% of storm-days end in a death on `crucible`'s
scarred terrain, 9.2% on `garden`'s fault ridges, 0.3% on a control with neither. They move
entropy by thousandths and churn by nothing, and they spend nothing from the water budget. What
they buy is a map with rain crossing it and a forecast a caravan can read. Decisions
`0015`–`0017`.

**Rivers are an area, and they are land.** A 23rd biome that springs from marsh, chains downhill
on retained elevation, and warms to swamp. `water: false` is load-bearing rather than incidental
(bug #13). Measured on `crucible`'s tail, river settles at **5.14%** of the world. Decisions
`0018`–`0021`.

**Bloom is naturally precious.** Sunpetal/nectar/essence/aureole settle at a fraction of a
percent with no special-casing — **0.44%** on `crucible`'s tail. The signature solarpunk
material is scarce because its conditions are.

**`crucible` tail-mean composition** (180 × 108, 1200 d), for reference:

```
ocean 17.30%  ·  tundra 11.38%  ·  forest 11.02%  ·  grassland 9.22%  ·  marsh 8.27%
desert 6.50%  ·  frozensea 5.40%  ·  river 5.14%  ·  rainforest 4.94%  ·  glacier 4.93%
barren 4.06%  ·  glass 2.42%  ·  rock 2.05%  ·  savanna 1.38%  ·  basalt 1.14%
swamp 1.01%  ·  shallows 0.90%  ·  mountain 0.82%  ·  badlands 0.56%  ·  ash 0.56%
bloom 0.44%  ·  soil 0.36%  ·  lava 0.19%
```

---

## Not yet modelled

- **Cities, stations, and player structures.** The beam destroying *terrain* is modelled; the
  beam destroying *infrastructure* is not. That is where evacuation and salvage live.
- **Soil fertility as a per-tile scalar** — farming depletion and fallow recovery (Session 10).
  Currently only biome-level fertility exists.
- **Population** — birth, death, famine, carrying capacity. Needs the same
  sources/sinks/oscillation discipline the terrain got.
- **A restoring force on the coastline.** The membrane is two-way, but only because two large
  opposed flows nearly cancel — nothing pulls the sea back to where it was. See the membrane
  section; this is the open structural gap the whole epic worked around rather than closed.
- **Erosion of elevation.** Elevation is retained but static (decision `0018`): rivers read it,
  nothing writes it, so a landscape does not wear down.
- **Depletion of mineral deposits.** Terrain change is currently the only churn in the resource
  map.
- Single-threaded, in-memory, no persistence. This is a model, not the service.
