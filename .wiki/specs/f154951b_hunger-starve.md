# Spec f154951b — Hunger, feed, and starve

Branch: `main--epic/f8e826fa_caravan-manager--spec/f154951b_hunger-starve`
Epic: `f8e826fa_caravan-manager`
Status: done

## Objective

Characters carry a food deadline (`satedUntilStep`). Feeding spends `rations` from
inventory and extends the deadline. Past-deadline characters starve (removed from the
caravan). A staffed `food_grower` produces rations on a timer — staffing + inventory
become load-bearing.

Source: ARCHITECTURE `sated_until_step` / `caravan_starve`; Session 11 staff→food.

## Acceptance criteria

1. **Characters** have `satedUntilStep` (deadline step, not a meter). Starting loadout
   sets it to a positive constant from step 0.
2. **`food.ts`:** `feed` / `starveAt` / `produceAt` — no I/O.
   - `feed(caravan, characterId, step, qty?)` withdraws `rations` (prefer hold, then
     loose), extends `satedUntilStep` from `max(step, current)` by `FEED_EXTEND_STEPS`
     per ration.
   - `starveAt(caravan, step)` removes every fitted character with
     `satedUntilStep < step` (destroy — not to bench); clears assignments; may collapse
     an outpost if the last manager starves.
   - `produceAt(caravan, step)` — each **staffed** `food_grower` deposits `PRODUCE_QTY`
     rations into a cargo hold (else loose) once per `PRODUCE_INTERVAL` steps since last
     produce. Unstaffed growers produce nothing.
3. **Constants** exported from `food.ts` (extend / interval / start / material id).
4. **`npm run caravan -- --deposit rations:2 --feed`** feeds the first character.
   **`--starve-at N`** advances starve check at step N. Exit 0.
5. **API:** `POST /api/feed`, and step/advance path runs `produceAt` then `starveAt`.
   State serializes `satedUntilStep` on characters and production timers.
6. **Manager:** topbar / roster shows hunger (steps until hungry); Stations or a small
   Feed control can feed the selected character from Inventory rations.
7. **`npm run typecheck` green.** `npm run sim:golden` unmoved.

## Scope

**May touch:** `src/caravan/**`, wiki specs for this epic, architecture/glossary notes.

**Must not touch:** `src/sim/**` stepping, `src/battle/**`, goldens.

## Boundary decisions

- Starve **destroys** the character this slice (derelict salvage is a later decision).
- Food is a deadline, not a depleting meter between feeds.
- No water / fuel budgets yet.
- Legs do not yet auto-stall on `MIN(sated_until_step)` — that couples later with A6.
