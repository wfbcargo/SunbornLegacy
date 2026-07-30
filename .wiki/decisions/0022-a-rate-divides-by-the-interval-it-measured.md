# 0022 — A rate divides by the interval it measured, not the one it expected

Date: 2026-07-30
Status: accepted
Spec: `2915cb06-6`
Decided by: `fix-sweep-churn-4a1c76`

## Context

`sweep.ts`'s `measure()` sampled the tail of a run every 5 days and accumulated, per
sample, the share of the map whose biome changed since the previous sample. It seeded the
comparison snapshot **before the loop**, at day 0:

```ts
let prev = world.biomeProportions();          // day 0
for (let d = 1; d <= days; d++) {
  world.stepDay();
  if (d > days * 0.66 && d % 5 === 0) {
    /* delta against prev */ churnTotal += delta / 2; churnSamples++; prev = now;
  }
}
```

Every delta was then weighted equally, as though each spanned one sampling interval. The
first one does not. At 1200 days the tail opens on **day 795**, so the first delta covers
**795 days** of worldgen transient and is averaged in as one 5-day sample among 82.

There was no divisor anywhere in the code to get wrong. The interval was never written
down — it lived implicitly in the fact that the samples *happened* to be 5 days apart, and
the seed snapshot silently violated it.

**This produced a false verdict on the load-bearing liveness metric.** Measured on this
tree, 180 × 108, 1200 days, seed 20260729:

| preset | as it printed | corrected | that first sample |
|---|---|---|---|
| `still` | **0.572%** | **0.047%** | 43.14% of the map over 795 d |
| `anvil` | 1.931% | 1.265% | 55.82% |
| `garden` | 3.179% | 2.348% | 70.51% |
| `kiln` | 3.388% | 2.550% | 71.20% |
| `crucible` | 3.774% | 2.951% | 70.46% |

The control read **12× its true churn** and thereby cleared `sweep.ts`'s own
`churn > 0.15%` gate — the one test R-005 exists to make `still` fail. The inflation is
worst exactly where it does the most damage: the quieter the world, the more of its
reported churn is the single transient term. `report.ts`'s `assessStability`, which every
shipped verdict rests on, differences *within* the tail and was never affected.

## Decision

**The interval is measured and explicit, and a snapshot from outside the window is a
baseline rather than a sample.** Both, because either alone leaves a hole.

1. **`prevDay` is tracked alongside `prev`, and the delta is divided by `d - prevDay`,
   then restated per `SAMPLE_DAYS`.** The divisor is now derived from the two snapshots
   actually compared. `SAMPLE_DAYS` and `TAIL_FROM` are named constants used both to
   choose the samples and to scale them, so cadence and divisor cannot drift apart.

2. **`prev` starts `undefined`; the first tail snapshot only establishes the baseline.**
   It has no predecessor inside the window, and a rate honestly averaged over the worldgen
   transient is still not a late-run rate — dividing that first term by 795 leaves `still`
   at 0.049%, closer but built from the wrong 795 days. This is what `assessStability`
   already does (its tail loop starts at `i = 1`).

Alone, (2) restores today's numbers but leaves the next reader to rediscover that the
gaps must all be equal. Alone, (1) hard-codes nothing but still averages the transient in.

## Evidence

`npm run typecheck` clean. `npm run sim:golden`: `still 10468117cccd7501`,
`crucible 599d7815137a0a4f` — **both unmoved**, as required: this changes an instrument,
not a world. `npm run sim:check`: all invariants hold.

`npm run sim:sweep` on this tree, cycle preset sweep, 180 × 108, 1200 days, seed 20260729:

```
  config       entropy   churn%    living% (min–max)     waste%   water%   biomes>0.5%
  still         0.633    0.05      35.6    (35–36)     12.9    22.4        9.0
  anvil         0.730    1.27      33.6    (26–36)     27.2    23.7       12.5
  garden        0.723    2.35      39.6    (30–62)     11.1    22.7       13.6
  kiln          0.760    2.55      36.8    (26–59)     13.0    22.9       16.1
  crucible      0.778    2.95      36.7    (22–58)     13.7    23.6       16.9

  ✗ still        flat, frozen, too few biomes
  ✓ anvil / garden / kiln / crucible    viable world

  ★ 63× the churn of the no-disturbance control
```

`still` now reads **frozen**, which it did not before. No other preset's verdict changed —
in section A the same control appears as `no beam` (0.05%, likewise now frozen) and the
weakest real configuration, `60d/720d`, reports 0.36%, still clear of the 0.15% floor. The
headline moved from **7×** to **63×**; it is computed from the two measurements, so it
corrected itself.

## Consequences

- **The sweep's argument got an order of magnitude stronger by being fixed.** The
  instrument built to show that disturbance keeps a world alive had been understating its
  own case 9-fold, because the bug added a constant to both sides of a ratio.
- **`churnSamples` is now 81 rather than 82** at the default size. The other columns —
  living, waste, water, bloom, entropy, biome count — are *stocks*, keep all 82 samples,
  and are unchanged.
- **The generalisation is the point, not the churn column.** Anything accumulated
  per-sample and reported per-interval must carry its interval with it. A seed value taken
  outside the measurement window is the shape to look for; it type-checks, it runs, and it
  is wrong only in the one number nobody re-derives by hand.
- **`SIMULATION.md`'s "Open, escalated" section A and `README.md`'s note that the churn
  column "is currently inflated" now describe a fixed defect** and are stale until
  re-measured. They are deliberately not touched here — this commit is scoped to the
  instrument.
