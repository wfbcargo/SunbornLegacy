# Gotchas

Non-obvious pitfalls. One line per entry. Things that bit us once.

- **Entropy alone does not detect a dead world.** At 22 biomes a no-disturbance control
  measured entropy 0.707 vs a living world's 0.703 — the *frozen* world scored higher (historical
  figures, pre-re-key). Re-confirmed after the re-key: the `still` control measures entropy
  **0.651, above the 0.65 alive threshold**, and only churn (0.05% against a required 0.15%)
  catches it. Churn is the discriminating metric (R-005).
- **Node strips types without checking them.** `run.ts` parsed `--beam-period` into a
  property `WorldOptions` no longer declared; it silently did nothing and the recorded numbers
  were right only by luck (defaults happened to match). Always run `tsc --noEmit`.
- **Measure the tail, never the final frame.** A purged world oscillates, so an end-of-run
  snapshot lands at an arbitrary phase of the cycle and reports it as steady state. Both tests
  sample across the final third.
- **Beam severity and recovery are separate knobs.** Collapsing `beamTransitDays` and
  `beamCycleDays` into one "period" makes a longer period mean a *slower* beam, baking each
  tile longer. At a single-knob 900-day period, water reached 0%.
- **A world's cycle set determines which biomes can exist in it.** With no tectonics there is
  no path to `mountain` at all; with no volcanism and no beam, `lava`/`ash`/`basalt`/fertile
  `soil` are unreachable. Never assume all 22 biomes are available in an arbitrary world.
- ~~**`rollAt` is keyed positionally.**~~ **FIXED** (spec `495707fd`, decision `0002`). Rolls
  now key on `rule.keyHash`, derived from `<from>-><to>:<label>`. Reordering `RULES` is a no-op;
  it changes precedence only.
- **Renaming a rule's `label` changes the world.** `label` is part of the rule key, because
  from/to alone is not unique (glass has three exits). A rename is therefore a re-key and every
  subsequent roll differs. Deliberate, but sharp — `npm run sim:golden` is what makes it loud.
- **`npm run <script> --flag` silently runs something else.** npm eats flags that are not after
  `--`, so `npm run sim --days 1500 --cycles still` ran *crucible at 1200 days*. This applies to
  every script here, `npm run viewer --port 5000` included. Always
  `npm run sim -- --days 1500`. Both `run.ts` and `server.ts` resolve flags with `indexOf`, so
  the FIRST occurrence of a duplicated flag wins.
- **Viewer metrics and CLI metrics legitimately disagree at the same day.** The viewer assesses
  the tail of a rolling 600-day window; `npm run sim` assesses the tail of the whole run. At
  day N they are computed over different evidence, so churn and entropy differ. That is not
  drift — do not go looking for a bug.
- **`npm run sim:golden` failing does not mean something is broken** — it means the world
  changed. If deliberate: `--update`, then re-run `npm run sim` and update SIMULATION.md and
  README.md *in the same commit*. Updating the hash alone makes it a rubber stamp.
- **The golden hashes are engine-specific, not universal.** `Math.cos`/`Math.pow` are not
  required by ECMA-262 to be correctly rounded, so another JS engine may legitimately produce
  different hashes. It is a regression test, not a conformance test.
- **TypeScript 7.x does not auto-include `@types/*`.** Installing `@types/node` is NOT enough:
  without `"types": ["node"]` in `tsconfig.json`, 7.0.2 reports 114 phantom host-global errors
  in code that is fine. Keep the `types` entry in config, never on a command line, so
  `npm run typecheck` is right however it's invoked. Decision `0004`.
- **Never add `"DOM"` to the root `tsconfig.json` `lib`.** Node code must not see
  `window`/`fetch`, browser code must not see `process`. Root stays `lib: ["ES2023"]`,
  `types: ["node"]`; browser code gets its own scoped tsconfig. No `exclude` is needed — the
  viewer client is `.js` under `src/viewer/public/` and `include: ["src/**/*.ts"]` already
  skips it. Decision `0004`.
- **`StabilityVerdict`, `BiomeDef` and `CYCLE_PRESETS` key names are frozen.** The viewer
  passes those field names to the browser verbatim, and the typechecker does not see across
  that seam — a rename breaks it silently at runtime. Same status as the `World` read surface.
- **The typecheck gate found nothing on the day it was added.** All 94 errors from the first
  `tsc --noEmit` were missing host globals; there were zero substantive type errors. Its value
  is entirely prospective — do not read "94 errors" as "94 bugs fixed".
- **~~A world's width must be a multiple of `bandWidth` (8), or time runs fast in a drifting
  band.~~ FIXED — any width ages evenly. Decision `0006`.** The measurement stays because it
  is the evidence. `stepDay()` runs `ceil(width/8)` steps and `step()` used to evaluate exactly
  8 columns every time, so any other width made the day's last step overlap its first. Measured
  with a zero-effect observer cycle: width 250 evaluated six columns twice a day (1.024
  evals/column/day), width 100 evaluated four twice (1.040), width 244 four twice (1.016).
  **Nothing crashed and no output showed it** — the world just aged a couple of percent fast in
  a stripe that drifted. `step()` now evaluates only what is left in the revolution, so the
  day's last band is SHORT rather than wrapped, and `src/viewer/limits.ts` no longer has a
  width rule (even height and the tile-count ceiling remain). Two things about it are worth
  keeping in mind:
  - **The rejection had never covered the sim.** `npm run sim -- --width 250` went straight past
    the viewer's `checkSize` and built the fast-ageing world anyway. A validator standing in for
    a simulator bug only guards the callers that route through it.
  - **The predicted golden-hash movement did not happen, and the reason is worth internalising
    before deferring a fix on that basis again.** Decision `0005` recorded the sim-side fix as
    blocked because it "moves the golden hashes (R-010)". It does not: both golden worlds are
    160×96, 160 divides 8, and on any such width the new `min` takes the `bandWidth` branch on
    every step, so the code path is bit-identical. `ea1caa9f367a0453` and `f4bece63b740b9e2`
    are unchanged, and that is the fix's primary correctness signal rather than an obstacle.
    "This touches stepping code, so it must move the hashes" is a guess; running it is cheap.
- **Height must be even and `HexTorus` throws if it is not** — odd-r parity breaks where the
  torus stitches its last row to its first. Validate before constructing: `ViewerSession.reset`
  now builds into a local and commits only on success, because assigning `height` and *then*
  throwing left the session reporting a height its world did not have, and the client slices
  the frame's byte planes by exactly that number.
- **Never import from `src/sim/invariants.ts`.** It is a script: nine checks run at module
  scope and it calls `process.exit`. Importing it to reuse a function would run a ~75-second
  test suite and then kill the importing process. The reusable half lives in
  `src/sim/reachability.ts`.
- **Reachability is KIND-level, not parameter-level.** `reachableCore` restricts the ruleset to
  the flags a cycle *kind* can raise, so `seasons` counts as a source of Freeze even at heat
  amplitude 0. The honest reading: **"unreachable" is a hard fact, "reachable" is a
  possibility.** Do not upgrade the second into a promise.
- **The reachability sweep is slowest for the emptiest worlds.** Cost is (unsatisfiable rules ×
  admitted flag combinations), and a rule that *can* fire exits on its first probe while one
  that cannot must exhaust 22×22 neighbour pairs × 7 water counts × 45 heats × 21 moistures per
  combination. Measured: all five kinds **0.2 s**, no cycles **4.7 s**, seasons + monsoon +
  tectonics **30.8 s**. Cached per flag mask, so it is paid once per distinct vocabulary.
- **Do not put prose in the frame header.** It rides along up to 15 times a second: adding each
  cycle's `describe()` (with its `summary`) took the header from ~600 bytes to **5,037** for
  four cycles. The client gets summaries once from `/api/meta` and the header carries only the
  specs.
- **Omitting a cycle's `key` is not the same as sending its default.** `makeCycle` defaults the
  solarbeam key to `beam`, not `solarbeam`, and the key seeds the cycle's RNG stream — so a UI
  that "helpfully" sends an explicit key builds a *different world* from the same preset:
  different fault lines, vents and phase. The composer narrows a spec back down (omitting the
  key when it equals the kind's default, omitting parameters equal to theirs), and it reads that
  default from `makeCycle` itself via `/api/meta` rather than writing it down twice.
