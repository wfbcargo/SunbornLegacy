# Spec 60cb7b0e — Tile activities (survey)

Branch: `main--epic/f8e826fa_caravan-manager--spec/60cb7b0e_tile-activities`
Epic: `f8e826fa_caravan-manager`
Status: done

## Objective

A caravan can start a **tile activity** that requires remaining stationary for N ticks.
This slice ships the general primitive as **survey** (100 ticks) and wires the manager
Investigate panel. Completing a survey deposits knowledge goods into inventory.

Source: `BRAINSTORM.md` Session 12 (tile activities — the vulnerability primitive);
manager-shell Investigate stub (`963e9e2e`).

## Acceptance criteria

1. **`Caravan.activity`** — `null` or `{ kind: 'survey', tile, startStep, durationTicks }`.
   At most one activity at a time. Tile is a snapshot of the park tile at start.
2. **`activity.ts`:** `canStartSurvey` / `startSurvey` / `activityProgress` / `cancelActivity` /
   `resolveActivity` — no I/O.
   - Start requires: mobile form, not travelling at `step`, no existing activity, ≥1
     fitted character.
   - `activityProgress(caravan, step)` → elapsed / remaining / complete fraction
     (clamped); rejects if no activity.
   - `resolveActivity(caravan, step)` — when elapsed ≥ duration, deposit
     `SURVEY_NOTES` × 1 (hold preferred, else loose), clear `activity`, return
     `{ completed: true, tile }`. Idempotent if already clear.
   - `cancelActivity` clears with no reward (explicit cancel or interrupt).
3. **Constants** exported: `SURVEY_DURATION = 100`, `SURVEY_NOTES = 'survey_notes'`.
4. **Interrupts forfeit all progress** (this slice — not partial). Auto-cancel on
   successful `commitLeg`, `settle`, or `mobilise`. Starting a survey while an
   activity exists is a named reject.
5. **`npm run caravan -- --survey`** starts a survey at step 0; **`--at 100`** (or
   any step ≥ duration) after `--survey` resolves it and prints the notes deposit.
   Exit 0.
6. **API:** `POST /api/survey` starts; `POST /api/survey/cancel` cancels;
   `/api/step` runs `resolveActivity` after `advanceNeeds`. State includes
   `activity` + derived progress at current step.
7. **Investigate mode** — live tile card, progress bar, Start enabled when
   `canStartSurvey`, Cancel while active, completion reflected in Inventory
   (`survey_notes`). No stub banner.
8. **`npm run typecheck` green.** `npm run sim:golden` unmoved.

## Scope

**May touch:** `src/caravan/**`, `.wiki/specs/60cb7b0e_tile-activities.md`,
`.wiki/specs/f8e826fa_caravan-manager.md`, `.wiki/architecture.md`, `.wiki/glossary.md`.

**Must not touch:** `src/sim/**` stepping, `src/battle/**`, goldens.

## Boundary decisions (do not relitigate)

- **Survey only** this slice — mining / build / observe-cycle share the same
  `activity` shape later; do not invent a second kind yet.
- **Fleeing forfeits 100%** — Session 12 left partial loss open; full forfeit is the
  harsh end that makes guards matter. Partial retention is a later tuning knob.
- **No charge / stamina budget** yet — duration alone is the cost.
- **No fog / deposit_knowledge table** — reward is an inventory stack the Inventory
  panel already shows.
- Outposts cannot survey (`mobile === false`), matching the shell stub.
