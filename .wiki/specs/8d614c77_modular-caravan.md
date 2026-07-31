# Epic 8d614c77 — Modular caravan

Status: done (squashed to main)
Target branch: `main`
Branch: `main--epic/8d614c77_modular-caravan`

## Why this epic exists

Caravans are the player's unit of play — characters grouped around vehicles outfitted
through typed slots. `BRAINSTORM.md` Sessions 2 and 11 decide the model; nothing in the
repo implements it. The terrain sim and battle kernel are far enough along that a
**sibling headless caravan module** plus a local outfit lab can land without waiting on
Postgres, the world API, or movement legs.

## Design source

Authoritative: `BRAINSTORM.md` Session 2 (Caravans & Vehicles) and Session 11 (Stations
& Settlement — typed tiered slots, one noun for every structure).
`ARCHITECTURE.md` §3.4 supplies the persistence-shaped vocabulary (`slot_kind`,
`slot_size`, `chassis_key`, uniqueness of occupants) but predates Session 11's
tier × container-class station rules — Session 11 wins on station typing.

Settled decisions this epic inherits (do not relitigate):

- The player is a manager of characters grouped into caravans.
- Start state: **2 characters + 1 basic caravan vehicle**, pulled by a **crabbeast**.
- Basic chassis loadout: mount / wheels / character slots / station slots.
- **Station** = every structure (vehicle module, city building, outpost).
- Slots are typed by **tier** (basic / advanced) × **container class**
  (caravan / city / outpost). A station must match both.
- Basic caravan station grid: **4 basic caravan + 1 advanced caravan**.
- A caravan travels at the speed of its **slowest member**.
- A caravan always needs ≥1 character (Session 11 invariant).

## Specs, in order

| # | Spec | Objective |
|---|------|-----------|
| 1 | `1fe6c0c7_chassis-slots` | Chassis defs, fit rules, catalog, starting loadout, `npm run caravan`, caravan lab UI |
| 2 | `983a22c6_outpost-convert` | Caravan ↔ outpost settle / mobilise + staffing collapse |
| 3 | `07717b6b_movement-legs` | Immutable travel legs + pure position-at-step on a hex path |

Spec 1 is the vertical slice that proves modules fit slots and can be inspected. Later
specs deepen logistics; they must not break Spec 1's fit invariants.

## Standing constraints

- **R-001 / R-002 / R-006** — no runtime deps; typecheck green; no enums.
- **R-007 analogue** — modules under `src/caravan/` that compute fit/derive do no I/O;
  `run.ts` / `server.ts` are harnesses.
- **Do not touch `src/sim/` stepping code.** No golden `--update`.
- **Not a product surface.** The lab binds localhost only (same spirit as R-009 / battle lab).
- Out of scope for this epic's first slice: food/starve, charge, persistence, world map,
  battle back-line wiring, markets.
