# Glossary

## Domain
- **Caravan** — the player's unit of play: characters grouped around one or more
  vehicles. Always needs ≥1 character. Speed = slowest fitted mount or character.
- **Chassis** — a vehicle's fixed slot layout (e.g. `basic_wagon`).
- **Station** — every structure in the game (vehicle module, city building, outpost).
  Fits slots typed by tier × container class (Session 11).
- **Assignment** — soft link from a fitted character to a fitted station (character stays
  in their seat). One-to-one this slice; station is operational iff assigned.
- **Hold** — cargo capacity on a fitted station (`cargo_chest`). Stacks live in holds or
  on the caravan as **loose** until deposited.
- **satedUntilStep** — food deadline on a character. Past the deadline they starve
  (removed). Feeding spends `rations` and extends the deadline.
- **Tile activity** — remain stationary for N ticks on a tile (survey, later mining /
  build). Fleeing forfeits progress this slice. Completing a survey deposits
  `survey_notes` into inventory.
- **Deploy template** — Side-A battle placements (4×6 zone) on the caravan. A skirmish
  bridges them into `src/battle` vs a canned raid (lab only — no wounds written back).
  **Assess** previews the same engagement (`outcome`, losses, ticks) without a separate
  Monte Carlo — fixed `engagementId` ⇒ exact answer.
- **Arena terrain** — per-hex features (`open` / `cover` / `mud` / `block` / `high`)
  generated from the world tile's biome key. Cover raises dodge; mud slows moves; block
  is impassable (never in deploy cols); high extends ranged ability range.
- **Derelict** — form after the last character is gone; chassis/cargo remain until
  salvage (decision `0039`).
- **Fertility** — biome lookup 0…3 gating `food_grower` produce (no depleting soil
  channel yet).
- **Outpost** — a settled caravan: immobile, gains one basic/outpost station slot.
  Requires a managing character; last character leaving collapses it. Mobilising
  destroys the outpost slot and refunds half its station construction scrap.
- **Leg** — an immutable travel segment: tile path + `ticksPerTile` snapshotted at
  commit from the slowest fitted mount/character. Position at a step is a pure function.
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
