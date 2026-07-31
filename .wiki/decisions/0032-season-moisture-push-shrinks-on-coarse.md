# 0032 — Season moisture-push amplitudes shrink on the coarse tier

Status: accepted · Spec: `d53ccbb6-6` · Date: 2026-07-31
Follows `0031`. Does not move LOD thresholds.

## Decision

Cycle parameters that are additive pushes on the hydrology diffusion target carry
catalogue unit `moisture-push`. `coarseCycleSpec` multiplies them by

```
moisturePushCoarseScale(factor) = 1 / factor^(MOISTURE_PUSH_COARSE_POWER)
```

with **`MOISTURE_PUSH_COARSE_POWER = 1/3`** (at factor 8: ×½). Today only
`seasons.moistureAmplitude` is tagged; monsoon/weather moisture params were
measured not to drive the arid gap and stay untagged.

Fine tier unchanged. Golden hashes unmoved.

## What was tried and rejected

**Hypothesis A — restore steady-state gain.** Spec 5 raised `(1-r)` by
`factor^1.25`, so `m = push/(1-r)` predicted cycle rain ~13× weaker. Scaling
`effect.moisture` *up* by that factor drove `garden`/`crucible` arid to
**~100%** / mean moisture 0.4. A bipolar sinusoid amplified into the [0,100]
clamp is net-drying (summer drought clips against the floor; winter surplus
wastes against the ceiling). Rejected.

**Hypothesis B — retune leak powers.** A 2-D sweep of basePow × heatPow cannot
hold `still` arid ≈23% and `garden` arid ≈43% at once: the Pareto front leaves
~11 pp max error. Rejected as the primary fix.

**Hypothesis C — shrink season heatAmplitude.** Alone, no effect on garden arid
(64→64). Rejected.

## What was measured

`seasons.moistureAmplitude` alone, divisor sweep, shipped retention, LOD window
(burn 300d, sample 300–400):

| divisor | amp | still | garden | crucible | kiln | anvil |
|---|---|---|---|---|---|---|
| 1 (baseline `0031`) | 4.00 | 23.29 | **64.27** | **68.5** | 65.94 | 29.01 |
| 1.75 | 2.29 | 23.29 | 44.4 | 54.3 | 52.43 | 29.01 |
| **2 (= 8^(1/3))** | **2.00** | **23.29** | **40.38** | **51.38** | **49.38** | **29.01** |
| 2.828 (= √8) | 1.41 | 23.29 | 32.88 | 48.26 | 47.6 | 29.01 |
| fine | — | 22.87 | 43.01 | 44.77 | ~44 | 24.27 |

Monsoon moisture and weather `rainMoisture` alone at divisor √8 move garden arid
by <1 pp. Seasons moisture is the load-bearing knob.

**Why shrinking helps.** Moisture lags heat by half a year
(`moistureLagQuarters: 2`), so summer = elevated heat *and* drought push. Spec 5
scaled the heat leak; the drought push then compounds into floor-clipped
aridification on the coarse tier. Halving the push removes that compound without
touching `still` (no seasons).

## Gate after the fix

`npm run sim:lod` · thresholds unmoved.

| preset | arid fine→coarse | M1 median | unexplained one-sided | overall |
|---|---|---|---|---|
| `still` | 22.87→**23.29** | 3.45× FAIL | 4 | FAIL |
| `anvil` | 24.30→29.27 | 1.47× PASS | 4 | FAIL |
| `garden` | 43.00→**40.39** | 1.34× PASS | 9 | FAIL |
| `kiln` | 44.12→**49.46** | 1.54× PASS | 7 | FAIL |
| `crucible` | 44.79→**51.61** | 1.38× PASS | **8** (was 19) | FAIL |

**0/5. Gate still red.** Arid acceptance of spec 6 met (garden/crucible within
~10 pp; `still` unregressed). Remaining unexplained one-sided rules are dominated
by **Bloom ABSENT** (filament, area-weighted fine patch ~2 tiles) and rainforest
under-representation — a resolution/representability residue, not a moisture
budget one.

## Consequences

- Residual physics of `0031`'s cycle arid overshoot is closed.
- Phase 2 remains blocked on the **gate** (THRESHOLD-01 outliers / THRESHOLD-04
  plain median / Bloom filaments), not on hydrology scaling.
- Next honest options are unchanged from the post-`0031` RESUME: escalate the
  three bad thresholds, or attack filament representability — not another
  moisture constant.
