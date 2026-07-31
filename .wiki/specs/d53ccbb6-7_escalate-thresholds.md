# Spec d53ccbb6-7 — Escalate the three bad LOD thresholds

Status: **done — companions are now the criteria; factor-1 PASS; gate still 0/5 on real fails** · 2026-07-31
Epic: `d53ccbb6`

## Result

`decisions/0033`. `lod.ts` gate uses structural one-sided, area-weighted patches,
connected correlation. `--factor 1` **PASS**. Full gate still FAIL 0/5 on chemistry
median/outliers and patch single-patch / small-biome weighted misses.

## Objective

Replace the three criteria `0030` proved cannot discriminate with the companions
that can — as an **explicit escalation**, recorded in `decisions/0033`, not a
silent edit. Re-run the gate. Do not touch world physics.

## The three escalations (already argued in `0030`)

| ID | Spec 4 criterion (broken) | Escalation (companion becomes criterion) |
|---|---|---|
| THRESHOLD-01 | Any one-sided rule = hard fail | Hard fail only on **unexplained** one-sided (`expected ≥ ONE_SIDED_SAMPLING_FLOOR`). Sample-size silence is reported, not a fail. |
| THRESHOLD-04 | Plain median patch size within 3× | **Area-weighted** median within 3×. Plain median remains printed, labelled companion. |
| THRESHOLD-03 | Raw `P(same)` length within 2× | **Connected** `C(d)-C(inf)` length within 2×. If either length is unresolved, that tier's connected length decides; UNRESOLVED on raw alone is no longer overall FAIL. Factor-1 must PASS. |

Median ratio / outlier fraction bands for M1 stay as written (0.5–2× / ≤10% outside 0.2–5×). Outlier fraction continues to count one-sided as outside — but after THRESHOLD-01, only structural one-sided feed the hard fail; optionally also only structural one-sided count as outliers (argue in ADR: an undefined ratio from sampling silence should not burn the 10% budget).

**Recommended:** outliers count only structural one-sided + ratio outliers. Sampling one-sided are listed separately.

## Acceptance

- `decisions/0033` records each old→new criterion with the `0030` evidence citation.
- `--factor 1` overall PASS (proves M3 escalation works).
- Spec 4 file gets a status note pointing at `0033` (criteria superseded for the gate).
- Fine goldens unmoved (lod.ts only).
- Full `sim:lod` table reported; may still FAIL on structural grounds (Bloom etc.).

## Scope

**In:** `lod.ts`, wiki (0033, specs, RESUME).
**Out:** `world.ts`, `biomes.ts`, `coarse.ts` physics (that's spec 8).
