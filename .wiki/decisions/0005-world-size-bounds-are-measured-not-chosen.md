# 0005 — World size bounds are measured, not chosen

Date: 2026-07-29
Status: accepted
Spec: `7b1f0f22_cycle-composer`
Decided by: `impl-composer-3e91b7`

## Context

`WorldOptions.width/height` have always existed, and `server.ts` has always parsed
`--width/--height`, but nothing ever validated them. Exposing size in the UI turns that
from a latent problem into an immediate one: a person typing `143` deserves an answer
better than a 500 and a stack trace, and worse, some illegal sizes do not fail at all —
they quietly produce a world that ages unevenly.

So the bounds had to be established rather than assumed. All four below are enforced in
`src/viewer/limits.ts`, each with a message that states the constraint rather than
clamping the number, and each traceable to a measurement rather than to taste.

## The bounds

### 1. Height must be EVEN — hard requirement, already enforced deeper down

`HexTorus` throws: *"Torus height must be even (got 143) or row parity breaks at the
seam."* Odd-r offset coordinates alternate the neighbour deltas by row parity, and the
torus stitches row `H-1` to row `0`; with an odd height those two rows have the same
parity and the seam joins up wrong. Confirmed by construction at 240×143.

This one only needed surfacing, not discovering. What it *did* need was making
`ViewerSession.reset` atomic — it previously assigned `this.height` before building, so a
throw left the session reporting a height its world did not have, and the client decodes
the frame's byte planes using exactly that number. The map would have sheared silently
instead of the request failing.

### 2. Width must be a multiple of 8 — measured, and silent when violated

This is the one worth the whole entry. `World.stepDay()` runs
`ceil(width / bandWidth)` steps and each advances the gaze by exactly `bandWidth` (8)
columns, so a width that is not a multiple of 8 makes the last step of a day overlap the
first. Measured with a zero-effect observer cycle counting `affect` calls per column
across one day (a cycle that contributes nothing changes no outcome, so it is an exact
instrument):

| width | width % 8 | evaluations/column/day | columns doubled |
|---|---|---|---|
| 240 | 0 | 1.000 | 0 |
| 244 | 4 | 1.016 | 4 |
| 250 | 2 | 1.024 | 6 |
| 100 | 4 | 1.040 | 4 |

Nothing crashes. The world simply runs a few percent fast, in a band that drifts across
the map as the days pass, and **no output anywhere would show it**. Every width this repo
has ever used — 240, 160, 120, 64 — is divisible by 8, so this has never been hit; a UI
with a free-text width box would have hit it immediately.

That is precisely why it is a rejection and not a clamp. A silent 2.4% error in the rate
of time is the same class of defect as `npm run sim --days 1500` running the default
world.

### 3. Minimum 16×16 — a judgement call, stated as one

The hard floor is much lower: the neighbour table only degenerates below 3 columns or 4
rows, where a tile becomes its own neighbour. 16×16 is chosen because it is twice the
beam's default band (8 columns) and nearly twice the monsoon's (9 rows) — below that a
single default cycle covers the entire map every day it is active, which is not a small
world but a world with no geography for weather to move across. 8×8, 16×2 and 24×18 all
run without error; they are simply not worth offering.

### 4. Maximum 262,144 tiles, 2048 per axis — bounded by STEP TIME

The simulation is linear in tiles, measured across a 400× range (one `stepDay` averaged
over 20 days after a 5-day warm-up): **~92 ns/tile with no cycles, ~125 ns/tile with all
five**, flat from 2,048 to 864,000 tiles.

| size | tiles | still | crucible | frame |
|---|---|---|---|---|
| 240×144 | 34,560 | 3.2 ms | 4.3 ms | 68 KiB |
| 480×288 | 138,240 | 12.5 ms | 17.1 ms | 270 KiB |
| 512×512 | 262,144 | — | 33 ms bare / **42.2 ms in the viewer** | 512 KiB |
| 960×576 | 552,960 | 51.7 ms | 68.4 ms | 1080 KiB |

The binding constraint is that `ViewerSession.schedule` delivers speeds above 20
days/second as several days per timer tick, so the top speed of 60 steps **three days in
one synchronous block** — ~127 ms of blocked event loop per tick at the cap, measured.
That is already at the edge of a viewer that is supposed to feel live, and at 960×576 it
is over 200 ms and playback visibly stalls.

The two candidates that turn out **not** to bind, both measured in Chrome at the cap:

- **Canvas.** At the maximum hex radius of 12 a tile costs ~374 canvas pixels, so
  Chrome's ~268 Mpx area limit is not reached until ~717,000 tiles. At 512×512 the canvas
  is 10,653×9,222 = 98.2 Mpx and allocates and draws fine; a full client redraw measured
  48 ms, independent of zoom (it is per-tile work, not per-pixel work — decision `0003`).
- **Frame bytes.** 512 KiB per frame at the cap, over loopback, at most 15 frames a
  second.

The per-axis cap of 2048 exists only so a legal tile count cannot become an illegal
canvas: 4096 columns at hex radius 12 would be 85,000 px wide, past Chrome's 65,535 px
maximum dimension.

## Consequences

- The four constraints live in one place, `src/viewer/limits.ts`, with the measurements in
  comments beside them. Moving a bound is allowed — on new evidence, not on preference.
- `checkSize` is also applied to `--width/--height` at startup, so the CLI and the UI
  refuse the same worlds for the same stated reason instead of the CLI dying in `HexTorus`.
- The viewer reports measured ms/simulated-day and projects it for a pending size, so the
  cost of a bigger world is visible before it is paid rather than discovered afterwards.
- **This bounds the VIEWER, not the simulator.** `npm run sim` at 960×576 is fine; it has
  no event loop to block. If the server ever steps worlds off the request thread, the cap
  should be re-measured rather than inherited.
- **The width-multiple check is a guard in front of a defect that lives elsewhere.** The
  step-overlap is a bug in `World.stepDay`, not a property of the viewer, so rejecting the
  width here protects the UI while `npm run sim -- --width 250` and `sweep.ts` still build
  the fast-ageing world. Two of these bounds are simulation invariants enforced in the wrong
  layer, and a second consumer of `World` would miss both. The real fix — make `stepDay`
  handle a partial final band, or reject in the `World` constructor — changes or constrains
  simulation behaviour and therefore moves the golden hashes, so it needs its own spec behind
  R-010. Deliberately deferred, not overlooked.

## Superseded — bound 2 is gone (spec `a6548ab1`, decision `0006`)

The deferral above is over, and it ended differently than this entry predicted.

`World.step()` now evaluates only the columns left in the revolution, so the day's last band
is short instead of wrapped and **every width ages evenly**. Bound 2 is therefore deleted from
`src/viewer/limits.ts` — `checkSize` accepts any width from `MIN_WIDTH` to `MAX_SIDE`, and
`SizeLimits.bandCols` is gone with it. Bounds 1, 3 and 4 stand exactly as measured above; the
measurement table for bound 2 stays in this entry and in `limits.ts` as the evidence for why
the rule existed.

**The claim that a sim-side fix "moves the golden hashes" was wrong, and it was wrong in the
direction that costs work.** Both golden worlds are 160×96; 160 is a multiple of 8, so on
those worlds the fixed `step()` takes the full-band branch on every step and the code path is
bit-identical. `ea1caa9f367a0453` and `f4bece63b740b9e2` did not move — they are the *proof*
the fix is surgical, not an obstacle to it. Reasoning about R-010 instead of running
`npm run sim:golden` deferred a real defect behind a gate that was never closed.
