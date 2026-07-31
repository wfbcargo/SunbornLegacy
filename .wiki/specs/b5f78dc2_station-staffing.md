# Spec b5f78dc2 — Station staffing

Branch: `main--epic/f8e826fa_caravan-manager--spec/b5f78dc2_station-staffing`
Epic: `f8e826fa_caravan-manager`
Status: done

## Objective

Characters fitted on a caravan can be **assigned** to fitted stations (and unassigned).
Assignment is a soft link — the character stays in their seat. Wire the manager Stations
panel to real assign/unassign. Throughput remains a stub: a station is "operational"
iff it has an assignee.

Source: `BRAINSTORM.md` Sessions 9 (`assign(station)`) and 11 (staff-driven stations).

## Acceptance criteria

1. **`Caravan.assignments`** — list of `{ characterInstanceId, stationInstanceId }`.
2. **`assign` / `unassign` / `canAssign`** in `src/caravan/staff.ts` (no I/O):
   - Both character and station must be fitted on the caravan.
   - A character staffs at most one station; a station has at most one assignee.
   - Reject, do not clamp — every failure names the constraint.
3. **Unfit clears assignments** involving the removed occupant (character or station).
   Outpost strip / collapse clears the stripped station's assignment.
4. **`deriveStats`** reports `staffedStationCount` (stations with an assignee) and
   keeps `staffed` as "≥1 character fitted" (unchanged meaning).
5. **`npm run caravan -- --staff`** assigns the first fitted character to the first
   fitted station (starting loadout) and prints assignments; exit 0.
6. **`POST /api/assign`** and **`POST /api/unassign`** on the manager server; state
   payload includes `assignments` and per-station `staffedBy`.
7. **Stations mode** in the manager: select character + station → assign; select an
   already-staffed pair → unassign. No stub banner for "does not mutate."
8. **`npm run typecheck` green.** `npm run sim:golden` unmoved.

## Scope

**May touch:** `src/caravan/**` (types, staff.ts, fit, settle, derive, report, run,
server, public/), `.wiki/specs/b5f78dc2_station-staffing.md`,
`.wiki/specs/f8e826fa_caravan-manager.md`, `.wiki/architecture.md` (short note),
`.wiki/glossary.md` (assignment term if missing).

**Must not touch:** `src/sim/**` stepping, `src/battle/**`, goldens.

## Boundary decisions (do not relitigate)

- Assignment ≠ unfit — character remains in a character slot while staffing.
- One-to-one this slice (multi-staff stations later).
- No food / throughput rates yet — operational is boolean only.
- Starting loadout leaves stations unassigned until `--staff` or the UI assigns.
