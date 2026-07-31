# 0033 — Escalate the three LOD thresholds that cannot discriminate

Status: accepted · Spec: `d53ccbb6-7` · Date: 2026-07-31
Evidence: `decisions/0030` §"Three thresholds are wrong". User chose escalation.

## Decision

The LOD gate's criteria are the **companions** `0030` measured as discriminative.
Spec `d53ccbb6-4`'s original numbers remain printed, labelled companions.

| ID | Was (spec 4) | Is now (gate) |
|---|---|---|
| THRESHOLD-01 | Any one-sided rule = hard fail | Hard fail iff **structural** one-sided (`expected ≥ 3`). Sampling silence listed, not a fail. Outlier budget counts structural one-sided only. |
| THRESHOLD-04 | Plain median patch within 3× | **Area-weighted** median within 3×; plain median is companion. Absent biome still fails. |
| THRESHOLD-03 | Raw `P(same)` length within 2× | **Connected** `C(d)-C(inf)` length within 2×. If **both** connected lengths are unresolved, PASS (tiers agree the length is unmeasurable) — required by the factor-1 control. |

M1 median band (0.5–2×) and outlier fraction (≤10% outside 0.2–5×) are **unchanged**.

## Proof the escalation is not a rubber stamp

`--factor 1` (identical worlds): **PASS** overall after this change. Under spec 4's raw
M3 it failed with UNRESOLVED on bit-identical tiers. That was the defect `0030` named.

## Gate after escalation (with spec 8 Bloom floor also shipped)

`npm run sim:lod` still **FAIL 0/5**. M3 connected PASSes on every preset. Failures
that remain are real:

- M1 on `still`: median 3.45× and 4 structural one-sided (chemistry, not sampling).
- M1 on live presets: median often PASSes; outlier fraction and a handful of
  structural one-sided still fail.
- M2: area-weighted large biomes often ~1× on `still`, but single-patch Desert /
  Frozen Sea and coastal/small biomes (Shallows, Rock) still fail weightedWithin.

## Consequences

- Spec 4's written criteria are **superseded for the gate** by this decision. The
  harness header points here.
- Phase 2 is no longer blocked by *unsatisfiable metrics*. It is blocked by remaining
  chemistry / patch disagreement the escalated gate still reports.
