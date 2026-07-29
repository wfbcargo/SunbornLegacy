# Gotchas

Non-obvious pitfalls. One line per entry. Things that bit us once.

- **Entropy alone does not detect a dead world.** At 22 biomes a no-disturbance control
  measured entropy 0.707 vs a living world's 0.703 — the *frozen* world scored higher. Churn
  is the discriminating metric (R-005).
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
- **`rollAt` is keyed positionally.** Re-ordering the `RULES` array silently re-keys history,
  so a ruleset edit changes outcomes for reasons unrelated to the edit. Stable rule ids are
  the fix (ARCHITECTURE Phase 0).
