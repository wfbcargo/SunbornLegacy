# Terrain Simulation — Findings

Results from the headless simulator in `src/sim/`. It exists to answer one question
before anything is built on top of it: **does a stochastic terrain CA driven by world
cycles produce a world that stays alive, or does it flatten into an absorbing state?**

Answer: it stays alive — and **only because of the cycles.**

```
npm run sim          # full run, map + charts + both tests
npm run sim:check    # transition-graph invariants (single SCC, satisfiability, chemistry)
npm run sim:sweep    # cycle parameter sweep
npm run sim:trace    # day-by-day trace of one disturbance cycle
```

*All figures below verified 2026-07-29 against the 22-biome ruleset.*

---

## Validated result

240 × 144 torus, 1500 days (4.1 game-years), `crucible` preset
(beam + seasons + monsoon + tectonics + volcanism):

**Test 1 — is the world alive?** ✓
| Metric | Result | Threshold |
|---|---|---|
| entropy (tail mean) | **0.751** | ≥ 0.65 |
| largest biome | Deep Ocean, **18.3%** | ≤ 40% |
| late churn | **3.95%** / sample | ≥ 0.15% |
| biomes > 1% | **14** of 22 | ≥ 8 |

**Test 2 — is every start a niche?** ✓
83 habitable regions, **0 generic**, **0 thin**, **median 18 materials** each.
Averaged over 73 samples across the final third, not a single snapshot.

**Performance.** 4.3M tile-evals/sec single-threaded; a live world of this size needs
0.4/sec. ~10,800,000× headroom. (Down from 13.3M/sec at 12 biomes — more biomes, more
rules, five active cycles. Still nowhere near a bottleneck.)

---

## ★ The central finding: disturbance is what keeps a world alive

The `still` preset is the control — same ruleset, no cycles at all:

| | `crucible` (all cycles) | `still` (no cycles) |
|---|---|---|
| entropy | **0.751** ✓ | 0.648 ✗ |
| late churn | **3.95%** ✓ | **0.04%** ✗ |
| biomes > 1% | 14 | 9 |
| largest biome | Ocean 18.3% | Tundra 28.1% |
| **verdict** | **alive** | **heat death** |

A world with no disturbance converges to a static equilibrium and stops moving. Churn
falls by two orders of magnitude. The Sun God's reshaping is not flavour laid over a
living world — it is the mechanism that makes it live.

### ⚠️ Churn is the load-bearing metric, not entropy
At 12 biomes, entropy alone separated living worlds from dead ones. **At 22 biomes it
stopped working**: a no-disturbance control measured entropy **0.707** against a fully
cycled world's **0.703** — the *frozen* world scored **higher**, and the old thresholds
reported both as alive. Recalibrating the entropy threshold cannot fix that, because both
worlds land on the same number.

**Variety is a snapshot property; being alive is a property of motion.** Only churn
measures motion. Test 1 now gates on all four metrics, and the control correctly fails.

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
- **Single strongly connected component** across all 22 biomes under the full flag set —
  every biome reaches every other by some path. Sparse direct edges, total reachability.
- **All 160 rules can fire** somewhere in climate × flag space (no dead rules whose
  precondition is unsatisfiable in their source biome).
- **Every biome has at least one exit needing no cycle at all** — so no biome is a trap
  on a world that lacks the relevant disturbance.
- **10 required chemistry edges present**, with worst-case path lengths:
  ```
  glass    → rainforest  d=3   glass → barren → swamp → rainforest
  glass    → bloom       d=4   glass → lava → soil → forest → bloom
  badlands → bloom       d=4   badlands → desert → grassland → forest → bloom
  mountain → ocean       d=3   mountain → barren → shallows → ocean
  ```

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
