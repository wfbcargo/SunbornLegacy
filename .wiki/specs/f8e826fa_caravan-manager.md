# Epic f8e826fa — Caravan manager

Status: done (shell → staffing → inventory → hunger → survey → deploy bridge)
Target branch: `main`
Branch: `main--epic/f8e826fa_caravan-manager`

## Why this epic exists

Epic `8d614c77` shipped the modular-caravan kernel and a localhost outfit lab with
route plotting, settle/mobilise, and chassis fit. The player-facing *manager* surface
needs more modes: station staffing, inventory, battle deploy, tile investigate. Those
kernels do not exist yet. This epic lands the **UI shell** first so later specs have a
place to wire into, without inventing product auth or `/v1/*`.

## Design source

- `BRAINSTORM.md` Session 2 (player as manager), Session 11 (stations), Session 12
  (deploy templates, tile activities / survey).
- Existing lab: `src/caravan/public/` + `npm run caravan:view`.

## Specs, in order

| # | Spec | Objective |
|---|------|-----------|
| 1 | `963e9e2e_manager-shell` | Tabbed manager shell; Map + Outfit live; Stations / Inventory / Deploy / Investigate stubbed |
| 2 | `b5f78dc2_station-staffing` | Assign characters to fitted stations; wire Stations panel |
| 3 | `4e4ce0d2_station-inventory` | Cargo holds + transfer; wire Inventory panel |
| 4 | `f154951b_hunger-starve` | satedUntilStep, feed, starve, staffed food_grower |
| 5 | `60cb7b0e_tile-activities` | Stationary survey primitive; wire Investigate panel |
| 6 | `b673990b_deploy-bridge` | Persist Side-A deploy; skirmish bridge into battle kernel |

Follow-on: none in this epic — Track A headless loop modes complete after A5.

## Standing constraints

- **R-001 / R-002 / R-006** — no runtime deps; typecheck green; no enums.
- **R-009 spirit** — localhost instrument only; not a product surface.
- **Do not touch `src/sim/` stepping code.** No golden `--update`.
- Kernel fit/legs/settle stay honest — stub modes are client presentation only.
