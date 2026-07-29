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
