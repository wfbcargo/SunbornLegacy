# Spec ba597c45 — Battle core loop

Branch: `main--epic/70a8a238_battle-sim--spec/ba597c45_core-loop`
Epic: `70a8a238_battle-sim`
Status: in progress

## Objective

A headless battle kernel that resolves one 40-turn combat on a 10×6 hex arena, plus
`npm run battle` that runs a canned 2v2 and prints the outcome. Same battle id + same
fighters ⇒ bit-identical result.

Source: `BRAINSTORM.md` Session 12 (Combat resolution model, arena, stats, targeting /
action-selection tiebreaks). Epic: `.wiki/specs/70a8a238_battle-sim.md`.

## Acceptance criteria

1. **`src/battle/`** exists as a sibling of `src/sim/`. Resolution modules do no I/O;
   `run.ts` is the CLI harness.
2. **Arena is 10 cols × 6 rows**, odd-r pointy-top hexes, **non-wrapping**. Deploy zones:
   side A cols 0–3, neutral 4–5, side B 6–9. One fighter per hex.
3. **`runBattle(battleId, fighters) → BattleResult`** runs exactly **40 turns** (or until
   one side has no living fighters). Each turn: living fighters act in speed order
   (higher first; tie → lower id); one action each.
4. **Actions (this spec):** `attack` if a living enemy is in range and attack cooldown is
   ready; else `move` one hex toward the nearest enemy if move cooldown is ready; else
   wait. Priority list is fixed in that order for the canned fight (templates later).
5. **Targeting tiebreak:** nearest (hex distance) → lowest current HP → lowest entity id.
6. **Damage:** `damage` subtracts from armor first, then health. Armor does not regenerate
   mid-combat. Fighter dies at health ≤ 0. Accuracy / dodge are **not** rolled this
   spec — every attack in range hits (rolls land in the next spec; the `rollAt` seam is
   still used so a determinism harness exists).
7. **Determinism:** `rollAt(hashString(battleId), turn, actorId, purpose)` is the only
   randomness primitive (imported from `src/sim/rng.ts`). Running the canned battle twice
   prints identical summaries.
8. **`npm run battle`** prints turn count, per-fighter final HP/armor/position, and
   winner (`A` / `B` / `draw`). Exit 0.
9. **`npm run typecheck` green.** `npm run sim:golden` hashes **unmoved**.

## Scope

**May touch:** `src/battle/**`, `package.json` (add `battle` script only),
`.wiki/specs/ba597c45_core-loop.md`, `.wiki/architecture.md` (one-paragraph note that
`src/battle/` exists).

**Must not touch:** `src/sim/**` except read-only imports of `rng.ts`. No viewer changes.
No golden `--update`.

## Boundary decisions (do not relitigate)

- **Bounded arena, not a torus.** `HexTorus` wraps; the arena must not. Own small grid
  helper under `src/battle/` — do not special-case wrap out of `HexTorus`.
- **Melee range = 1** for the canned fighters. Ranged/gear-bound ranges are next spec.
- **No biome terrain, no flee, no multi-tick, no structures** in this spec.
- **Stalemate after 40 turns with both sides alive is a draw** — acceptable per Session 12.

## Canned 2v2 (for `npm run battle`)

Two fighters per side, all melee, deployed on each side's front edge (col 3 for A, col 6
for B), two different rows. Stats chosen so the fight usually resolves inside 40 turns
rather than drawing — tune by running, then record the chosen numbers in a comment next
to the fixture.
