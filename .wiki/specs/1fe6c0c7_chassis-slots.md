# Spec 1fe6c0c7 — Chassis, slots, and caravan lab

Branch: `main--epic/8d614c77_modular-caravan--spec/1fe6c0c7_chassis-slots`
Epic: `8d614c77_modular-caravan`
Status: done

## Objective

A headless modular-caravan kernel: chassis definitions, typed slots, a small catalog of
fit-able modules (mount / wheel / character / station), fit/unfit rules, derived caravan
stats (speed = slowest member), the Session-2 starting loadout, `npm run caravan` that
prints it, and a localhost **caravan lab** to outfit and inspect.

Source: `BRAINSTORM.md` Sessions 2 and 11. Epic: `.wiki/specs/8d614c77_modular-caravan.md`.

## Acceptance criteria

1. **`src/caravan/`** exists as a sibling of `src/sim/` and `src/battle/`. Fit/derive
   modules do no I/O; `run.ts` and `server.ts` are harnesses.
2. **Chassis `basic_wagon`** exposes exactly:
   - 1× mount slot, size `medium`
   - 4× wheel slots, size `medium`
   - 4× character slots (slot 0 is the driver seat — display only this slice)
   - 4× basic-caravan station slots + 1× advanced-caravan station slot
3. **Fit rules:**
   - Occupant kind must match slot kind (`mount`/`wheel`/`character`/`station`).
   - Mounts and wheels must also match slot size.
   - Stations must match **tier × container class** (Session 11).
   - An occupant occupies at most one slot; reject double-fit.
   - `unfit` clears a slot; fitting into an occupied slot rejects (no silent swap).
   - Reject, do not clamp — every failure names the constraint.
4. **Derive:** `ticksPerTile` = max over fitted mounts and characters (slowest member).
   With no mount and no characters, derive reports immobile (`null` speed) and
   `staffed: false`. `staffed` is true iff ≥1 character is fitted.
5. **Starting loadout** (`makeStartingCaravan(seed)`): 1 `basic_wagon`, crabbeast in the
   mount slot, 4 basic wheels, 2 seeded characters in character seats, one basic
   `cargo_chest` station. Deterministic from `seed` (use `mulberry32` / `hashString` from
   `src/sim/rng.ts` — do not invent a second RNG).
6. **`npm run caravan`** prints chassis id, per-slot occupants, derived ticks/tile and
   staffed flag. Exit 0. Running twice with the same seed prints identical text.
7. **`npm run caravan:view`** serves a localhost lab (default port **4175**) that lists
   the catalog, shows the current caravan's slot grid, lets the user fit/unfit from the
   catalog into empty/occupied slots via the API, and shows derived stats. Plain
   HTML/CSS/JS under `public/` (same no-build pattern as battle/viewer).
8. **`npm run typecheck` green.** `npm run sim:golden` hashes **unmoved**.

## Scope

**May touch:** `src/caravan/**`, `package.json` (add `caravan` / `caravan:view` only),
`.wiki/specs/1fe6c0c7_chassis-slots.md`, `.wiki/specs/8d614c77_modular-caravan.md`,
`.wiki/architecture.md` (one short note that `src/caravan/` exists),
`.wiki/glossary.md` (caravan / station / chassis terms if missing).

**Must not touch:** `src/sim/**` stepping code (rng import OK), `src/battle/**`,
`src/viewer/**`. No golden `--update`. No Postgres / API `/v1/*`.

## Boundary decisions (do not relitigate)

- **In-memory only.** No database; ids are opaque strings.
- **Session 11 station typing wins** over Session 2's undifferentiated "4 station slots".
  Mount/wheel/character layout still comes from Session 2.
- **Wheels do not affect speed this slice** — only mounts and characters contribute to
  `ticksPerTile`. Wheels are fit-checked so the chassis is real.
- **No cargo mass/volume accounting yet** beyond recognising a `cargo_chest` station
  exists. Containers land later.
- **Outpost convert / movement legs** are later specs in this epic.
- **Driver seat** is seat index 0 among character slots — flavour for the lab; no
  special rules beyond display this slice.

## Catalog minimum (this spec)

| Id | Kind | Notes |
|----|------|-------|
| `crabbeast` | mount, medium | slow, durable; `ticksPerTile: 12` |
| `basic_wheel` | wheel, medium | starter wheel |
| `cargo_chest` | station, basic/caravan | starter cargo |
| `food_grower` | station, basic/caravan | catalog only |
| `water_collector` | station, basic/caravan | catalog only |
| `med_station` | station, basic/caravan | catalog only |
| `solar_generator` | station, advanced/caravan | advanced slot only |
| `wanderer` / `hand` | character templates | names rolled from seed |

Character `ticksPerTile: 8` (faster on foot than a crabbeast-pulled wagon — the mount
is the bottleneck when fitted).
