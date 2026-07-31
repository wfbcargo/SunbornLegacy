# Spec c7d2048f — Multi-tick engagement + assess_engagement

Branch: `main--epic/70a8a238_battle-sim--spec/c7d2048f_assess-engagement`
Epic: `70a8a238_battle-sim`
Status: done

## Objective

Expose the Session 12 automation primitive: preview a multi-round engagement's
outcome, losses, and ticks-to-resolve **before** committing. Multi-round resolution
already lives in `engagement.ts` (HP persists, armor/positions reset); this spec
adds `assessEngagement` and wires CLI + battle lab.

Source: `BRAINSTORM.md` Session 12 (`assess_engagement(force, target) → { outcome,
expected_losses, ticks_to_resolve }`). Epic: `.wiki/specs/70a8a238_battle-sim.md`.

## Acceptance criteria

1. **`assessEngagement(opts) → Assessment`** runs `runEngagement` (same opts) and
   returns:
   - `outcome`: `A` | `B` | `draw`
   - `ticksToResolve`: `roundsPlayed`
   - `expectedLosses`: `{ A, B }` — fighters that started alive and ended dead
   - `remaining`: alive counts per side
   - `summary`: short string lines
   - `engagement`: full `EngagementResult` for callers that want detail
2. Because combat is deterministic for a fixed `engagementId`, "expected" **is** the
   exact result for that id (uncertainty comes from the world changing, not rolls).
3. **CLI:** `npm run battle -- --assess --id <scenario>` prints the Assessment and
   exits 0 without requiring a separate run mode.
4. **Battle lab:** `POST /api/assess` accepts the same body as `/api/run` and returns
   the Assessment JSON.
5. **Caravan:** `POST /api/assess-skirmish` (or skirmish response field) exposes the
   same shape from the manager Deploy panel — optional thin wire if bridge already
   has fighters.
6. **`npm run typecheck` green.** `sim:golden` unmoved. Determinism check on assess
   twice ⇒ identical JSON for outcome/losses/ticks.

## Scope

**May touch:** `src/battle/**`, `src/caravan/server.ts` + public Deploy assess button,
wiki, epic (mark done when 2–4 land).
**Must not touch:** sim stepping, goldens.

## Boundary decisions

- Assess is a pure re-sim — no separate Monte Carlo. One engagementId ⇒ one answer.
- Flee / pursuit stay out of scope.
- `runEngagement` behavior unchanged; assess is a façade + reporting.
