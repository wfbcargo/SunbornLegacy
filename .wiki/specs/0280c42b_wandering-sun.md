# Spec 0280c42b — The wandering sun

Status: in progress · Target: `main` · Branch: `main--spec/0280c42b_wandering-sun`

## The intent, in the user's words

> "The intention is partial coverage. The pattern should behave in a way that over time it
> will reach full coverage, the wave needs to be predictable though. I am imagining a large
> solar beam that is always present and always moving, its core is devastatingly hot. Players
> will want to predict its movements which they can do by following its path, but eventually
> the entire planet will get hit by it given enough time."

Five properties. **Three of them are not what epic `2915cb06` shipped**, and this spec exists
because I read "5×5 blob on a sinusoid" as a geometry change when it was a behaviour change.

| property | shipped today | required |
|---|---|---|
| always present | **dormant 375 of every 420 days** (`cycleDays` is a recovery gap) | continuous |
| always moving | ✓ | ✓ |
| devastating core | ✓ `Focus` raises melt | ✓, and it should stay the identity |
| partial coverage per pass | ✓ at small radius | ✓ |
| **eventually covers everything** | **impossible — the track retraces exactly** | must precess to full coverage |
| **predictable / followable** | **nothing renders it; no forward track exposed** | must be visible and forecastable |

## Why "eventually everything" is currently impossible

`dayState` derives the track from `p = intoPurge / transitDays`, so every traverse walks an
identical curve. Measured in spec `2915cb06-1`: coverage after 1 purge **7.47%**, after 5
purges **still 7.47%**. Whatever the first pass misses is missed forever. This is also why the
shipped default had to be radius 16 — at r=16 the wave is wide enough to cover 100% in a
single pass, which is the *only* way the current design reaches every tile. That default then
erased the visible sinusoid, which is the defect that prompted this spec. **Precession
dissolves the trade**: partial per-pass coverage becomes complete over a great year.

## The design

### 1. Precession — the great year

Add a phase advance per traverse. The track's phase becomes `wavePhase + precessionTurns · n`
where `n` is the traverse index (`floor((day − phaseDays) / cycleDays)`, still a pure function
of the day — R-004 is not at risk).

**`precessionTurns` should be a rational `1/K`** so the beam returns exactly to its starting
track after `K` traverses. That is what makes it predictable in the way the user means: the
world has a *great year* of `K · cycleDays`, and a player who learns one number knows where
the sun will be forever. An irrational or seed-random drift would technically cover the map
but is unlearnable, which defeats the point.

Choose `K` so that `K × (per-pass coverage) ≳ 1.3 × world` (some overlap is expected and
healthy — an exactly-tiling K would leave hairline seams). Per-pass swept area is
approximately `(2r+1) × L` where `L ≈ 4·amp·(H/2)·osc + W`. **Measure the real cumulative
coverage curve; do not trust that formula** — it ignores the torus and the arc geometry.

Deliverable: a **cumulative coverage table** — coverage after 1, 2, … K traverses — showing it
reaches ~100% at K and that traverse K+1 begins repeating. This is the spec's headline
evidence and it is what the GM-facing text must quote.

### 2. Always present

The beam must never be dormant. Simplest honest form: a traverse ends and the next begins
immediately, so `cycleDays` stops meaning "recovery gap" and becomes **traverse period** —
how long one crossing takes. `transitDays` and `cycleDays` collapse into one number.

★ **This overturns a documented finding, so read it before touching it.** `cycles.ts` records:
*"These two MUST stay separate. Collapsing them into a single 'period' inverts the effect: a
longer period becomes a SLOWER beam, each tile bakes longer, and the world sterilises — at a
single-knob 900-day period, water reached 0%."* That finding is **true for a full-height band**,
where every tile is under the beam for the whole transit. It does not obviously transfer to a
small blob, where dwell is set by `radius / speed` and recovery is set by the great year rather
than by a global dormancy. **Verify this on the new geometry and record the result either way.**
If the finding does transfer, say so and keep two knobs.

The severity model becomes: **dwell** = how long the core sits on a tile (radius ÷ speed);
**recovery** = how long until the track returns (the great year). Both are local, which is
better physics and a better GM dial than a global on/off.

`shape: 'band'` keeps the old dormancy semantics untouched — `anvil` and the band findings must
still reproduce.

### 3. Legibility

Daily row travel must be watchable. Measured on the shipped default (r16 / osc 9 / 45d): the
beam sweeps **143 of 144 rows within a single day** — the full height of the world per frame,
which is why it reads as a smear rather than a wave. At r2 / osc 3 / amp 0.6 it sweeps 2–18
rows/day, which is legible.

Target: **daily row travel bounded well under the world height** at the shipped defaults.
Report it as a table. The knobs are `oscillations`, `amplitudeHalfHeights` and traverse period.

### 4. The core stays devastating

Reduced coverage must not become reduced menace. The core keeps raising `Focus` and the melt
chemistry (`biomes.ts` `melting()`) is unchanged. A smaller, always-present, precessing beam
should be *more* frightening per encounter, not less — it is the recovery interval that grows,
not the damage.

### 5. ~~The viewer must show it~~ → The SCAR must show it

★ **CORRECTED BY THE USER DURING IMPLEMENTATION.** This section originally read the ask
("players will want to predict its movements ... by following its path") as a rendering
task and required the viewer to draw the beam's forward track and storms' projected paths.
That was wrong:

> "One clarification, I didnt mean to render its path. I simply meant that because of the
> immense heat of the beam effecting the biomes, it will be easy to see where it has been
> because of the biome changes preceding it"

The trail is **glass, ash and lava in the terrain** — a simulation property, visible in any
render of the biome grid, and available to a player inside the fiction rather than through
a HUD.

Required instead:
- The beam's track must be **legible from the biome changes it leaves behind**, at the
  shipped defaults, demonstrated by rendering the altered ground.
- This puts a **ceiling** on beam size where escapability puts a floor: a beam that burns
  everything leaves nothing for the burned ground to be legible against. The defaults must
  be justified by that, not asserted.
- No forward track, no storm projections, no predictive overlay of any kind.
- A small current-position marker in the viewer is permitted as orientation. R-009 still
  binds: local dev instrument, no product features, localhost only.

## Acceptance criteria

1. **Cumulative coverage reaches ~100% at K traverses and repeats at K+1.** Table, real runs.
2. **The beam is never dormant** — no day on which a `blob` beam contributes nothing.
3. **Daily row travel table** at the shipped defaults, showing a legible wave.
4. `npm run sim:check` all invariants hold, **including invariant 8**, on all five presets.
   ★ Invariant 8 is the binding constraint on beam size, not the liveness test — at r=2 with the
   old geometry `anvil` PASSED `npm run sim` while 61.56% of the world had no live out-rule and
   six biome families latched. Report escapability per preset and do not rely on `npm run sim`.
5. `still` still FAILS (R-005). Report every preset's entropy and churn.
6. Water trend, 60 game-years, all five presets, against the merged baseline: still −0.0264 ·
   anvil +0.0197 · garden −0.0579 · kiln −0.0525 · crucible +0.0415.
7. `shape: 'band'` unchanged: `anvil`'s band behaviour and the transit-as-dwell findings still
   reproduce.
8. ~~The viewer draws beam position, storm positions and the beam's forward track.~~
   **REPLACED (user correction, see §5): the SCAR is legible.** A render of the ground the
   beam has altered traces a recognisable wave at the shipped defaults, shown against the
   negative case at r=16 where 100% coverage leaves no trail. No forward track ships.
9. `npm run typecheck` green; goldens re-baselined with `--update` and hashes recorded here.
10. Whether the two-knob finding transfers to blob geometry is **measured and recorded**.

## Explicitly NOT in this spec

New biomes, new cycle kinds, changes to rivers, weather behaviour beyond rendering it, thermal
inertia, water chemistry, `ICE_FORM`/`ICE_THAW`, or any liveness threshold. If the new geometry
makes a threshold wrong, **escalate with numbers** rather than adjusting it.

## Measured

Implemented by `impl-wandering-sun-3c7e14`. Everything below is from a run on this branch.

**Shipped defaults:** `radiusHexes: 8`, `focusRadiusHexes: 2`, `oscillations: 2`,
`amplitudeHalfHeights: 1`, `transitDays: 60`, `greatYearTraverses: 8`, `continuous: true`.
Great year **480 days**. `anvil` runs it at 60; `crucible` at a longer period (below).

### AC1 — cumulative coverage reaches 100% at K and repeats at K+1 ✓

240×144, seed 20260729, driving the real `dayState`/`affect`:

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

Against the old geometry's 7.47% after one traverse and 7.47% after five.

### AC2 — the beam is never dormant ✓

Over those 9 traverses (540 days): **0 dormant days, 0 days on which the beam contributed
nothing.**

### AC3 — daily row travel is legible ✓

Centre row travel per day at the shipped defaults, world height 144:
`14, 13, 12, 8, 6, 4, 0, 4, 6, 8, 12, 13, 14, 15 …` — **max 15, mean 9.6**, against
`68, 30, 143, 30, 68, 143 …` at the old default. Row speed and track slope are both
proportional to `oscillations / transitDays`:

| oscillations | slope (rows/col) | mean / max row travel | reads as |
|---|---|---|---|
| 9 *(old, 45 d)* | 17.0 | 68 / **143** | a full-height smear |
| 3 | 5.7 | 14.4 / 22 | periodic stripes |
| **2** *(shipped, 60 d)* | **3.8** | **9.6 / 15** | **a wave** |
| 1 | 1.9 | 4.8 / 8 | a wave, at a third of the coverage |

### AC4 — `npm run sim:check` green, invariant 8 per preset ✓

`✓ all invariants hold`. Escapability (no live out-rule), 120×72:

| preset | share | latched families |
|---|---|---|
| still | 92.37% | control, exempt |
| anvil | **13.97%** (ocean 13.96%) | none |
| garden | 8.40% | none |
| kiln | 7.55% | none |
| crucible | **5.53%** (ocean 5.23%) | none |

Baseline was anvil 13.54% / crucible 5.08%; garden, kiln and still are bit-identical.

### AC5 — `still` still FAILS ✓ (R-005)

1500 d, 240×144, seed 20260729:

| preset | entropy | late churn | verdict |
|---|---|---|---|
| **still** | **0.637** | **0.05%** | **✗ FAILS both** |
| anvil | 0.744 | 1.18% | ✓ alive |
| garden | 0.723 | 3.17% | ✓ alive |
| kiln | 0.755 | 3.25% | ✓ alive |
| crucible | 0.769 | 3.40% | ✓ alive |

### AC6 — 60-game-year water trend ⚠️ passes, with two things to report

120×72, seed 20260729, sea share y0 → y60, `pp/y = (end − start) / 60`. The standing
verdict from spec `2915cb06-3` is **±5 pp over 60 game-years**, i.e. ±0.0833 pp/y.

| preset | quoted baseline | measured here | sea y0 → y60 | over 60 y |
|---|---|---|---|---|
| still | −0.0264 | **−0.0264** | 23.81 → 22.22 | −1.59 pp |
| anvil | +0.0197 | **+0.0378** | 23.81 → 26.08 | +2.27 pp |
| garden | −0.0579 | **−0.0328** | 23.81 → 21.84 | −1.97 pp |
| kiln | −0.0525 | **−0.0336** | 23.81 → 21.79 | −2.02 pp |
| crucible | +0.0415 | **+0.0571** | 23.81 → 27.23 | +3.42 pp |

**Every preset is inside the verdict.** Two caveats, both stated rather than smoothed over:

1. **`garden` and `kiln` do not match their quoted baselines, and this spec did not cause
   it.** Neither preset contains a `solarbeam`. Their biome hashes at 500 d / 160×96 are
   **bit-identical** to the pre-spec commit `e8cc929` (`garden 6cd205a9`, `kiln 6174a113`,
   `still 01fe78ed` — same in both trees), so the quoted −0.0579 / −0.0525 are stale
   figures from before rivers landed. `still` reproduces its −0.0264 exactly, and decision
   `0019` only ever claimed `still` and `anvil` were pinned across that change.
2. **The two beamed presets drift further landward than before** (+0.0197 → +0.0378 and
   +0.0415 → +0.0571). A permanently-present beam adds heat where a dormant one added
   none, and heat drives land → sea at the coasts. Both stay inside the verdict, and
   `crucible`'s beam period was set to 200 days for exactly this reason — at 150 it read
   +0.0995, over the bar. The full period table is on the preset.

### AC7 — `shape: 'band'` is unchanged ✓

Compared tile-by-tile against `HEAD` across four band configurations (60/360, 45/420,
120/360 wide, 30/90 narrow), 900 days each: **33,696,000 tile-days, 0 differences**,
including dormancy transitions.

Beamless presets are bit-identical to the pre-spec commit `e8cc929` — `still`, `garden`
and `kiln` biome hashes all match exactly (500 d, 160×96).

### AC8 (replacement) — the scar is legible ✓

Renders and the full argument are in `SIMULATION.md`. Measured by differencing against a
no-cycle control at the same seed, one traverse, 240×144: the shipped defaults change
**8.74%** of the world and draw two traceable waves; the old r=16 / 9-oscillation default
changes **44.44%** as a uniform smear with no track in it; r=2 draws the cleanest line of
the three at 1.37% and latches six biome families.

### AC9 — typecheck and goldens ✓

`npm run typecheck` green. Goldens re-baselined with `--update`:

- `still 160×96 seed 20260729 500d` — **`10468117cccd7501`** (unchanged; no beam)
- `crucible 160×96 seed 20260729 500d` — **`0a1c093d0850b2ad`** (was `599d7815137a0a4f`)

### AC10 — the two-knob finding does NOT transfer ✓

Decision `0024`. The band reproduces it (single-knob 900 d drains the sea 23.81% → 5.60%,
−0.3034 pp/y); a continuous blob at the same 900-day period does not drain it at all
(23.81% → 23.52%, −0.0048 pp/y) and instead goes quiet (entropy 0.685, churn 0.24%). Dwell
and dose move together under a band and in opposite directions under a blob, so **the
direction a GM turns the dial inverts with the shape**.
