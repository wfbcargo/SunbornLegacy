# Spec d8f1c3a0 — Hit / armor / dodge + gear-bound action stats

Branch: `main--epic/70a8a238_battle-sim--spec/d8f1c3a0_hit-rolls`
Epic: `70a8a238_battle-sim`
Status: done

## Objective

Lock the Session 12 combat math that grew past Spec 1: every damaging/control
ability rolls hit then dodge; armor absorbs before HP; range / cooldown / damage /
accuracy live on the **ability** (gear-bound), not as a character class.

Source: `BRAINSTORM.md` Session 12 (Combat stats, "stats bound to the ACTION").
Epic: `.wiki/specs/70a8a238_battle-sim.md`. Spec 1 (`ba597c45`) deferred rolls.

## Acceptance criteria

1. **Hit roll:** `rollAt(battleKey, turn, actorId, PURPOSE_HIT, targetId, abilityKey)` —
   miss if `roll >= accuracy`. Accuracy is `ability.accuracy ?? fighter.accuracy`.
2. **Dodge roll:** after a hit connects, `PURPOSE_DODGE` — negate if
   `roll < target.dodge`. Events: `miss` / `dodge`; stats track both.
3. **Armor then HP:** damage subtracts from armor first, then health. Armor does not
   regenerate mid-battle. Engagement rounds restore `startArmor` (already in
   `engagement.ts`).
4. **Gear-bound action stats:** `Ability` carries `range`, `cooldown`, and kind-
   specific fields (`damage`, `accuracy`, `aoe`, `shield`, …). Fighter role/name are
   display; combat role comes from the ability list.
5. **Templates** ship ability-level accuracy on every strike/volley/weaken/root.
6. **Determinism:** same battleId + fighters + arena ⇒ identical summaries (CLI check).
7. **`npm run typecheck` green.** `npm run sim:golden` unmoved.

## Scope

**May touch:** `src/battle/**`, this spec, epic table, architecture one-liner,
`ba597c45` status.
**Must not touch:** `src/sim/` stepping, goldens, caravan (except if bridge already
imports battle).

## Boundary decisions

- Ward does **not** roll hit/dodge (ally grant).
- Volley splash always connects once primary hits (existing Spec-1-era choice).
- Stalemates (armor > throughput) remain acceptable (Session 12).
