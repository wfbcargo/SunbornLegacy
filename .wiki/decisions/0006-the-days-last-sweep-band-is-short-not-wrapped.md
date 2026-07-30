# 0006 — The day's last sweep band is short, not wrapped

Date: 2026-07-29
Status: accepted
Spec: `a6548ab1_partial-band`
Decided by: `impl-partial-band-5c7e13`

## Context

`World.stepsPerDay` is `ceil(width / bandWidth)`, and `World.step()` evaluated exactly
`bandWidth` columns every time. Those two halves of the same statement disagree whenever the
width is not a multiple of the band: the day's final step ran past the end of the world and
wrapped onto columns already done that day.

The consequence is not a crash and not a visible artefact. The doubled columns aged twice that
day, and because `gaze` accumulated `bandWidth` per step rather than the number of columns it
actually visited, the doubled stripe DRIFTED across the map day by day. So the world ran a few
percent fast in a moving band, and no output anywhere reported it. Measured with a zero-effect
observer cycle counting real `affect` calls per column over one day — a cycle contributing
nothing changes no outcome, so it is an exact instrument:

| width | width % 8 | evaluations/column/day | columns doubled |
|---|---|---|---|
| 240 | 0 | 1.000 | 0 |
| 244 | 4 | 1.016 | 4 |
| 250 | 2 | 1.024 | 6 |
| 100 | 4 | 1.040 | 4 |

Decision `0005` rejected those widths in `src/viewer/limits.ts` and deferred the real fix on the
grounds that it would move the golden hashes. See below: it does not.

## Decision

**`step()` evaluates the columns remaining in the revolution, not a fixed band.**

```ts
const cols = Math.min(this.bandWidth, grid.width - this.gaze);
// ... evaluate columns gaze .. gaze + cols - 1 ...
this.gaze = (this.gaze + cols) % grid.width;
```

Three properties follow, and all three are what make this safe:

- `gaze` is exactly `(steps % stepsPerDay) * bandWidth`. It starts a revolution at 0, the
  per-step counts sum to `width`, and the modulo returns it to 0 for the next one — so the
  band's phase cannot drift, which a count-only fix could still have allowed.
- `gaze + cols <= width` always, so the per-column `% grid.width` inside the hot loop is gone.
  The change removes work from the loop rather than adding it; measured at 240×144 crucible,
  ten interleaved runs of 40 days each, pre-fix 9.75–11.33 ms/day and post-fix 10.45–11.06,
  i.e. inside the spread of the pre-fix runs alone. No allocation was added
  (`conventions.md#performance-idiom`).
- Correct for any `bandWidth`, including a band wider than the world, where the single step of
  the day evaluates all `width` columns. `bandWidth` is a `WorldOptions` knob; `DEFAULT_BAND_WIDTH`
  is only its default, and the check below covers band 1, 7, 64, 250 and 300 as well as 8.

**★ THE GOLDEN HASHES DID NOT MOVE, AND THAT IS THE PRIMARY CORRECTNESS SIGNAL.** Both golden
worlds are 160×96. 160 is a multiple of 8, so `min(bandWidth, width - gaze)` takes the
`bandWidth` branch on every step of every day and the executed path is identical to the old
code, instruction for instruction. `ea1caa9f367a0453` and `f4bece63b740b9e2` are unchanged.
A moved hash would have meant the fix changed behaviour on a width that was already correct —
a bug in the fix, not a legitimate world change, and not something to `--update` past.

**The regression check is a measurement, in `invariants.ts`, not a hook in the sim.** Check 9,
`sweep coverage`, runs a test-only `WorldCycle` whose `affect` increments a per-column counter
and passes it through `WorldOptions.cycles`, which already accepts instances — so the
production code needs no test seam and R-007 is untouched. It asserts, over ten
width × band combinations including widths below the band, that every column is evaluated
exactly once per `stepDay()` **and that the visit order is 0,1,…,width-1 repeated**, which is
what "`gaze` returned to its starting value" means from outside the class. Verified to fail on
the pre-fix `step()` with exactly the numbers in the table above.

**The viewer's width rule is deleted, not relaxed.** `checkSize` accepts any width from
`MIN_WIDTH` to `MAX_SIDE`; the even-height rule, the minimum and the 262,144-tile ceiling are
untouched. `SizeLimits.bandCols` is gone, and the width input's `step` is `1`.

## Consequences

- **A validator in front of a simulator bug covers only the callers that route through it.**
  This is the transferable lesson. `checkSize` guarded the viewer for as long as it existed
  while `npm run sim -- --width 250` and `sweep.ts` built the fast-ageing world without
  comment. When a bound is a simulation invariant, the check belongs where the invariant does;
  a UI rejection is a stopgap and should be recorded as one, which `0005` did do.
- **"It touches stepping code, therefore it moves the golden hashes" is a guess.** `0005`
  deferred this fix on that guess. Running `npm run sim:golden` costs seconds and would have
  shown the deferral was unnecessary. When R-010 is the stated blocker on a piece of work, run
  the gate before accepting the block.
- The width is now the free axis and the height is the constrained one (even, for the torus
  seam). Anyone adding a size constraint should expect to justify it the way `0005` does.
- Any width from 16 to 2048 is now a legal world in the viewer and in `npm run sim`. Verified
  in the browser at 250×100 and 251×100 (odd, and a non-multiple): both accepted, stepping,
  rendering without shear.

## Also in this spec, and not worth its own entry

`run.ts` and `server.ts` resolved flags with `indexOf`, so the FIRST occurrence of a repeated
flag won and `--days 300 --days 500` silently ran 300. Both now use `lastIndexOf`. Same class
of quiet wrongness as an npm-swallowed flag, which has already invalidated this repo's recorded
evidence once (`CLAUDE.md`).
