# 0024 — The two-knob finding is about a band, and does not transfer to a blob

Date: 2026-07-30
Status: accepted
Spec: `0280c42b`
Decided by: `impl-wandering-sun-3c7e14`

## Context

`cycles.ts` carried this in `SolarBeamParams.cycleDays`, in the strongest terms the file
uses:

> ★ These two MUST stay separate. Collapsing them into a single "period" inverts the
> effect: a longer period becomes a SLOWER beam, each tile bakes longer, and the world
> sterilises — at a single-knob 900-day period, water reached 0%.

Spec `0280c42b` needed the beam to be **permanently present**, and the simplest honest
form of that is exactly the thing this note forbids: one traverse ends, the next begins,
`cycleDays` stops meaning a recovery gap and `transitDays` becomes the traverse period.

The finding was measured on a **full-height band**, where every tile of a column is under
the wall for as long as the wall takes to clear its own width. It was never measured on a
blob, whose dwell is set by `radius / trackSpeed` and whose recovery, under decision
`0023`, is set by the great year rather than by a global dormancy. So it was re-measured
rather than assumed, in both directions.

## Measurement 1 — dwell and dose, by period

240×144, seed 20260729, driving the real `dayState`/`affect`. Dwell is the run length of
consecutive days a tile is under the beam; "tile-days/day" is total beam exposure divided
by elapsed days, i.e. what the world absorbs per unit time.

| geometry | period | mean dwell | max dwell | beam tile-days/day |
|---|---|---|---|---|
| band, 8 cols | 30 d | 1.82 d | 2 d | 180 |
| band, 8 cols | 60 d | 3.59 d | 4 d | 360 |
| band, 8 cols | 120 d | 7.11 d | 8 d | 720 |
| band, 8 cols | 240 d | 14.17 d | 16 d | 1440 |
| blob r6 osc3 | 30 d | 1.30 d | 3 d | 459 |
| blob r6 osc3 | 60 d | 1.60 d | 4 d | 284 |
| blob r6 osc3 | 120 d | 2.21 d | 7 d | 196 |
| blob r6 osc3 | 240 d | 3.42 d | 12 d | 152 |

**Under a band the two columns move together and both move up.** Dwell is exactly linear
in the period (×2 per doubling) and so is the dose: a slower band bakes each tile longer
*and* delivers more heat per day, because the band is always somewhere and its footprint
is the full height of the world. Two effects, same direction, and that is why one knob
sterilises.

**Under a blob the two columns move in opposite directions.** Dwell grows sub-linearly
(2.6× over an 8× period) while the dose per day *falls* by 3×, because a blob's footprint
is fixed and a longer period simply spreads the same great-year track over more days.

## Measurement 2 — what the world does about it

1500 days, 240×144, seed 20260729, beam-only world:

| geometry | period | entropy | churn |
|---|---|---|---|
| band | 30 d | 0.726 | 1.43% |
| band | 60 d | 0.729 | 1.52% |
| band | 120 d | 0.739 | 1.40% |
| band | 240 d | 0.771 | 1.16% |
| blob r6 osc3 K7 | 30 d | 0.764 | 1.24% |
| blob r6 osc3 K7 | 60 d | 0.746 | 0.84% |
| blob r6 osc3 K7 | 120 d | 0.730 | 0.71% |
| blob r6 osc3 K7 | 240 d | 0.718 | 0.54% |

The orderings are opposite. The blob's churn falls monotonically as the period grows,
which is the signature of *less* disturbance, not more.

## Measurement 3 — the actual claim, retested

The recorded finding names a specific outcome: a single-knob 900-day period drains the
water. 120×72, seed 20260729, sea share over 60 game-years:

| configuration | sea y0 → y60 | pp/y | entropy | churn |
|---|---|---|---|---|
| band, single-knob 900 d | 23.81 → **5.60** | **−0.3034** | 0.769 | 0.40% |
| blob r6 osc3 K7, continuous 900 d | 23.81 → **23.52** | **−0.0048** | 0.685 | 0.24% |

**The band reproduces the finding.** It drains three quarters of the world's water in 60
game-years, which is the absorbing state the original note was warning about.

**The blob does not drain at all.** Its sea share is flat to four decimal places of a
percentage point per year. What goes wrong at a 900-day period is something else entirely:
entropy falls to 0.685 and churn to 0.24%, and the world converges toward the `still`
control's frozen equilibrium. The failure mode is a world that stops moving, not a world
that boils dry — and it is caught by the churn floor (R-005), which is already a merge
gate, rather than by a water measurement nobody would have thought to take.

## Decision

**Add `continuous: boolean` (blob only, default on) and let the two time knobs collapse
for a continuous blob.** `transitDays` becomes the traverse period; `cycleDays` is not
consulted. The severity model becomes local: dwell is `radius / trackSpeed`, recovery is
the great year.

**Keep both knobs for a band, and keep the original note attached to the band.** The
finding is true, it is load-bearing, and `shape: 'band'` still reproduces it — the
`anvil` band numbers and the transit-as-dwell relationship above are unchanged.

## Consequences

- The direction a GM turns the dial **inverts with the shape**, which is the trap this
  decision exists to mark. Under a band, "tune the beam down" means a *shorter* transit —
  that is why `crucible` shipped 45 days against `anvil`'s 60. Under a blob it means a
  *longer* traverse period, because period sets disturbance rate rather than dwell. A GM
  who carries the band intuition across will make the world harsher while believing they
  softened it.
- `crucible`'s beam period moves the other way for exactly this reason: see the preset's
  own comment for the water-trend numbers that set it.
- Dwell under a blob is short in absolute terms (1.3–3.4 days mean) and the `Focus` heat
  is a one-day impulse against a melt gate, so `CycleEffect.heat` must stay off any
  thermal filter — decision `0009` already says so, and a blob makes it sharper, not
  softer.
