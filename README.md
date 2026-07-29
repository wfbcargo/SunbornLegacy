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
| **`SIMULATION.md`** | Findings from the terrain simulator, with verified numbers | Current — re-verified 2026-07-29 |

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

## Current state — 2026-07-29

### Decided and stable
The pillars in `BRAINSTORM.md` are settled unless explicitly marked open:
API-first with third-party clients, toroidal hex map, TypeScript end-to-end, flat
(non-exponential) progression, regional materials, GM-per-world, world cycles as the
disturbance engine, obedient characters, station/slot settlement, light automated combat.

### Built
- `src/sim/` — headless terrain simulator. TypeScript, runs natively on Node 24, no deps.
  ```
  npm run sim          # full run, map + charts + both tests
  npm run sim:check    # transition-graph invariants (single SCC)
  npm run sim:sweep    # cycle parameter sweep
  npm run sim:trace    # day-by-day trace of one disturbance cycle
  ```

### Validated — 2026-07-29
The 22-biome ruleset, general cycle system, and invariant checker were built by a
multi-agent workflow and have since been **independently verified by running them**:

- `npm run sim:check` — **all invariants hold.** Single strongly connected component
  across 22 biomes, all 160 rules satisfiable, every biome escapable without cycles,
  10 required chemistry edges present.
- `npm run sim --days 1500 --cycles crucible` — **both tests pass.** Entropy 0.751,
  churn 3.95%, largest biome 18.3%, 14 biomes above 1%; 0 generic and 0 thin regions
  with median 18 materials.
- `npm run sim --days 1500 --cycles still` — **the control correctly FAILS** (entropy
  0.648, churn 0.04%, flagged as heat death). This is the important one: it proves the
  test discriminates. The previous thresholds reported both worlds as alive.

Full numbers and reasoning in `SIMULATION.md`.

### Fixed
**Dead CLI flags in `run.ts`.** `--beam-period` was parsed into a property
`WorldOptions` no longer declared; Node strips types unchecked, so it silently did
nothing, and `--beam-transit`/`--beam-cycle` were never parsed at all. Now genuinely
parsed. (The older recorded numbers were correct *by luck* — the ignored flags meant
constructor defaults applied, which happened to match the config being claimed.)

### ⚠️ Test-1 thresholds were recalibrated — know why
At ~22 biomes, entropy stopped separating living worlds from dead ones: a no-disturbance
control measured entropy **0.707** against a fully-cycled world's **0.703**, so the
*frozen* world scored **higher** and both were reported alive. **Churn is now the
load-bearing metric.** Variety is a snapshot property; being alive is a property of
motion. Do not "simplify" Test 1 back to entropy alone.

---

## The three findings that shape everything

**1. Disturbance is what keeps a world alive.** A world with no cycles converges to a
static equilibrium — measured churn 0.29%, with the min–max range of habitable land
collapsing to a single value. Every cycled world showed 3–5× the churn. The god's
reshaping is not flavour on top of a living world; it is the mechanism that makes it live.

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
to `mountain` at all; with no volcanism and no beam, `lava`, `ash`, `basalt` and fertile
`soil` are unreachable. A no-cycle world fragments into 6 disconnected components covering
17 of 22 biomes; the full-cycle presets form a single component covering all 22. **The
GM's difficulty dial reaches all the way into the economy** — a garden world has no
volcanic stone and must trade for it.

---

## Biggest open questions

Full lists live per-session in `BRAINSTORM.md`; these are the ones that block work.

1. **Does fleeing forfeit tile-activity progress?** Sets the entire price of protection.
2. **Are station slots scarce per tile or per owner?** Decides whether territory is
   genuinely contested.
3. **Does armor need an anti-stalemate rule?** Currently stalemates are accepted as fine.
4. **How do levels/stats stay breadth-not-power?** They drift toward multipliers unless
   watched, and multipliers break pillar #2 above.
5. **Rivers** — an edge feature, not an area. Currently modelled as ground subsiding into
   shallows, which is a stand-in, not a river layer.

---

## Working agreement

- Design decisions get written into `BRAINSTORM.md` **with the reasoning**, including
  corrections — superseded reasoning is marked, not deleted, so the record explains why
  the current answer is the current answer.
- Claims about the sim get **numbers from an actual run**, not estimates.
- When something fails, it gets reported as failing.
