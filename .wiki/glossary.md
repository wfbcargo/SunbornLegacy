# Glossary

## Domain
- **Beam / the gaze** — the Sun God's cleansing sweep across the world; the primary
  disturbance cycle. `transitDays` = severity, `cycleDays` = recovery time.
- **Cycle** — a world-scale disturbance engine (`SolarBeam`, `Seasons`, `Tectonics`,
  `Volcanism`, `Monsoon`). A world's cycle set is its identity and its difficulty dial.
- **Churn** — fraction of the map changing biome per sample. The load-bearing liveness metric.
- **Crucible / garden / still** — cycle presets. `crucible` = all cycles (the default and the
  representative world); `still` = no disturbance (the control, which MUST fail the test).
- **Niche** — a region with a scarce export and enough materials to build with. Test 2 asserts
  every spawn region is one.
- **Torus** — the map wraps on both axes, so there are no poles and no edges. Latitude is a
  periodic band: hot equator at row 0, cold band at row H/2.
- **Tick / day / revolution** — 1 day = 1 solar revolution = 14,400 ticks (`TICKS_PER_DAY`).
- **LOD** — level of detail; the 8×8 coarse tier the storage model depends on agreeing with
  the tile tier. Not built yet.

## Framework
- **Epic / Spec / Implementation / task** — the claude-architect work tiers. See
  `ORCHESTRATION.md` in the plugin.
- **Work log** — `.work-log/`, ephemeral AI-to-AI scratch paper, gitignored, dies with the
  worktree. Durable knowledge goes here in `.wiki/` instead.
