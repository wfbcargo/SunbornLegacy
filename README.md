# Sunborn Legacy

A browser-based living-world MMO of caravans, industry, and trade in a multiverse being
endlessly reshaped by a Sun God.

**This file is the entry point.** It records what exists, what is decided, what is
validated, and what is not.

---

## Read in this order

| Doc | What it is | Trust level |
|---|---|---|
| **`PITCH.md`** | The elevator version — world, pitch, audience, how it plays. Start here. | Current |
| **`BRAINSTORM.md`** | The full design record, 12 sessions. Every decision with the reasoning that produced it, plus corrections and open questions. ~1,550 lines. | Current; the authoritative design source |
| **`ARCHITECTURE.md`** | Technical architecture — data model, API contract, simulation, realtime, economy, build sequence. ~2,000 lines. | ⚠️ See caveat below |
| **`SIMULATION.md`** | Findings from the terrain simulator, with verified numbers | Current — re-measured 2026-07-30 in one pass |

`BRAINSTORM.md` is the source of truth for *design*. Where `ARCHITECTURE.md` and
`BRAINSTORM.md` disagree, brainstorm wins on intent and architecture wins on mechanism —
but flag the conflict, because it means one of them missed a decision.

### ⚠️ `ARCHITECTURE.md` predates Sessions 9–12
It was produced by a multi-agent workflow that read `BRAINSTORM.md` as it stood at
**Session 8**. It is thorough and its reasoning is sound on what it covers — persistence,
LOD, API/auth, fog of war, realtime, terrain simulation, the economy, GMs, and a
13-phase build sequence — but it has **no knowledge of** design decided afterwards:

- characters as an economy; birth, death, obedience, conversation, trading
- soil fertility and carrying capacity
- stations, slots, settlements, and spacing rules
- combat, arenas, deployment, fleeing and pursuit
- tile activities as the vulnerability primitive
- communication locality; sightings stored with timestamps rather than as truth

**Treat it as a strong foundation with a known cut-off, not as a complete spec.** The data
model in particular will need extending for characters, stations, settlements, combat, and
soil. Its `world_log`, fog-of-war-in-authorization, and lattice decisions should survive
that extension intact.

---

## Current state — 2026-07-30

### Decided and stable
The pillars in `BRAINSTORM.md` are settled unless explicitly marked open:
API-first with third-party clients, toroidal hex map, TypeScript end-to-end, flat
(non-exponential) progression, regional materials, GM-per-world, world cycles as the
disturbance engine, obedient characters, station/slot settlement, light automated combat.

### How to run it

Node ≥ 22.6 (developed on 24). **No install step and no build step** — zero runtime
dependencies. To watch a world:

```
npm run viewer          # then open http://127.0.0.1:4173 and press Play
```

Everything else:

```
npm run typecheck    # tsc --noEmit — merge gate (R-002)
npm run sim:golden   # golden-world hashes — merge gate (R-010)
npm run sim          # full run, map + charts + both liveness tests
npm run sim:check    # transition graph + escapability + sweep coverage
npm run sim:sweep    # cycle parameter sweep + the 40-game-year coastline membrane
npm run sim:trace    # day-by-day trace of one disturbance cycle
```

⚠️ **Pass options after `--`:** `npm run sim -- --days 1500 --cycles still`. Without it npm
eats the flags and you silently get a different world — the mistake that once invalidated
the evidence recorded in this very file (see `SIMULATION.md` bug #8).

`npm install` is only needed to run `npm run typecheck`, which wants the two type-only
devDependencies. The simulator and viewer run from a bare checkout.

### Built
- **`src/sim/`** — headless terrain simulator. TypeScript, runs natively on Node 24, **zero
  runtime dependencies, no build step.** `typescript` and `@types/node` are devDependencies,
  type-only and erased at runtime (decision `0004`). **23 biomes, 185 transition rules**, six
  cycle kinds, five named presets. What a world can do now:
  - **Land and water are two-way traffic.** Lava reaching the sea builds new land
    (`shallows → basalt`); shallows cut off from the sea bake dry (`shallows → desert`). Both
    are gated on *geometry*, never on heat alone, because a heat-gated evaporation edge closes
    a feedback loop whose gain is greater than one. Decisions `0012`–`0014`.
  - **Rivers, as an area and a 23rd biome.** They spring from marsh, chain downhill on a
    retained elevation field, and warm to swamp. A river is **land**, not sea — the flag that
    makes that true is load-bearing (decision `0019`). Decisions `0018`–`0021`.
  - **Weather systems that travel, morph and die.** Six flags (rain / heavy rain / wind /
    heavy wind / cloud / heavy cloud), storms on their own sinusoidal tracks that change
    character against the ground they cross and die on stone. `garden` and `crucible` carry
    weather. It buys legibility, not disturbance, and spends nothing from the water budget.
    Decisions `0015`–`0017`.
  - **A wandering sun.** The beam is a swept hex disc on a sinusoid rather than a full-height
    wall, so **coverage** is a parameter where it used to be pinned at 100%. It is now also
    **permanently present** and **precessing**: the track's wave phase advances `1/K` per
    crossing, so it burns 28.50% of the world per pass and 100.00% over a **great year** of
    `K` crossings, then repeats exactly. And its path is meant to be read off **the scar it
    leaves in the terrain** — glass, ash and lava — not off an overlay, which makes partial
    coverage load-bearing twice: a beam that burns everything leaves no trail. `radiusHexes`
    is a first-class GM knob with a measured table behind it. `shape: 'band'` is kept and
    scoped, not deleted. Decisions `0007`, `0008`, `0023`, `0024`, `0025`.
  - **A sea whose temperature reaches inland.** Per-tile stored temperature with thermal
    inertia, a per-day BFS proximity field with distance falloff, and seasons moved onto a
    separate ambient channel so an acute purge is not low-passed into nothing. Decisions
    `0009`–`0011`.
- **`src/viewer/`** — a local world viewer: the hex map on a canvas, play/pause/step,
  hover readout, live liveness metrics, and a **cycle composer** — assemble any set of
  cycles (including two of the same kind out of phase), read what each one does to a world,
  set the world's size, and ask which biomes a given cycle set can never produce. It is a
  **development instrument, not a product surface**: localhost only, no auth, and it
  deliberately serves whole-world state the real API must never expose (decision `0001`).
  ```
  npm run viewer -- --width 320 --height 192 --seed 7 --cycles garden
  ```

### Validated — 2026-07-30, re-measured in one pass after epic `2915cb06`
Five sequential specs each moved the world and each re-baselined the golden hashes, and none
of them was allowed to touch this file. **Nothing below is carried forward from any of them;
all of it comes from runs made on the final tree, in one pass.** That discipline is not
optional pedantry — this epic produced *three* separate defects from numbers surviving across
trees, one of which reached GM-facing text (`SIMULATION.md` bug #16). 240 × 144, seed
20260729, unless stated.

- `npm run typecheck` — **clean.** ⚠️ Read this one honestly: the first `tsc --noEmit` reported
  94 errors and **every one was a missing Node host global**, so there were **zero substantive
  type errors** and nothing was fixed — a host environment was configured (`@types/node`).
  **The gate found nothing on the day it was added; its entire value is prospective.**
- `npm run sim:check` — **all invariants hold.** 23 biomes, 185 rules with 185 unique keys and
  185 distinct roll streams, a single strongly connected component over all 23 biomes (148
  edges, 29.2% density), all 185 rules satisfiable, every biome escapable without cycles, 10
  required chemistry edges, no latched biome family on any live preset, and 1.000
  evaluations/column/day at all ten width × band combinations.
- `npm run sim:golden` — **2 golden worlds unchanged**, each verified deterministic across two
  independent builds: `still` `10468117cccd7501`, `crucible` `599d7815137a0a4f`.
- `node src/sim/run.ts --days 1500 --cycles crucible` — **both tests pass.** Entropy 0.772,
  churn 3.65%, largest biome Deep Ocean 17.7%, 15 biomes above 1%; 83 habitable regions,
  0 generic and 0 thin, median 18 materials.
- `node src/sim/run.ts --days 1500 --cycles still` — **the control correctly FAILS**
  (entropy 0.637, churn 0.05%, 15 generic and 19 thin regions, flagged as heat death).
  This is the important one: it proves the test discriminates.
- The other three presets at 1500 days all pass both tests: `kiln` 0.755 / 3.25%, `anvil`
  0.728 / 1.51%, `garden` 0.723 / 3.17%.
- `npm run sim:sweep` — **the coastline is a two-way membrane on every cycle set**, inside
  ±5 pp over 40 game-years. Sea share y0 → y40: `still` 23.8 → 22.2%, `anvil` 23.8 → 25.2%,
  `garden` 23.8 → 22.0%, `kiln` 23.8 → 22.0%, `crucible` 23.8 → 26.3%. Corrected churn column:
  `still` 0.05%, `anvil` 1.27%, `garden` 2.35%, `kiln` 2.55%, `crucible` 2.95% — a **63×** spread
  between the control and the fullest cycle set. **Read the caveat in `SIMULATION.md`**: the
  membrane has no restoring force, and that one is recorded, not fixed.

  The documentation pass that produced this section also found the sweep dividing its churn
  delta by the wrong interval — the control was reading 12× its true churn and **spuriously
  clearing the sweep's own frozen-world test**. Fixed in `0b664b2`; no shipped verdict moved,
  because `npm run sim` computes churn by a different and correct path.

Full numbers, the argument behind each, and the bug list are in `SIMULATION.md`.

### ⚠️ Test-1 thresholds were recalibrated — know why, and know what just moved
Entropy stopped separating living worlds from dead ones once the taxonomy grew. *(Historical
measurement, from the ruleset as it stood before the recalibration and not re-run since:* a
no-disturbance control measured entropy **0.707** against a fully-cycled world's **0.703**, so
the *frozen* world scored **higher** and both were reported alive. *That was taken when the
taxonomy held 22 biomes; it holds 23 today.)*

**Churn is the load-bearing metric.** Variety is a snapshot property; being alive is a property
of motion. Do not "simplify" Test 1 back to entropy alone.

**The margin moved this epic, and the reason matters more than the number.** `biomeEntropy()`
divides by `ln(BIOME_COUNT)`, so the 23rd biome rescaled *every entropy figure ever recorded*
by 0.985823. Measured today, the control fails entropy by **0.0133** (0.637 against 0.65), and
**all of that widening is arithmetic**: the same composition under the old divisor scores
0.6459 and **fails too**, by 0.0041.

⚠️ **The denominator widened a failure that was already there — it did not create one.** That
is provable, not argued: `still` holds no river tiles at all, and its golden hash has been
`10468117cccd7501` since spec 2, unchanged by specs 3, 4 and 5. The control's world is the same
world; only the divisor moved. The often-repeated pre-epic margin of "0.003" is **not** quoted
here, because it was taken on a tree whose control has since changed and the figures recorded
mid-epic used a 1200-day horizon rather than 1500 — comparing them would be the defect in
`SIMULATION.md` bug #16, which this epic committed four times.

That is the real argument for R-005, and it is a stronger one than it replaces: **entropy's
safety margin is a function of the taxonomy's size, which has nothing to do with liveness.**
Churn is a total-variation distance, bounded 0…1, and does not move when a biome is added.
Today the control fails entropy by 2.0% of its threshold and churn by 66% of its threshold —
churn's margin is thirty times wider, and it is the one that will still mean the same thing
after the 24th biome. `ALIVE_ENTROPY` was **not** changed; moving a liveness threshold is an
escalation, not a documentation edit.

### Fixed
**Transition rolls were keyed on array position.** `rollAt(seed, tile, day, r)` used the
rule's *index* in its bucket, so inserting or moving any rule silently handed every rule
after it different dice — editing the erosion rules changed what the forests did, and
nothing reported it. Rule identity is now derived from content. Decision `0002`.

**`npm run sim --days N` ran a different world than it claimed.** npm swallows flags that
aren't after `--`, and the `sim` script hard-coded `--days 1200` which won anyway on
`indexOf`. `npm run sim --days 1500 --cycles still` actually ran *crucible at 1200 days* —
and that exact command was documented here as the evidence for the control failing. Fixed;
`run.ts` now resolves flags with `lastIndexOf`, so a repeated flag takes the last occurrence.

**Dead CLI flags in `run.ts`.** `--beam-period` was parsed into a property
`WorldOptions` no longer declared; Node strips types unchecked, so it silently did
nothing, and `--beam-transit`/`--beam-cycle` were never parsed at all. Now genuinely
parsed. (The older recorded numbers were correct *by luck* — the ignored flags meant
constructor defaults applied, which happened to match the config being claimed.)
`npm run typecheck` now exists so this class of bug is caught rather than discovered.

---

## ⚠️ Two decisions waiting on you

Neither is a defect. Both are choices deliberately left open rather than settled by whoever
happened to be editing the code.

### 1. The beam radius default is now chosen for legibility — check it is the severity you want

**The default moved from `radiusHexes: 16` to `8`, and the reason is your clarification** that
the beam's path should be visible through "the biome changes preceding it". That makes the
trail a simulation property and puts a *ceiling* on beam size: at r=16 one pass changed 44.44%
of the world in a uniform smear with no track in it, and at the new default it changes 8.74%
and draws a wave you can trace end to end (the pictures are in `SIMULATION.md`).

So radius is now squeezed from both sides — escapability from below, legibility from above —
and 8 is where both hold. **It is still your call**, and the table below is the evidence for
the floor. Note it was measured on the OLD 9-oscillation, dormant, non-precessing track and its
coverage column is specific to that geometry; on the shipped track the same radii read 7.00%
(r=2), 14.17% (r=4), 28.50% (r=8), 42.73% (r=12), 56.78% (r=16) per pass.

`anvil` (beam only), 240 × 144, 1200 days, seed 20260729, track held fixed so radius is the
only variable:

| radius | coverage % | entropy | churn % | `npm run sim` says | `npm run sim:check` says |
|---|---|---|---|---|---|
| 2 | 28.46 | 0.676 | 0.180 | **alive** | ✗ **61.56% has no live exit — 6 families latched** |
| 4 | 55.98 | 0.699 | 0.327 | **alive** | ✗ **34.16% — 4 families latched** |
| **8** | 93.34 | 0.722 | 0.644 | alive | ✓ 15.78% |
| 12 | 100.00 | 0.731 | 0.937 | alive | ✓ 13.88% |
| 16 *(then shipped)* | 100.00 | 0.730 | 1.197 | alive | ✓ 13.54% |
| 24 | 100.00 | 0.730 | 1.620 | alive | ✓ 13.45% |
| 32 | 100.00 | 0.728 | 1.926 | alive | ✓ 13.09% |

**Below radius ≈8 the world latches, and `npm run sim` does not notice.** That is the row that
decided the floor: a radius below 8 produces a world that reports itself alive while most of it
can never change again. **`npm run sim:check`, not `npm run sim`, is what catches that** — see
`SIMULATION.md` bug #9, which is the general lesson: a merge gate can be weaker than it looks.

On the shipped track and with precession, `npm run sim:check` reads **13.97%** for `anvil` at
r=8 with no latched family, so the floor still sits where this table put it — but the reason to
stop there is now legibility as much as churn. Above r≈12 the trail begins to close up, and the
whole point of the sun is that you can see where it has been.

### 2. `viewer/limits.ts`'s `MAX_TILES` bound is now questionable

The viewer's cap is 262,144 tiles, and what bounds it is step time. Re-measured on the final
tree (5-day warm-up, mean of 20 days, median of 3 reps):

| world | tiles | `still` | `crucible` (six cycles) |
|---|---|---|---|
| 240 × 144 | 34,560 | 4.6 ms/day | 8.0 ms/day |
| 512 × 512 | 262,144 | 38.7 ms/day | **74.9 ms/day** |

`ViewerSession.schedule` delivers speeds above 20 days/second as several days per timer tick,
so at the top speed of 60 it steps 3 days in one synchronous block: **~225 ms of blocked event
loop per tick at the cap with six cycles.** That is past "feels live", not at the edge of it. A
GM who builds a 512 × 512 `crucible` world and plays it at 60 days/second will see playback
stall.

Spec `2915cb06-5` corrected the stale comment that justified the bound and **deliberately left
the bound alone**, because lowering `MAX_TILES` is a product decision — it decides how large a
world a GM may build at all, not merely how smoothly it plays. It is yours to make.

---

## The four findings that shape everything

**1. Disturbance is what keeps a world alive.** A world with no cycles converges to a
static equilibrium — measured churn **0.05%** against a fully-cycled world's **3.65%**, a
factor of **72**, with 92.4% of the control's tiles holding no live out-rule at all across a
watched game-year. The god's reshaping is not flavour on top of a living world; it is the
mechanism that makes it live.

**2. Exponential progression and a player economy are incompatible.** If power multiplies,
early materials become worthless and the market collapses to a thin band of the current
tier. Flat power is what lets iron matter in year three, which is what makes trade real,
which is what makes the whole game work.

**3. The terrain sim is the economy's supply curve.** Materials are regional and terrain
changes, so resource geography is dynamic: no permanent monopolies, routes must adapt,
scouting has recurring value. The living world isn't scenery sitting next to the economy —
it *is* the supply side.

**4. A world's cycle set determines which biomes can exist in it — and therefore which
materials.** Measured, not theorised: with no tectonics the transition graph has no path
to `mountain` at all; with no volcanism and no beam, `lava` and `ash` are unreachable. A
no-cycle world fragments into 4 disconnected components covering 20 of 23 biomes; `kiln` and
`crucible` each form a single component covering all 23. **The GM's difficulty dial reaches
all the way into the economy** — a garden world has no volcanic stone and must trade for it.

---

## Biggest open questions

Full lists live per-session in `BRAINSTORM.md`; these are the ones that block work.

1. **Does fleeing forfeit tile-activity progress?** Sets the entire price of protection.
2. **Are station slots scarce per tile or per owner?** Decides whether territory is
   genuinely contested.
3. **Does armor need an anti-stalemate rule?** Currently stalemates are accepted as fine.
4. **How do levels/stats stay breadth-not-power?** They drift toward multipliers unless
   watched, and multipliers break pillar #2 above.
5. **Does the coastline need a restoring force?** The membrane is two-way, but only because
   two large opposed flows nearly cancel — on a live world the net is **4–15% of the gross**,
   and nothing pulls the sea back towards where it started. Every new water↔land edge is
   therefore a pure ratchet spending from a few points of headroom. Related: the ±5 pp /
   40-game-year test cannot tell "converged" from "draining forever" — `kiln` passes it
   comfortably while its post-transient rate projects to 15% sea at year 200.

### Answered: rivers are an area, not an edge

*Previously open question #5 — "an edge feature, not an area; currently modelled as ground
subsiding into shallows, which is a stand-in, not a river layer."* **Settled the other way, on
measurement.** Rivers are a 23rd biome occupying whole tiles, springing from marsh and chaining
downhill against a retained elevation field. Two results decided it:

- **Only elevation bounds the growth.** River spreading is a directed branching process: with
  a downhill gate it settles at ~1.9% of the world; without one it reached 24.9% and was still
  climbing.
- **A river must be `water: false`.** Counting it as water annihilated the biome (1.14% →
  0.00%) *and* opened a +1.5 pp water ratchet in four game-years — two failures from one flag.

Measured on `crucible`'s tail, river holds **5.14%** of the world. Decisions `0018`–`0021`; the
sublattice trap that nearly shipped underneath a misleading render is `SIMULATION.md` bug #14.

---

## Working agreement

- Design decisions get written into `BRAINSTORM.md` **with the reasoning**, including
  corrections — superseded reasoning is marked, not deleted, so the record explains why
  the current answer is the current answer.
- Claims about the sim get **numbers from an actual run**, not estimates — and from a run made
  on *the tree the claim is committed with*, not a plausible earlier one.
- When something fails, it gets reported as failing.
