# Spec 2915cb06-1 — The cycle contract grows two channels, and the sun travels a sinusoid

Epic: `2915cb06` · Status: implemented · Order: 1 of 6

## Objective

Two changes to `cycles.ts` that everything after this depends on, plus the beam geometry
correction that motivated one of them.

**(a) The contract.** `WorldCycle.dayState` becomes `dayState(day, view)`, where `view` is a
read-only window on the grid; a cycle declares `readsWorld` and its forecasts are labelled
`basis: 'exact' | 'projected'`. `CycleEffect` gains a second heat channel, `ambientHeat`,
separate from the existing acute `heat`.

**(b) The beam.** `SolarBeam` gains `shape: 'band' | 'blob'`. In `blob` shape it is a hex
disc of `radiusHexes` travelling a sinusoidal track across the world, swept along the day's
arc. `radiusHexes` is the severity dial and is a first-class GM knob.

## Why these two are one spec

Both are `cycles.ts` surgery on the same three structures (the base class, `CycleEffect`,
`CYCLE_CATALOGUE`), and the catalogue cannot express `shape` until `CycleParamDef` is
widened to carry string choices. Splitting them would mean two agents editing the same
sixty lines.

## Acceptance criteria

1. **The contract change is inert.** With `shape` defaulting to `'band'` *for the purposes
   of this check*, both golden hashes are **bit-identical** to `ea1caa9f367a0453` (still)
   and `f4bece63b740b9e2` (crucible). Demonstrate this before changing the default. This is
   the whole value of doing (a) separately — if the plumbing moves a single tile, it is a bug.
2. The five existing cycle kinds need **zero** changes to their `dayState` bodies. A
   one-parameter override satisfying a two-parameter abstract signature is valid TypeScript
   and was verified under this repo's `tsconfig`.
3. `npm run typecheck`, `npm run sim:check`, `npm run sim:golden` green.
4. The radius table below exists, from real runs.
5. `still` still fails the liveness test.

## (a) The contract — exact shape

```ts
/**
 * A read-only view of the world, for cycles that resolve their day against terrain.
 * Deliberately NOT `World`: no mutation, no stepping, no I/O (R-007). Coordinates wrap.
 * It is the grid as of the START of the day being resolved.
 */
export interface WorldView {
  readonly width: number;
  readonly height: number;
  biomeAt(col: number, row: number): number;
  moistureAt(col: number, row: number): number;
}

export abstract class WorldCycle<S = unknown> {
  /** True marks a cycle whose forecasts are PROJECTIONS, not schedules. Default false. */
  get readsWorld(): boolean { return false; }
  abstract dayState(day: number, view: WorldView): S | null;
  forecast(col, row, fromDay, horizonDays, view): CycleForecast | null;
  protected probe(day, col, row, view): number;
}

export interface CycleForecast { /* …unchanged… */ readonly basis: 'exact' | 'projected'; }
export interface CycleCatalogueEntry { /* … */ readonly readsWorld?: boolean; }
```

`CycleEffect` gains:

```ts
/**
 * Slow, seasonal, ambient heat — passes through the tile's thermal filter (spec 2).
 * Distinct from `heat`, which is ACUTE and must bypass any filter: `Focus` dwell is
 * exactly 1 day carrying +115 against a melt gate of 120, so low-passing it kills the
 * melt chemistry outright. Seasons writes here; beam, volcanism and tectonics do not.
 */
ambientHeat = 0;
```

Until spec 2 lands, `World` sums `ambientHeat` into the same place `heat` goes, so this
change is behaviour-neutral. `Seasons.affect` moves its `out.heat +=` to `out.ambientHeat +=`
in **spec 2**, not here — moving it here would change worlds while the goldens are meant to
prove nothing changed.

### Two required fixes that fall out

- **`world.ts:126` — move `this.refreshCycles(0)` to after `this.generate(...)`.** It
  currently runs before `this.biome` is allocated, so any world-reading `dayState` throws
  during construction, and a guarded one silently gets no world read on day 0. Verified
  behaviour-preserving: both golden hashes unchanged by the move alone.
- **`invariants.ts` §9 (sweep coverage) instruments `affect` calls.** Anything that calls
  `affect` during construction poisons it with a bogus 3.667 evals/column/day. Zero
  `observer.hits` / `observer.order` after construction — construction is not a sweep.

## (b) The beam — exact shape

```ts
shape: 'band' | 'blob';        // default 'blob' (see "the default" below)
widthCols: number;             // band only, unchanged
focusCols: number;             // band only, unchanged
radiusHexes: number;           // blob only. Hex rings, inclusive: r=2 is 5 across, 19 tiles.
focusRadiusHexes: number;      // blob only. 0 is legal: only the centreline melts.
amplitudeHalfHeights: number;  // blob only. FRACTION of height/2, not absolute rows.
oscillations: number;          // blob only. INTEGER, full sine cycles per transit.
wavePhase: number;             // blob only. Turns [0,1).
homeRow: number;               // blob only. Default 0, the hot equator.
```

Three things here are not stylistic and were measured:

- **The path must be SWEPT, not sampled.** At 240 cols / 45 d transit the centre advances
  5.33 columns and up to 15 rows per day. A 5-hex blob is smaller than its own daily step,
  so a point sample produces 45 disjoint clumps with zero overlap — not a track. `affect`
  must take the **minimum** distance to the day's arc of sub-centres. Accumulating heat per
  substep instead multiplies it ~17-fold; take the min, then apply the heat once. This
  preserves the "exactly one beam-exposed evaluation per tile per day" property at
  `cycles.ts:466`.
- **`amplitudeHalfHeights` is a fraction, not rows.** The golden worlds are 160×96 and
  `MIN_HEIGHT` is 16 (`limits.ts:54`); an absolute-row default is wrong at every world size
  but the one it was tuned on. At 1.0 the track visits every latitude; at 0.5 it visits 77
  of 144 rows and half the world is structurally beam-free forever.
- **`oscillations` must be an integer.** The track starts at col 0 and ends at col W ≡ 0;
  only an integer count makes the two ends of the scar meet at the torus seam.

### The default, and whose decision it is

The user asked to set the radius themselves and declined to pick a preset size. Therefore:

- `shape` defaults to **`'blob'`** — the band was the misimplementation this spec corrects.
- `radiusHexes` defaults to **16**, `focusRadiusHexes` **4**, `oscillations` **9**,
  `amplitudeHalfHeights` **1.0**, `wavePhase` **0**, `homeRow` **0**. Measured to reproduce
  the validated worlds to three decimal places.
- **This default is the orchestrator's choice, not the user's, and must be labelled as such**
  in the catalogue note and in the work-log. The user sets radius per world.
- `shape: 'band'` stays fully supported: it is the validated `anvil` prototype and the
  transit-as-dwell-time findings (`cycles.ts:418-427`, `SIMULATION.md:149-152`) are true only
  of it. Do not delete them — **scope** them to band.

### Deliverable: the radius table

Real runs, `anvil` and `crucible`, 1200 d, 240×144, seed 20260729. Columns:
`radiusHexes | tile-days/purge | distinct coverage % | entropy | churn % | biomes>1% |
liveness verdict | invariant-8 escapability %`. At minimum r ∈ {2, 4, 8, 12, 16, 24, 32}.
Write it into this file under "Measured" and cite it from the catalogue note. It is the
whole point of making radius a knob.

## Collateral this spec owns

- **`CycleParamDef` cannot express a string choice.** `default: number | boolean` and
  `choices?: readonly number[]` must widen to include `string`, as must the
  `defaults[name] as number | boolean` cast in `paramDefs`. `CycleDescription.params`
  already permits `string`.
- **`viewer.js:533`** does `Number(input.value)` for every non-boolean input; a string
  `shape` becomes `NaN`. Special-case `def.type === 'choice'` with string choices.
- **`World.beamColumn()` / `daysUntilBeam(col)`** (`world.ts:479-490`) assume a column
  answer. `daysUntilBeam` hardcodes `row: 0` and returns `Infinity` for 210/240 columns
  under a blob. Add `beamPosition(): {col,row} | null` and give `daysUntilBeam` a row
  parameter. `Infinity` / `null` is the honest answer for a tile the track misses; callers
  must handle "never".
- **`forecast()`'s horizon proof** (`cycles.ts:517-544`) claims one cycle plus one transit is
  "provably enough for every column". False under blob — the track retraces itself, so a
  missed tile is missed forever. Correct the comment; `null` is correct behaviour.
- **`limits.ts:45-55, 124-128`** justify `MIN_WIDTH`/`MIN_HEIGHT` by "an 8-column beam band".
  Under blob the real constraint is `2*radiusHexes + 1 < min(width, height)` — and the
  default r=16 violates it at the minimum world size. Fix the constraint and its message.
- **Catalogue summary** (`cycles.ts:1389-1398`) says the beam drags heat "across every column
  of the world". Band-only. Rewrite, keeping every measured claim and scoping it.
- `run.ts` / `WorldOptions` legacy `--beam*` sugar hardcodes `widthCols` and has no shape
  flag. Keep it meaning `shape: 'band'` so recorded harness results still reproduce.

## Explicitly NOT in this spec

Storms, thermal inertia, water chemistry, rivers. `ambientHeat` is *plumbed* here and
*consumed* in spec 2. `WorldView` is *plumbed* here and *consumed* in spec 4. Do not add a
cycle kind.

## Measured

All numbers below are from runs executed by `impl-contract-beam-4f2a91` on this branch.

### 1. The contract change is inert — acceptance criterion 1

Landed on its own, with `shape` defaulting to `'band'`, before any geometry existed.

```
✓ still     160×96 seed 20260729 500d   ea1caa9f367a0453  (deterministic across two builds)
✓ crucible  160×96 seed 20260729 500d   f4bece63b740b9e2  (deterministic across two builds)
✓ 2 golden worlds unchanged
```

Bit-identical to baseline. `npm run typecheck` and `npm run sim:check` green at the same
point. The beam geometry was then landed, still defaulting to `'band'`, and **both hashes
were verified unchanged a second time** — so neither the plumbing nor the new code paths
move a tile until the default is deliberately flipped.

### 2. The radius table

`anvil` and `crucible`, 1200 days, 240×144, seed 20260729. Blob rows hold the track fixed
at `oscillations: 9`, `amplitudeHalfHeights: 1.0`, `wavePhase: 0`, `homeRow: 0`, and scale
`focusRadiusHexes` with the radius (`round(r/4)`: 1, 1, 2, 3, 4, 6, 8) so that **radius is
the only variable**. Entropy and churn are tail means from the real `assessStability`;
coverage and tile-days are from the real `SolarBeam.affect` over one whole purge;
invariant-8 is the verbatim `invariants.ts` recipe (120×72, settle 365, watch 365, stride 3).

**`anvil`** — beam only, 60d transit / 360d cycle.

| radius | tile-days/purge | coverage % | entropy | churn % | biomes>1% | liveness | inv-8 % |
|---|---|---|---|---|---|---|---|
| *band* | *129,600* | *100.00* | *0.743* | *1.191* | *11* | *PASS* | *12.82* |
| 2 | 10,623 | 28.46 | 0.686 | 0.175 | 9 | PASS | **61.03 — latches 6 families** |
| 4 | 23,069 | 55.98 | 0.710 | 0.324 | 11 | PASS | **33.52 — latches 4 families** |
| 8 | 52,233 | 93.34 | 0.733 | 0.635 | 11 | PASS | 14.90 |
| 12 | 87,133 | 100.00 | 0.743 | 0.922 | 11 | PASS | 13.00 |
| **16** | **127,793** | **100.00** | **0.742** | **1.182** | **11** | **PASS** | **12.67** |
| 24 | 226,393 | 100.00 | 0.740 | 1.600 | 11 | PASS | 12.80 |
| 32 | 348,033 | 100.00 | 0.738 | 1.899 | 11 | PASS | 12.70 |

Latched families (per-biome share above the 2% limit, i.e. `npm run sim:check` FAILS):
r=2 — tundra 15.90%, forest 10.80%, grassland 5.96%, savanna 4.47%, frozensea 4.06%,
desert 2.37%. r=4 — tundra 5.28%, forest 4.94%, grassland 2.44%, frozensea 2.09%.

**`crucible`** — beam + seasons + monsoon + tectonics + volcanism, 45d transit / 420d cycle.

| radius | tile-days/purge | coverage % | entropy | churn % | biomes>1% | liveness | inv-8 % |
|---|---|---|---|---|---|---|---|
| *band* | *97,200* | *100.00* | *0.749* | *3.578* | *13* | *PASS* | *4.95* |
| 2 | 10,389 | 28.45 | 0.725 | 3.236 | 12 | PASS | 6.33 |
| 4 | 22,213 | 55.96 | 0.732 | 3.256 | 13 | PASS | 5.64 |
| 8 | 49,023 | 93.32 | 0.741 | 3.387 | 13 | PASS | 5.07 |
| 12 | 80,099 | 100.00 | 0.746 | 3.523 | 13 | PASS | 4.93 |
| **16** | **115,495** | **100.00** | **0.749** | **3.659** | **13** | **PASS** | **4.98** |
| 24 | 199,247 | 100.00 | 0.752 | 3.892 | 14 | PASS | 4.98 |
| 32 | 298,974 | 100.00 | 0.755 | 4.048 | 14 | PASS | 4.99 |

No latched families at any radius on `crucible`. Four other cycles are disturbing the
world, so the beam's coverage is not the only thing standing between a tile and a live
out-rule — which is exactly why the table is run on both presets and why `anvil`, the
beam-only world, is the one that sets the floor.

### 3. What the table says, including where it contradicts the prediction

**Coverage saturates between r=8 and r=12, and everything follows coverage.** Below
saturation, churn and invariant-8 both track coverage almost linearly. Above it, more
radius buys only heat: from r=12 to r=32 on `anvil`, coverage is pinned at 100.00% while
tile-days quadruple, and invariant-8 does not improve (13.00 → 12.70). This is the epic's
finding 3 restated with the track held fixed — the world consumes the fraction of itself
the beam reaches, and radius past saturation is severity with no reach behind it.

**★ THE BINDING CONSTRAINT ON RADIUS IS INVARIANT 8, NOT THE LIVENESS TEST, AND THAT WAS
NOT PREDICTED.** The prior analysis expected a small-radius `anvil` to fail both liveness
tests. It does not. At r=2 the world scores entropy 0.686 (needs ≥ 0.65) and churn 0.175%
(needs ≥ 0.15%) and is reported **alive** — while 61.03% of it has no live out-rule and six
separate biome families are latched, five of them at more than double the 2% limit. Test 1
is a measure of how much composition MOVES, and a beam reaching 28% of the world moves
enough of it to clear the floor with the other 72% frozen solid. `npm run sim:check` catches
this and `npm run sim` does not. The smallest radius that keeps `sim:check` green on `anvil`
is **8**; r=4 and r=2 both fail it. This is reported rather than smoothed over: it means the
liveness thresholds in `report.ts` are not a sufficient gate for a radius choice, and a GM
lowering the radius should be pointed at invariant 8. Changing those thresholds is out of
scope for this spec (it requires escalation) and was not done.

**The r=16 default reproduces the validated worlds, but on churn it is close rather than
exact.** The spec predicted "to three decimal places". Measured:

| | entropy | churn % | biomes>1% | inv-8 % |
|---|---|---|---|---|
| `anvil` band → blob r=16 | 0.743 → 0.742 | 1.191 → 1.182 | 11 → 11 | 12.82 → 12.67 |
| `crucible` band → blob r=16 | 0.749 → 0.749 | 3.578 → 3.659 | 13 → 13 | 4.95 → 4.98 |

Entropy holds to three decimals on `crucible` and moves by 0.001 on `anvil`. Churn moves by
0.009 pp on `anvil` and by **0.081 pp (+2.3% relative) on `crucible`** — a real difference,
not rounding. The shipped default therefore reproduces the validated worlds' *verdicts and
composition* rather than their exact numbers, which is the honest claim.

**The prior analysis's r=2 figures do not reproduce here, and should not be expected to.**
That prototype's track used an absolute row amplitude and a different oscillation count, so
its 5-hex blob traced a much shorter path: 3,447 tile-days and 7.47% coverage against the
10,623 tile-days and 28.46% measured here for the same radius on the shipped track. The
table above holds the track constant and varies radius alone, which is the only way its
column means what its heading says. The *finding* the prior analysis drew from that run —
that a small blob's track retraces itself and the world consumes coverage — is unaffected
and is visible in the r=2 and r=4 rows.

### 4. After the flip to `shape: 'blob'`

New golden hashes, `npm run sim:golden` re-verified after pasting them in:

```
✓ still     160×96 seed 20260729 500d   ea1caa9f367a0453  (unchanged — `still` has no cycles)
✓ crucible  160×96 seed 20260729 500d   938695caecb6f08d  (was f4bece63b740b9e2)
✓ 2 golden worlds unchanged
```

`npm run sim:check` — **all invariants hold.** Escapability with the shipped default:
`still` 92.41% (exempt control), `anvil` 12.67% (ocean 12.63%, nothing else), `garden`
8.41%, `kiln` 6.98%, `crucible` 4.98% (ocean 4.98%). Sweep coverage 1.000 evals/column/day
at all ten width × band combinations. These agree to the digit with the harness above,
which is a useful cross-check: two independent measurements of the same quantity.

`npm run sim -- --days 1200 --cycles <preset>`, 240×144, seed 20260729:

| preset | entropy | largest biome | late churn | biomes>1% | test 1 | test 2 |
|---|---|---|---|---|---|---|
| crucible | 0.529 → 0.749 | Deep Ocean 17.0% | 3.66% | 13 | **PASS** | PASS (0 generic, 0 thin) |
| anvil | 0.529 → 0.742 | Barren 17.6% | 1.18% | 11 | **PASS** | — |
| still | 0.529 → 0.651 | Tundra 28.0% | 0.05% | 9 | **FAIL** | **FAIL** (12 generic, 16 thin) |

**R-005 holds: `still` still fails, and fails on churn** — 0.05% against a 0.15% floor,
"Composition has stopped moving — heat death." The control that proves the test
discriminates is untouched.

### 5. Geometry, validators and introspection, checked directly

The disc is a disc, at both row parities, on the torus: counting tiles within radius r of a
tile centre gives 1, 7, 19, 37, 217, 817 for r = 0, 1, 2, 3, 8, 16 — exactly `1 + 3r(r+1)`,
the hex ring formula, on even and odd centre rows alike. Row parity is where an odd-r
distance formula normally goes wrong, so both are checked.

`hexDistanceToPoint` was compared against the existing cube-coordinate `HexTorus.distance`
over a 22 × 21 grid of tiles against four reference tiles including the seam corners
(239, 143): **0 mismatches**. It is the same metric, extended to fractional points.

Validators, over the real `checkCycles`: `shape: 'blob'` and `shape: 'band'` accepted,
`shape: 'sphere'` rejected; `direction: -1` still accepted and `direction: 3` still rejected,
so widening `choices` to strings did not weaken the numeric case. The default r=16 beam is
rejected in a 16×16 and a 33×34 world and accepted in a 34×34 one; a `band` beam is still
accepted at 16×16; `checkSize(16, 16)` still returns null, so a small world with no beam is
still legal. Exercised over HTTP against a running viewer as well as in-process, and
`/api/meta` serialises `shape` as `{"type":"choice","choices":["blob","band"],"default":"blob"}`
alongside `direction`'s `[1,-1]`.

Introspection under the shipped blob: `beamPosition()` returns `{"col":4,"row":58}` on day 0
where `beamColumn()` returns 4 — the row is the half of the answer the old accessor could not
give. `daysUntilBeam(col, row)` resolved for **960 of 960** tiles on a 40 × 24 sample, against
the `Infinity`-for-210-of-240-columns the prior analysis measured at r=2; that is the 100%
coverage of the r=16 row showing up in the API. `forecast()` reports `basis=exact` for the
beam, which is correct — the beam does not read the world.

### 6. Cost of the swept blob

The swept path is a per-tile inner loop over ~96 sub-centres, so it was measured rather
than assumed. `crucible` at 240×144, band vs blob interleaved on the same machine, five
repetitions of 25 days each taken mid-purge (i.e. the beam active every day — the worst
case), after a 20-day warm-up:

```
crucible band  5.46 ms/day  [5.10-5.86]
crucible blob  6.76 ms/day  [6.58-6.90]
blob / band = 1.238x
```

Over a full 400-day run, which includes the 89% of days a `crucible` beam is dormant:

```
pass1 crucible band  400 days in 1.84s  7,506,849 tile-evals/s
pass1 crucible blob  400 days in 1.91s  7,234,248 tile-evals/s
pass2 crucible band  400 days in 1.88s  7,368,801 tile-evals/s
pass2 crucible blob  400 days in 1.91s  7,225,735 tile-evals/s
```

**~2.4% slower over a full run, 1.24× on days the beam is actually crossing.** The prior
analysis measured a naive per-substep loop at ~22% slower overall and recommended a
bounding-box reject; the reject is in (`SolarBeam.affect`) and it is worth roughly a factor
of ten on that overhead. The reported `npm run sim` figure for the shipped `crucible` is
6,352,689 tile-evals/sec over 41,472,000 evaluations in 6.53s.

---

**★ Provenance note (added by the orchestrator after spec 2 landed).** The entropy, churn
and invariant-8 columns of the table above were measured BEFORE spec 2 introduced thermal
inertia. They are correct as of this commit and stale as a current authority — `sim:check`
now reports `anvil` at 13.60%, not 12.67%. The geometry columns (tile-days, coverage) are
unaffected and still hold. The re-measured table at HEAD lives in commit `2bde7c4` and in
`.wiki/decisions/0008`. Do not cite this table as current; re-run the harness.
