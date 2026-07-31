# Spec b673990b — Deploy templates + battle bridge

Branch: `main--epic/f8e826fa_caravan-manager--spec/b673990b_deploy-bridge`
Epic: `f8e826fa_caravan-manager`
Status: done

## Objective

Persist a Side-A **deployment template** on the caravan (placements in the 4×6
deploy zone). Bridge those placements into the existing battle kernel as Side A
against a canned Side-B raid, and wire the manager Deploy panel. Closes the last
stub mode in the caravan manager shell.

Source: `BRAINSTORM.md` Session 12 (deployment IS the gameplay; templates
first-class); manager-shell Deploy stub (`963e9e2e`); battle `spawn` /
`runBattle` / `runEngagement`.

## Acceptance criteria

1. **`Caravan.deploy`** — `{ placements: DeployPlacement[] }` where each placement
   is `{ characterInstanceId, col, row }` with `col ∈ 0…3`, `row ∈ 0…5`.
2. **`deploy.ts`:** `place` / `clearPlacement` / `clearDeploy` / `canPlace` — no I/O.
   - Character must be fitted; one character → one cell; one cell → one character.
   - Reject out-of-zone coords and unknown characters (named reasons).
   - Unfitting a character drops their placement.
3. **`bridge.ts`:** `buildSkirmish(caravan)` → fighters for `runBattle` /
   `runEngagement`:
   - Side A: each placed character mapped `catalogId →` battle `TemplateId`
     (`wanderer`→`reedstep`, `hand`→`wagonram`; unknown catalog → named reject).
   - Side B: canned raid of equal count from `MIX_RAID`, front-loaded in cols 6–9.
   - Fighter `name` overrides use the caravan character’s display name on Side A.
   - Reject if fewer than 1 placement.
4. **`skirmish(caravan, battleId?)`** runs one engagement (default max rounds) and
   returns the outcome summary. Deterministic for the same `battleId` + placements.
5. **`npm run caravan -- --deploy`** places fitted characters on Side-A front
   (col 3, successive rows). **`--skirmish`** (after deploy or existing places)
   prints outcome / turns / surviving counts. Exit 0.
6. **API:** `POST /api/deploy` `{ characterInstanceId, col, row }`;
   `POST /api/deploy/clear` (optional `characterInstanceId`);
   `POST /api/skirmish` runs the bridge and returns `{ outcome, summary, … }`
   plus state. State payload includes `deploy.placements`.
7. **Deploy mode** — place/clear mutate kernel state (survive refresh via server
   session). **Run skirmish** button shows outcome text. No stub banner.
8. **`npm run typecheck` green.** `npm run sim:golden` unmoved.

## Scope

**May touch:** `src/caravan/**`, read-only imports from `src/battle/**` (roster,
engagement/resolve, arena, types — **do not change battle resolution**), wiki
specs for this epic, architecture/glossary notes.

**Must not touch:** `src/sim/**` stepping, battle golden/scenario authoring
except importing; no golden `--update`.

## Boundary decisions (do not relitigate)

- **One deploy bag per caravan** this slice — named multi-templates / shareable
  JSON come later. Shape leaves room (`deploy.placements`).
- **Ability priority lists stay battle-template defaults** — editing priorities
  is a later metagame slice.
- **One-way dependency:** `src/caravan` may import `src/battle`; battle must not
  import caravan.
- **Skirmish is a lab rehearsal**, not world combat — no stamina/charge, no
  wounds written back to caravan characters, no map threat.
- Side B is always the canned raid mix — player-vs-player deploy is out of scope.
