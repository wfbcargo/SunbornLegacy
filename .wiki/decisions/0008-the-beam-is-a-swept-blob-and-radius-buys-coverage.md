# 0008 — The beam is a swept blob on a sinusoid, and radius buys coverage

Date: 2026-07-29
Status: accepted
Spec: `2915cb06-1_contract-and-beam`
Decided by: `impl-contract-beam-4f2a91`

## Context

The cleansing sweep was implemented as a full-height band of columns: every row of the
band's columns is under it at once, so a purge covers 100% of the world's tiles and the only
severity knob that matters is transit. The fiction is a travelling focus — a sun that comes
for one part of the world at a time — and a wall that passes over everything is not that.

The correction is not cosmetic, because a blob makes COVERAGE a parameter where the band
pinned it at 100%, and coverage turns out to be the quantity the world actually consumes.

## Decision

**`SolarBeam.shape: 'band' | 'blob'`, defaulting to `blob`.** A blob is a hex disc of
`radiusHexes` travelling a sinusoidal track: x runs the full width once per transit, y is a
sine about `homeRow` with amplitude `amplitudeHalfHeights × height / 2` and `oscillations`
whole cycles per transit.

**`band` is kept and scoped, not deleted.** It is the validated `anvil` prototype and every
transit-as-dwell-time number in `SIMULATION.md` was taken with it; those findings are true of
a band and are now labelled as such rather than stated as facts about "the beam". The legacy
`WorldOptions.beam` / `--beam` sugar sets `shape: 'band'` explicitly, so `sweep.ts`,
`diagnose.ts` and every recorded harness result still reproduce.

Three parts of the geometry are not stylistic choices and each was measured:

- **The path is SWEPT, not point-sampled.** At 240 columns and a 45-day transit the centre
  advances 5.33 columns and up to 90 rows a day. A disc 33 hexes across is smaller than its
  own daily step, so one sample per day produces a row of disjoint clumps with zero overlap
  between consecutive days. `dayState` resolves the whole arc traversed today (~96
  sub-centres, endpoints inclusive so today's last is tomorrow's first) and `affect` takes
  the **minimum** distance to it.
- **Minimum, then heat applied ONCE — never accumulated per substep.** Summing multiplies a
  tile's dose ~17-fold. Taking the minimum preserves the property the band had by
  construction: exactly one beam-exposed evaluation per tile per day.
- **`amplitudeHalfHeights` is a FRACTION of `height / 2`, and `oscillations` is an INTEGER.**
  The golden worlds are 160×96 and the viewer's floor is 16 rows, so an absolute row count is
  correct at exactly one world size. And the track starts at column 0 and ends at column W,
  which is column 0 again — only a whole number of oscillations makes the two ends of the
  scar meet at the torus seam.

**`radiusHexes` is a first-class GM knob with a measured table behind it, not a tuned
constant.** The user asked to set it per world and declined to pick a size. **The shipped
default of 16 (focus 4, 9 oscillations, full amplitude) is the ORCHESTRATOR'S choice, not the
user's**, and is stated as such in the catalogue note and in `SOLAR_BEAM_DEFAULTS`. It was
selected to reproduce the validated worlds, not to be the right severity.

## Evidence

Full table in `.wiki/specs/2915cb06-1_contract-and-beam.md`. The three findings:

*(Provenance: everything in this section was measured at this decision's own commit, i.e.
BEFORE spec 2's thermal inertia landed. The geometry columns — coverage %, tile-days — are
properties of the track and have not moved since. The world-outcome columns have: re-measured
on the same recipe after spec 2, `anvil` r=2 reads churn 0.180% and 61.56% with no live
out-rule, r=12 → r=32 invariant-8 reads 13.90% → 13.36%, and band → blob r=16 reads
`anvil` 0.743 → 0.740 / 1.208% → 1.197% and `crucible` 3.483% → 3.559%. Every conclusion
below is unchanged; do not carry the digits forward without re-running them.)*

**Coverage saturates between r=8 (93.3%) and r=12 (100%), and everything follows coverage.**
Below saturation, churn and invariant-8 track it almost linearly. Above it, radius buys only
heat: `anvil` r=12 → r=32 quadruples tile-days per purge (87,133 → 348,033) with coverage
pinned at 100.00% and invariant-8 flat (13.00% → 12.70%).

**★ THE BINDING CONSTRAINT ON RADIUS IS INVARIANT 8, NOT THE LIVENESS TEST.** `anvil` at
r=2 PASSES `npm run sim`'s test 1 — entropy 0.686 against a 0.65 floor, churn 0.175% against
0.15% — while 61.03% of the world has no live out-rule and six biome families are latched,
five of them at more than double the 2% limit. A beam reaching 28% of the world moves enough
composition to clear the churn floor with the other 72% frozen solid. `npm run sim:check`
catches it; `npm run sim` does not. The smallest radius that keeps `sim:check` green on the
beam-only world is **8**.

**The default reproduces the validated worlds' verdicts, and on churn is close rather than
exact.** `anvil` band → blob r=16: entropy 0.743 → 0.742, churn 1.191% → 1.182%, 11 biomes
both. `crucible`: 0.749 → 0.749, churn 3.578% → 3.659% (+0.081 pp, +2.3% relative), 13
biomes both. The spec predicted three decimal places; entropy holds, churn does not.

**Cost.** `crucible` at 240×144, band vs blob interleaved on one machine: 5.46 vs 6.76 ms/day
mid-purge (1.238×), and 7.44M vs 7.23M tile-evals/s over a full 400-day run — **~2.4% slower
overall**. A naive per-substep loop measured ~22% slower; the bounding-box reject in
`affect` is worth about a factor of ten on that overhead, because the day's arc occupies ~5
of 240 columns and ~84% of tiles are discarded on two subtracts.

Golden hashes moved as intended and only where intended: `crucible`
`f4bece63b740b9e2` → `938695caecb6f08d`, `still` unchanged at `ea1caa9f367a0453` because it
has no cycles. Both were verified bit-identical first with the geometry present and the
default still `band`, so the flip is the only thing that moved a tile.

## Consequences

- **"Which column is the beam at" is no longer a question with an answer.** `World.beamColumn`
  survives for the band, and `World.beamPosition()` returns `{col, row}` — with `row: -1` for
  a band, which genuinely occupies every row. `daysUntilBeam` takes a **required** row
  parameter; it used to hardcode row 0, which was harmless under a band and returns
  `Infinity` for 172 of 240 columns under the shipped blob.
  *(Superseded: this entry first cited "210 of 240 columns". That figure came from the
  prior analysis's prototype track, not the shipped one. Re-measured at r=2 on the shipped
  track, 240×144 seed 20260729: 172 of 240. The consequence is unchanged.)*
- **`Infinity` and `null` are answers meaning "never", not "not yet".** The blob's track is
  periodic and retraces itself every purge, so a tile it misses is missed for the life of the
  world. `forecast()`'s claim that one cycle plus one transit is "provably enough for every
  column" is true of a band only, and the comment now says so. Callers must render "never".
- **A blob beam must fit its world: `2 × radiusHexes + 1 < min(width, height)`.** A disc as
  wide as the world wraps onto itself, which breaks the torus distance the sweep is measured
  with (`hexDistanceWithin` guarantees an exact y-wrap only under half the height) and turns
  a travelling focus into a permanent global heat offset. This is checked in
  `limits.ts:checkCycles`, which now takes an optional world size, rather than being folded
  into `MIN_WIDTH` / `MIN_HEIGHT` — the beam's constraint depends on a PARAMETER, so a size
  floor cannot express it, and raising the floor to 34 would have banned small worlds that
  have no beam at all. The old floor's justification ("twice the beam band, 8 columns") was a
  fact about one of two shapes and has been rewritten.
- **`CycleParamDef` now carries string choices.** `shape` is `band` or `blob` — two
  geometries, not two points on a scale — and encoding it as 0/1 would put a meaningless
  number in front of a GM. `viewer.js` matches a select's value back against the catalogue's
  own `choices` list to recover the original type; it previously ran `Number(input.value)` on
  every non-boolean input, which turns a string choice into `NaN` that the server rejects and
  the person cannot see in the control they just used.
- **Hex distance to a POINT is now a shared primitive** (`hex.ts:hexDistanceToPoint` /
  `hexDistanceWithin`), because rounding a continuous arc to tiles before measuring it is
  what makes a track into beads. The closed form is `max(|dx| + |dy|/2, |dy|)` on the
  half-shifted odd-r offsets; it agrees exactly with the existing cube-coordinate
  `HexTorus.distance` on integer coordinates and extends to fractional points, which the cube
  form does not. The pruning variant exists so the ~96-iteration inner loop can reject on the
  row offset alone, and the plain form is implemented as the pruning form with no limit — one
  implementation of the geometry, not two.
