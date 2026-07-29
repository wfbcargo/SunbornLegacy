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

Without `--`, npm eats the flags as its own config and the script runs with its defaults —
a *different preset* for the same command line, with nothing to say so. Earlier revisions
of this file and of `README.md` documented the second form. The `sim` script no longer
hard-codes `--days`, so `--`-forwarded options now take effect; `run.ts` resolves each flag
with `indexOf`, so a duplicated flag would take the *first* occurrence.

*All figures below re-measured 2026-07-29 from actual runs, on the ruleset described here.*

---

## ⚠️ Every number below was re-measured after the rule re-key

Transition rolls used to be keyed on a rule's **positional index** in the `RULES` array, so
inserting or moving any rule handed every rule after it a different stream of dice.
Rule identity is now derived from content (`<from>-><to>:<label>`) — see
`ruleKey` in `src/sim/biomes.ts` and decision `0002`.

**That changed every world, including the no-cycle control.** Verified directly: inserting a
rule that can never fire (`when: () => 0`) at the head of the array moved both golden hashes
under the old keying and moves neither under the new one.

| | old keying | content keying |
|---|---|---|
| baseline, `still` | `0c4d5c1bd222dc2b` | `ea1caa9f367a0453` |
| + dead probe rule | `0f61f686021ee87c` | `ea1caa9f367a0453` |
| baseline, `crucible` | `cbfbb340506e0ae6` | `f4bece63b740b9e2` |
| + dead probe rule | `6ba6dd80f4bb49d1` | `f4bece63b740b9e2` |

Every previously recorded figure was therefore stale on arrival, and none has been carried
forward. **The verdicts did not move — only the third decimal place.** That is the reassuring
outcome: the findings were properties of the ruleset, not artefacts of its array order.

---

## Validated result

240 × 144 torus, 1500 days (4.1 game-years), `crucible` preset
(beam + seasons + monsoon + tectonics + volcanism), seed 20260729.
`node src/sim/run.ts --days 1500 --cycles crucible`

**Test 1 — is the world alive?** ✓
| Metric | Result | Threshold | (pre-re-key) |
|---|---|---|---|
| entropy (tail mean) | **0.753** | ≥ 0.65 | 0.751 |
| largest biome | Deep Ocean, **18.2%** | ≤ 40% | 18.3% |
| late churn | **3.92%** / sample | ≥ 0.15% | 3.95% |
| biomes > 1% | **14** of 22 | ≥ 8 | 14 |

Entropy opens at 0.529 on the day-0 worldgen and climbs; the tail minimum is 0.529.

**Test 2 — is every start a niche?** ✓
82 habitable regions (14 open water), **0 generic**, **0 thin**, **median 18 materials** each.
Averaged over 73 samples across the final third, not a single snapshot.

**Default run.** `npm run sim` is the same world at 1200 days (3.3 game-years): entropy
**0.749**, Deep Ocean **17.0%**, churn **3.58%**, **13** biomes above 1%, 82 habitable
regions with median 18 materials, 0 generic, 0 thin. Both tests pass. The 13-vs-14 is the
oscillation, not a regression — a biome sitting near the 1% line crosses it depending on
where in the beam cycle the tail lands.

**Performance.** 51,840,000 tile evaluations in 6.91s = **7.5M tile-evals/sec**
single-threaded; a live world of this size needs 0.4/sec, so ~18,700,000× headroom. This
number is hardware-dependent and is not comparable to the 4.3M/sec recorded previously on
different hardware — treat the headroom, not the rate, as the finding.

---

## ★ The central finding: disturbance is what keeps a world alive

The `still` preset is the control — same ruleset, no cycles at all. Both re-measured at
1500 days after the re-key:

| | `crucible` (all cycles) | `still` (no cycles) |
|---|---|---|
| entropy | **0.753** ✓ | 0.647 ✗ |
| late churn | **3.92%** ✓ | **0.04%** ✗ |
| biomes > 1% | 14 | 9 |
| largest biome | Ocean 18.2% | Tundra 28.1% |
| habitable regions | 82, median 18 materials | 81, median 9 materials |
| generic / thin regions | 0 / 0 ✓ | 12 / 16 ✗ |
| **verdict** | **alive** | **heat death** |

A world with no disturbance converges to a static equilibrium and stops moving. Churn
falls by two orders of magnitude. The Sun God's reshaping is not flavour laid over a
living world — it is the mechanism that makes it live.

The control fails *both* tests, and the margins are worth reading. Entropy fails by
0.003 — 0.647 against a 0.65 threshold — while churn fails by a factor of **four**
(0.04% against 0.15%). A world that had drifted a hair the other way would have passed on
entropy while being just as dead. That is R-005 restated as a measurement rather than a
principle: entropy is the metric that nearly lets a corpse through, churn is the one that
catches it.

`npm run sim:check` corroborates it independently and by a different route: **92.41%** of
the `still` world holds tiles with no live out-rule at all across a full watched game-year,
against **4.95%** for `crucible` — and all of `crucible`'s is Deep Ocean interior, which is
expected and exempt. Nine-tenths of the control is terrain that can never change again.

### ⚠️ Churn is the load-bearing metric, not entropy
At 12 biomes, entropy alone separated living worlds from dead ones. **At 22 biomes it
stopped working.** *(Historical measurement, taken on the ruleset as it stood before the
thresholds were recalibrated, and not re-run since:* a no-disturbance control measured
entropy **0.707** against a fully cycled world's **0.703** — the *frozen* world scored
**higher**, and the old thresholds reported both as alive.*)* Recalibrating the entropy
threshold cannot fix that, because both worlds land on the same number.

**Variety is a snapshot property; being alive is a property of motion.** Only churn
measures motion. Test 1 now gates on all four metrics, and the control correctly fails —
today, by 0.003 on entropy and by a factor of four on churn.

### Two knobs, not one
Severity and frequency must be separate parameters:
- **transit** — how fast the beam crosses. Sets how long a tile bakes underneath it.
- **cycle** — time from one purge to the next. Sets recovery time.

Collapsing them inverts the intent: a *longer* period means a *slower* beam, so each tile
is exposed for longer and the world sterilises. At a single-knob 900-day period, water
reached **0%**. Recommended default: **60-day transit / 360-day cycle**.

---

## ★★ A world's cycle set determines its biome vocabulary

From `npm run sim:check` — reachable core per preset:

| preset | live edges | SCCs | core | unreachable |
|---|---|---|---|---|
| `still` | 90 | 6 | 17/22 | mountain, basalt, lava, ash, soil |
| `anvil` | 106 | 2 | 21/22 | mountain |
| `garden` | 96 | 5 | 18/22 | basalt, lava, ash, soil |
| `kiln` | 124 | **1** | **22/22** | — |
| `crucible` | 127 | **1** | **22/22** | — |

**A world with no tectonics literally cannot make a mountain. One with no volcanism and
no beam has no route to lava, ash, basalt or fertile soil.** The GM's cycle dial is
expressed as graph connectivity — choosing a world's cycles chooses which biomes, and
therefore which *materials*, can exist there at all.

That is a much stronger version of "cycle set is the world's identity" than intended: it
reaches all the way into the economy. A garden world simply has no iron-bearing volcanic
stone, and must trade for it.

---

## Invariants (`npm run sim:check`)

All passing:
- **160 rules, 160 unique keys, 160 distinct roll streams.** Every rule's identity is
  derived from its content, and no two collide — so no two rules share dice. See below.
- **Single strongly connected component** across all 22 biomes under the full flag set —
  every biome reaches every other by some path. 127 distinct edges over 22 nodes (27.5%
  density), eccentricity 3–4. Sparse direct edges, total reachability.
- **All 160 rules can fire** somewhere in climate × flag space (no dead rules whose
  precondition is unsatisfiable in their source biome).
- **Every biome has at least one exit needing no cycle at all** — so no biome is a trap
  on a world that lacks the relevant disturbance.
- **0 derived/hand-written fan-out clashes** — no predicate-derived rule silently doubles
  the rate of an edge a biome already carries by hand.
- **10 required chemistry edges present**, with worst-case path lengths:
  ```
  glass    → rainforest  d=3   glass → barren → swamp → rainforest
  glass    → bloom       d=4   glass → lava → soil → forest → bloom
  badlands → bloom       d=4   badlands → desert → grassland → forest → bloom
  mountain → ocean       d=3   mountain → barren → shallows → ocean
  ```
- **No biome family latches on a live world.** Share of the world with no live out-rule
  over a watched game-year: `crucible` 4.95% (all Deep Ocean interior), `kiln` 6.98%,
  `garden` 8.41%, `anvil` 12.82%, `still` 92.41% (control, exempt by construction).

---

## Golden worlds (`npm run sim:golden`)

The graph invariants above can all hold while the simulation quietly produces a *different
world* than the one these numbers describe. A changed constant, a reordered array, a
renamed rule, a refactor that looked equivalent — none of them announces itself, and each
invalidates this entire file.

So two worlds are pinned by hash. 160 × 96, seed 20260729, 500 days:

| case | preset | hash |
|---|---|---|
| `still` | no cycles | `ea1caa9f367a0453` |
| `crucible` | all five cycles | `f4bece63b740b9e2` |

Two cases rather than one so a failure **localises**: `still` exercises worldgen, the
hydrology and the climate-gated rules only. If both drift, suspect worldgen or hydrology;
if only `crucible` does, suspect the cycles or the cycle-gated rules.

500 days is chosen, not arbitrary — it clears `crucible`'s full 420-day beam cycle plus a
transit, a 360-day year of seasons and monsoon, and several 64-day tectonic/volcanic
epochs, so every cycle has both fired and gone dormant before the hash is taken.

The check also builds each world **twice** and requires bit-identical results, which is
R-004 (determinism) tested rather than asserted.

**A failure here is not necessarily a bug — it means the world changed.** If that was
deliberate: `npm run sim:golden -- --update`, paste the hashes, then re-run `npm run sim`
and update this file in the same commit. Updating a hash without re-measuring turns the
tripwire into a rubber stamp.

⚠️ **Scope.** This pins the simulator against *itself on one JavaScript engine*. `Math.cos`
and `Math.pow` are not required by ECMA-262 to be correctly rounded, so another engine may
produce different hashes without anything being wrong. Making it cross-engine means
replacing those two calls with our own approximations, not loosening the test.

---

## Bugs the prototype caught

Each would have been far more expensive to find after building on top of it.

**1. Moisture diffusion constant off by ~25×.** Retention was set as though moisture
decayed like `r^distance`, but the target averages six neighbours — it is a *diffusion
equation*, with falloff `exp(-sqrt(2(1-r))·d)`. At r=0.995 that is ~0.1/tile, so every
continental interior was bone dry by construction and nothing could regrow. Correct value
is **0.9998** (~0.02/tile). This one constant was the difference between 8% and 35%
living land.

**2. Heat applied as an additive moisture sink.** A flat subtraction compounds across
diffusion steps, driving any tile above 50 heat that wasn't touching water to zero
moisture. Forests and blooms were mathematically impossible. Heat must be a
*multiplicative* decay on retention.

**3. The coastline was a one-way ratchet.** Deposition slightly outran erosion, so oceans
drained from 21% to 11.9% over four game-years — the same absorbing-state failure, slower
and less obvious. The coast must be a genuine two-way membrane.

**4. Albedo feedback caused runaway desertification.** Desert and glass each added +2.5
heat to neighbours → lower retention → more desert. One purge desertified the world
permanently. Capped at **+1.2**.

**5. Measurement bug.** A purged world **oscillates**, so a single end-of-run snapshot
lands at an arbitrary cycle phase and reports it as steady state. Metrics must be tail
means with the range reported — the swing *is* the design.

**6. Dead CLI flags.** `run.ts` parsed `--beam-period` into a property `WorldOptions` no
longer declared; Node strips types unchecked, so it silently did nothing. Fixed —
`--beam-transit` and `--beam-cycle` are now genuinely parsed.

**7. ★ Transition rolls were keyed on array position.** `rollAt(seed, tile, day, r)` took
`r` = the rule's index in its per-biome bucket, so a rule's dice were a function of where
it happened to sit in `RULES`. Inserting one renumbered every rule after it: **editing the
erosion rules changed what the forests did**, every recorded number shifted for reasons
unrelated to the edit, and nothing said so. This is the worst kind of bug in a simulator
whose entire value is that its numbers can be believed — it makes any A/B comparison
between two rulesets meaningless, and it is invisible.

Fixed by deriving identity from content: `<fromBiome>-><toBiome>:<label>`, hashed to a
32-bit stream id. Proven by the probe table at the top of this file. `sim:check` now
verifies all 160 keys and all 160 hashes are distinct, because two rules sharing a stream
would make the later one dead code that the graph checks still count as a live edge.

Note the sharp edge this trades for: from/to alone is not unique (glass has three exits),
so `label` is part of the key — which means **renaming a rule re-keys it and changes the
world.** That is the right trade, since a rename is a deliberate edit to the rule where a
reorder is not, but `sim:golden` exists partly to make it loud.

**8. `npm run sim --days N` silently ran a different world.** Without `--`, npm swallows the
flags as its own config; `npm run sim --days 1500 --cycles still` ran **crucible at 1200
days**, i.e. the opposite preset. The `sim` script also hard-coded `--days 1200`, and
`run.ts` resolves flags with `indexOf` (first wins), so even the correct
`npm run sim -- --days 1500` was overridden back to 1200. Both README and this file
documented the broken form. The hard-coded `--days` is gone and `run.ts`'s own default
(1200) applies, so `--`-forwarded options now work.

---

## Mechanics the sim produced

**Life reclaims from the edges.** Regrowth rules scale pressure by living-neighbour count,
so a scoured region recovers inward from survivors. Stops a purge being an absorbing
state; visually, green creeping back across the scar.

**Latitude on a torus.** No poles, so latitude is a smooth periodic band:
`26·cos(2πr/H)` — one hot equator, one cold band, continuous across the seam. The desert
belt and tundra band emerge from hydrology rather than being authored.

**Bloom is naturally precious.** Sunpetal/nectar/essence/aureole settle at a fraction of a
percent with no special-casing. The signature solarpunk material is scarce because its
conditions are.

---

## Not yet modelled

- **Cities, stations, and player structures.** The beam destroying *terrain* is modelled;
  the beam destroying *infrastructure* is not. That is where evacuation and salvage live.
- **Soil fertility as a per-tile scalar** — farming depletion and fallow recovery
  (Session 10). Currently only biome-level fertility exists.
- **Population** — birth, death, famine, carrying capacity. Needs the same
  sources/sinks/oscillation discipline the terrain got.
- **Rivers.** An edge feature, not an area. Quakes currently subside ground into shallows
  as a stand-in, which doubles as the coastal erosion counterweight but is not a river
  layer.
- **Depletion of mineral deposits.** Terrain change is currently the only churn in the
  resource map.
- Single-threaded, in-memory, no persistence. This is a model, not the service.
