# Spec 2915cb06-6 — Re-baseline, and tell the truth about it

Epic: `2915cb06` · Status: in progress · Order: 6 of 6

## Objective

Specs 1–5 each moved the world and each re-baselined the golden hashes, but none of them was
allowed to touch `SIMULATION.md` or `README.md` — because re-measuring them five times would
produce five sets of numbers, each true for exactly one commit. This spec is where the
project's public record is brought back to the truth, in one pass, from one set of runs.

It is not a documentation chore. Three of the five specs changed something the recorded
numbers *reason about*, not merely something they *report*.

## What is now stale, and why each is more than a number

### 1. The entropy denominator changed

`BIOME_COUNT` went 22 → 23 (spec 5). `biomeEntropy()` normalises by `log(BIOME_COUNT)`
(`world.ts:636`), so **every entropy figure ever recorded is stale by construction**, and the
liveness threshold's *calibration story* changed, not just its inputs.

`README.md:139-150` and `SIMULATION.md` explain that `ALIVE_ENTROPY = 0.65` is calibrated
against a control that fails it by **0.003** — the passage whose whole point is "entropy is
the metric that nearly lets a corpse through". Under `ln(23)` the same unchanged control fails
by **0.012**. The threshold got *safer*, so R-005 is not at risk, but the passage as written
now describes a denominator that no longer exists. **Re-derive the argument; do not just
substitute the number.**

### 2. The beam is no longer a band

`SIMULATION.md:147-154` and `README.md:174` carry the transit-as-dwell-time finding
("transit is dwell time and dwell time is what sterilises", the 60d/360d → 2% living share
result, the 45d recovery to a 13% floor / 28.4% mean). **All of it is true only of
`shape: 'band'`.** Spec 1 scoped it correctly in `cycles.ts` but was explicitly forbidden from
touching these two documents. Scope it here — do not delete it. Under `blob`, dwell is set by
radius and track length, not by transit alone, and the binding constraint on radius is
invariant 8 rather than the liveness test.

`ARCHITECTURE.md:825` (`widthCols // HARD CONSTRAINT: >= ceil(width/transitDays)`) and
`ARCHITECTURE.md:1151` ("exactly invertible against `daysUntilBeam(col)` — `col = w·(daysUntil + …)`")
are band-only algebra and are now false in the general case. `daysUntilBeam` also gained a row
parameter. Correct both, respecting `ARCHITECTURE.md`'s stated Session-8 cut-off: fix what is
now *wrong*, do not extend it with new design.

### 3. Rivers were an open question and are now answered

`README.md` open question #5 says rivers are "an edge feature, not an area… currently modelled
as ground subsiding into shallows, which is a stand-in, not a river layer." Spec 5 ratified the
opposite — area, and a 23rd biome — with the measured reasoning. Retire the open question and
record the answer. `biomes.ts:593-596` was already updated by spec 5.

### 4. "22 biomes" appears as a load-bearing phrase

R-005's own wording is "At 22 biomes a frozen world can score HIGHER entropy than a living
one." Grep for `22` across `README.md`, `SIMULATION.md` and `.wiki/` and fix every instance
that means the taxonomy size. **`.wiki/rules.md` is normally out of bounds for sub-agents;
for this spec only, R-005's biome count may be corrected — the text, not the rule's meaning.**

## The measurement pass

Every number in both documents must come from runs made **after spec 5's commit**, on one
consistent tree. Do not carry forward a single figure from an earlier commit in this epic,
however plausible — that is precisely the mistake `README.md:93-96` records the project having
made once before ("Nothing below is carried forward; all of it comes from runs made after the
fix").

At minimum, run and record:

- `npm run typecheck`
- `npm run sim:check` — full invariant report including invariant 8 per preset
- `npm run sim:golden` — the final hashes
- `npm run sim -- --days 1500 --cycles crucible` and `-- --days 1500 --cycles still`
- `npm run sim -- --days 1500` for each of `anvil`, `garden`, `kiln`, and whichever preset
  spec 4 gave weather to
- `npm run sim:sweep` — the 60-game-year water trend, per preset, which is the epic's
  load-bearing safety number
- The beam radius table from spec 1, re-run on the final tree if it has moved

⚠️ npm swallows flags not after `--`. `npm run sim --days 1500` silently runs the default
world; `README.md:72-74` records that this exact mistake once invalidated the evidence in that
very file.

## What to write

**`SIMULATION.md`** — the verified numbers, re-measured. Keep the bug list; add the ones this
epic found, in the same style (what looked reasonable, what it actually did, how it was
caught). Strong candidates from the epic's own record:

- A beam radius that passes the liveness test while latching 61% of the world — **`npm run sim:check`
  catches it, `npm run sim` does not**. This says a merge gate is weaker than it appears and
  belongs in the record.
- `sweep.ts` hand-enumerating `SEA_SHARE` while `biomes.ts` derives `SEA` from a predicate:
  the one instrument built to catch a water ratchet would have reported a green ✓ for a river
  covering 20% of the land.
- Neighbour-diffusion of temperature latching the polar cap, and why reach and inertia are not
  independent knobs in any nearest-neighbour scheme.
- A storm classified on wetness latching to 100% rain share; classified on geography, stable.
- The coastline membrane having **no restoring force** — the sea ends roughly where it starts,
  and every new edge is a pure ratchet. This is the single most important thing the epic
  learned and it is not currently written down anywhere a future agent will look.

**`README.md`** — the state of the project. Update "Built", "Validated", the three-findings
section, and the open questions. Add what the world can now do: land↔water traffic, rivers,
weather systems, a travelling sun with a GM-settable radius, and a sea whose temperature
reaches inland.

**`.wiki/`** — check `architecture.md` and `gotchas.md` are still true. `.wiki/rules.md` only
as licensed above. Do not duplicate the decisions `0007`–`00NN` already written by specs 1–5;
link them.

## The user's open decision — surface it, do not bury it

The user asked to set the beam radius themselves and declined to pick a size. The shipped
default is **the orchestrator's choice, not theirs**. `README.md` must say so plainly, next to
the radius table, so the next person to read it knows the number is a placeholder awaiting a
decision and not a validated result.

## Acceptance criteria

1. Every number in `README.md` and `SIMULATION.md` traces to a run made on the final tree.
   Where a run failed, it is reported as failing (R-003).
2. `npm run typecheck`, `npm run sim:check`, `npm run sim:golden` green and recorded.
3. `still` still FAILS, and the margin is stated under the new denominator (R-005).
4. The entropy-threshold calibration argument is re-derived, not merely renumbered.
5. Band-only findings survive, scoped to `shape: 'band'`. Nothing measured was deleted.
6. Rivers removed from the open-questions list with the answer recorded.
7. No occurrence of "22 biomes" meaning the taxonomy size remains anywhere.
8. The beam radius default is labelled as the orchestrator's placeholder, not a validated choice.

## Explicitly NOT in this spec

New behaviour of any kind. No transition rules, no cycle changes, no tuning. If a measurement
in this pass reveals a defect, **escalate it — do not fix it here**. A documentation pass that
also changes the world produces documents describing a tree that no longer exists, which is
the failure this spec exists to prevent.

## Measured

All runs on the final tree (spec 5 landed at `36791d5`), one pass, nothing carried forward.

### Gates

```
npm run typecheck    exit 0, clean
npm run sim:golden   ✓ still     160×96 seed 20260729 500d   10468117cccd7501
                     ✓ crucible  160×96 seed 20260729 500d   599d7815137a0a4f
                     ✓ 2 golden worlds unchanged (deterministic across two builds)
npm run sim:check    ✓ all invariants hold
```

**Neither golden hash moved.** That is the primary correctness signal for a pass that was
forbidden to change behaviour.

`sim:check` in full: 23 biomes · 70 materials · 70 unique · 23 glyphs · 23 colours; 185 rules
with 185 unique keys and 185 distinct roll streams; 148 distinct edges over 23 nodes (29.2%
density), single SCC containing all 23, eccentricity 3–4; 0 fan-out clashes; all 185 rules
satisfiable; every biome escapable without cycles; 10 required chemistry edges; sweep coverage
1.000 evals/column/day at all ten width × band cases.

Invariant 8 (escapability, 120 × 72, settle 365, watch 365, stride 3):
`crucible` 5.08% (ocean 5.08%) · `kiln` 7.55% · `garden` 8.40% · `anvil` 13.54% (ocean 13.51%)
· `still` 92.37% (control, exempt). Reachable core: `still` 109 edges / 4 SCC / 20-of-23
(mountain, lava, ash outside) · `anvil` 125 / 2 / 22-of-23 (mountain) · `garden` 116 / 3 /
21-of-23 (lava, ash) · `kiln` 144 / 1 / 23-of-23 · `crucible` 148 / 1 / 23-of-23.

### `node src/sim/run.ts --days 1500 --cycles <preset>`, 240 × 144, seed 20260729

| preset | entropy | largest | churn | biomes>1% | test 1 | test 2 |
|---|---|---|---|---|---|---|
| crucible | 0.521 → 0.772 | Deep Ocean 17.7% | 3.65% | 15 | PASS | PASS (83 regions, median 18, 0/0) |
| kiln | 0.521 → 0.755 | Deep Ocean 17.2% | 3.25% | 13 | PASS | PASS (83, median 18, 0/0) |
| anvil | 0.521 → 0.728 | Barren 17.8% | 1.51% | 11 | PASS | PASS (81, median 15, 0/0) |
| garden | 0.521 → 0.723 | Deep Ocean 17.2% | 3.17% | 13 | PASS | PASS (83, median 18, 0/0) |
| still | 0.521 → 0.637 | Tundra 29.1% | 0.05% | 9 | **FAIL** | **FAIL** (81, median 9, 15 generic / 19 thin) |

Four-decimal churn over the same tails: `crucible` 3.6491%, `kiln` 3.2458%, `garden` 3.1686%,
`anvil` 1.5144%, `still` 0.0507% — a ratio of **72×** between `crucible` and the control.
Performance: `crucible` 51,840,000 evals in 14.98 s (3.46M/s); `still` 7.68 s (6.75M/s).

### The entropy denominator, isolated

`ln 23 = 3.135494`, `ln 22 = 3.091042`, ratio `0.985823`. Same tail compositions, two divisors:

| preset | H / ln 23 (shipped) | H / ln 22 (old) | Δ |
|---|---|---|---|
| still | **0.6367** | 0.6459 | +0.0092 |
| crucible | 0.7723 | 0.7834 | +0.0111 |
| kiln | 0.7546 | 0.7654 | +0.0109 |
| anvil | 0.7281 | 0.7386 | +0.0105 |
| garden | 0.7232 | 0.7336 | +0.0104 |

The control fails entropy by **0.0133**; under the old divisor the same world scores 0.6459 and
**fails there too**, by 0.0041. **All of the widening is arithmetic.**

★ **Correction to this spec's own framing.** §1 above predicts the denominator change is what
takes the control below the gate ("the threshold got *safer*"). It did not: the control was
already failing at 0.6459. The denominator **widened a failure that was already there**. This is
provable rather than inferred — `still` holds no river tiles at any share, and its golden hash
has been `10468117cccd7501` since spec 2 (`a26c8dd`), unchanged by specs 3, 4 and 5, so the
composition being divided is the same composition before and after the biome count moved.

The pre-epic margin of 0.003 is **not** carried into the documents. It was measured on a tree
whose control has since changed (spec 2 moved `still` from `ea1caa9f367a0453`), and the
mid-epic figures were taken at a **1200-day** horizon against this file's 1500 — quoting either
would be bug #16 a fifth time. R-003 prefers an absent number to an unsourced one.

The argument was re-derived rather than renumbered: entropy's margin is a function of
`BIOME_COUNT` and churn's is not, which is a stronger reason for R-005 than "entropy nearly lets
a corpse through". Conclusion kept; evidence still carries it (entropy fails by 2.0% of its
threshold, churn by 66%).

### `npm run sim:sweep` — the coastline

```
  preset            y 0    y10    y20    y30    y40     drift    late pp/y   → y200
  still           23.8%  22.2%  22.2%  22.2%  22.2%   ✓  -1.6pp     +0.000     22%
  anvil           23.8%  24.3%  25.1%  25.5%  25.2%   ✓  +1.4pp     +0.004     26%
  garden          23.8%  22.0%  21.8%  22.0%  22.0%   ✓  -1.8pp     +0.009     23%
  kiln            23.8%  22.6%  22.8%  22.7%  22.0%   ✓  -1.8pp     -0.041     15%
  crucible        23.8%  24.8%  25.5%  25.8%  26.3%   ✓  +2.5pp     +0.036     32%
  ✓ the coastline is a two-way membrane on every cycle set
```

Gross flux, net as % of gross: `anvil` 14.7%, `garden` 7.3%, `kiln` 4.7%, `crucible` 4.1%.
The epic's new edges on `crucible`: `shallows→desert` 0.0226, `shallows→basalt` 0.0191,
`river→shallows` 0.0023 pp/y — inside the 0.05 pp/y per-edge and 0.125 pp/y aggregate ceilings.

### The beam radius table, re-run on the final tree

Recipe held identical to spec 1 §2 (240 × 144, 1200 d, track fixed, `focusRadiusHexes =
round(r/4)`, coverage from the real `affect`, inv-8 the verbatim `invariants.ts` recipe).

`anvil`: band 100.00% / 0.732 / 1.208% / 13.69 · r2 28.46% / 0.676 / 0.180% / **61.56 latched**
· r4 55.98% / 0.699 / 0.327% / **34.16 latched** · r8 93.34% / 0.722 / 0.644% / 15.78 ·
r12 100.00% / 0.731 / 0.937% / 13.88 · **r16 100.00% / 0.730 / 1.197% / 13.54** ·
r24 100.00% / 0.730 / 1.620% / 13.45 · r32 100.00% / 0.728 / 1.926% / 13.09.

`crucible`: no family latches at any radius; inv-8 4.95–6.50 throughout.

The conclusions from spec 1 reproduce: coverage saturates between r=8 and r=12, everything
follows coverage, and **the binding constraint is invariant 8, not the liveness test** — r=2
passes `npm run sim` while latching six families.

### Two defects found by this pass, escalated not fixed

**A.** `sweep.ts`'s churn column is inflated by a stale `prev` (the first tail sample is a
~790-day delta counted as a 5-day one). Measured both ways, 180 × 108, 1200 d: `still` 0.572%
vs **0.047%** (12×), `crucible` 3.774% vs 2.951%. The control therefore clears the sweep's own
`churn > 0.15%` test spuriously, and the sweep's "★ 7× the control" headline should read 63×.
`assessStability` (i.e. `npm run sim`) is correct; no shipped verdict changes.

**B.** The ±5 pp / 40-year membrane test cannot distinguish converged from draining: `kiln`
projects to 15% sea at y200 and `crucible` to 32%, both passing comfortably. Pre-existing,
surfaced by spec 3's new rate column. Making it a gate would fail `kiln` today — a tuning
decision for the user.

**C (documentation, in spec 5's record).** Spec 5 §5 is headed 1500 days and compares against
"before" figures lifted verbatim from spec 4 §8, which states its own horizon as **1200 days**.
A 1200-day before against a 1500-day after, presented as the effect of adding a biome — and it
implied a false causal story ("the control passed entropy before rivers"). Arithmetic settles
it: `still`'s composition is unchanged (hash `10468117cccd7501` since spec 2, zero river
tiles), so its entropy must move by exactly `ln22/ln23`; measured here, 0.6459 → 0.6367. It was
**already failing at 1500 days before rivers existed**. This is the **fourth** R-003 defect of
the same shape in this epic and is recorded as `SIMULATION.md` bug #16, now written as one
entry about the class with the four instances as evidence. Spec 5's own `## Measured` section
is left untouched — it is another spec's record, and correcting it is not this spec's licence.

Also measured, for README §"Two decisions waiting on you": step time at the viewer cap
(5-day warm-up, mean of 20 days, median of 3 reps) — 512 × 512 `crucible` **74.9 ms/day**
(286 ns/tile), i.e. **~225 ms** of blocked event loop per tick at speed 60; 240 × 144
`crucible` 8.0 ms/day.

### Acceptance criteria

1. ✅ Every number in `README.md` and `SIMULATION.md` traces to a run listed above. Nothing
   carried forward; two failing/defective measurements reported as such (A and B).
2. ✅ `typecheck`, `sim:check`, `sim:golden` green and recorded. Neither hash moved.
3. ✅ `still` FAILS. Margin under the new denominator: entropy by **0.0133** (0.637 vs 0.65),
   churn by a factor of **three** (0.05% vs 0.15%). It also fails under the old denominator
   (0.6459), which is the correction above.
4. ✅ The calibration argument is re-derived from a two-divisor measurement, not substituted.
   R-005's conclusion is kept because the numbers still carry it, and is now supported by a
   stronger reason (entropy's margin scales with the taxonomy; churn's does not). The false
   causal story the spec's own §1 invited — "the denominator pushed the control below the
   gate" — is explicitly refuted in `SIMULATION.md` rather than repeated.
5. ✅ Band-only findings survive, scoped to `shape: 'band'`: the two-knob / 900-day / 60-360
   passage in `SIMULATION.md`, `ARCHITECTURE.md:825` (`widthCols`) and `:1151`
   (`daysUntilBeam` invertibility). Nothing measured was deleted.
6. ✅ Rivers retired from the open-questions list with the answer and its two measurements
   recorded; a new open question #5 (the coastline's missing restoring force) replaces it.
7. ✅ No occurrence of "22 biomes" meaning the *current* taxonomy size remains in `README.md`,
   `SIMULATION.md` or `.wiki/`. Three occurrences are deliberately kept as **dated history**,
   each now explicitly labelled: the 0.707-vs-0.703 measurement in `README.md`,
   `SIMULATION.md` and `gotchas.md` (taken at 22 biomes, stated as such). Two occurrences
   outside this spec's scope are left alone and reported: `src/sim/report.ts:177` (a past-tense
   comment recording the same historical measurement) and
   `.wiki/decisions/0017` (an internally consistent as-of-spec-4 evidence record that also
   cites 165 rules and 129→130 edges — editing one number would falsify the entry).
8. ✅ The radius default is labelled the orchestrator's placeholder in `README.md` beside the
   table, in `SIMULATION.md`, and it already was in decision `0008` and `SOLAR_BEAM_DEFAULTS`.
