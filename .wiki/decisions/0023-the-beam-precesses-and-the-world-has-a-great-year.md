# 0023 — The beam precesses by a rational 1/K, and the world has a great year

Date: 2026-07-30
Status: accepted
Spec: `0280c42b`
Decided by: `impl-wandering-sun-3c7e14`

## Context

The user asked for five properties of the sun: always present, always moving, a
devastating core, partial coverage per pass, and **eventually everything**, all while
staying **predictable enough to follow**.

Epic `2915cb06` shipped a blob on a sinusoid that had the first four in some form and
could not have the fifth. `dayState` derived the track from `p = intoPurge / transitDays`,
so every traverse walked an identical curve. Measured: coverage after 1 traverse **7.47%**,
after 5 traverses **still 7.47%**. Whatever the first pass missed was missed for the life
of the world.

That left exactly one way to reach every tile — make the beam wide enough to cover the
whole map in a single pass — and that is what the shipped `radiusHexes: 16` default did.
It reached 100.00% per purge, which erased the pattern: a scar with no shape is not a
track anybody can follow. The requirement to cover everything and the requirement to be
followable were in direct opposition, and the default resolved it by abandoning the second.

## Decision

**Advance the track's wave phase by `1/K` turns per traverse, where `K` is a first-class
GM parameter (`greatYearTraverses`), and derive the traverse index from the day.**

```ts
trackFor(n: number): SinusoidTrack {
  const k = this.greatYearTraverses;
  if (k <= 1) return this.track;
  return { ...this.track, wavePhase: this.track.wavePhase + mod(n, k) / k };
}

traverseIndex(day: number): number {
  return Math.floor((day - this.params.phaseDays) / this.traversePeriodDays);
}
```

Three properties of that formulation are load-bearing.

**It is a rational `1/K`, not a drift.** After exactly `K` traverses the track is back on
the curve it started on, so the world has a **great year** of `K × transitDays` days. A
player who learns one number knows where the sun will be forever. An irrational or
seed-random advance would also cover the map and would be *unlearnable*, which defeats
the point of the beam being predictable at all — the user's words were "players will want
to predict its movements which they can do by following its path".

**The index is derived from the day, never accumulated** (R-004). A precession counter
advanced once per traverse would make the track a function of the run's history, and day
N resolved out of order would disagree with day N stepped to. That is the property
`cycles.ts` exists to defend.

**It reduces before it divides.** `mod(n, K) / K` rather than `n / K`: both are pure
functions of the day, but `n/K` grows without bound and a world stepped far enough would
lose wave-phase precision to the float. Reducing first keeps the phase exactly in [0,1)
and makes K-periodicity exact rather than approximate.

## What it buys, measured

240×144, seed 20260729, shipped defaults (radius 6, 3 oscillations, 60-day traverse,
amplitude 1.0), driving the real `SolarBeam.dayState` and `affect`:

| traverse | this pass | cumulative |
|---|---|---|
| 1 | 30.64% | **30.64%** |
| 2 | 30.40% | 56.92% |
| 3 | 30.50% | 78.22% |
| 4 | 30.33% | 91.15% |
| 5 | 30.33% | 98.00% |
| 6 | 30.50% | 99.98% |
| 7 | 30.40% | **100.00%** |
| 8 | 30.64% | 100.00% — reproduces traverse 1 exactly |

Partial coverage every pass, complete coverage in a great year, and then it repeats. The
trade the old design could not escape is dissolved: the beam is followable *because* it
only covers a third of the world at a time, and it reaches everywhere *because* the track
moves.

## Choosing K

Precession slides the sine horizontally by exactly one wavelength over the great year, so
the first estimate is `K ≈ width / (2 · oscillations · beamWidthCols)`. **Do not trust it**
— it ignores the torus, the hex metric and the arc's own vertical sweep. The measured
curve is the number to read, and the shape to look for is the one above: ~100% at K, and
K+1 reproducing traverse 1. Under-shooting is visible as a plateau below 100% (K=6 on this
geometry stalls at 98.81%, K=4 at 83.91%); over-shooting only costs a longer great year.

`K` is an absolute count, not a fraction of anything, so like `radiusHexes` it is a
statement about a world of a particular size. A larger world needs a larger K.

## Consequences

- `SolarBeam.forecast`'s horizon becomes a **great year**, not a cycle. Under one cycle it
  would answer "never" for most of the map purely because the beam was on a later
  traverse. `Infinity` is still a real answer — an `amplitudeHalfHeights` below 1.0 leaves
  whole latitudes structurally beam-free — but it now means "outside the track's reach",
  not "not on this pass".
- `expectedIntervalDays` and `describe().periodDays` become the great year for a blob. A
  tile is not under the beam once per traverse; it is under the beam about once per return
  of the track, and reporting the traverse period would understate recovery by a factor of K.
- `greatYearTraverses: 1` reproduces the old behaviour exactly. Verified: with `K: 1` and
  `continuous: false` the golden hashes were bit-identical to the pre-change tree
  (`still 10468117cccd7501`, `crucible 599d7815137a0a4f`), which is how the refactor was
  proven inert before the defaults moved.

## Alternatives rejected

**A wider beam.** This is what the previous default did, and it is what this spec exists
to undo. It reaches everything by covering everything, and a uniform scar is not a track.

**Random per-traverse phase.** Covers the map faster and is unpredictable by construction.
The user asked for predictable; this is the one requirement a random walk cannot satisfy.

**Precessing `homeRow` instead of `wavePhase`.** Sliding the track's centre latitude
covers rows rather than columns. It works geometrically, but it means the beam spends
whole great-years away from the equator, so the hot band — the thing the fiction is about
— stops being hot. Phase precession keeps every traverse crossing every latitude.
