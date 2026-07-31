# Spec d53ccbb6-6 — Restore cycle moisture gain on the coarse tier

Status: **done — seasons moisture-push scaled; arid overshoot closed; gate still FAIL 0/5** · 2026-07-31
Epic: `d53ccbb6` · Target: `main--epic/d53ccbb6_lod-gate`

## Result

Full numbers in **`.wiki/decisions/0032`**.

**Rejected first hypothesis:** scaling `CycleEffect.moisture` *up* by the leak gain
ratio (`cellSize^1.25`) drove garden/crucible arid to ~100% — bipolar seasonal
pushes clip asymmetrically when amplified.

**Measured cause:** `seasons.moistureAmplitude` on the coarse tier is net-drying.
Moisture lags heat by half a year, so summer = hot + drought push; the drought
compounds with the scaled heat leak from spec 5. Monsoon/weather moisture alone
do not move the arid gap.

**Fix:** catalogue unit `moisture-push` on `seasons.moistureAmplitude`; 
`coarseCycleSpec` multiplies by `moisturePushCoarseScale(factor) =
1/factor^(1/3)` (= ½ at factor 8 → amplitude 4→2). Fine tier unchanged.

| preset | arid fine→coarse (`0031`) | after spec 6 |
|---|---|---|
| `still` | 22.87→23.29 | **22.87→23.29** (unchanged) |
| `garden` | 43→64 | **43→40.4** |
| `crucible` | 45→69 | **45→51.6** |

Unexplained one-sided on `crucible` 19→8. Bloom remains ABSENT (filament /
sub-cell). Gate still **0/5 FAIL** on unmoved thresholds.

## Objective

Close the cycle-preset arid overshoot left by spec 5, and report what that does to
the LOD gate's unexplained one-sided rules — without moving thresholds or the fine
tier.
