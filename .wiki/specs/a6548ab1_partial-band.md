# Spec a6548ab1 — `stepDay` must evaluate every column exactly once

Branch: `main--spec/a6548ab1_partial-band` (standalone spec)
Status: in progress

## Objective

A world of any width ages evenly: one simulated day evaluates each column exactly
once, whatever the width. The bug is fixed where it lives, in the simulator, so the
viewer's width restriction can be removed.

Source: task #5, raised by spec `7b1f0f22` and recorded in
`.wiki/decisions/0005` → Consequences and `.wiki/gotchas.md`.

## The defect

`World.stepsPerDay = ceil(width / bandWidth)` and `World.step()` evaluates **exactly
`bandWidth` columns** every time. When `width` is not a multiple of `bandWidth`, the
day's final band runs past the end and wraps onto columns already done:

| width | steps/day | columns evaluated | doubled | evals/column/day |
|---|---|---|---|---|
| 240 | 30 | 240 | 0 | 1.000 |
| 244 | 31 | 248 | 4 | 1.016 |
| 250 | 32 | 256 | 6 | 1.024 |
| 100 | 13 | 104 | 4 | 1.040 |

Those numbers were measured with a zero-effect observer cycle counting `affect` calls
per column. Nothing crashes; the world simply ages a few percent fast in a band that
drifts as `gaze` accumulates a per-day offset. No output anywhere reveals it.

## Acceptance criteria

1. **`step()` evaluates only the columns remaining in the day.** The day's last band is
   short rather than overlapping. After a full `stepDay()` at any width, every column
   has been evaluated exactly once and `gaze` has returned to its starting value.

2. **★ `npm run sim:golden` MUST be UNCHANGED — `ea1caa9f367a0453` and
   `f4bece63b740b9e2`.** This is the primary correctness signal and it is inverted from
   the usual expectation, so read it carefully: both golden worlds are **160×96**, and
   160 *is* a multiple of 8, so the defect never touched them. A correct fix is
   therefore bit-identical on every width that already divided evenly. **If a hash
   moves, your fix changed behaviour where nothing should have changed — that is a bug
   in the fix, not a legitimate world change. Do NOT run `--update`. Escalate.**

3. **A regression check runs in `npm run sim:check`** and would have caught this. Assert
   over a set of widths that **includes non-multiples of `bandWidth`** (e.g. 240, 250,
   244, 100, and a width below `bandWidth`) that one `stepDay()` evaluates every column
   exactly once. Implement it by passing a test-only `WorldCycle` whose `affect`
   increments a per-column counter — `WorldOptions.cycles` accepts instances, so this
   needs no production hook. Keep it fast; it runs in the standard check.

4. **`src/viewer/limits.ts` drops the width-multiple rule.** Even height stays (it is a
   real `HexTorus` constraint). Update the rejection messages, the doc comment carrying
   the measurement table, and anything in the UI that states the constraint. Do not
   loosen the tile-count cap or the minimum.

5. **`npm run typecheck`, `npm run sim:check`, `npm run sim` all pass.** `sim:check`'s
   pre-existing output must stay byte-identical apart from your new check's lines —
   diff it against `main` with `NO_COLOR=1`.

6. **Verified at a non-multiple width, in the browser**: run the viewer, regenerate at
   width 250, confirm it is accepted, steps, and renders without shear. Report what you
   saw.

7. **Wiki updated.** Strike the width gotcha as FIXED (keep the measurement — it is the
   evidence). Update `decisions/0005` Consequences: the deferred fix has landed, so the
   viewer guard is gone and the constraint no longer exists. Record the fix itself as
   **`decisions/0006`** (next free number), including why the golden hashes did not move.

## Secondary item — fold it in, it is one line each

`run.ts` and `src/viewer/server.ts` both resolve flags with `indexOf`, so the **first**
occurrence of a duplicated flag wins: `--days 300 --days 500` silently runs 300. Make
the last occurrence win in both. This has been outstanding since spec `495707fd`, which
correctly left it out of scope. Mention it in your work log; it does not need its own
decision entry.

## Scope

**May touch:** `src/sim/world.ts` (the `step()` fix), `src/sim/invariants.ts` (the new
check), `src/viewer/limits.ts`, `src/viewer/**` where it states the width constraint,
`src/sim/run.ts` and `src/viewer/server.ts` (the flag fix only), `.wiki/`.

**Must not touch:** the ruleset, biome definitions, worldgen, climate, cycle effect
computation, thresholds, or rule keying. This changes *which columns a step visits*,
nothing about what happens to a tile when it is visited.

## Notes

- `gaze` and the step index within the day must stay consistent. `this.steps %
  this.stepsPerDay` gives the index; the offset is `index * bandWidth`; the count is
  `min(bandWidth, width - offset)`. Check the width-below-`bandWidth` case.
- Keep the hot-loop discipline in `conventions.md#performance-idiom` — no per-step
  allocation.
- R-004: determinism is unaffected by this change and must stay so. Same seed and
  options ⇒ same world.
- `bandWidth` is a `WorldOptions` knob; `DEFAULT_BAND_WIDTH` is only its default. The
  fix must be correct for any `bandWidth`, not just 8.
