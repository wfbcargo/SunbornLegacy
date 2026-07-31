# Spec 95327940 — Characters as economy (derelict + gear)

Branch: `main--epic/fc2c41c9_headless-loop-finish--spec/95327940_character-economy`
Epic: `fc2c41c9_headless-loop-finish`
Status: done

## Objective

When the last character leaves a caravan, it becomes a **derelict** (salvageable), not
an empty vanishing act. Characters gain three equipment slots that bias the battle
bridge template map. Decision: `.wiki/decisions/0039-derelict-on-last-character.md`.

## Acceptance criteria

1. **`Form.derelict`** — immobile, unstaffed chassis + holds remain. Cannot commit legs,
   settle, or survey until salvaged.
2. **Last character removed** (unfit / starve) → `markDerelict` (clears assignments,
   activity, deploy; keeps vehicles/holds/loose).
3. **`salvage(caravan, character)`** — fit a character onto an empty character slot;
   form → `caravan`. Reject if not derelict or no free seat.
4. **Equipment** on characters: optional `armor` / `tool` / `gear` catalog ids.
   Catalog adds at least `scrap_vest`, `hand_axe`, `trail_kit`. `equip` / `unequip` in
   `gear.ts`. Unequip returns item to loose as a 1-qty stack (material id = catalog id)
   or rejects if no room — prefer deposit to hold/loose like refunds.
5. **Bridge:** if `armor` equipped → prefer `ashplate` / `slagguard` templates; else
   existing catalog map. Gear does not change HP numbers this slice — template swap only.
6. **CLI:** `--starve-at` that clears all characters leaves derelict; `--salvage` with
   a spawned character restores. **`--equip scrap_vest`** equips first character.
7. **API:** `POST /api/equip`, `/api/unequip`, `/api/salvage`. State shows `form` and gear.
8. **`npm run typecheck` green.** Goldens unmoved.

## Scope

**May touch:** `src/caravan/**`, wiki specs/decision/architecture/glossary.
**Must not touch:** sim stepping, battle resolution internals (import roster only).

## Boundary decisions

- No character markets / contracts this slice.
- Professions stay catalog flavour; equipment is the mechanical breadth lever.
