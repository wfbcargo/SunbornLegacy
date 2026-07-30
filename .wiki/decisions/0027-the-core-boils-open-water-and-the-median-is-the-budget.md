# 0027 — The core boils open water, gated on `Focus`, and the median is the budget

Date: 2026-07-30
Status: accepted
Spec: `a966588d_thermal-and-boiling` (Part B)
Supersedes: the "deep ocean survives a purge" absolute in `biomes.ts`; qualifies `0014`

## Context

The user's request: *"Im expecting the solar beam to boil oceans into deserts as its core
passes through."* It did not happen, and — measured on the post-Part-A tree, 240×144 over
240 days — **it was never a temperature problem**:

| | `anvil` | `crucible` |
|---|---|---|
| mean heat under the focus | **148.3** | 130.9 |
| hottest observed | 181.5 | 181.0 |
| focus-lit water with all six neighbours water | **93%** | 85% |

Against `SCORCHING` 78 / `VITRIFY` 110 / `MOLTEN` 120. The water under the core is far past
the point at which **rock melts into lava**. Every water→land rule was gated on how
*enclosed* the tile is, and open ocean is not enclosed, so it had no beam-driven exit at any
temperature.

## Decision

**Two hand-written rules, `Ocean → Desert` and `Shallows → Desert`, label
`the core boils it dry`, median 20, gated `Focus && waterNeighbours >= 4`.**

### 1. The gate is `Focus`, never a temperature — and this is the safety argument

`world.ts` gives every open-water neighbour **−3.0** heat, so converting one sea tile to land
adds **+4.2** to each remaining adjacent sea tile. A heat-gated evaporation rule therefore
**manufactures its own next trigger**, with measured gain above one — halving `garden`'s sea
produced ~3.5× more above-threshold exposure per remaining sea tile. That is why spec
`2915cb06-3` gated `the shallows bake dry` on geometry (decision `0014`).

`Focus` closes the loop by construction. Boiling water still raises the neighbours' heat, but
heat is **not the trigger**, so no new trigger is created and the feedback cannot close. It is
the same trick `melting()` uses, for the same reason.

### 2. `waterNeighbours >= 4` runs the OPPOSITE way to every other gate here

The existing rules ask how *enclosed* a tile is (`<= 4`, `<= 2`). This asks that it still be
mostly *surrounded by water*, which is exactly what `sea takes it` needs to take it back
(`>= 4`, median 14 at pressure 3). Open ocean is 6 and sails through, so the requested
behaviour is untouched. What it forbids is a patch thick enough to have an **interior**:
tiles inside a boiled blob fall below 4 and stop boiling, so the scar stays thin and every
tile in it is reachable by the sea from the day it was made.

### 3. ★ "Deep ocean survives a purge" is deliberately overridden — and the old reasoning is right

`biomes.ts` carried this absolute: *"He remakes; he does not annihilate… if deep water can be
destroyed, every purge permanently removes the world's moisture source and the map ends as
glass."* **That reasoning is correct and is not deleted.** It holds for any rule that destroys
water *permanently*. What makes this survivable is the rate, bounded by measurement — not a
claim that the failure mode was imaginary.

## Evidence

### ★ The median is the budget. The return path is not.

This is the finding, and it **contradicts what the spec was written expecting.** Spec
`a966588d` B2 argued the resolution was the return path rather than a smaller number, because
a desert tile stranded in open ocean has six water neighbours and `sea takes it` wants four.
Measured, 60 game-years at 120×72, this edge's contribution against the pre-Part-B trend:

| median | gate | `crucible` | `anvil` | `kiln` | ocean visibly boils? |
|---|---|---|---|---|---|
| 3 | none | −0.361 | −0.256 | −0.065 | strongly |
| 3 | `wn >= 4` | −0.288 | −0.183 | −0.060 | **yes** |
| 8 | `wn >= 4` | −0.129 | −0.079 | −0.064 | barely |
| **20** | **`wn >= 4`** | **−0.018** | **−0.057** | **0.000** | **no** |
| 20 | none | −0.053 | −0.066 | −0.007 | no |

A dedicated fast reclaim edge (`Desert → Shallows`, median 2 at `wn >= 5`) was built and
measured: at median 3 it moved `crucible` only from **−0.308 to −0.276**. It was removed.

**Why the return path cannot work, in one line:** `sand to glass` fires at **median 1** under
the same beam that did the boiling. A boiled tile is **stone within a day**, and stone returns
through `the sea undercuts it` at median **26** rather than 14, with further exits into lava
and basalt. No product choice avoids that chain while the beam is still overhead, so a
fraction of every conversion leaks into permanent land whatever the geometry. This is
`SIMULATION.md`'s own statement restated: *every new water↔land edge is a pure ratchet whose
full magnitude accumulates linearly.*

### The scar does heal — that part of B2 held

`anvil`, 240×144, 720d settle + 1080d watched, **daily resolution** (`sweep.ts` samples at
decade marks and structurally cannot see a transient — spec `2915cb06-3` recorded probes
moving `crucible` 25.12% → 12.41% inside a 5-year window with nothing visible at 10-year
marks). Against a no-rule control on the same world:

| | control | with the rule at median 3 |
|---|---|---|
| water→land openings / game-year | 22 | 725 |
| closed again | 4.5% | **89.8%** |
| median days to close | 185 | **11** |
| peak simultaneous scar | 0.182% of world | 0.764% |

The wound does close behind the beam. It just does not close *completely enough*, and the
residual is what the budget pays.

### ★ What it buys: deep ocean is no longer a dead end

Invariant 8 has exempted Deep Ocean interiors since it was written, because they legitimately
had no live out-rule. They have one now:

| preset | no live exit, before | after |
|---|---|---|
| `anvil` | 14.51% | **8.61%** |
| `crucible` | 5.87% | **4.43%** |
| `kiln` | 7.30% | **6.66%** |

All invariants hold; `kiln` and `crucible` keep a single SCC over all 23 biomes, live edges
148 → 149.

### What it does not buy

**The ocean does not visibly boil.** At median 20 the core converts ~3% of the water it
lights, so an ASCII render of open water under the core shows an unbroken sea. **The
requested image is not delivered.** That is a deliberate, escalated choice — the alternative
was `crucible` draining 23.81% → 9.69% over 60 game-years, roughly twice the epic's aggregate
ceiling — and it is recorded here rather than quietly reframed as success.

### Everything else

`still`'s golden hash is **unchanged** (`3bc4c35b1b99adc7`), which is the self-check that
matters: `still` raises no `Focus` flag, so this rule cannot fire there, and a hash that moved
would have meant the gate was wrong. `crucible` re-baselined
`4bc5ea27c0744876` → `406cbd9ca84e3e3f`. Determinism: zero biome and zero temperature diffs
across two independent 600-day runs.

## Consequences

- **The 0.05 pp/y per-edge ceiling is not met on `anvil` (−0.057) and is met everywhere
  else.** The aggregate 0.125 pp/y ceiling is met on all five presets with margin. This is
  recorded as a known overrun, not rounded away.
- **Do not shorten the median without re-running the 60-game-year trend on all five
  presets.** The relationship is steeply non-linear and the code comment carries the table.
- **If someone wants the dramatic version, the lever is `sand to glass`**, not this median:
  gating that median-1 rule on water neighbours would keep a boiled tile as reclaimable
  desert. It modifies a validated beam rule and changes coastal glass formation everywhere,
  so it needs its own measurement pass. Deliberately not taken here.
- **Decision `0014` still stands.** Evaporation is still gated on geometry and heat still only
  picks the product. This adds a *flag*-gated edge, which is a third category and is safe for
  a different reason — the trigger is not a quantity the rule's own effect can raise.
