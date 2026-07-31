# Spec d53ccbb6-5 — Scale field-physics lengths with resolution

Status: **done — arid gap closed on `still`; gate still FAIL 0/5** · 2026-07-31
Epic: `d53ccbb6` · Target: `main--epic/d53ccbb6_lod-gate`

## Result

`WorldOptions.cellSizeTiles` + `moistureRetention` / `thermalKappaFor`.
`makeCoarseWorld` passes `cellSizeTiles: factor`. Fine goldens **unmoved**.
Full numbers in **`.wiki/decisions/0031`**.

The continuum derivation (`1-r ∝ factor²`, r≈0.9872) **overshot** (coarse arid
62.85% vs fine 21.74%). Fine inland moisture is not a coastal exponential, so that
length was the wrong target. Measured calibration: **`MOISTURE_LEAK_GRID_POWER = 1.25`**
→ `still` arid 22.87% → 23.29%, composition distance 30.48% → 7.70%.

`npm run sim:lod` after the fix: **0/5 presets still FAIL** on the unmoved
thresholds. M1 median now PASSes on the four live presets; outliers / one-sided
rules and M2's plain median keep the gate red. Cycle presets still run ~20 pp too
dry. `--factor 1` still 1.00× M1+M2 PASS.

## Objective

Make the coarse tier's hydrology (and the suspected twin, neighbour thermal exchange)
carry the same **tile-scale** length constants as the fine tier, then re-run the LOD
gate and report whether the aridity gap closes and whether M1/M2 move.

## Context a fresh session needs

- **`decisions/0030`** is the brief. Spec 4's gate failed 0/5 because moisture retention
  is applied once per grid step, so one coarse step carries moisture 8× farther in world
  distance. Coarse land never goes arid → every `moisture < ARID` rule is unreachable.
- Shrinking `COARSE_FACTOR` is **measured and rejected** (aridity already gone at factor 4).
- The derived fix from `world.ts`'s own law `exp(-sqrt(2(1-r))·distance)`:
  `1 - r_coarse = factor² · (1 - r_fine)` → at `r = 0.9998`, factor 8 → **r ≈ 0.9872**.
  ⚠️ That number is **derived, never run.** This spec's first experiment is to run it.
- `THERMAL_KAPPA = 0.30` is a **candidate**, not a finding (coarse land ~2–3 ° cooler;
  consistent with over-long reach, not isolated). Co-ship the same class of fix:
  penetration `~sqrt(κ/α)` is in cells, so `κ_coarse = κ_fine / factor²` holds tile reach.
- Work in `.worktrees/d53ccbb6_lod-gate`. `main` is untouched at `be3e44d`.
- Thresholds in `d53ccbb6-4` are **not moved**. If they still fail after the physics fix,
  report that honestly. Companions stay companions.

## Standing constraints

- `npm run typecheck`, `sim:check`, `sim:golden` green.
- **Fine-world goldens must not move.** `cellSizeTiles` defaults to 1; only a coarse
  world (or an explicit opt-in) uses another value. Specs 1–4 required unmoved hashes;
  this one must leave them unmoved too — the fine tier's physics is unchanged.
- R-003: every number from a real run. The derived 0.9872 is a hypothesis until printed
  from a run that used it.
- R-004, R-007, R-001, R-006 as usual.
- Do not quietly retune `THRESHOLD-*` in `lod.ts`.

## Design

1. Add `WorldOptions.cellSizeTiles?: number` (default **1**): how many fine tiles one
   grid cell of this `World` represents.
2. Export pure helpers (so the lab and the stepper share one formula):
   - `moistureRetention(heat, cellSizeTiles)` → `1 - cellSize² · (0.0002 + max(0, heat-52)·0.0006)`,
     then `max(0.5, …)` as today.
   - `thermalKappaFor(cellSizeTiles)` → `THERMAL_KAPPA / cellSize²`.
3. `World` stores `cellSizeTiles` and uses the helpers in hydrology and
   `diffuseTemperature`. Reject `cellSizeTiles < 1` (and non-integers).
4. `makeCoarseWorld` passes `cellSizeTiles: factor`.
5. `coarse.ts` already scales cycle geometry; this spec classifies the two field-physics
   constants the same way — spatial, resolution-dependent, living in `world.ts`.

## Experiments (order)

All at 240×144 fine, seed 20260729, unless iterating with the smaller window from RESUME.

| # | Run | What it answers |
|---|---|---|
| 0 | `npm run sim:golden` | Fine tier unmoved |
| 1 | `npm run sim:lod -- --preset still --factor 1` | Control still reads 1.00×; M1+M2 PASS |
| 2 | `npm run sim:lod -- --preset still` | Does aridity return? Land below ARID fine vs coarse; inland moisture gradient |
| 3 | `npm run sim:lod` | Full gate, all five presets — report the same table shape as `0030` |

Paste real output into `.work-log/` and summarise into `decisions/0031`.

## Acceptance

**Must**

- Fine goldens unchanged (`still 3bc4c35b1b99adc7`, `crucible 406cbd9ca84e3e3f`).
- `--factor 1` still PASS on M1 and M2 at 1.00× (gate can still pass).
- Coarse `still` land-below-`ARID` is no longer 0.00% — the structural silence that
  made every dry transition unreachable must be broken. Target shape: within a factor
  of ~2 of the fine share (22.87%), not "exactly equal". Exact equality is not claimed.
- A new ADR `0031` records measured numbers and whether the **gate** (M1/M2/M3 as
  written) passes, fails, or is mixed. Option 3 stays available if aridity closes and
  M1 still hard-fails for a new reason.

**Must not**

- Change fine-tier defaults or move LOD thresholds to manufacture a PASS.
- Start Phase 2 / Postgres work.

## Scope boundaries

**In:** `world.ts` (options + retention + kappa), `coarse.ts` (`makeCoarseWorld` wiring),
ADR + spec status + epic index + RESUME, whatever `lod.ts` needs to *report* the scaled
constants (no threshold edits).

**Out:** rewriting M2/M3 criteria; tectonic rules; viewer; docs saying "185 rules"
(carried forward separately).

## Done when

Experiments 0–3 have pasted output, `0031` exists with a verdict, and this file's status
line names the outcome in one sentence.
