# Epic 70a8a238 — Battle simulator

Status: done
Target branch: `main`
Branch: `main--epic/70a8a238_battle-sim`

## Why this epic exists

`BRAINSTORM.md` Session 12 decides combat: light, automated, deterministic from the
player's side, hex arena, preconfigured deployment, 40 turns flat. Nothing in the repo
implements it yet — the terrain sim is complete enough that a parallel combat kernel can
exist without waiting on characters, stations, or the database.

This epic builds that kernel as a **sibling of `src/sim/`**, not inside it. Terrain
stepping stays free of combat; combat stays free of world days. The seam is shared pure
utilities (`rollAt` / `hash32` from `src/sim/rng.ts`) and, later, biome → arena terrain.

## Design source

Authoritative: `BRAINSTORM.md` Session 12 — Combat through Open Questions.
`ARCHITECTURE.md` predates Session 12 and has no combat mechanics; ignore it for this
epic except for the eventual event-queue placement of combat in the full stack.

Settled decisions this epic inherits (do not relitigate):

- Combat is a **cost / logistics check**, not a gamble — outcomes tightly bounded.
- **40 turns** per combat tick, flat.
- Hex grid, one character per hex; no mid-fight tactical control.
- Replays are **re-simulations**: `hash(battleId, combatTurn, actorId, purpose)`.
- Arena **10×6**; deploy zones 4 / 2-neutral / 4; back line = caravan/structure.
- Targeting tiebreak: nearest → lowest current HP → lowest entity id.
- Action selection: ordered priority list, first available fires.
- Stalemates are fine; either side can leave (flee is a later spec).
- Damage persists across world ticks; positions reset — multi-tick is a later spec.

## Specs, in order

| # | Spec | Objective |
|---|------|-----------|
| 1 | `ba597c45_core-loop` | Runnable 40-turn battle: arena, fighters, move/attack, `npm run battle` |
| 2 | `d8f1c3a0_hit-rolls` | Hit/armor/dodge rolls + gear-bound action stats as first-class |
| 3 | `a1e9b472_biome-arena` | Biome-derived arena terrain |
| 4 | `c7d2048f_assess-engagement` | Multi-tick engagement + `assessEngagement` preview |

Spec 1 is the vertical slice that proves the kernel runs. Later specs deepen fidelity;
they must not break Spec 1's determinism contract.

## Standing constraints

- **R-001 / R-002 / R-006** — no runtime deps; typecheck green; no enums.
- **R-004** — same battle id + same initial fighters ⇒ bit-identical outcome. No
  `Math.random()`, no `Date.now()` in resolution.
- **R-007 analogue** — modules under `src/battle/` that resolve combat do no I/O;
  `run.ts` is the harness.
- **Do not touch `src/sim/` stepping code.** Importing `rng.ts` (and later hex helpers
  if extracted) is allowed; changing biomes/world/cycles is not.
- **Do not move golden hashes.** This epic does not change the terrain world.
- Terrain sim gates (`sim:golden`, `sim:check`) stay green and unmoved.
