# 0031 — Field-physics lengths scale with resolution; the continuum power is wrong

Status: accepted · Spec: `d53ccbb6-5` · Date: 2026-07-31
Supersedes the *recommendation* in `0030` (the diagnosis stands); does not move
`0030`'s thresholds.

## Decision

A `World` carries `cellSizeTiles` (default 1; `makeCoarseWorld` passes
`COARSE_FACTOR`). Hydrology retention and neighbour thermal exchange are computed
from it:

- `moistureRetention(heat, cellSize)` — leak scales as
  `cellSize ^ MOISTURE_LEAK_GRID_POWER` with **`MOISTURE_LEAK_GRID_POWER = 1.25`**
- `thermalKappaFor(cellSize)` — `THERMAL_KAPPA / cellSize²` (continuum length
  `~√κ`; thermal was not the arid driver and is co-shipped as the same bug class)

The fine tier is unchanged (`cellSizeTiles = 1`). Golden hashes did not move.

## What the first experiment did

`0030` derived `1 - r_coarse = factor² · (1 - r_fine)` → r ≈ 0.9872 at factor 8,
from `world.ts`'s own `exp(-√(2(1-r))·d)` comment. **That number is wrong for this
world.** Measured on `still` 240×144 seed 20260729, 300d burn-in, land below
`ARID(25)`:

| leak power | coarse arid % | coarse mean moisture | notes |
|---|---|---|---|
| 0 (unscaled) | **0.00** | 97.2 | `0030`'s bug |
| 1 | 11.06 | 61.9 | |
| **1.25** | **22.54** | 48.6 | fine is 21.74% / 57 |
| 2 (derived) | **62.85** | 22.8 | overshoots |

Fine arid share is stable out to 2400d (~20–23%); the power-2 coarse share is
stable at ~63%. This is not incomplete equilibration.

**Why power 2 fails.** The fine inland moisture profile is not a coastal
exponential — LOD ladder 5 reads `51→46→56→69→71→99` going inland. Aridity here
is heat-driven, not coast-distance-driven, so matching the 2D coastal diffusion
length is matching the wrong thing. Split probes confirmed: scaling the base
leak alone (any power) and leaving the heat term fixed leaves coarse arid at
**0%**; the heat term must scale. Thermal kappa on/off changes arid by <1 pp.

1.25 is therefore a **measured calibration** against `still`'s arid share, not a
derivation. It is named `MOISTURE_LEAK_GRID_POWER` so the next agent does not
"simplify" it back to 2.

## Gate result after the fix

`npm run sim:lod` · same size/seed/window/thresholds as `0030`. **Thresholds were
not moved.**

| preset | arid fine→coarse | M1 median | M1 outliers | unexplained one-sided | M3 | overall |
|---|---|---|---|---|---|---|
| `still` | 22.87% → **23.29%** | 3.45× FAIL | 82% FAIL | 4 | PASS | **FAIL** |
| `anvil` | 24.30% → 29.27% | **1.47× PASS** | 54% FAIL | 4 | PASS | **FAIL** |
| `garden` | 43.00% → 64.27% | **1.44× PASS** | 60% FAIL | 9 | PASS | **FAIL** |
| `kiln` | 44.12% → 66.04% | **1.28× PASS** | 61% FAIL | 9 | PASS | **FAIL** |
| `crucible` | 44.79% → 68.65% | **1.38× PASS** | 67% FAIL | 9 | PASS | **FAIL** |

**0/5 presets. Gate still red.**

What moved relative to `0030`:

- The structural silence is broken on `still`: arid 0% → 23%, composition
  distance 30.48% → **7.70%**, Desert/Barren/Tundra shares now track the fine
  tier. Every `moisture < ARID` transition is reachable again on the control.
- M1 *median* ratio passes on the four live presets (was failing hard on
  `still` at 33×; live presets were 1.3–2.1× with worse outliers).
- Cycle-bearing presets still run too dry (arid overshoot ~20 pp). The
  calibration was against `still`; cycle moisture pushes interact with the
  scaled leak and were not part of the fit. That is a residual, not a reopen of
  `0030`'s zero-arid failure mode.
- M2's plain median still fails on every preset (THRESHOLD-04's known unit
  artefact: 64× floor). Area-weighted companions on `still` now read ~1× on the
  large biomes (Grassland 1.02×, Forest 0.96×, Tundra 1.01×, Desert 1.07×).
- `--factor 1` still reads 1.00× with M1+M2 PASS. Fine goldens unchanged
  (`still 3bc4c35b1b99adc7`, `crucible 406cbd9ca84e3e3f`).

## Consequences

- **Option 1 of `0030` is done in form, and its derived constant is rejected.**
  The shipped power is the measured one. Option 3 (reshape the architecture) is
  not forced yet — the zero-arid defect is closed on the control — but the gate
  as written remains red, mostly on THRESHOLD-01 outliers / one-sided rules and
  THRESHOLD-04's unmeetable plain median.
- **Phase 2 stays blocked on the gate**, not on the hydrology bug. A follow-up
  that wants a green gate must either (a) finish the residual (cycle-preset
  arid overshoot + remaining unexplained one-sided rules) without moving
  thresholds, or (b) escalate the three bad thresholds `0030` already argued —
  that is a separate decision, not a silent edit to `lod.ts`.
- `src/sim/lod.ts` ladder-5 prose still describes the *pre-fix* failure mode
  ("interior never dries"). Cosmetic; do not confuse it with the current
  numbers.

## Rejected alternatives

- **Ship power 2 as derived.** Measured into the ground on the control.
- **Ship power 1 as "path length".** Lands at 11% arid — inside a factor of two
  of fine, but half the dry geography the chemistry needs. 1.25 is what the
  ARID share actually asked for.
- **Narrow the claim (option 2) without fixing physics.** Available before this
  spec; worse now that composition on `still` agrees at 7.7%.
