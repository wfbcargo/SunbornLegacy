# Spec 963e9e2e — Caravan manager UI shell

Branch: `main--epic/f8e826fa_caravan-manager--spec/963e9e2e_manager-shell`
Epic: `f8e826fa_caravan-manager`
Status: done

## Objective

Evolve the caravan lab into a tabbed **Caravan manager** shell: Map and Outfit stay
live against the existing API; Stations, Inventory, Deploy, and Investigate ship as
interactive chrome with stubbed backends (no new kernel models).

## Acceptance criteria

1. **Rebrand** — `src/caravan/public/` presents as “Caravan manager”; `npm run caravan:view`
   still serves it on localhost (default port 4175).
2. **Mode nav** — tabs Map · Outfit · Stations · Inventory · Deploy · Investigate.
   Exactly one mode visible. URL hash `#map` / `#outfit` / `#stations` / `#inventory` /
   `#deploy` / `#investigate` persists the active mode across refresh.
3. **Topbar** — brand, derived stats strip, settle · mobilise · starting loadout · empty
   chassis. Route commit / clear / stall live under Map mode only.
4. **Map** — existing hex canvas, step scrubber, route draft/commit/clear/stall still work.
5. **Outfit** — existing catalog / slot grid / bench fit/unfit still work.
6. **Stations (stub)** — lists fitted stations and character roster; click-to-assign UI
   that does **not** mutate caravan state; shows that station staffing kernel is needed.
7. **Inventory (stub)** — per-station cargo panes (`cargo_chest` highlighted); empty
   stacks; transfer controls disabled with stub reason.
8. **Deploy (stub)** — mini 4×6 Side-A deploy grid; caravan characters as placeable
   chips; placements are **client-local session state only** (lost on refresh), not
   persisted to kernel or battle.
9. **Investigate (stub)** — current-tile card; “Start survey (100 ticks)” disabled unless
   the caravan is idle and mobile; stub progress bar.
10. **No kernel changes** — `src/caravan/*.ts` fit/derive/legs/settle/types untouched
    except optional comment renames in `server.ts`. No `src/battle/**` imports.
11. **`npm run typecheck` green.** `npm run sim:golden` hashes **unmoved**.

## Scope

**May touch:** `src/caravan/public/**`, `src/caravan/server.ts` (banner comments only),
`.wiki/specs/f8e826fa_caravan-manager.md`, `.wiki/specs/963e9e2e_manager-shell.md`,
`.wiki/architecture.md` (short note).

**Must not touch:** `src/sim/**`, `src/battle/**`, caravan kernel modules
(`fit.ts`, `legs.ts`, `settle.ts`, `types.ts`, `catalog.ts`, `chassis.ts`, `derive.ts`,
`loadout.ts`, `path.ts`, `run.ts`). No golden `--update`. No Postgres / `/v1/*`.

## Boundary decisions (do not relitigate)

- **Evolve the lab in place** — not a separate product surface.
- **UI shell first** — stub panels are presentation; later specs wire real kernels.
- **Client-only stubs** — no fake `/api/*` for staffing/inventory/survey; keep the
  server API honest about what is real.
- **Deploy placements** are disposable client state for chrome rehearsal only.
