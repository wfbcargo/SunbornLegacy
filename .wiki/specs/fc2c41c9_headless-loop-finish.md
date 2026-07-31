# Epic fc2c41c9 — Headless loop finish (A6–A8)

Status: done
Target branch: `main`
Branch: `main--epic/fc2c41c9_headless-loop-finish`

## Why this epic exists

Track A manager modes (epic `f8e826fa`) are wired. The roadmap exit gate still needs
the caravan on a **living world seed**, characters as salvageable economy nouns, and
terrain-gated food throughput — without Postgres.

## Specs, in order

| # | Spec | Objective |
|---|------|-----------|
| 1 | `a74338aa_world-couple` | Small in-memory `World`; biome path costs; one settlement/tile; hunger stall |
| 2 | `95327940_character-economy` | Derelict on last character; equipment slots; salvage |
| 3 | `60e8f1a2_soil-fertility` | Biome→fertility table; food_grower gated/scaled by tile fertility |

## Standing constraints

- **R-001 / R-002 / R-006** — no runtime deps; typecheck green; no enums.
- **R-009 spirit** — localhost labs only.
- **Do not change `src/sim/` stepping** — import `World` / biomes / rng read-only.
  A8 fertility is a **lookup from biome**, not a new sim channel (no golden `--update`).
- Decision `0039` locks derelict salvage before A7 coding.
