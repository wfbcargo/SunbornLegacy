# Spec 4e4ce0d2 — Station inventory

Branch: `main--epic/f8e826fa_caravan-manager--spec/4e4ce0d2_station-inventory`
Epic: `f8e826fa_caravan-manager`
Status: done

## Objective

Fitted cargo stations hold material stacks. Goods can transfer between holds (and
to/from caravan-loose when no hold accepts them). Wire the manager Inventory panel.
No markets, mass accounting, or ledger persistence yet.

Source: Session 2 cargo; ARCHITECTURE `container` / `item_stack` shape (in-memory).

## Acceptance criteria

1. **Catalog:** `cargo_chest` declares `cargoCapacity` (max total qty this slice).
   Stations without capacity cannot hold goods.
2. **`Caravan.holds`** — one hold per fitted cargo station (`stationInstanceId` + stacks).
   **`Caravan.loose`** — stacks not in a hold (refunds when no chest, or emptied chest unfit).
3. **`inventory.ts`:** `deposit` / `withdraw` / `transfer` / `ensureHolds` — reject on
   unknown station, non-cargo station, insufficient qty, capacity exceeded. No I/O.
4. **Lifecycle:** fitting a cargo station creates an empty hold; unfitting moves its
   stacks to `loose` and drops the hold. Mobilise / collapse refunds deposit into a
   cargo hold if any, else `loose` (server no longer keeps a separate scrap purse).
5. **`npm run caravan -- --deposit construction_scrap:25`** deposits into the first
   cargo hold (or loose). **`--transfer`** moves 10 scrap from first hold to loose
   (or reverse) for a round-trip smoke. Exit 0.
6. **API:** `POST /api/deposit`, `/api/withdraw`, `/api/transfer`; state includes
   `holds` + `loose` (no top-level `scrap`).
7. **Inventory mode** lists holds (cargo_chest highlighted) with stacks; select
   source stack + destination hold/loose → Transfer enabled and mutates state.
8. **`npm run typecheck` green.** `npm run sim:golden` unmoved.

## Scope

**May touch:** `src/caravan/**`, `.wiki/specs/4e4ce0d2_station-inventory.md`,
`.wiki/specs/f8e826fa_caravan-manager.md`, `.wiki/architecture.md`, `.wiki/glossary.md`.

**Must not touch:** `src/sim/**` stepping, `src/battle/**`, goldens.

## Boundary decisions

- Capacity is total qty across stacks in one hold — not mass/volume yet.
- One material id per stack row; deposit merges same `materialId`.
- No `goods_ledger` append log this slice — stacks are source of truth in memory.
